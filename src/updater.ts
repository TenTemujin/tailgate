import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { updateAllPlugins } from './update.js';
import { GUIDES, isToolInstalled, runUpdate } from './guides.js';

export type Group = 'plugin' | 'skill' | 'tool';
export interface UpdateRow { group: Group; id: string; status: 'updated' | 'latest' | 'skipped' | 'failed'; detail: string }

const LATEST = /already (at the )?(latest|up[- ]to[- ]date)|up[- ]to[- ]date|no (update|upgrade)s? (available|found)|nothing to (do|update)|no applicable upgrade/i;

// A package manager that does not know the tool means it was installed another way. That is not a failure.
const NOT_MANAGED = /no installed package found|no package found|is not installed|not found in/i;

export const classify = (ok: boolean, out: string): UpdateRow['status'] =>
  NOT_MANAGED.test(out) ? 'skipped' : !ok ? 'failed' : LATEST.test(out) ? 'latest' : 'updated';

// Skills installed by cloning a repo into ~/.claude/skills are updated with git. Folders that are not clones
// (copied, synced or managed by a plugin) are left alone.
export function updateSkills(root = join(homedir(), '.claude', 'skills')): UpdateRow[] {
  if (!existsSync(root)) return [];
  const rows: UpdateRow[] = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    if (!existsSync(join(dir, '.git'))) { rows.push({ group: 'skill', id: d.name, status: 'skipped', detail: 'not a git clone' }); continue; }
    const head = () => spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() ?? '';
    const before = head();
    const r = spawnSync('git', ['-C', dir, 'pull', '--ff-only', '--quiet'], { encoding: 'utf8', timeout: 120_000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    // --quiet prints nothing either way, so the commit before and after is what tells updated from already current.
    const status = r.status !== 0 ? 'failed' : head() !== before ? 'updated' : 'latest';
    rows.push({ group: 'skill', id: d.name, status, detail: status === 'failed' ? out.slice(0, 120) : status === 'updated' ? `${before.slice(0, 7)} to ${head().slice(0, 7)}` : 'already current' });
  }
  return rows;
}

export function updateTools(): UpdateRow[] {
  return GUIDES.filter((g) => g.detect && isToolInstalled(g)).map((g) => {
    const r = runUpdate(g);
    if (r.skipped) return { group: 'tool', id: g.repo, status: 'skipped', detail: r.out.slice(0, 120) } as UpdateRow;
    return { group: 'tool', id: g.repo, status: classify(r.ok, r.out), detail: (r.out.split('\n').filter(Boolean).pop() ?? '').slice(0, 120) } as UpdateRow;
  });
}

export function updateEverything(): UpdateRow[] {
  const plugins: UpdateRow[] = updateAllPlugins().map((x) => ({
    group: 'plugin', id: x.id,
    status: x.skipped ? 'skipped' : classify(x.ok, x.out), detail: x.skipped ? 'managed by your account' : x.out.slice(0, 120),
  }));
  return [...plugins, ...updateSkills(), ...updateTools()];
}
