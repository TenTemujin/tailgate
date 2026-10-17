import * as p from '@clack/prompts';
import { load, save, loadReport } from './catalog.js';
import { scrape } from './github.js';
import { pluginCmd, installedPlugins, alwaysOnTokens } from './claude.js';
import { installChecked } from './installer.js';
import { delegateStats, savings } from './stats.js';
import { accent, banner, bold, compactNum, dim, grade, green, red, scanWord, starsCol, tag, yellow } from './theme.js';
import { maybeInstall } from './setup.js';
import { available, refreshCatalogIfStale, selfUpdate, startup } from './update.js';
import { VERSION } from './version.js';
import { startGui } from './web.js';
import { conflicts, listInstalled } from './core.js';
import { apply, loadProfiles, plan } from './profiles.js';
import { guideFor, isToolInstalled } from './guides.js';
import { updateEverything } from './updater.js';
import type { Entry } from './types.js';

let INSTALLED = new Set<string>();
const refreshInstalled = () => { INSTALLED = new Set(installedPlugins().map((x) => x.id)); };
const isInstalled = (e: Entry) => {
  if (e.kind === 'marketplace') return (e.plugins ?? [e.marketplaceName ?? '']).some((n) => INSTALLED.has(`${n}@${e.marketplaceName}`));
  const g = guideFor(e.id);
  return !!g && (e.kind === 'tool' || e.kind === 'unknown') && isToolInstalled(g);
};

const kindWord = (e: Entry) => (e.kind === 'marketplace' ? 'plugin' : e.kind === 'skill' ? 'skill' : e.kind === 'tool' ? 'tool' : guideFor(e.id) ? 'guided' : 'manual');

// One row per entry, fixed columns: state, name, score, grade, stars, scan, kind.
const label = (e: Entry) =>
  `${isInstalled(e) ? accent('■') : dim('·')} ${e.id.padEnd(34)} ${String(e.score).padStart(3)} ${grade(e.tier)} ${starsCol(e.stars)}  ${scanWord(e.security?.level)} ${dim(kindWord(e))}`;

export async function refresh() {
  const s = p.spinner();
  s.start('Scraping GitHub');
  let res;
  try {
    res = await scrape((m) => s.message(dim(m.slice(0, 60))));
  } catch (e) {
    s.stop(red('Failed: ' + (e as Error).message));
    return load();
  }
  save(res);
  const rej = Object.entries(res.report.rejectedByReason).map(([k, v]) => `${v} ${k}`).join(', ');
  s.stop(`Kept ${bold(String(res.entries.length))} of ${res.report.candidates}. ${dim('Rejected: ' + rej)}`);
  return load();
}

function showDetail(e: Entry) {
  p.note(
    [
      e.description,
      '',
      `${dim('score    ')} ${e.score}/100  grade ${grade(e.tier)}`,
      e.stars > 0 ? `${dim('stars    ')} ${compactNum(e.stars)}` : '',
      `${dim('license  ')} ${e.license ?? yellow('none')}`,
      e.pushedAt ? `${dim('updated  ')} ${e.pushedAt.slice(0, 10)}` : '',
      e.plugins?.length ? `${dim('plugins  ')} ${e.plugins.join(', ')}` : '',
      `${dim('category ')} ${e.category}, ${kindWord(e)}`,
      `${dim('scan     ')} ${scanWord(e.security?.level)} ${e.security ? dim(`${e.security.counts.high} high, ${e.security.counts.warn} warn (pattern scan, not a code review)`) : ''}`,
      dim(`https://github.com/${e.id}`),
    ].filter((l) => l !== '').join(String.fromCharCode(10)),
    e.id,
  );
}

async function installMany(list: Entry[]) {
  if (list.some((e) => !e.curated)) p.log.warn('Community repos are scored, not manually vetted. Review the code before trusting them.');
  for (const e of list) {
    const guide = guideFor(e.id);
    // Interactive installers need the real terminal, so they run outside the spinner.
    if (guide?.interactive && (e.kind === 'tool' || e.kind === 'unknown')) {
      p.log.step(`${e.id} asks questions, so it runs here in the terminal.`);
      const r = installChecked(e, { inherit: true });
      p.log[r.ok ? 'success' : 'error'](`${e.id}: ${r.ok ? 'done' : r.out.slice(0, 200)}`);
      continue;
    }
    const s = p.spinner();
    s.start(`Installing ${e.id}`);
    let r = installChecked(e);
    if (r.blocked) {
      s.stop(red(`${e.id}: the security scan found high-risk patterns`));
      p.log.warn(r.out);
      const go = await p.confirm({ message: `Install ${e.id} anyway?`, initialValue: false });
      if (p.isCancel(go) || !go) continue;
      s.start(`Installing ${e.id}`);
      r = installChecked(e, { force: true });
    }
    s.stop(r.ok ? `Installed ${e.id}` : red(`${e.id}: ${r.out.slice(0, 160)}`));
  }
  refreshInstalled();
  p.log.info('Restart Claude Code to apply.');
}

// One step install: space selects, enter installs the whole selection.
async function pickAndInstall(items: Entry[], what: string) {
  const sel = await p.multiselect({
    message: `${items.length} ${what}, best first. ${dim('space selects, enter installs')}`,
    maxItems: 12,
    required: false,
    initialValues: items.filter((e) => e.curated && e.kind !== 'unknown' && e.kind !== 'tool' && !isInstalled(e)).map((e) => e.id),
    options: items.map((e) => ({ value: e.id, label: label(e), hint: e.description.slice(0, 45) })),
  });
  if (p.isCancel(sel) || !sel.length) return;
  await installMany(items.filter((e) => (sel as string[]).includes(e.id)));
}

async function inspect(items: Entry[]) {
  for (;;) {
    const pick = await p.select({
      message: 'Inspect',
      maxItems: 12,
      options: [...items.map((e) => ({ value: e.id, label: label(e) })), { value: '__back', label: dim('Back') }],
    });
    if (p.isCancel(pick) || pick === '__back') return;
    const e = items.find((x) => x.id === pick)!;
    showDetail(e);
    const ok = await p.confirm({ message: `Install ${e.id}?` });
    if (!p.isCancel(ok) && ok) await installMany([e]);
  }
}

export async function offerUpdate(force = false): Promise<boolean> {
  const r = await available(force);
  if (!r) {
    if (force) p.log.success(`Tailgate is up to date (v${VERSION}).`);
    return false;
  }
  const yes = await p.confirm({ message: `Tailgate v${r.version} is available (you have v${VERSION}). Update now?`, initialValue: true });
  if (p.isCancel(yes) || !yes) return false;
  const s = p.spinner();
  s.start('Downloading update');
  try {
    await selfUpdate(r);
    s.stop(`Updated to v${r.version}. Reopen Tailgate to use it.`);
    process.exit(0);
  } catch (e) {
    s.stop(red((e as Error).message));
    return false;
  }
}

async function updateAll() {
  const s = p.spinner();
  s.start('Updating plugins, skills and tools');
  const rows = updateEverything();
  const n = (st: string) => rows.filter((x) => x.status === st).length;
  s.stop(`${n('updated')} updated, ${n('latest')} already current, ${n('skipped')} skipped, ${n('failed')} failed`);
  rows.filter((x) => x.status === 'updated' || x.status === 'failed').forEach((x) =>
    p.log[x.status === 'failed' ? 'error' : 'info'](`${x.group} ${x.id}: ${dim(x.detail.slice(0, 90))}`));
  if (n('updated')) p.log.info('Restart Claude Code to apply plugin updates.');
}

async function profiles(cat: Entry[]) {
  const all = loadProfiles();
  const pick = await p.select({
    message: 'Profile',
    options: [...all.map((x) => ({ value: x.name, label: x.name, hint: x.description })), { value: '__back', label: dim('Back') }],
  });
  if (p.isCancel(pick) || pick === '__back') return;
  const prof = all.find((x) => x.name === pick)!;
  const steps = plan(prof, cat, await listInstalled(cat));
  if (!steps.length) return void p.log.success('Already matches this profile.');
  p.note(steps.map((s) => `${s.action.padEnd(8)} ${s.plugin}  ${dim(s.reason)}`).join(String.fromCharCode(10)), `Plan for "${prof.name}"`);
  const ok = await p.confirm({ message: 'Apply?' });
  if (p.isCancel(ok) || !ok) return;
  apply(steps, cat).forEach((r) => p.log[r.ok ? 'success' : 'error'](`${r.step.action} ${r.step.plugin}${r.ok ? '' : ': ' + r.out}`));
  p.log.info('Restart Claude Code to apply.');
}

async function delegateScreen() {
  const d = delegateStats();
  const s = savings();
  if (!d.installed) return void p.log.warn('agy-delegate was not detected on this machine.');
  const live = d.running.length > 0;
  p.note(
    [
      live ? accent(`Gemini is running ${d.running.length} job(s)`) : dim(`Gemini is idle (agy processes: ${d.agyProcesses})`),
      ...d.running.map((j) => `  ${j.model}  ${Math.floor(Date.now() / 1000 - j.startedAt)}s`),
      '',
      `${bold('Delegate')}   ${d.totals.jobs} jobs (${d.totals.ok} ok, ${d.totals.failed} failed), Gemini used ${compactNum(d.totals.geminiTokens)} tokens`,
      `${bold('Saved')}      ~${compactNum(d.totals.claudeSaved)} Claude tokens ${dim('(estimate)')}`,
      `${bold('rtk')}        ${s.rtk.saved === null ? 'n/a' : compactNum(s.rtk.saved)} tokens ${dim('(measured by rtk)')}`,
      `${bold('Total')}      ~${compactNum(s.total)} tokens`,
      '',
      ...d.recent.slice(0, 6).map((j) => dim(`${new Date(j.startedAt * 1000).toISOString().slice(5, 16).replace('T', ' ')}  ${j.status.padEnd(5)} ${String(j.durS ?? 0).padStart(4)}s  gemini ${compactNum(j.geminiIn + j.geminiOut).padStart(6)}  saved ~${compactNum(j.claudeSaved)}`)),
    ].join(String.fromCharCode(10)),
    'Delegate (Gemini)',
  );
}

async function manage() {
  for (;;) {
    const list = installedPlugins();
    if (!list.length) return void p.log.info('Nothing installed.');
    const sp = p.spinner();
    sp.start('Measuring token cost');
    const cost = new Map(list.map((x) => [x.id, alwaysOnTokens(x.id)]));
    const total = [...cost.values()].reduce<number>((a, b) => a + (b ?? 0), 0);
    sp.stop(`Plugins add ${bold(total.toLocaleString())} tokens to every session`);
    conflicts(await listInstalled(load())).forEach((c) => p.log.warn(c.message));
    const pick = await p.select({
      message: `Installed (${list.length})`,
      maxItems: 12,
      options: [
        { value: '__updateall', label: 'Update everything' },
        ...list.map((x) => {
          const t = cost.get(x.id);
          const costText = t == null ? dim('       n/a') : (t > 3000 ? yellow : (s: string) => s)(('~' + t.toLocaleString() + ' tok').padStart(11));
          return { value: x.id, label: `${x.enabled ? accent('■') : dim('□')} ${x.id.padEnd(38)} ${dim(('v' + x.version).padEnd(9))} ${costText}` };
        }),
        { value: '__back', label: dim('Back') },
      ],
    });
    if (p.isCancel(pick) || pick === '__back') return;
    if (pick === '__updateall') { await updateAll(); continue; }
    const cur = list.find((x) => x.id === pick)!;
    const verb = await p.select({
      message: String(pick),
      options: [
        { value: 'details', label: 'Token cost', hint: 'projected context cost' },
        { value: cur.enabled ? 'disable' : 'enable', label: cur.enabled ? 'Disable' : 'Enable' },
        { value: 'update', label: 'Update' },
        { value: 'uninstall', label: 'Uninstall' },
      ],
    });
    if (p.isCancel(verb)) continue;
    const r = pluginCmd(verb as any, String(pick));
    p.log[r.ok ? 'success' : 'error'](r.out || 'done');
  }
}

export async function run() {
  console.clear();
  console.log(banner(VERSION));
  p.intro(tag('tailgate'));
  startup();
  await refreshCatalogIfStale();
  if (!(await maybeInstall())) await offerUpdate();
  let list = load();
  if (!list.length) list = await refresh();
  else {
    const rep = loadReport();
    if (rep) p.log.info(dim(`Catalog: ${list.length} entries, scraped ${rep.at.slice(0, 16).replace('T', ' ')}`));
  }
  for (;;) {
    refreshInstalled();
    const plugins = list.filter((e) => e.kind !== 'tool');
    const savers = plugins.filter((e) => e.tokenSaver);
    const tools = list.filter((e) => e.kind === 'tool');
    const a = await p.select({
      message: 'What now?',
      options: [
        { value: 'quick', label: 'Install token savers', hint: `${savers.length} ranked` },
        { value: 'all', label: 'Browse plugins and skills', hint: `${plugins.length} ranked` },
        { value: 'tools', label: 'Tools', hint: `${tools.length}: REA, Ghidra, MCP servers, CLIs` },
        { value: 'search', label: 'Search', hint: 'name, description or category' },
        { value: 'inspect', label: 'Inspect details' },
        { value: 'profiles', label: 'Profiles', hint: 'minimal, balanced, max-savings' },
        { value: 'manage', label: 'Installed', hint: 'enable, disable, token cost' },
        { value: 'updateall', label: 'Update everything', hint: 'plugins, skills, tools' },
        { value: 'delegate', label: 'Delegate and savings', hint: 'is Gemini running, tokens saved' },
        { value: 'gui', label: 'Open graphical interface', hint: 'browser, mouse' },
        { value: 'refresh', label: 'Refresh catalog' },
        { value: 'selfupdate', label: 'Check for Tailgate updates' },
        { value: 'quit', label: 'Quit' },
      ],
    });
    if (p.isCancel(a) || a === 'quit') break;
    if (a === 'refresh') list = await refresh();
    else if (a === 'selfupdate') await offerUpdate(true);
    else if (a === 'updateall') await updateAll();
    else if (a === 'delegate') await delegateScreen();
    else if (a === 'profiles') await profiles(list);
    else if (a === 'gui') { await startGui(); break; }
    else if (a === 'search') {
      const q = await p.text({ message: 'Search' });
      if (p.isCancel(q) || !String(q).trim()) continue;
      const re = String(q).trim().toLowerCase();
      const hits = list.filter((e) => `${e.id} ${e.description} ${e.category}`.toLowerCase().includes(re));
      if (!hits.length) p.log.warn('No match.');
      else await pickAndInstall(hits, 'matches');
    } else if (a === 'inspect') await inspect(list);
    else if (a === 'manage') await manage();
    else if (a === 'tools') await pickAndInstall(tools, 'tools');
    else await pickAndInstall(a === 'quick' ? savers : plugins, a === 'quick' ? 'token savers' : 'plugins and skills');
  }
  p.outro(dim('See you at the tailgate.'));
}
