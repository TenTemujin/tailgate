import * as p from '@clack/prompts';
import { load, save, loadReport } from './catalog.js';
import { scrape } from './github.js';
import { install, pluginCmd, installedPlugins } from './claude.js';
import { banner, bar, bold, cyan, dim, green, mag, red, stars, yellow, gradient } from './theme.js';
import { maybeInstall } from './setup.js';
import type { Entry, Tier } from './types.js';

const TIER: Record<Tier, (s: string) => string> = { S: mag, A: green, B: yellow };
const tier = (e: Entry) => TIER[e.tier](`[${e.tier}]`);

const badge = (e: Entry) =>
  [e.curated ? mag('◆ curated') : '', e.tokenSaver ? green('⚡ ' + e.category) : cyan(e.category), cyan(e.kind === 'marketplace' ? 'plugin' : 'skill')]
    .filter(Boolean).join(' · ');

const label = (e: Entry) =>
  `${tier(e)} ${e.id.padEnd(34)} ${bar(e.score)} ${String(e.score).padStart(3)}  ${stars(e.stars)}${e.kind === 'unknown' ? dim('  manual') : ''}`;

export async function refresh() {
  const s = p.spinner();
  s.start('Scraping GitHub for the best skills & plugins');
  let res;
  try {
    res = await scrape((m) => s.message(dim(m.slice(0, 60))));
  } catch (e) {
    s.stop(red('✘ ' + (e as Error).message));
    return load();
  }
  save(res);
  const rej = Object.entries(res.report.rejectedByReason).map(([k, v]) => `${v} ${k}`).join(', ');
  s.stop(`${green('✔')} kept ${bold(String(res.entries.length))} of ${res.report.candidates} · ${dim('rejected: ' + rej)}`);
  return res.entries;
}

function showDetail(e: Entry) {
  p.note(
    [
      e.description,
      '',
      `${dim('quality ')} ${bar(e.score, 20)} ${e.score}/100  ${tier(e)}`,
      `${dim('stars   ')} ${stars(e.stars)}   ${dim('license')} ${e.license ?? yellow('none')}`,
      `${dim('updated ')} ${e.pushedAt.slice(0, 10)}`,
      e.plugins?.length ? `${dim('plugins ')} ${e.plugins.join(', ')}` : '',
      '',
      badge(e),
      dim(`https://github.com/${e.id}`),
    ].join('\n'),
    gradient(e.id),
  );
}

async function installMany(list: Entry[]) {
  if (list.some((e) => !e.curated)) p.log.warn(yellow('Community repos are scored, not manually vetted. Review code before trusting.'));
  for (const e of list) {
    const s = p.spinner();
    s.start(`Installing ${e.id}`);
    const r = install(e);
    s.stop(r.ok ? `${green('✔')} ${e.id}` : `${red('✘')} ${e.id}: ${r.out.slice(0, 120)}`);
  }
  p.log.info('Restart Claude Code to apply.');
}

// One-step install: space toggles, enter installs the whole selection.
async function pickAndInstall(items: Entry[]) {
  const sel = await p.multiselect({
    message: `${items.length} ranked by quality · ${dim('space = select, enter = install')}`,
    maxItems: 12,
    required: false,
    initialValues: items.filter((e) => e.curated && e.kind !== 'unknown').map((e) => e.id),
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
      options: [...items.map((e) => ({ value: e.id, label: label(e) })), { value: '__back', label: dim('← back') }],
    });
    if (p.isCancel(pick) || pick === '__back') return;
    const e = items.find((x) => x.id === pick)!;
    showDetail(e);
    const ok = await p.confirm({ message: `Install ${e.id}?` });
    if (!p.isCancel(ok) && ok) await installMany([e]);
  }
}

async function manage() {
  for (;;) {
    const list = installedPlugins();
    if (!list.length) return void p.log.info('Nothing installed.');
    const pick = await p.select({
      message: `Installed (${list.length})`,
      maxItems: 12,
      options: [
        ...list.map((x) => ({ value: x.id, label: `${x.enabled ? green('●') : red('○')} ${x.id.padEnd(38)} ${dim('v' + x.version)}` })),
        { value: '__back', label: dim('← back') },
      ],
    });
    if (p.isCancel(pick) || pick === '__back') return;
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
  console.log(banner());
  p.intro(gradient(' tailgate '));
  await maybeInstall();
  let list = load();
  if (!list.length) list = await refresh();
  else {
    const rep = loadReport();
    if (rep) p.log.info(dim(`catalog: ${list.length} entries · scraped ${rep.at.slice(0, 16).replace('T', ' ')}`));
  }
  for (;;) {
    const savers = list.filter((e) => e.tokenSaver);
    const a = await p.select({
      message: 'What now?',
      options: [
        { value: 'quick', label: '⚡ Install token savers', hint: `${savers.length} ranked · multi-select` },
        { value: 'all', label: '✦ Install from everything', hint: `${list.length} ranked` },
        { value: 'inspect', label: '🔍 Inspect details' },
        { value: 'manage', label: '⚙ Manage installed', hint: 'enable · disable · update · cost' },
        { value: 'refresh', label: '↻ Re-scrape catalog' },
        { value: 'quit', label: 'Quit' },
      ],
    });
    if (p.isCancel(a) || a === 'quit') break;
    if (a === 'refresh') list = await refresh();
    else if (a === 'manage') await manage();
    else if (a === 'inspect') await inspect(list);
    else await pickAndInstall(a === 'quick' ? savers : list);
  }
  p.outro(gradient('see you at the tailgate'));
}
