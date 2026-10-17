import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// Observational before/after comparison from Claude Code's own session transcripts. It is NOT causal: the task mix
// changes between periods. Tailgate shows it with its sample sizes so a thin result is never presented as proof.

export interface SessionStat { id: string; start: number; turns: number; tokens: number }

const PROJECTS = join(homedir(), '.claude', 'projects');

// Pure: folds transcript lines into per-session totals. Counts only main-thread assistant turns with usage data.
export function aggregate(lines: Iterable<string>, into = new Map<string, SessionStat>()): Map<string, SessionStat> {
  for (const line of lines) {
    if (!line.includes('"usage"') || line.includes('"isSidechain":true')) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const u = e?.message?.usage;
    if (e?.type !== 'assistant' || !u || !e.sessionId) continue;
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    // New tokens only. cache_read is the re-sent context and would swamp the signal.
    const fresh = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    const s = into.get(e.sessionId) ?? { id: e.sessionId, start: t, turns: 0, tokens: 0 };
    s.start = Math.min(s.start, t);
    s.turns++;
    s.tokens += fresh;
    into.set(e.sessionId, s);
  }
  return into;
}

export async function scanTranscripts(sinceMs: number): Promise<SessionStat[]> {
  const sessions = new Map<string, SessionStat>();
  if (!existsSync(PROJECTS)) return [];
  for (const proj of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, proj);
    let files: string[];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const p = join(dir, f);
      try { if (statSync(p).mtimeMs < sinceMs) continue; } catch { continue; }
      const rl = createInterface({ input: createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
      const batch: string[] = [];
      for await (const line of rl) {
        if (line.includes('"usage"')) batch.push(line);
        if (batch.length >= 500) { aggregate(batch, sessions); batch.length = 0; }
      }
      aggregate(batch, sessions);
    }
  }
  return [...sessions.values()].filter((s) => s.turns >= 5);
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface Impact {
  before: { n: number; perTurn: number | null };
  after: { n: number; perTurn: number | null };
  deltaPct: number | null; // negative = fewer tokens per turn after install
  confidence: 'none' | 'low' | 'ok';
}

const BEFORE_WINDOW_MS = 45 * 864e5;
const MIN_N = 8;

export function impactFor(sessions: SessionStat[], installedAtMs: number): Impact {
  const per = (s: SessionStat) => s.tokens / s.turns;
  const before = sessions.filter((s) => s.start < installedAtMs && s.start >= installedAtMs - BEFORE_WINDOW_MS).map(per);
  const after = sessions.filter((s) => s.start >= installedAtMs).map(per);
  const [mb, ma] = [median(before), median(after)];
  const deltaPct = mb && ma !== null ? Math.round(((ma - mb) / mb) * 100) : null;
  const confidence = deltaPct === null ? 'none' : before.length >= MIN_N && after.length >= MIN_N ? 'ok' : 'low';
  return { before: { n: before.length, perTurn: mb && Math.round(mb) }, after: { n: after.length, perTurn: ma && Math.round(ma) }, deltaPct, confidence };
}
