import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/updater.js';
import { GUIDES, guideFor, pickOption, runGuide, runUpdate } from '../src/guides.js';
import { TOOLS, withTools } from '../src/tools.js';
import type { Entry } from '../src/types.js';

const scraped = (id: string, kind: Entry['kind'] = 'unknown'): Entry => ({
  id, description: 'x', stars: 500, pushedAt: '2026-01-01T00:00:00Z', license: 'MIT', kind, category: 'dev', tokenSaver: false, score: 60, tier: 'B', curated: false,
});

test('every curated tool has an install guide, and every guide has a manual link', () => {
  for (const t of TOOLS) assert.ok(guideFor(t.id), `${t.id} has no guide`);
  for (const g of GUIDES) assert.match(g.manual, /^https:\/\/(github\.com|docs\.astral\.sh)\//, g.repo);
});

test('tools are added to the catalog once, and never duplicated', () => {
  const merged = withTools([scraped('someone/plugin', 'marketplace')]);
  assert.equal(merged.filter((e) => e.kind === 'tool').length, TOOLS.length);
  assert.equal(withTools(merged).filter((e) => e.id === TOOLS[0].id).length, 1, 'idempotent');
});

test('a scraped repo that is a curated tool becomes a tool but keeps its real stats', () => {
  const merged = withTools([scraped('morluto/rea')]);
  const rea = merged.find((e) => e.id === 'morluto/rea')!;
  assert.equal(rea.kind, 'tool');
  assert.equal(rea.stars, 500);
  assert.equal(merged.filter((e) => e.id === 'morluto/rea').length, 1);
});

test('tool entries are curated, not token savers, and not scanned as code', () => {
  for (const e of withTools([]).filter((x) => x.kind === 'tool')) {
    assert.equal(e.curated, true);
    assert.equal(e.tokenSaver, false);
    assert.equal(e.security, undefined);
  }
});

test('interactive installers refuse to run without a terminal and show the command', () => {
  const rea = guideFor('morluto/rea')!;
  assert.equal(rea.interactive, true);
  // pickOption needs npx; stub by checking the refusal path only when an option exists on this machine.
  const opt = pickOption(rea.options, process.platform, () => true)!;
  assert.ok(opt);
  const r = runGuide({ ...rea, options: [{ ...opt, needs: 'node' }] });
  assert.equal(r.ok, false);
  assert.match(r.out, /run it in a terminal/);
  assert.match(r.out, /rea-agents setup/);
});

test('MCP servers launched with npx @latest report nothing to update instead of failing', () => {
  const r = runUpdate(guideFor('microsoft/playwright-mcp')!);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});

test('update outcome classification', () => {
  assert.equal(classify(true, 'Plugin "x" is already at the latest version (1.0).'), 'latest');
  assert.equal(classify(true, 'No applicable upgrade found.'), 'latest');
  assert.equal(classify(true, 'Updated x from 1.0 to 1.1'), 'updated');
  assert.equal(classify(false, 'network error'), 'failed');
  assert.equal(classify(false, 'No installed package found matching input criteria.'), 'skipped', 'installed another way is not a failure');
});

test('a tool installed outside the package manager is never upgraded through it', () => {
  const ghidra = guideFor('NationalSecurityAgency/ghidra')!;
  for (const o of ghidra.update!) assert.ok(o.owns, `${o.label} update must check ownership first`);
});
