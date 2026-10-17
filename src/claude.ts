import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Entry } from './types.js';

// On Windows `claude` is a .cmd shim and needs a shell, so reject anything that could inject shell syntax.
const SAFE_ARG = /^[A-Za-z0-9_.@:\/\\=-]+$/;

export function claude(args: string[], inherit = false) {
  const bad = args.find((a) => !SAFE_ARG.test(a));
  if (bad !== undefined) return { ok: false, out: `Refusing unsafe argument: ${JSON.stringify(bad)}` };
  const r = spawnSync('claude', args, { encoding: 'utf8', shell: process.platform === 'win32', stdio: inherit ? 'inherit' : 'pipe' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

export interface Installed { id: string; version: string; enabled: boolean; scope: string }

export function installedPlugins(): Installed[] {
  const r = claude(['plugin', 'list', '--json']);
  try { return JSON.parse(r.out); } catch { return []; }
}

export function installed(): string {
  return claude(['plugin', 'list']).out;
}

export function install(e: Entry) {
  if (e.kind === 'marketplace') {
    const add = claude(['plugin', 'marketplace', 'add', e.id]);
    if (!add.ok && !/already/i.test(add.out)) return add;
    const plugin = e.plugins?.[0] ?? e.marketplaceName ?? e.id.split('/')[1];
    return claude(['plugin', 'install', `${plugin}@${e.marketplaceName ?? plugin}`]);
  }
  if (e.kind === 'unknown') {
    return { ok: false, out: `No Claude Code plugin or skill detected. Install manually: https://github.com/${e.id}` };
  }
  // Raw skill repo: clone into ~/.claude/skills/<name>
  const dest = join(homedir(), '.claude', 'skills', e.id.split('/')[1]);
  if (existsSync(dest)) return { ok: true, out: 'already present' };
  const r = spawnSync('git', ['clone', '--depth', '1', `https://github.com/${e.id}`, dest], { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
}

export const pluginCmd = (verb: 'enable' | 'disable' | 'uninstall' | 'update' | 'details', name: string) =>
  claude(['plugin', verb, name]);

// Always-on context cost (tokens added to every session), parsed from `claude plugin details`.
export function alwaysOnTokens(id: string): number | null {
  const m = claude(['plugin', 'details', id]).out.match(/Always-on:\s*~?([\d,.]+)\s*(k?)\s*tok/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Math.round(m[2] ? n * 1000 : n);
}
