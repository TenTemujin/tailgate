import { install } from './claude.js';
import { auditRepo } from './audit.js';
import { guideFor, runGuide } from './guides.js';
import { inspectRepo, parseRepoInput } from './github.js';
import type { Audit, Entry } from './types.js';

export interface Resolved { entry: Entry; fromCatalog: boolean }

// Catalog entry, or any public GitHub repo given as owner/repo or a github.com link.
export async function resolveTarget(input: string, catalog: Entry[]): Promise<Resolved | { error: string }> {
  const repo = parseRepoInput(input);
  if (!repo) return { error: `Not a GitHub repo reference: ${input}` };
  const hit = catalog.find((e) => e.id.toLowerCase() === repo.toLowerCase());
  if (hit) return { entry: hit, fromCatalog: true };
  const e = await inspectRepo(repo);
  if (!e) return { error: `${repo}: repo not found on GitHub` };
  return { entry: e, fromCatalog: false };
}

export const summarizeAudit = (a: Audit) =>
  a.findings.filter((f) => f.severity !== 'info').slice(0, 5).map((f) => `  [${f.severity}] ${f.rule}  ${f.file}:${f.line}  ${f.snippet}`).join('\n');

export interface InstallResult { ok: boolean; out: string; blocked?: boolean; audit?: Audit | null }

// Single install path for CLI, TUI and GUI: guide for non-plugin tools, security gate for everything else.
export function installChecked(e: Entry, opts: { force?: boolean; inherit?: boolean } = {}): InstallResult {
  const g = guideFor(e.id);
  if (e.kind === 'unknown' || e.kind === 'tool') {
    if (!g) return { ok: false, out: `No Claude Code plugin or skill detected. Install manually: https://github.com/${e.id}` };
    const r = runGuide(g, { inherit: opts.inherit });
    return { ok: r.ok, out: g.after && r.ok ? `${r.out}\n${g.after}` : r.out };
  }
  // Catalog entries carry a scan from the weekly run. Anything else (link installs, old catalogs) is scanned now.
  const audit = e.security ?? auditRepo(e.id);
  if (audit?.level === 'risky' && !opts.force) {
    return { ok: false, blocked: true, audit, out: `Blocked: the static scan found high-risk patterns in ${e.id}.\n${summarizeAudit(audit)}\nReview the code, then retry with --force if you trust it.` };
  }
  const r = install(e);
  const note = audit === null ? '\nNote: could not scan this repo (clone failed).' : '';
  return { ok: r.ok, out: r.out + note, audit };
}
