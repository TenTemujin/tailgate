#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { Command } from 'commander';
import { load, save, loadReport } from './catalog.js';
import { scrape } from './github.js';
import { install, pluginCmd, installed } from './claude.js';
import { REJECTS } from './paths.js';
import { bar, bold, dim, green, stars } from './theme.js';
import { run } from './ui.js';
import { isCompiled, uninstallSelf } from './setup.js';

const program = new Command('tailgate').description('Skills & plugins manager for Claude Code, focused on token savings');

// Double-click (compiled, no args): keep the window open when the TUI ends.
const pauseOnExit = async () => {
  if (!isCompiled() || process.env.TAILGATE_NOPAUSE || !process.stdin.isTTY) return;
  process.stdout.write('\nPress Enter to close...');
  await new Promise<void>((r) => process.stdin.once('data', () => r()));
};

program.command('ui', { isDefault: true }).description('interactive TUI').action(async () => {
  await run();
  await pauseOnExit();
});

program.command('self-uninstall').description('remove Tailgate (PATH, shortcuts, binary)').action(uninstallSelf);

program.command('scrape')
  .description('refresh catalog from GitHub (quality filtered); --json prints the audit report for AI/automation')
  .option('--json', 'print report as JSON on stdout (no progress noise)')
  .action(async (o) => {
    const res = await scrape(o.json ? () => {} : (m) => process.stderr.write(dim(`\r${m.slice(0, 70).padEnd(70)}`)));
    save(res);
    if (o.json) return console.log(JSON.stringify(res.report, null, 2));
    console.log(green(`\n✔ kept ${res.entries.length} of ${res.report.candidates}`), dim(JSON.stringify(res.report.rejectedByReason)));
  });

program.command('report').description('last scrape report (JSON): counts, rules, top picks').action(() =>
  console.log(JSON.stringify(loadReport(), null, 2)));

program.command('rejects').description('why repos were filtered out (JSONL)').option('-r, --reason <r>').action((o) => {
  if (!existsSync(REJECTS)) return;
  readFileSync(REJECTS, 'utf8').split('\n').filter(Boolean)
    .filter((l) => !o.reason || JSON.parse(l).reason === o.reason).forEach((l) => console.log(l));
});

program.command('list').description('ranked catalog')
  .option('-t, --tokens', 'token savers only').option('-n <n>', 'limit', '20').option('--json', 'machine-readable')
  .action((o) => {
    const rows = load().filter((e) => !o.tokens || e.tokenSaver).slice(0, +o.n);
    if (o.json) return console.log(JSON.stringify(rows, null, 2));
    rows.forEach((e) => console.log(`[${e.tier}] ${bold(e.id.padEnd(36))} ${bar(e.score)} ${String(e.score).padStart(3)} ${stars(e.stars)}  ${dim(e.description.slice(0, 55))}`));
  });

program.command('install <repo...>').description('install one or more catalog entries (owner/repo)').action((repos: string[]) => {
  const cat = load();
  for (const repo of repos) {
    const e = cat.find((x) => x.id === repo);
    if (!e) { console.error(`${repo}: not in catalog. Run: tailgate scrape`); process.exitCode = 1; continue; }
    const r = install(e);
    console.log(`${repo}: ${r.ok ? 'ok' : 'FAILED'}\n${r.out}`);
    if (!r.ok) process.exitCode = 1;
  }
});

program.command('installed').action(() => console.log(installed()));
for (const v of ['enable', 'disable', 'update', 'uninstall', 'details'] as const)
  program.command(`${v} <plugin>`).action((n) => {
    const r = pluginCmd(v, n);
    console.log(r.out);
    process.exitCode = r.ok ? 0 : 1;
  });

program.parseAsync();
