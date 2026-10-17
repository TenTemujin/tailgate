export type Kind = 'marketplace' | 'skill' | 'unknown';
export type Category = 'token-saver' | 'memory' | 'context' | 'workflow' | 'other';
export type Tier = 'S' | 'A' | 'B';

export interface Entry {
  id: string; // owner/repo
  description: string;
  stars: number;
  pushedAt: string;
  license: string | null;
  kind: Kind;
  category: Category;
  tokenSaver: boolean;
  score: number; // 0-100 quality score
  tier: Tier;
  curated: boolean;
  marketplaceName?: string;
  plugins?: string[];
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
  rules: Record<string, number | string>;
  top: { id: string; score: number; tier: Tier; category: Category }[];
}
