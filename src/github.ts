import { execFileSync } from 'node:child_process';
import type { Category, Entry, Kind, Rejection, ScrapeReport, Tier } from './types.js';
import { SEED } from './seed.js';
import { auditRepo } from './audit.js';

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
  curatedFloor: 75,
};

const CATEGORY_RE: [Category, RegExp][] = [
  // Narrow on purpose: words like cost, reduce or optimize also describe marketing and SEO tools.
  // "tokens" alone is ambiguous (design tokens, auth tokens), so it needs a saving or cost word next to it.
  ['token-saver', /(save|saves|saving|reduce|reduces|cut|cuts|fewer|less|many|few|burn)\s+(llm\s+)?tokens?\b|\btokens?\s+(saver|saving|usage|cost|budget|reduction|optimi[sz]|efficien|consumption)|compress|terse|concise|\bslim|context[- ](window|budget|saving)|minif|prune|delegat/i],
  ['memory', /memory|recall|persist|remember/i],
  ['context', /context|graph|index|compact|summar/i],
  ['browser', /browser|playwright|puppeteer|scrap|crawl|web ?(search|fetch)/i],
  ['security', /security|pentest|vulnerab|audit|owasp|threat/i],
  ['design', /design|\bui\b|\bux\b|figma|frontend|css|tailwind/i],
  ['docs', /docs?\b|documentation|pdf|powerpoint|pptx|docx|spreadsheet|markdown|writing/i],
  ['data', /\bdata\b|analytics|notebook|\bsql\b|database|science|dataset/i],
  ['dev', /test(ing)?|lint|review|debug|refactor|\bgit\b|\bci\b|deploy|docker|kubernetes|devops|code quality/i],
  ['productivity', /task|notes?\b|obsidian|calendar|email|slack|notion|jira|linear|project management/i],
  ['workflow', /workflow|agent|planning|harness|spec|orchestrat|skills?\b/i],
];
const HITS_RE = /token|context|compress|terse|concise|memory|cache|slim|optimi[sz]|reduce|cost|prune|compact|delegat/gi;

function token(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; }
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

const daysSince = (iso?: string) => (iso ? (Date.now() - Date.parse(iso)) / 864e5 : Infinity);

export interface ScoreInput { r: any; kind: Kind; curated: boolean; releasedAt?: string; nPlugins?: number }

// Quality score 0-100: popularity 28, relevance 22, push freshness 12, release recency 8, installable 10,
// valid manifest 5, license 5, issue health 5. Curated entries get +10 and a floor, so a good small repo is not buried.
export function score({ r, kind, curated, releasedAt, nPlugins = 0 }: ScoreInput): number {
  const pop = Math.min(28, (Math.log10(r.stargazers_count + 1) / 5.5) * 28);
  // Relevance: token-saving vocabulary scores high, but any recognizable "helps Claude" category earns a base score,
  // so a good browser or testing tool is not ranked below a mediocre token tool.
  const tokenRel = Math.min(22, (textOf(r).match(HITS_RE)?.length ?? 0) * 7);
  const rel = Math.max(tokenRel, categorize(r) === 'other' ? 0 : 12);
  const d = daysSince(r.pushed_at);
  const fresh = d < 30 ? 12 : d < 90 ? 9 : d < 180 ? 5 : d < 365 ? 2 : 0;
  const rd = daysSince(releasedAt);
  const release = rd < 90 ? 8 : rd < 180 ? 6 : rd < 365 ? 3 : 0;
  const inst = kind === 'marketplace' ? 10 : kind === 'skill' ? 7 : 0;
  const manifest = nPlugins > 0 || kind === 'skill' ? 5 : 0;
  const ratio = (r.open_issues_count ?? 0) / (r.stargazers_count + 1);
  const issues = ratio < 0.02 ? 5 : ratio < 0.05 ? 3 : ratio < 0.15 ? 1 : 0;
  const raw = pop + rel + fresh + release + inst + manifest + (r.license ? 5 : 0) + issues;
  return Math.min(100, Math.round(curated ? Math.max(raw + 10, RULES.curatedFloor) : raw));
}

export const tierOf = (s: number): Tier => (s >= RULES.tierS ? 'S' : s >= RULES.tierA ? 'A' : 'B');

function prefilter(r: any): Rejection['reason'] | null {
  if (r.archived || r.disabled) return 'archived';
  if (r.fork) return 'fork';
  if (!r.description) return 'no-description';
  if (r.stargazers_count < RULES.minStars) return 'low-stars';
  if (daysSince(r.pushed_at) > RULES.maxStaleDays) return 'stale';
  return null;
}

async function latestRelease(repo: string): Promise<string | undefined> {
  try { return (await gh(`/repos/${repo}/releases/latest`))?.published_at ?? undefined; } catch { return undefined; }
}

const TOKEN_CATS: Category[] = ['token-saver', 'memory', 'context'];

async function build(r: any, curated: boolean): Promise<Entry | null> {
  const d = await detect(r.full_name);
  if (d.kind === 'unknown' && !curated) return null;
  const releasedAt = await latestRelease(r.full_name);
  const category = categorize(r);
  const s = score({ r, kind: d.kind, curated, releasedAt, nPlugins: d.plugins?.length });
  return {
    id: r.full_name, description: r.description ?? '', stars: r.stargazers_count, pushedAt: r.pushed_at, releasedAt,
    license: r.license?.spdx_id ?? null, kind: d.kind, category, tokenSaver: TOKEN_CATS.includes(category),
    curated, marketplaceName: d.name, plugins: d.plugins, score: s, tier: tierOf(s),
  };
}

// Inspect any public repo on demand (used by `tailgate install github.com/owner/repo`).
export async function inspectRepo(fullName: string): Promise<Entry | null> {
  const r = await gh(`/repos/${fullName}`);
  return r ? build(r, SEED.includes(r.full_name)) : null;
}

// Accepts owner/repo, github.com/owner/repo, https://github.com/owner/repo(.git)(/tree/...) and returns owner/repo.
export function parseRepoInput(input: string): string | null {
  const m = input.trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (!m || /^(https?|www)$/i.test(m[1])) return null;
  return `${m[1]}/${m[2]}`;
}

export interface ScrapeResult { entries: Entry[]; rejected: Rejection[]; report: ScrapeReport }
export interface ScrapeOptions { audit?: boolean; previous?: Entry[] }

export async function scrape(onProgress: (m: string) => void = () => {}, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
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
    // GitHub redirects renamed repos, so match the seed on either name.
    const curated = SEED.includes(r.full_name);
    const why = curated ? null : prefilter(r);
    if (why) { rejected.push({ id: r.full_name, reason: why }); continue; }
    onProgress(`inspect ${r.full_name}`);
    const e = await build(r, curated);
    if (!e) { rejected.push({ id: r.full_name, reason: 'not-installable', detail: 'no marketplace.json or SKILL.md at root' }); continue; }
    if (!curated && e.score < RULES.minScore) { rejected.push({ id: r.full_name, reason: 'low-score', detail: `score ${e.score}` }); continue; }
    kept.push(e);
  }
  // Token savers first, then by score.
  kept.sort((a, b) => Number(b.tokenSaver) - Number(a.tokenSaver) || b.score - a.score);

  // Security scan: fresh when asked (CI), otherwise carry over the previous result for the same repo.
  const prev = new Map((opts.previous ?? []).map((e) => [e.id, e.security]));
  for (const e of kept) {
    if (opts.audit && e.kind !== 'unknown') {
      onProgress(`audit ${e.id}`);
      e.security = auditRepo(e.id) ?? prev.get(e.id);
    } else if (prev.get(e.id) && prev.get(e.id)!.level !== 'risky') {
      e.security = prev.get(e.id);
    } else if (e.kind !== 'unknown') {
      // Anything previously flagged risky is rescanned: the rules improve, and a stale block is worse than a slow run.
      onProgress(`re-audit ${e.id}`);
      e.security = auditRepo(e.id) ?? prev.get(e.id);
    }
  }

  const byReason: Record<string, number> = {};
  rejected.forEach((x) => (byReason[x.reason] = (byReason[x.reason] ?? 0) + 1));
  const tiers: Record<Tier, number> = { S: 0, A: 0, B: 0 };
  kept.forEach((e) => tiers[e.tier]++);
  const sec = { clean: 0, notes: 0, risky: 0, unscanned: 0 };
  kept.forEach((e) => sec[e.security?.level ?? 'unscanned']++);
  const report: ScrapeReport = {
    at: new Date().toISOString(), candidates: repos.size, kept: kept.length, rejectedByReason: byReason, tiers, security: sec,
    rules: { ...RULES, scoring: 'pop28+relevance22+fresh12+release8+install10+manifest5+license5+issues5; curated +10 and floor 75' },
    top: kept.slice(0, 15).map((e) => ({ id: e.id, score: e.score, tier: e.tier, category: e.category })),
  };
  return { entries: kept, rejected, report };
}
