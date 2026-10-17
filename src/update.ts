import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG, HOME, ensureHome } from './paths.js';
import { REPO, VERSION } from './version.js';
import { installedPlugins, pluginCmd } from './claude.js';
import { isCompiled } from './setup.js';

const CHECK = join(HOME, 'update-check.json');
const STAMP = join(HOME, 'version');
const CHECK_EVERY_MS = 12 * 3600e3;

export interface Release { version: string; assetUrl: string; token: boolean }

function token(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; }
}

export function assetName(): string {
  const os = { win32: 'windows', linux: 'linux', darwin: 'macos' }[process.platform as string];
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `tailgate-${os}-${arch}${process.platform === 'win32' ? '.exe' : ''}`;
}

const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
export function isNewer(remote: string, local: string): boolean {
  const [a, b] = [parse(remote), parse(local)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

// Housekeeping at startup: drop the previous binary left by an update and a catalog older than this build's snapshot.
export function startup() {
  try { rmSync(`${process.execPath}.old`, { force: true }); } catch { /* still locked */ }
  ensureHome();
  const seen = existsSync(STAMP) ? readFileSync(STAMP, 'utf8').trim() : '';
  if (seen !== VERSION) {
    if (seen) rmSync(CATALOG, { force: true }); // new build ships a fresher snapshot
    writeFileSync(STAMP, VERSION);
  }
}

export async function latest(force = false): Promise<Release | null> {
  try {
    ensureHome();
    if (!force && existsSync(CHECK)) {
      const c = JSON.parse(readFileSync(CHECK, 'utf8'));
      if (Date.now() - c.at < CHECK_EVERY_MS) return c.release;
    }
    const t = token();
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const asset = (j.assets ?? []).find((a: any) => a.name === assetName());
    const release: Release | null = asset
      ? { version: String(j.tag_name).replace(/^v/, ''), assetUrl: t ? asset.url : asset.browser_download_url, token: !!t }
      : null;
    writeFileSync(CHECK, JSON.stringify({ at: Date.now(), release }));
    return release;
  } catch {
    return null; // offline or rate limited: never block the app
  }
}

export async function available(force = false): Promise<Release | null> {
  const r = await latest(force);
  return r && isNewer(r.version, VERSION) ? r : null;
}

// Replace the running binary. Windows locks a running exe but allows renaming it, so swap via .old.
export async function selfUpdate(r: Release): Promise<void> {
  if (!isCompiled()) throw new Error('Self-update only works for the compiled binary. Use git pull when running from source.');
  const t = token();
  const res = await fetch(r.assetUrl, {
    headers: r.token && t ? { authorization: `Bearer ${t}`, accept: 'application/octet-stream' } : {},
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error('Downloaded file looks wrong (too small), aborting.');
  const exe = process.execPath;
  const next = `${exe}.new`;
  writeFileSync(next, buf);
  if (process.platform !== 'win32') chmodSync(next, 0o755);
  rmSync(`${exe}.old`, { force: true });
  renameSync(exe, `${exe}.old`);
  try {
    renameSync(next, exe);
  } catch (e) {
    renameSync(`${exe}.old`, exe); // roll back
    throw e;
  }
}

export interface PluginUpdate { id: string; ok: boolean; out: string; skipped?: boolean }

export function updateAllPlugins(): PluginUpdate[] {
  return installedPlugins().map((p) => {
    const r = pluginCmd('update', p.id);
    const synced = !r.ok && /synced from/i.test(r.out); // account-managed plugins can't be updated locally
    return { id: p.id, ok: r.ok || synced, skipped: synced, out: r.out.split('\n').pop() ?? '' };
  });
}
