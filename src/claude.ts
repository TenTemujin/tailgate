import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Entry } from './types.js';

export function claude(args: string[], inherit = false) {
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
