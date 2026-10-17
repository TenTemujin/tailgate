import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compact, parseJobs, summarize } from '../src/stats.js';
import { aggregate, impactFor, type SessionStat } from '../src/impact.js';

const NOW = 1_800_000_000;
const start = (id: string, ts: number) => JSON.stringify({ ev: 'start', id, ts, model: 'gemini', mode: 'plan', in_bytes: 100 });
const end = (id: string, ts: number, o: any = {}) =>
  JSON.stringify({ ev: 'end', id, ts, model: 'gemini', dur_s: 10, out_bytes: 4000, status: 'ok', in_tokens: 1000, out_tokens: 200, src_bytes: 100000, ...o });

// ---- delegate log ---------------------------------------------------------------------------------

test('a start without an end is a running job', () => {
  const jobs = parseJobs([start('a', NOW - 30)].join('\n'), NOW);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'running');
});

test('a start with no end after 30 minutes is stale, not running', () => {
  assert.equal(parseJobs(start('a', NOW - 3600), NOW)[0].status, 'stale');
});

test('finished job: saved = (source bytes - answer bytes) / 4', () => {
  const [j] = parseJobs([start('a', NOW - 20), end('a', NOW - 10)].join('\n'), NOW);
  assert.equal(j.status, 'ok');
  assert.equal(j.claudeSaved, Math.round((100000 - 4000) / 4));
  assert.equal(j.geminiIn + j.geminiOut, 1200);
});

test('failed jobs save nothing', () => {
  const [j] = parseJobs([start('a', NOW - 20), end('a', NOW - 10, { status: 'error' })].join('\n'), NOW);
  assert.equal(j.claudeSaved, 0);
});

test('answer larger than the source never yields negative savings', () => {
  const [j] = parseJobs(end('a', NOW, { src_bytes: 100, out_bytes: 9000 }), NOW);
  assert.equal(j.claudeSaved, 0);
});

test('corrupt and blank lines are skipped (log may be mid-write)', () => {
  const text = ['', '{not json', start('a', NOW - 5), '{"ev":"end"', end('a', NOW - 1)].join('\n');
  assert.equal(parseJobs(text, NOW).length, 1);
});

test('totals exclude running and stale jobs', () => {
  const jobs = parseJobs([start('r', NOW - 5), start('s', NOW - 7200), start('d', NOW - 50), end('d', NOW - 40), end('e', NOW - 30, { status: 'error' })].join('\n'), NOW);
  const t = summarize(jobs);
  assert.equal(t.jobs, 2);
  assert.equal(t.ok, 1);
  assert.equal(t.failed, 1);
});

test('compact number formatting', () => {
  assert.deepEqual([999, 1500, 12345, 2_500_000].map(compact), ['999', '1.5k', '12k', '2.5M']);
});

// ---- impact ---------------------------------------------------------------------------------------

const msg = (sid: string, t: number, fresh: number, extra: any = {}) =>
  JSON.stringify({ type: 'assistant', sessionId: sid, timestamp: new Date(t).toISOString(), message: { usage: { input_tokens: fresh, cache_creation_input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 999999 } }, ...extra });

test('aggregate counts fresh tokens only (cache reads would swamp the signal)', () => {
  const m = aggregate([msg('s1', 1000, 100), msg('s1', 2000, 300)]);
  assert.equal(m.get('s1')!.tokens, 400);
  assert.equal(m.get('s1')!.turns, 2);
});

test('aggregate skips sidechain agents, non-assistant lines and garbage', () => {
  const m = aggregate([msg('s1', 1000, 100, { isSidechain: true }), JSON.stringify({ type: 'user', usage: 1 }), '{"usage":', msg('s1', 2000, 50)]);
  assert.equal(m.get('s1')!.tokens, 50);
});

const sessions = (n: number, at: number, perTurn: number): SessionStat[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${at}-${i}`, start: at + i, turns: 10, tokens: perTurn * 10 }));

test('impact reports a drop with enough samples as ok confidence', () => {
  const install = 1_000_000_000_000;
  const s = [...sessions(10, install - 86400e3, 1000), ...sessions(10, install + 86400e3, 600)];
  const r = impactFor(s, install);
  assert.equal(r.deltaPct, -40);
  assert.equal(r.confidence, 'ok');
});

test('impact with few sessions is flagged low confidence, and with none it says so', () => {
  const install = 1_000_000_000_000;
  assert.equal(impactFor([...sessions(3, install - 1e6, 1000), ...sessions(2, install + 1e6, 500)], install).confidence, 'low');
  assert.equal(impactFor([], install).confidence, 'none');
});

test('sessions older than the 45-day window are ignored', () => {
  const install = 1_000_000_000_000;
  const r = impactFor([...sessions(10, install - 60 * 864e5, 5000), ...sessions(10, install + 1e6, 100)], install);
  assert.equal(r.before.n, 0);
  assert.equal(r.confidence, 'none');
});
