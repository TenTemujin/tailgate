import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import page from './page.gen.js';
import { load, save } from './catalog.js';
import { scrape } from './github.js';
import { install, installedPlugins, pluginCmd } from './claude.js';
import { conflicts, entryFor, isEntryInstalled, listInstalled } from './core.js';
import { apply, loadProfiles, plan, saveProfile } from './profiles.js';
import { available, fetchRemoteCatalog, selfUpdate, updateAllPlugins } from './update.js';
import { VERSION } from './version.js';
import type { Entry } from './types.js';

const VERBS = new Set(['enable', 'disable', 'uninstall', 'update']);
const IDLE_MS = 60_000;

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* user can open the printed URL */ }
}

export async function startGui(open = true): Promise<void> {
  const token = randomBytes(24).toString('hex');
  let busy = 0;
  let lastPing = Date.now();
  let catalog: Entry[] = load();

  const state = async () => {
    const rows = await listInstalled(catalog);
    const ids = new Set(rows.map((r) => r.id));
    const upd = await available();
    return {
      version: VERSION,
      update: upd ? { version: upd.version } : null,
      catalog: catalog.map((e) => ({ ...e, installed: isEntryInstalled(e, ids) })),
      installed: rows.map(({ entry, ...r }) => r),
      totalTokens: rows.filter((r) => r.enabled).reduce((a, r) => a + (r.tokens ?? 0), 0),
      conflicts: conflicts(rows),
      profiles: loadProfiles(),
    };
  };

  const route = async (method: string, path: string, req: IncomingMessage): Promise<unknown> => {
    if (path === 'ping') { lastPing = Date.now(); return { ok: true }; }
    if (path === 'state') return state();
    if (method !== 'POST') throw new HttpError(405, 'POST required');
    const body = await readJson(req);

    if (path === 'install') {
      const e = catalog.find((x) => x.id === body.id);
      if (!e) throw new HttpError(404, 'Not in catalog');
      const r = install(e);
      if (!r.ok) throw new HttpError(500, r.out.slice(0, 300));
      return { ok: true };
    }
    if (path === 'plugin') {
      if (!VERBS.has(body.verb)) throw new HttpError(400, 'Bad verb');
      if (!installedPlugins().some((p) => p.id === body.id)) throw new HttpError(404, 'Not installed');
      const r = pluginCmd(body.verb, body.id);
      if (!r.ok) throw new HttpError(500, r.out.slice(0, 300));
      return { ok: true, out: r.out.split('\n').pop() };
    }
    if (path === 'update-all') return { results: updateAllPlugins() };
    if (path === 'selfupdate') {
      const r = await available(true);
      if (!r) throw new HttpError(400, 'Already up to date');
      await selfUpdate(r);
      return { ok: true };
    }
    if (path === 'refresh') {
      let list = await fetchRemoteCatalog();
      let source = 'release';
      if (!list) {
        const res = await scrape();
        save(res);
        list = res.entries;
        source = 'github scrape';
      }
      catalog = list;
      return { count: list.length, source };
    }
    if (path === 'profile-plan' || path === 'profile-apply') {
      const prof = loadProfiles().find((p) => p.name === body.name);
      if (!prof) throw new HttpError(404, 'Unknown profile');
      const steps = plan(prof, catalog, await listInstalled(catalog));
      return path === 'profile-plan' ? { steps } : { results: apply(steps, catalog) };
    }
    if (path === 'profile-save') {
      const name = String(body.name ?? '').trim();
      if (!/^[\w .-]{1,40}$/.test(name)) throw new HttpError(400, 'Name: letters, digits, space, . _ - (max 40)');
      const rows = await listInstalled(catalog);
      const repos = rows.filter((r) => r.enabled && r.entry?.tokenSaver).map((r) => r.entry!.id);
      saveProfile(name, 'Saved from current setup', [...new Set(repos)]);
      return { ok: true };
    }
    throw new HttpError(404, 'Unknown route');
  };

  const server = createServer(async (req, res) => {
    try {
      const addr = server.address() as { port: number };
      // Block DNS rebinding and cross-site calls: only our exact origin may talk to us.
      if (req.headers.host !== `127.0.0.1:${addr.port}`) throw new HttpError(403, 'Bad host');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const given = Buffer.from(String(req.headers['x-tg-token'] ?? url.searchParams.get('t') ?? ''));
      const want = Buffer.from(token);
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(403, 'Bad token');
      if (url.pathname === '/') return send(res, 200, page, 'text/html');
      if (url.pathname.startsWith('/api/')) {
        busy++;
        try { return send(res, 200, await route(req.method ?? 'GET', url.pathname.slice(5), req)); } finally { busy--; }
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      send(res, status, { error: (e as Error).message });
    }
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  console.log(`Tailgate is running at ${url}\nClose the browser tab (or press Ctrl+C) to stop.`);
  if (open) openBrowser(url);

  // Exit once the tab is gone, so double-click users are not left with a zombie window.
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (busy === 0 && Date.now() - lastPing > IDLE_MS) { clearInterval(t); server.close(); resolve(); }
    }, 5000);
  });
}
