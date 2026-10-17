// tool = a CLI, app or MCP server that helps Claude but is not a Claude Code plugin.
export type Kind = 'marketplace' | 'skill' | 'tool' | 'unknown';
export type Category =
  | 'token-saver' | 'memory' | 'context' // cut cost or keep context
  | 'workflow' | 'dev' | 'browser' | 'docs' | 'design' | 'security' | 'data' | 'productivity' | 'other'; // everything else that helps Claude
export type Tier = 'S' | 'A' | 'B';
export type Level = 'clean' | 'notes' | 'risky';

export interface Finding {
  severity: 'info' | 'warn' | 'high';
  rule: string;
  file: string;
  line: number;
  snippet: string;
}

// Result of the static scan. It is a pattern scan of scripts and hook configs, not a human code review.
export interface Audit {
  level: Level;
  at: string;
  files: number;
  counts: { info: number; warn: number; high: number };
  findings: Finding[];
}

export interface Entry {
  id: string; // owner/repo
  description: string;
  stars: number;
  pushedAt: string;
  releasedAt?: string; // latest GitHub release, if any
  license: string | null;
  kind: Kind;
  category: Category;
  tokenSaver: boolean;
  score: number; // 0-100 quality score
  tier: Tier;
  curated: boolean;
  marketplaceName?: string;
  plugins?: string[];
  security?: Audit;
}

export interface Rejection {
  id: string;
  reason: 'archived' | 'fork' | 'low-stars' | 'stale' | 'no-description' | 'not-installable' | 'low-score' | 'off-topic';
  detail?: string;
}

export interface ScrapeReport {
  at: string;
  candidates: number;
  kept: number;
  rejectedByReason: Record<string, number>;
  tiers: Record<Tier, number>;
  security: Record<Level | 'unscanned', number>;
  rules: Record<string, number | string>;
  top: { id: string; score: number; tier: Tier; category: Category }[];
}
