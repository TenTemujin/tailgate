import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, ensureHome } from './paths.js';
import { entryPluginIds, isEntryInstalled, type Row } from './core.js';
import { install, pluginCmd } from './claude.js';
import type { Entry } from './types.js';

export interface Profile { name: string; description: string; repos: string[]; builtin?: boolean }
export interface Step { action: 'install' | 'enable' | 'disable'; repo: string; plugin: string; reason: string }

const FILE = join(HOME, 'profiles.json');

// ecc is left out of every built-in on purpose: ~47k always-on tokens.
export const BUILTIN: Profile[] = [
  { name: 'minimal', description: 'Terse output only. Lowest overhead.', repos: ['JuliusBrussee/caveman'], builtin: true },
  { name: 'balanced', description: 'Terse output + persistent memory.', repos: ['JuliusBrussee/caveman', 'thedotmack/claude-mem'], builtin: true },
  {
    name: 'max-savings', description: 'Terse output, memory, output compression and context sandboxing.', builtin: true,
    repos: ['JuliusBrussee/caveman', 'thedotmack/claude-mem', 'headroomlabs-ai/headroom', 'mksglu/context-mode'],
  },
];

export function loadProfiles(): Profile[] {
  const mine: Profile[] = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : [];
  return [...BUILTIN, ...mine.filter((p) => !BUILTIN.some((b) => b.name === p.name))];
}

export function saveProfile(name: string, description: string, repos: string[]) {
  ensureHome();
  const mine: Profile[] = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : [];
  writeFileSync(FILE, JSON.stringify([...mine.filter((p) => p.name !== name), { name, description, repos }], null, 2));
}

// Profiles only touch plugins that exist in the catalog as token savers; unrelated plugins are never disabled.
export function plan(profile: Profile, catalog: Entry[], rows: Row[]): Step[] {
  const steps: Step[] = [];
  const have = new Set(rows.map((r) => r.id));
  for (const repo of profile.repos) {
    const e = catalog.find((x) => x.id === repo);
    if (!e || e.kind !== 'marketplace') continue;
    if (isEntryInstalled(e, have)) {
      const off = rows.filter((r) => entryPluginIds(e).includes(r.id) && !r.enabled);
      off.forEach((r) => steps.push({ action: 'enable', repo, plugin: r.id, reason: 'in profile, currently disabled' }));
    } else {
      steps.push({ action: 'install', repo, plugin: entryPluginIds(e)[0], reason: 'in profile, not installed' });
    }
  }
  for (const r of rows) {
    if (!r.enabled || !r.entry?.tokenSaver || profile.repos.includes(r.entry.id)) continue;
    steps.push({ action: 'disable', repo: r.entry.id, plugin: r.id, reason: `not in "${profile.name}"${r.tokens ? ` (saves ~${r.tokens.toLocaleString()} tok)` : ''}` });
  }
  return steps;
}

export function apply(steps: Step[], catalog: Entry[]): { step: Step; ok: boolean; out: string }[] {
  return steps.map((step) => {
    const r = step.action === 'install'
      ? install(catalog.find((e) => e.id === step.repo)!)
      : pluginCmd(step.action, step.plugin);
    return { step, ok: r.ok, out: r.out.split('\n').pop() ?? '' };
  });
}
