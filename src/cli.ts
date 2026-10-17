#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Command } from 'commander';
import { load, save, loadReport } from './catalog.js';
import { scrape } from './github.js';
import { pluginCmd, installed, claude } from './claude.js';
import { REJECTS } from './paths.js';
import { bold, dim, green, grade, red, scanWord, starsCol, yellow } from './theme.js';
import { run } from './ui.js';
import { isCompiled, uninstallSelf } from './setup.js';
import { available, selfUpdate, startup, updateAllPlugins } from './update.js';
import { VERSION } from './version.js';
import { startGui } from './web.js';
import { conflicts, listInstalled } from './core.js';
import { apply, loadProfiles, plan } from './profiles.js';
import { applyProject, clearPlan, currentEnabled, planProject, settingsPath } from './project.js';
import { auditRepo } from './audit.js';
import { installChecked, resolveTarget } from './installer.js';
import { compact, delegateStats, savings } from './stats.js';
import { impactFor, scanTranscripts } from './impact.js';
import { setAutostart, startTray, stopTray } from './tray.js';
import { updateEverything } from './updater.js';
import { TOOLS } from './tools.js';

const program = new Command('tailgate').description('Skills & plugins manager for Claude Code, focused on token savings').version(VERSION);

// Double-click (compiled, no args): keep the window open when the TUI ends.
const pauseOnExit = async () => {
  if (!isCompiled() || process.env.TAILGATE_NOPAUSE || !process.stdin.isTTY) return;
  process.stdout.write('\nPress Enter to close...');
  await new Promise<void>((r) => process.stdin.once('data', () => r()));
};

program.command('ui', { isDefault: true }).description('interactive terminal UI').action(async () => {
  await run();
  await pauseOnExit();
});

program.command('gui').description('open the clickable interface in your browser')
  .option('--no-open', 'do not launch the browser').option('--tab <tab>', 'discover | installed | profiles | delegate')
  .action((o) => startGui(o.open, o.tab));

program.command('scrape')
  .description('refresh catalog from GitHub (quality filtered); --json prints the audit report for AI/automation')
  .option('--json', 'print report as JSON on stdout (no progress noise)')
  .option('--audit', 'also clone and security-scan every kept repo (slow, used by CI)')
  .action(async (o) => {
    const res = await scrape(o.json ? () => {} : (m) => process.stderr.write(dim(`\r${m.slice(0, 70).padEnd(70)}`)), { audit: o.audit, previous: load() });
    save(res);
    if (o.json) return console.log(JSON.stringify(res.report, null, 2));
    console.log(green(`\n✔ kept ${res.entries.length} of ${res.report.candidates}`), dim(JSON.stringify(res.report.rejectedByReason)));
  });

program.command('report').description('last scrape report (JSON): counts, rules, top picks').action(() => console.log(JSON.stringify(loadReport(), null, 2)));

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
    rows.forEach((e) => console.log(`${bold(e.id.padEnd(36))} ${String(e.score).padStart(3)} ${grade(e.tier)} ${starsCol(e.stars)}  ${scanWord(e.security?.level)} ${dim(e.kind === 'marketplace' ? 'plugin' : e.kind)}  ${dim(e.description.slice(0, 38))}`));
  });

program.command('install <target...>')
  .description('install from the catalog or any GitHub repo (owner/repo or a github.com link)')
  .option('--force', 'install even when the security scan found high-risk patterns')
  .action(async (targets: string[], o) => {
    const cat = load();
    for (const t of targets) {
      const r = await resolveTarget(t, cat);
      if ('error' in r) { console.error(`${t}: ${r.error}`); process.exitCode = 1; continue; }
      if (!r.fromCatalog) console.log(dim(`${r.entry.id} is not in the catalog (community repo, not vetted). Scanning before install...`));
      const res = installChecked(r.entry, { force: o.force, inherit: true });
      console.log(`${r.entry.id}: ${res.ok ? 'ok' : res.blocked ? 'BLOCKED' : 'FAILED'}\n${res.out}`);
      if (!res.ok) process.exitCode = 1;
    }
  });

program.command('audit <repo>').description('static security scan of a GitHub repo (hooks, network, credentials, destructive commands)')
  .option('--json', 'machine-readable').action((repo, o) => {
    const a = auditRepo(repo);
    if (!a) { console.error('Could not clone or scan that repo.'); process.exitCode = 1; return; }
    if (o.json) return console.log(JSON.stringify(a, null, 2));
    console.log(`${repo}: ${a.level.toUpperCase()}  (${a.files} files, ${a.counts.high} high, ${a.counts.warn} warn, ${a.counts.info} info)`);
    a.findings.filter((f) => f.severity !== 'info').slice(0, 15).forEach((f) => console.log(`  [${f.severity}] ${f.rule}  ${f.file}:${f.line}\n      ${dim(f.snippet)}`));
    console.log(dim('\nThis is a pattern scan, not a code review. Absence of findings is not proof of safety.'));
    process.exitCode = a.level === 'risky' ? 2 : 0;
  });

program.command('installed').action(() => console.log(installed()));
for (const v of ['enable', 'disable', 'uninstall', 'details'] as const)
  program.command(`${v} <plugin>`).action((n) => {
    const r = pluginCmd(v, n);
    console.log(r.out);
    process.exitCode = r.ok ? 0 : 1;
  });
program.command('plugin-update <plugin>').description('update one plugin').action((n) => {
  const r = pluginCmd('update', n);
  console.log(r.out);
  process.exitCode = r.ok ? 0 : 1;
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

program.command('update-all').description('update plugins, git-cloned skills and installed tools (REA, rtk, Ghidra, ...)').action(() => {
  const rows = updateEverything();
  const mark = { updated: green('updated'), latest: dim('latest '), skipped: dim('skipped'), failed: red('FAILED ') };
  for (const g of ['plugin', 'skill', 'tool'] as const) {
    const r = rows.filter((x) => x.group === g);
    if (!r.length) continue;
    console.log(bold(g + 's'));
    r.forEach((x) => console.log(`  ${mark[x.status]}  ${x.id.padEnd(44)} ${dim(x.detail.slice(0, 60))}`));
  }
  const n = (s: string) => rows.filter((x) => x.status === s).length;
  console.log(`
${n('updated')} updated, ${n('latest')} already current, ${n('skipped')} skipped, ${n('failed')} failed`);
  process.exitCode = n('failed') ? 1 : 0;
});

program.command('tools').description('tools that help Claude but are not plugins (REA, Ghidra, Playwright MCP, ...)').action(() => {
  const cat = load();
  TOOLS.forEach((t) => {
    const e = cat.find((x) => x.id === t.id);
    console.log(`${bold(t.name.padEnd(16))} ${dim(t.toolKind.padEnd(4))} ${t.description.slice(0, 70)}
${' '.repeat(17)}${dim('tailgate install ' + t.id)}${e ? '' : ''}`);
  });
});

const profile = program.command('profile').description('switch between plugin sets (minimal, balanced, max-savings, yours)');
profile.command('list').action(() => loadProfiles().forEach((p) => console.log(`${bold(p.name.padEnd(14))} ${dim(p.description)}\n${' '.repeat(15)}${p.repos.join(', ')}`)));
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

program.command('project [profile]')
  .description('apply a profile to ONE project folder (writes enabledPlugins in .claude/settings.local.json)')
  .option('-d, --dir <dir>', 'project folder', '.').option('--shared', 'write .claude/settings.json (shared with the team) instead')
  .option('--clear', 'remove Tailgate-managed overrides from this project').option('--show', 'show current overrides')
  .option('-y, --yes', 'actually write (default is a dry run)')
  .action(async (name, o) => {
    const scope = o.shared ? 'shared' : 'local';
    const dir = resolve(o.dir);
    const cur = currentEnabled(dir, scope);
    if (o.show) return console.log(Object.keys(cur).length ? JSON.stringify(cur, null, 2) : 'No overrides in ' + settingsPath(dir, scope));
    const cat = load();
    const rows = await listInstalled(cat);
    let changes;
    if (o.clear) changes = clearPlan(rows, cur);
    else {
      const prof = loadProfiles().find((p) => p.name === name);
      if (!prof) { console.error(`Give a profile: ${loadProfiles().map((p) => p.name).join(', ')} (or --clear / --show)`); process.exitCode = 1; return; }
      changes = planProject(prof, rows, cur);
    }
    if (!changes.length) return console.log('Nothing to change.');
    changes.forEach((c) => console.log(`${String(c.to === undefined ? 'unset' : c.to ? 'enable' : 'disable').padEnd(8)} ${c.plugin}`));
    if (!o.yes) return console.log(dim(`\nDry run for ${settingsPath(dir, scope)}. Add --yes to write.`));
    console.log(green('Wrote ' + applyProject(dir, changes, scope)), dim('Restart Claude Code in that folder.'));
  });

program.command('conflicts').description('warn about installed plugins that overlap').action(async () => {
  const c = conflicts(await listInstalled(load()));
  console.log(c.length ? c.map((x) => `! ${x.message}`).join(String.fromCharCode(10)) : 'No conflicts.');
});

program.command('delegate').description('what Gemini (agy-delegate) is doing and what it saved').option('--json', 'machine-readable').action((o) => {
  const d = delegateStats();
  if (o.json) return console.log(JSON.stringify(d, null, 2));
  if (!d.installed) return console.log('agy-delegate not detected (no ~/.agy-delegate/usage.jsonl and no agy binary).');
  console.log(d.running.length ? green(`● Gemini is running ${d.running.length} job(s)`) : dim('○ Gemini is idle'), dim(`(agy processes: ${d.agyProcesses})`));
  d.running.forEach((j) => console.log(`  running  ${j.model}  ${Math.floor(Date.now() / 1000 - j.startedAt)}s`));
  console.log(`\n${bold('Totals')}  ${d.totals.jobs} jobs (${d.totals.ok} ok, ${d.totals.failed} failed)  Gemini used ${compact(d.totals.geminiTokens)} tok`);
  console.log(`${bold('Claude saved')} ~${compact(d.totals.claudeSaved)} tokens ${dim('(estimate: source bytes Claude did not read minus the answer, 4 bytes per token)')}`);
  d.recent.slice(0, 8).forEach((j) => console.log(dim(`  ${new Date(j.startedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')}  ${j.status.padEnd(6)} ${String(j.durS ?? 0).padStart(4)}s  gemini ${compact(j.geminiIn + j.geminiOut).padStart(6)}  saved ~${compact(j.claudeSaved)}`)));
});

program.command('stats').description('tokens saved across tools (used by the tray icon)').option('--json', 'machine-readable').action((o) => {
  const s = savings();
  if (o.json) return console.log(JSON.stringify(s));
  console.log(`${bold('Total saved')} ~${compact(s.total)} tokens`);
  console.log(`  rtk       ${s.rtk.saved === null ? 'n/a' : compact(s.rtk.saved)} ${dim('measured by rtk itself')}`);
  console.log(`  delegate  ~${compact(s.delegate.saved)} ${dim(`estimated, ${s.delegate.jobs} jobs`)}${s.delegate.active ? green('  ● running now') : ''}`);
});

program.command('impact').description('observational before/after per plugin, from your session transcripts').option('--json').action(async (o) => {
  const rows = await listInstalled(load());
  const sessions = await scanTranscripts(Date.now() - 120 * 864e5);
  const out = rows.map((r) => ({ plugin: r.id, ...impactFor(sessions, Date.parse(String(r.installedAt ?? 0)) || 0) }));
  if (o.json) return console.log(JSON.stringify(out, null, 2));
  console.log(dim(`${sessions.length} sessions scanned. Tokens per turn (new input + output), median, before vs after install.`));
  out.filter((x) => x.confidence !== 'none').forEach((x) =>
    console.log(`${x.plugin.padEnd(42)} ${String(x.before.perTurn).padStart(7)} -> ${String(x.after.perTurn).padStart(7)}  ${String(x.deltaPct).padStart(5)}%  n=${x.before.n}/${x.after.n} ${x.confidence === 'ok' ? '' : yellow('(low sample)')}`));
  console.log(dim('\nObservational only: your task mix changes over time, so this is a hint, not proof.'));
});

program.command('tray').description('Windows: show the savings icon in the taskbar notification area')
  .option('--stop', 'close the tray icon').option('--autostart <on|off>', 'start the icon at login')
  .action((o) => {
    const exe = process.execPath;
    if (o.stop) { stopTray(); return console.log('Tray stop requested.'); }
    if (o.autostart) return console.log(setAutostart(exe, o.autostart === 'on') ? `Autostart ${o.autostart}.` : 'Could not change autostart.');
    const r = startTray(exe);
    console.log(r.msg);
    process.exitCode = r.ok ? 0 : 1;
  });

program.command('marketplace-init [name]').description('scaffold .claude-plugin/ in the current folder so you can publish your own plugin')
  .option('--owner <owner>', 'owner name', 'me').action((name, o) => {
    const dir = resolve('.');
    const n = (name ?? basename(dir)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const meta = join(dir, '.claude-plugin');
    if (existsSync(join(meta, 'marketplace.json'))) { console.error('.claude-plugin/marketplace.json already exists. Not overwriting.'); process.exitCode = 1; return; }
    mkdirSync(meta, { recursive: true });
    writeFileSync(join(meta, 'marketplace.json'), JSON.stringify({ name: n, owner: { name: o.owner }, plugins: [{ name: n, source: './', description: 'Describe what your plugin does' }] }, null, 2) + '\n');
    if (!existsSync(join(meta, 'plugin.json'))) writeFileSync(join(meta, 'plugin.json'), JSON.stringify({ name: n, version: '0.1.0', description: 'Describe what your plugin does', license: 'MIT' }, null, 2) + '\n');
    console.log(green(`Created .claude-plugin/ for "${n}".`));
    const v = claude(['plugin', 'validate', dir]);
    console.log(v.out || '(validate printed nothing)');
    console.log(dim(`\nPush to GitHub, then anyone can run: tailgate install ${o.owner}/${n}  (or: claude plugin marketplace add ${o.owner}/${n})`));
    process.exitCode = v.ok ? 0 : 1;
  });

program.command('self-uninstall').description('remove Tailgate (PATH, shortcuts, binary)').action(uninstallSelf);

program.parseAsync();
