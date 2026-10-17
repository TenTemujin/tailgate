import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Row } from './core.js';
import type { Profile } from './profiles.js';

// Per-project profiles use Claude Code's own project settings: `enabledPlugins` in .claude/settings.local.json
// (personal, normally git-ignored) or .claude/settings.json (shared with the team). The global install is untouched.

export type Scope = 'local' | 'shared';
export const settingsPath = (dir: string, scope: Scope = 'local') =>
  join(resolve(dir), '.claude', scope === 'shared' ? 'settings.json' : 'settings.local.json');

export interface Change { plugin: string; from: boolean | undefined; to: boolean | undefined }

function readSettings(p: string): Record<string, any> {
  if (!existsSync(p)) return {};
  const j = JSON.parse(readFileSync(p, 'utf8'));
  if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error(`${p} is not a JSON object`);
  return j;
}

// Pure: what would change. Only token-saver plugins known to the catalog are managed, other keys are never touched.
export function planProject(profile: Profile, rows: Row[], current: Record<string, boolean>): Change[] {
  const changes: Change[] = [];
  for (const r of rows) {
    if (!r.entry?.tokenSaver) continue;
    const want = profile.repos.includes(r.entry.id);
    if (current[r.id] !== want) changes.push({ plugin: r.id, from: current[r.id], to: want });
  }
  return changes;
}

export function clearPlan(rows: Row[], current: Record<string, boolean>): Change[] {
  return rows.filter((r) => r.entry?.tokenSaver && r.id in current).map((r) => ({ plugin: r.id, from: current[r.id], to: undefined }));
}

export function currentEnabled(dir: string, scope: Scope = 'local'): Record<string, boolean> {
  return readSettings(settingsPath(dir, scope)).enabledPlugins ?? {};
}

export function applyProject(dir: string, changes: Change[], scope: Scope = 'local'): string {
  const p = settingsPath(dir, scope);
  const s = readSettings(p);
  const map: Record<string, boolean> = { ...(s.enabledPlugins ?? {}) };
  for (const c of changes) { if (c.to === undefined) delete map[c.plugin]; else map[c.plugin] = c.to; }
  if (Object.keys(map).length) s.enabledPlugins = map; else delete s.enabledPlugins;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  return p;
}
