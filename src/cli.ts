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
import { available, selfUpdate, startup, updateAllPlugins } from './update.js';
import { VERSION } from './version.js';
import { startGui } from './web.js';
import { conflicts, listInstalled } from './core.js';
import { apply, loadProfiles, plan } from './profiles.js';

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

program.command('update').description('update Tailgate itself (--check only reports)')
  .option('--check', 'only report whether an update exists')
  .action(async (o) => {
    startup();
    const r = await available(true);
    if (!r) return console.log(`Up to date (v${VERSION}).`);
    console.log(`v${r.version} available (current v${VERSION}).`);
    if (o.check) return;
    await selfUpdate(r);
    console.log(green(`Updated to v${r.version}.`));
  });

program.command('update-plugins').description('update every installed Claude Code plugin').action(() =>
  updateAllPlugins().forEach((x) => console.log(`${x.skipped ? 'skip  ' : x.ok ? 'ok    ' : 'FAILED'} ${x.id}  ${x.out}`)));

program.command('gui').description('open the clickable interface in your browser').option('--no-open', 'do not launch the browser').action((o) => startGui(o.open));

const profile = program.command('profile').description('switch between plugin sets (minimal, balanced, max-savings, yours)');
profile.command('list').action(() => loadProfiles().forEach((p) => console.log(`${bold(p.name.padEnd(14))} ${dim(p.description)}
${' '.repeat(15)}${p.repos.join(', ')}`)));
profile.command('apply <name>').option('-y, --yes', 'actually apply (default is a dry run)').action(async (name, o) => {
  const prof = loadProfiles().find((p) => p.name === name);
  if (!prof) { console.error(`Unknown profile. Try: ${loadProfiles().map((p) => p.name).join(', ')}`); process.exitCode = 1; return; }
  const cat = load();
  const steps = plan(prof, cat, await listInstalled(cat));
  if (!steps.length) return console.log('Already matches this profile.');
  steps.forEach((s) => console.log(`${s.action.padEnd(8)} ${s.plugin}  ${dim(s.reason)}`));
  if (!o.yes) return console.log(dim('Dry run. Add --yes to apply.'));
  const res = apply(steps, cat);
  res.forEach((r) => console.log(`${r.ok ? 'ok    ' : 'FAILED'} ${r.step.action} ${r.step.plugin}`));
  process.exitCode = res.every((r) => r.ok) ? 0 : 1;
});

program.command('conflicts').description('warn about installed plugins that overlap').action(async () => {
  const c = conflicts(await listInstalled(load()));
  console.log(c.length ? c.map((x) => `! ${x.message}`).join(String.fromCharCode(10)) : 'No conflicts.');
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
// `update` is Tailgate itself; a single plugin is `plugin-update`.
for (const v of ['enable', 'disable', 'update', 'uninstall', 'details'] as const)
  program.command(v === 'update' ? 'plugin-update <plugin>' : `${v} <plugin>`).action((n) => {
    const r = pluginCmd(v, n);
    console.log(r.out);
    process.exitCode = r.ok ? 0 : 1;
  });

program.parseAsync();
