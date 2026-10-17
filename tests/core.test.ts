import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRepoInput, score, tierOf } from '../src/github.js';
import { conflicts, familyOf, type Row } from '../src/core.js';
import { plan, BUILTIN } from '../src/profiles.js';
import { applyProject, clearPlan, currentEnabled, planProject } from '../src/project.js';
import { pickOption, GUIDES } from '../src/guides.js';
import { claude, SAFE_ARG } from '../src/claude.js';
import { assetName, isNewer } from '../src/update.js';
import { installChecked } from '../src/installer.js';
import type { Entry } from '../src/types.js';

const entry = (o: Partial<Entry> & { id: string }): Entry => ({
  description: '', stars: 100, pushedAt: new Date().toISOString(), license: 'MIT', kind: 'marketplace', category: 'token-saver',
  tokenSaver: true, score: 70, tier: 'A', curated: false, marketplaceName: o.id.split('/')[1], plugins: [o.id.split('/')[1]], ...o,
});
const row = (e: Entry, enabled = true, tokens: number | null = 1000): Row => ({
  id: `${e.plugins![0]}@${e.marketplaceName}`, version: '1', enabled, scope: 'user', tokens, entry: e,
});

// ---- scoring --------------------------------------------------------------------------------------

const repoMeta = (o: any = {}) => ({ name: 'x', description: 'reduce tokens', topics: [], stargazers_count: 10, pushed_at: new Date().toISOString(), license: { spdx_id: 'MIT' }, open_issues_count: 0, ...o });

test('curated entries get a floor so a small good repo is not buried', () => {
  const small = score({ r: repoMeta({ stargazers_count: 3 }), kind: 'marketplace', curated: true });
  assert.ok(small >= 75, `got ${small}`);
  assert.equal(tierOf(small), 'A');
});

test('score is bounded and monotonic in popularity', () => {
  const lo = score({ r: repoMeta({ stargazers_count: 60 }), kind: 'marketplace', curated: false });
  const hi = score({ r: repoMeta({ stargazers_count: 100000 }), kind: 'marketplace', curated: false });
  assert.ok(hi > lo && hi <= 100 && lo >= 0);
});

test('recent releases and healthy issues raise the score', () => {
  const base = { r: repoMeta(), kind: 'marketplace' as const, curated: false };
  const withRel = score({ ...base, releasedAt: new Date().toISOString(), nPlugins: 1 });
  const without = score({ ...base, nPlugins: 1 });
  assert.ok(withRel > without);
  const messy = score({ ...base, r: repoMeta({ open_issues_count: 500 }) });
  assert.ok(messy < score(base));
});

test('tier thresholds', () => {
  assert.deepEqual([90, 80, 79, 65, 64, 10].map(tierOf), ['S', 'S', 'A', 'A', 'B', 'B']);
});

test('parseRepoInput accepts the usual shapes and rejects junk', () => {
  for (const s of ['owner/repo', 'github.com/owner/repo', 'https://github.com/owner/repo', 'https://github.com/owner/repo.git', 'https://github.com/owner/repo/tree/main/x'])
    assert.equal(parseRepoInput(s), 'owner/repo', s);
  for (const s of ['', 'justaword', 'https://example.com', 'a b/c']) assert.equal(parseRepoInput(s), null, s);
});

// ---- conflicts ------------------------------------------------------------------------------------

test('two memory plugins conflict, but unrelated token savers do not', () => {
  const mem1 = entry({ id: 'a/claude-mem' }), mem2 = entry({ id: 'b/memsearch' }), other = entry({ id: 'c/context-mode' });
  assert.equal(familyOf(mem1), 'memory');
  assert.equal(conflicts([row(mem1), row(mem2)]).length, 1);
  assert.equal(conflicts([row(mem1), row(other)]).length, 0);
  assert.equal(conflicts([row(mem1), row(mem2, false)]).length, 0, 'disabled plugins do not conflict');
});

test('descriptions mentioning memory do not cause false alarms', () => {
  const e = entry({ id: 'x/planning-with-files', description: 'persistent memory for agents' });
  assert.equal(familyOf(e), null);
});

// ---- profiles (global) ----------------------------------------------------------------------------

test('profile plan installs missing, enables disabled, disables other token savers only', () => {
  const caveman = entry({ id: 'JuliusBrussee/caveman' }), mem = entry({ id: 'thedotmack/claude-mem' });
  const unrelated = entry({ id: 'x/design-tool', tokenSaver: false });
  const minimal = BUILTIN.find((p) => p.name === 'minimal')!;
  const steps = plan(minimal, [caveman, mem, unrelated], [row(mem), row(unrelated)]);
  assert.deepEqual(steps.map((s) => `${s.action}:${s.repo}`).sort(), ['disable:thedotmack/claude-mem', 'install:JuliusBrussee/caveman']);
  assert.ok(!steps.some((s) => s.repo === 'x/design-tool'), 'never touches non-token-saver plugins');
});

// ---- profiles (per project) -----------------------------------------------------------------------

test('per-project profile preserves unrelated settings and is reversible', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-proj-'));
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ model: 'opus', enabledPlugins: { 'mine@x': true } }));
  const cave = entry({ id: 'a/caveman' }), mem = entry({ id: 'b/claude-mem' });
  const rows = [row(cave), row(mem)];
  const prof = { name: 't', description: '', repos: ['a/caveman'] };

  const changes = planProject(prof, rows, currentEnabled(dir));
  applyProject(dir, changes);
  const after = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(after.model, 'opus');
  assert.equal(after.enabledPlugins['mine@x'], true, 'foreign keys survive');
  assert.equal(after.enabledPlugins['caveman@caveman'], true);
  assert.equal(after.enabledPlugins['claude-mem@claude-mem'], false);
  assert.equal(planProject(prof, rows, currentEnabled(dir)).length, 0, 'idempotent');

  applyProject(dir, clearPlan(rows, currentEnabled(dir)));
  const cleared = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(cleared.enabledPlugins, { 'mine@x': true });
  rmSync(dir, { recursive: true, force: true });
});

// ---- guided installs ------------------------------------------------------------------------------

test('guide picks the first available installer for the platform', () => {
  const rtk = GUIDES.find((g) => g.repo === 'rtk-ai/rtk')!;
  assert.equal(pickOption(rtk.options, 'win32', (c) => c === 'winget')?.label, 'winget');
  assert.equal(pickOption(rtk.options, 'darwin', (c) => c === 'brew')?.label, 'Homebrew');
  assert.equal(pickOption(rtk.options, 'win32', (c) => c === 'brew'), null, 'brew is not offered on Windows');
  const gfy = GUIDES.find((g) => g.repo === 'Graphify-Labs/graphify')!;
  assert.equal(pickOption(gfy.options, 'linux', (c) => c === 'pipx')?.label, 'pipx');
  assert.equal(pickOption(gfy.options, 'linux', () => false), null);
});

test('guide commands are static argument arrays (no shell strings)', () => {
  for (const g of GUIDES) for (const o of g.options) for (const s of o.steps) {
    assert.ok(Array.isArray(s.args));
    assert.ok([s.cmd, ...s.args].every((x) => /^[\w.@:/-]+$/.test(x)), `${s.cmd} ${s.args.join(' ')}`);
  }
});

// ---- safety ---------------------------------------------------------------------------------------

test('shell metacharacters are refused before reaching the shell', () => {
  for (const bad of ['x & calc', 'a|b', 'a;b', '$(id)', 'a`b`', 'a"b', 'a>b', 'a%PATH%', 'a^b', 'a!b'])
    assert.equal(SAFE_ARG.test(bad), false, bad);
  for (const ok of ['caveman@caveman', 'plugin', 'C:\\My Projects\\x', 'owner/repo']) assert.equal(SAFE_ARG.test(ok), true, ok);
  assert.equal(claude(['plugin', 'enable', 'x & calc']).ok, false);
});

test('a high-risk scan blocks install unless forced, and never reaches the claude CLI', () => {
  const risky = entry({
    id: 'evil/plugin',
    security: { level: 'risky', at: '', files: 1, counts: { info: 0, warn: 0, high: 1 }, findings: [{ severity: 'high', rule: 'curl-pipe-shell', file: 'hooks/a.sh', line: 1, snippet: 'curl x | bash' }] },
  });
  const r = installChecked(risky);
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.match(r.out, /curl-pipe-shell/);
});

test('manual-only repos without a guide explain how to install', () => {
  const r = installChecked(entry({ id: 'nobody/some-cli', kind: 'unknown' }));
  assert.equal(r.ok, false);
  assert.match(r.out, /Install manually/);
});

// ---- updates --------------------------------------------------------------------------------------

test('version comparison', () => {
  assert.equal(isNewer('0.4.0', '0.3.1'), true);
  assert.equal(isNewer('v1.0.0', '0.9.9'), true);
  assert.equal(isNewer('0.3.1', '0.3.1'), false);
  assert.equal(isNewer('0.3.0', '0.3.1'), false);
  assert.equal(isNewer('0.10.0', '0.9.0'), true, 'numeric, not lexical');
});

test('release asset name matches what CI publishes', () => {
  assert.match(assetName(), /^tailgate-(windows|linux|macos)-(x64|arm64)(\.exe)?$/);
});
