import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

// Boots the real GUI server and calls every route the page uses. This is what catches "the page asks with GET but
// the route only accepts POST", which unit tests cannot see.
let child: ChildProcess;
let base = '';
let token = '';

before(async () => {
  const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  child = spawn(process.execPath, [tsx, 'src/cli.ts', 'gui', '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start in 30s')), 30_000);
    child.stdout!.on('data', (d) => {
      const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/);
      if (m) { clearTimeout(t); resolve(m[0]); }
    });
    child.on('exit', (c) => reject(new Error(`server exited early (${c})`)));
  });
  const u = new URL(url);
  base = u.origin;
  token = u.searchParams.get('t')!;
});

after(() => { child?.kill(); });

const get = (path: string, withToken = true) => fetch(base + path, { headers: withToken ? { 'x-tg-token': token } : {} });

test('the page loads with the token and is refused without it', async () => {
  const ok = await fetch(`${base}/?t=${token}`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /tailgate/);
  assert.equal((await fetch(`${base}/`)).status, 403);
  assert.equal((await get('/api/state', false)).status, 403);
});

test('a wrong host header is refused (DNS rebinding)', async () => {
  // fetch() will not forge Host, so use a raw request.
  const status = await new Promise<number>((resolve, reject) => {
    const u = new URL(base);
    const req = httpRequest({ host: u.hostname, port: u.port, path: `/?t=${token}`, headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('read-only routes the page polls work with GET', async () => {
  for (const route of ['ping', 'state', 'savings', 'delegate']) {
    const r = await get(`/api/${route}`);
    assert.equal(r.status, 200, `${route} returned ${r.status}`);
    await r.json();
  }
});

test('state has everything the page renders', async () => {
  const s: any = await (await get('/api/state')).json();
  for (const k of ['version', 'catalog', 'installed', 'totalTokens', 'conflicts', 'profiles']) assert.ok(k in s, k);
  assert.ok(s.catalog.some((e: any) => e.kind === 'tool'), 'toolbox entries present');
  assert.ok(s.catalog.every((e: any) => typeof e.installed === 'boolean'));
  assert.equal(s.profiles.length >= 3, true);
});

test('savings and delegate have the shapes the page reads', async () => {
  const sv: any = await (await get('/api/savings')).json();
  assert.equal(typeof sv.total, 'number');
  assert.equal(typeof sv.delegate.active, 'boolean');
  const d: any = await (await get('/api/delegate')).json();
  for (const k of ['installed', 'running', 'recent', 'totals']) assert.ok(k in d, k);
});

test('write routes need POST and validate input', async () => {
  assert.equal((await get('/api/plugin')).status, 405);
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'x-tg-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/plugin', { id: 'caveman@caveman', verb: 'rm' })).status, 400, 'unknown verb');
  assert.equal((await post('/api/plugin', { id: 'x & calc', verb: 'enable' })).status, 404, 'not an installed plugin');
  assert.equal((await post('/api/install', { id: 'not a repo' })).status, 404);
  assert.equal((await post('/api/profile-plan', { name: 'nope' })).status, 404);
  assert.equal((await post('/api/profile-save', { name: '../../etc' })).status, 400);
  assert.equal((await post('/api/profile-plan', { name: 'minimal', dir: '/definitely/not/here' })).status, 400, 'missing project folder');
});
