import { execFileSync } from 'node:child_process';
import type { Category, Entry, Kind, Rejection, ScrapeReport, Tier } from './types.js';
import { SEED } from './seed.js';

const API = 'https://api.github.com';
const TOPICS = ['claude-code-plugin', 'claude-code-skills', 'claude-skills', 'claude-code-marketplace', 'claude-code'];
const QUERIES = ['claude code token savings', 'claude code context compression', 'claude skill reduce tokens', 'claude code token optimizer'];

// Scraper rules. Exposed in the report so a reviewer (human or AI) can audit and tune them.
export const RULES = {
  minStars: 50,
  maxStaleDays: 365,
  minScore: 55,
  tierS: 80,
  tierA: 65,
};

const CATEGORY_RE: [Category, RegExp][] = [
  ['token-saver', /token|compress|terse|concise|slim|optimi[sz]|reduce|cost|budget|brief|prune|minif/i],
  ['memory', /memory|recall|persist|remember/i],
  ['context', /context|graph|index|compact|summar/i],
  ['workflow', /workflow|agent|planning|harness|spec/i],
];
const HITS_RE = /token|context|compress|terse|concise|memory|cache|slim|optimi[sz]|reduce|cost|prune|compact/gi;

function token(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); } catch { return undefined; }
}

async function gh(path: string): Promise<any | null> {
  const t = token();
  const res = await fetch(API + path, {
    headers: { accept: 'application/vnd.github+json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
  });
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit hit. Set GITHUB_TOKEN or run `gh auth login`, then retry.');
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}`);
  return res.json();
}

async function detect(repo: string): Promise<{ kind: Kind; name?: string; plugins?: string[] }> {
  const m = await gh(`/repos/${repo}/contents/.claude-plugin/marketplace.json`);
  if (m?.content) {
    try {
      const j = JSON.parse(Buffer.from(m.content, 'base64').toString());
      return { kind: 'marketplace', name: j.name, plugins: (j.plugins ?? []).map((p: any) => p.name) };
    } catch { /* fallthrough */ }
  }
  if (await gh(`/repos/${repo}/contents/SKILL.md`)) return { kind: 'skill' };
  return { kind: 'unknown' };
}

const textOf = (r: any) => `${r.name} ${r.description ?? ''} ${(r.topics ?? []).join(' ')}`;

export function categorize(r: any): Category {
  const t = textOf(r);
  return CATEGORY_RE.find(([, re]) => re.test(t))?.[0] ?? 'other';
}

// Quality score 0-100, not saturating: popularity 35 + relevance 24 + freshness 15 + install 10 + license 5 + curated 10.
export function score(r: any, kind: Kind, curated: boolean): number {
  const pop = Math.min(35, (Math.log10(r.stargazers_count + 1) / 5.5) * 35);
  const rel = Math.min(24, (textOf(r).match(HITS_RE)?.length ?? 0) * 8);
  const days = (Date.now() - Date.parse(r.pushed_at)) / 864e5;
  const fresh = days < 30 ? 15 : days < 90 ? 11 : days < 180 ? 6 : days < 365 ? 2 : 0;
  const inst = kind === 'marketplace' ? 10 : kind === 'skill' ? 7 : 0;
  return Math.round(pop + rel + fresh + inst + (r.license ? 5 : 0) + (curated ? 10 : 0));
}

export const tierOf = (s: number): Tier => (s >= RULES.tierS ? 'S' : s >= RULES.tierA ? 'A' : 'B');

function prefilter(r: any): Rejection['reason'] | null {
  if (r.archived || r.disabled) return 'archived';
  if (r.fork) return 'fork';
  if (!r.description) return 'no-description';
  if (r.stargazers_count < RULES.minStars) return 'low-stars';
  if ((Date.now() - Date.parse(r.pushed_at)) / 864e5 > RULES.maxStaleDays) return 'stale';
  return null;
}

export interface ScrapeResult { entries: Entry[]; rejected: Rejection[]; report: ScrapeReport }

export async function scrape(onProgress: (m: string) => void = () => {}): Promise<ScrapeResult> {
  const repos = new Map<string, any>();
  const add = (items: any[] = []) => items.forEach((r) => repos.set(r.full_name, r));

  for (const t of TOPICS) {
    onProgress(`topic:${t}`);
    add((await gh(`/search/repositories?q=topic:${t}+stars:>=${RULES.minStars}&sort=stars&per_page=60`))?.items);
  }
  for (const q of QUERIES) {
    onProgress(`search:${q}`);
    add((await gh(`/search/repositories?q=${encodeURIComponent(q)}+stars:>=${RULES.minStars}&sort=stars&per_page=40`))?.items);
  }
  for (const s of SEED) { const r = await gh(`/repos/${s}`); if (r) repos.set(r.full_name, r); }

  const kept: Entry[] = [];
  const rejected: Rejection[] = [];
  for (const r of repos.values()) {
    const curated = SEED.includes(r.full_name);
    const why = curated ? null : prefilter(r);
    if (why) { rejected.push({ id: r.full_name, reason: why }); continue; }
    onProgress(`inspect ${r.full_name}`);
    const d = await detect(r.full_name);
    if (d.kind === 'unknown' && !curated) { rejected.push({ id: r.full_name, reason: 'not-installable', detail: 'no marketplace.json or SKILL.md at root' }); continue; }
    const category = categorize(r);
    const s = score(r, d.kind, curated);
    if (!curated && category === 'other') { rejected.push({ id: r.full_name, reason: 'off-topic', detail: `score ${s}` }); continue; }
    if (!curated && s < RULES.minScore) { rejected.push({ id: r.full_name, reason: 'low-score', detail: `score ${s}` }); continue; }
    kept.push({
      id: r.full_name, description: r.description ?? '', stars: r.stargazers_count, pushedAt: r.pushed_at,
      license: r.license?.spdx_id ?? null, kind: d.kind, category, tokenSaver: ['token-saver', 'memory', 'context'].includes(category),
      curated, marketplaceName: d.name, plugins: d.plugins, score: s, tier: tierOf(s),
    });
  }
  // Token savers first, then by score.
  kept.sort((a, b) => Number(b.tokenSaver) - Number(a.tokenSaver) || b.score - a.score);

  const byReason: Record<string, number> = {};
  rejected.forEach((x) => (byReason[x.reason] = (byReason[x.reason] ?? 0) + 1));
  const tiers: Record<Tier, number> = { S: 0, A: 0, B: 0 };
  kept.forEach((e) => tiers[e.tier]++);
  const report: ScrapeReport = {
    at: new Date().toISOString(), candidates: repos.size, kept: kept.length, rejectedByReason: byReason, tiers,
    rules: { ...RULES, scoring: 'pop35+relevance24+fresh15+install10+license5+curated10' },
    top: kept.slice(0, 15).map((e) => ({ id: e.id, score: e.score, tier: e.tier, category: e.category })),
  };
  return { entries: kept, rejected, report };
}
