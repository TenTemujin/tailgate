import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeAsync, installedPlugins, type Installed } from './claude.js';
import { HOME, ensureHome } from './paths.js';
import type { Entry } from './types.js';

export interface Row extends Installed { tokens: number | null; entry?: Entry }

// ---- catalog <-> installed matching -------------------------------------------------

export const entryPluginIds = (e: Entry): string[] =>
  e.kind === 'marketplace' ? (e.plugins?.length ? e.plugins : [e.marketplaceName ?? '']).map((n) => `${n}@${e.marketplaceName}`) : [];

export const entryFor = (catalog: Entry[], pluginId: string) => catalog.find((e) => entryPluginIds(e).includes(pluginId));
export const isEntryInstalled = (e: Entry, ids: Set<string>) => entryPluginIds(e).some((i) => ids.has(i));

// ---- token cost (cached: details is slow and only changes with the version) ----------

const COSTS = join(HOME, 'costs.json');
let costCache: Record<string, number | null> | null = null;
const costs = () => (costCache ??= existsSync(COSTS) ? JSON.parse(readFileSync(COSTS, 'utf8')) : {});

function parseTokens(out: string): number | null {
  const m = out.match(/Always-on:\s*~?([\d,.]+)\s*(k?)\s*tok/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Math.round(m[2] ? n * 1000 : n);
}

export async function costOf(id: string, version: string): Promise<number | null> {
  const key = `${id}#${version}`;
  const c = costs();
  if (key in c) return c[key];
  const v = parseTokens((await claudeAsync(['plugin', 'details', id])).out);
  if (v !== null) { c[key] = v; ensureHome(); writeFileSync(COSTS, JSON.stringify(c)); }
  return v;
}

export async function listInstalled(catalog: Entry[]): Promise<Row[]> {
  return Promise.all(installedPlugins().map(async (p) => ({ ...p, tokens: await costOf(p.id, p.version), entry: entryFor(catalog, p.id) })));
}

// ---- conflicts: only families where two tools do the same job and fight over it -----

const FAMILIES: [string, string, RegExp][] = [
  ['memory', 'persistent memory', /mem|recall|remember|hippo|engram/i],
  ['output-style', 'terse output style', /caveman|terse|concise|brief/i],
];

// Matched on the repo name only. Descriptions mention "memory" or "terse" in passing and would cause false alarms.
export function familyOf(e: Entry): string | null {
  const name = e.id.split('/')[1] ?? e.id;
  return FAMILIES.find(([, , re]) => re.test(name))?.[0] ?? null;
}

export interface Conflict { family: string; ids: string[]; message: string }

export function conflicts(rows: Row[]): Conflict[] {
  const by = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.enabled || !r.entry) continue;
    const f = familyOf(r.entry);
    if (f) by.set(f, [...(by.get(f) ?? []), r]);
  }
  return [...by].filter(([, v]) => v.length > 1).map(([family, v]) => {
    const label = FAMILIES.find(([k]) => k === family)![1];
    const ids = v.map((r) => r.id);
    return { family, ids, message: `${ids.join(' + ')} both provide ${label}. They may inject overlapping context. Keep one enabled.` };
  });
}
