import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---- agy-delegate: Claude hands bulk work to Gemini (agy). Its wrapper logs every call ----------------

export const DELEGATE_LOG = process.env.AGY_DELEGATE_LOG ?? join(homedir(), '.agy-delegate', 'usage.jsonl');
const BYTES_PER_TOKEN = 4; // rough heuristic, the same one the delegate uses for sizing
const STALE_S = 30 * 60; // a start with no end after 30 min is a crashed run, not a live one

export interface Job {
  id: string;
  model: string;
  startedAt: number; // unix seconds
  durS: number | null;
  status: 'running' | 'ok' | 'error' | string;
  geminiIn: number;
  geminiOut: number;
  srcBytes: number;
  outBytes: number;
  claudeSaved: number; // estimated tokens Claude did not have to read
}

export interface DelegateStats {
  installed: boolean;
  logFound: boolean;
  running: Job[];
  agyProcesses: number;
  recent: Job[];
  totals: { jobs: number; ok: number; failed: number; geminiTokens: number; claudeSaved: number };
}

// Pure: turns the JSONL text into jobs. Tolerates blank and corrupt lines (the log is append-only and may be mid-write).
export function parseJobs(text: string, nowS = Math.floor(Date.now() / 1000)): Job[] {
  const jobs = new Map<string, Job>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e.id !== 'string') continue;
    if (e.ev === 'start') {
      jobs.set(e.id, { id: e.id, model: String(e.model ?? '?'), startedAt: Number(e.ts) || 0, durS: null, status: 'running', geminiIn: 0, geminiOut: 0, srcBytes: 0, outBytes: 0, claudeSaved: 0 });
    } else if (e.ev === 'end') {
      const j = jobs.get(e.id) ?? { id: e.id, model: String(e.model ?? '?'), startedAt: (Number(e.ts) || 0) - (Number(e.dur_s) || 0), durS: null, status: 'ok', geminiIn: 0, geminiOut: 0, srcBytes: 0, outBytes: 0, claudeSaved: 0 };
      j.durS = Number(e.dur_s) || 0;
      j.status = String(e.status ?? 'ok');
      j.geminiIn = Number(e.in_tokens) || 0;
      j.geminiOut = Number(e.out_tokens) || 0;
      j.srcBytes = Number(e.src_bytes) || 0;
      j.outBytes = Number(e.out_bytes) || 0;
      // Claude would have read the source itself. It received only the answer. Failed runs saved nothing.
      j.claudeSaved = j.status === 'ok' ? Math.max(0, Math.round((j.srcBytes - j.outBytes) / BYTES_PER_TOKEN)) : 0;
      jobs.set(e.id, j);
    }
  }
  // A start that never ended and is older than STALE_S is dead, not running.
  for (const j of jobs.values()) if (j.status === 'running' && nowS - j.startedAt > STALE_S) j.status = 'stale';
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function summarize(jobs: Job[]): DelegateStats['totals'] {
  const done = jobs.filter((j) => j.status !== 'running' && j.status !== 'stale');
  return {
    jobs: done.length,
    ok: done.filter((j) => j.status === 'ok').length,
    failed: done.filter((j) => j.status !== 'ok').length,
    geminiTokens: done.reduce((a, j) => a + j.geminiIn + j.geminiOut, 0),
    claudeSaved: done.reduce((a, j) => a + j.claudeSaved, 0),
  };
}

function countAgyProcesses(): number {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq agy.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000 });
      return (r.stdout ?? '').split('\n').filter((l) => /agy\.exe/i.test(l)).length;
    }
    const r = spawnSync('pgrep', ['-fc', 'agy'], { encoding: 'utf8', timeout: 5000 });
    return parseInt(r.stdout ?? '0', 10) || 0;
  } catch {
    return 0;
  }
}

export function delegateStats(): DelegateStats {
  const logFound = existsSync(DELEGATE_LOG);
  const jobs = logFound ? parseJobs(readFileSync(DELEGATE_LOG, 'utf8')) : [];
  const agyBin = process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'agy', 'bin', 'agy.exe') : '';
  return {
    installed: logFound || (agyBin !== '' && existsSync(agyBin)),
    logFound,
    running: jobs.filter((j) => j.status === 'running'),
    agyProcesses: countAgyProcesses(),
    recent: jobs.filter((j) => j.status !== 'running').slice(0, 12),
    totals: summarize(jobs),
  };
}

// ---- rtk: measures its own savings, so this number is measured, not estimated ------------------------

export function rtkSaved(): number | null {
  try {
    const r = spawnSync('rtk', ['gain', '--format', 'json'], { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32' });
    if (r.status !== 0) return null;
    const n = JSON.parse(r.stdout).summary?.total_saved;
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  }
}

// ---- unified view -----------------------------------------------------------------------------------

export interface Savings {
  at: string;
  rtk: { saved: number | null; basis: 'measured' };
  delegate: { saved: number; jobs: number; geminiTokens: number; active: boolean; running: number; basis: 'estimated' };
  total: number;
}

export function savings(): Savings {
  const d = delegateStats();
  const rtk = rtkSaved();
  const active = d.running.length > 0;
  return {
    at: new Date().toISOString(),
    rtk: { saved: rtk, basis: 'measured' },
    delegate: { saved: d.totals.claudeSaved, jobs: d.totals.jobs, geminiTokens: d.totals.geminiTokens, active, running: d.running.length, basis: 'estimated' },
    total: (rtk ?? 0) + d.totals.claudeSaved,
  };
}

export const compact = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n));
export const fileAgeS = (p: string) => (existsSync(p) ? (Date.now() - statSync(p).mtimeMs) / 1000 : Infinity);
