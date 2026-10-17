import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claude } from './claude.js';

// Guided install and update for things that are not Claude Code plugins: CLIs, desktop apps and MCP servers.
// Every command comes from the project's own documentation and is a static argument list. Tailgate runs the first
// option whose prerequisite exists, and never pipes a remote script into a shell.

export interface Option {
  label: string;
  platforms?: NodeJS.Platform[];
  needs: string; // executable that must be on PATH
  steps: { cmd: string; args: string[] }[];
  // Only update when this manager really installed the tool. Otherwise an upgrade could create a second copy.
  owns?: { cmd: string; args: string[]; match: string };
}

// How to tell the tool is already on this machine.
export type Detect = { kind: 'cmd'; cmd: string } | { kind: 'env-dir'; env: string } | { kind: 'mcp'; name: string };

export interface Guide {
  repo: string;
  title: string;
  options: Option[];
  update?: Option[]; // absent = nothing to do (for example an MCP server launched with npx @latest)
  detect?: Detect;
  interactive?: boolean; // asks questions, so it needs a real terminal
  manual: string;
  after?: string;
}

export const GUIDES: Guide[] = [
  {
    repo: 'rtk-ai/rtk',
    title: 'RTK (token-saving CLI proxy)',
    detect: { kind: 'cmd', cmd: 'rtk' },
    options: [
      { label: 'winget', platforms: ['win32'], needs: 'winget', steps: [{ cmd: 'winget', args: ['install', '-e', '--id', 'rtk-ai.rtk'] }] },
      { label: 'Homebrew', platforms: ['darwin', 'linux'], needs: 'brew', steps: [{ cmd: 'brew', args: ['install', 'rtk'] }] },
    ],
    update: [
      { label: 'winget', platforms: ['win32'], needs: 'winget', steps: [{ cmd: 'winget', args: ['upgrade', '-e', '--id', 'rtk-ai.rtk'] }] },
      { label: 'Homebrew', platforms: ['darwin', 'linux'], needs: 'brew', steps: [{ cmd: 'brew', args: ['upgrade', 'rtk'] }] },
    ],
    manual: 'https://github.com/rtk-ai/rtk#installation',
    after: 'Hook it into Claude Code by following the RTK installation guide.',
  },
  {
    repo: 'Graphify-Labs/graphify',
    title: 'Graphify (code knowledge graph)',
    detect: { kind: 'cmd', cmd: 'graphify' },
    options: [
      { label: 'uv', needs: 'uv', steps: [{ cmd: 'uv', args: ['tool', 'install', 'graphifyy'] }, { cmd: 'graphify', args: ['install'] }] },
      { label: 'pipx', needs: 'pipx', steps: [{ cmd: 'pipx', args: ['install', 'graphifyy'] }, { cmd: 'graphify', args: ['install'] }] },
    ],
    update: [
      { label: 'uv', needs: 'uv', steps: [{ cmd: 'uv', args: ['tool', 'upgrade', 'graphifyy'] }] },
      { label: 'pipx', needs: 'pipx', steps: [{ cmd: 'pipx', args: ['upgrade', 'graphifyy'] }] },
    ],
    manual: 'https://github.com/Graphify-Labs/graphify#install',
  },
  {
    repo: 'morluto/rea',
    title: 'REA (reverse engineering for agents)',
    detect: { kind: 'cmd', cmd: 'rea' },
    interactive: true,
    options: [{ label: 'npm', needs: 'npx', steps: [{ cmd: 'npx', args: ['rea-agents', 'setup'] }] }],
    update: [{ label: 'npm', needs: 'npm', steps: [{ cmd: 'npm', args: ['install', '--global', 'rea-agents@latest'] }] }],
    manual: 'https://github.com/morluto/rea#readme',
    after: 'Run `rea doctor` to check that your analysis engine (Ghidra, Hopper or IDA) is found.',
  },
  {
    repo: 'NationalSecurityAgency/ghidra',
    title: 'Ghidra (software reverse engineering suite)',
    detect: { kind: 'env-dir', env: 'GHIDRA_INSTALL_DIR' },
    options: [
      { label: 'Chocolatey', platforms: ['win32'], needs: 'choco', steps: [{ cmd: 'choco', args: ['install', 'ghidra', '-y'] }] },
      { label: 'Homebrew', platforms: ['darwin'], needs: 'brew', steps: [{ cmd: 'brew', args: ['install', '--cask', 'ghidra'] }] },
    ],
    update: [
      {
        label: 'Chocolatey', platforms: ['win32'], needs: 'choco', steps: [{ cmd: 'choco', args: ['upgrade', 'ghidra', '-y'] }],
        owns: { cmd: 'choco', args: ['list', '--local-only', '--limit-output', 'ghidra'], match: 'ghidra|' },
      },
      {
        label: 'Homebrew', platforms: ['darwin'], needs: 'brew', steps: [{ cmd: 'brew', args: ['upgrade', '--cask', 'ghidra'] }],
        owns: { cmd: 'brew', args: ['list', '--cask', 'ghidra'], match: '' },
      },
    ],
    manual: 'https://github.com/NationalSecurityAgency/ghidra/releases',
    after: 'Ghidra needs JDK 21. Set GHIDRA_INSTALL_DIR to the install folder so other tools can find it. Chocolatey needs an elevated terminal.',
  },
  {
    repo: 'microsoft/playwright-mcp',
    title: 'Playwright MCP (browser control for Claude)',
    detect: { kind: 'mcp', name: 'playwright' },
    options: [{ label: 'claude mcp', needs: 'claude', steps: [{ cmd: 'claude', args: ['mcp', 'add', 'playwright', 'npx', '@playwright/mcp@latest'] }] }],
    manual: 'https://github.com/microsoft/playwright-mcp#getting-started',
    after: 'Launched through npx @latest, so it updates itself each time Claude starts it.',
  },
  {
    repo: 'upstash/context7',
    title: 'Context7 (current library docs for Claude)',
    detect: { kind: 'mcp', name: 'context7' },
    options: [{ label: 'claude mcp', needs: 'claude', steps: [{ cmd: 'claude', args: ['mcp', 'add', 'context7', '--', 'npx', '-y', '@upstash/context7-mcp'] }] }],
    manual: 'https://github.com/upstash/context7#installation',
    after: 'Launched through npx, so it fetches the latest release when Claude starts it.',
  },
  {
    repo: 'cli/cli',
    title: 'GitHub CLI (pull requests and issues from the terminal)',
    detect: { kind: 'cmd', cmd: 'gh' },
    options: [
      { label: 'winget', platforms: ['win32'], needs: 'winget', steps: [{ cmd: 'winget', args: ['install', '-e', '--id', 'GitHub.cli'] }] },
      { label: 'Homebrew', platforms: ['darwin', 'linux'], needs: 'brew', steps: [{ cmd: 'brew', args: ['install', 'gh'] }] },
    ],
    update: [
      { label: 'winget', platforms: ['win32'], needs: 'winget', steps: [{ cmd: 'winget', args: ['upgrade', '-e', '--id', 'GitHub.cli'] }] },
      { label: 'Homebrew', platforms: ['darwin', 'linux'], needs: 'brew', steps: [{ cmd: 'brew', args: ['upgrade', 'gh'] }] },
    ],
    manual: 'https://github.com/cli/cli#installation',
  },
  {
    repo: 'BurntSushi/ripgrep',
    title: 'ripgrep (fast code search)',
    detect: { kind: 'cmd', cmd: 'rg' },
    options: [
      { label: 'winget', platforms: ['win32'], needs: 'winget', steps: [{ cmd: 'winget', args: ['install', '-e', '--id', 'BurntSushi.ripgrep.MSVC'] }] },
      { label: 'Homebrew', platforms: ['darwin', 'linux'], needs: 'brew', steps: [{ cmd: 'brew', args: ['install', 'ripgrep'] }] },
    ],
    update: [
      { label: 'winget', platforms: ['win32'], needs: 'winget', steps: [{ cmd: 'winget', args: ['upgrade', '-e', '--id', 'BurntSushi.ripgrep.MSVC'] }] },
      { label: 'Homebrew', platforms: ['darwin', 'linux'], needs: 'brew', steps: [{ cmd: 'brew', args: ['upgrade', 'ripgrep'] }] },
    ],
    manual: 'https://github.com/BurntSushi/ripgrep#installation',
  },
  {
    repo: 'astral-sh/uv',
    title: 'uv (fast Python package and tool manager)',
    detect: { kind: 'cmd', cmd: 'uv' },
    options: [
      { label: 'winget', platforms: ['win32'], needs: 'winget', steps: [{ cmd: 'winget', args: ['install', '-e', '--id', 'astral-sh.uv'] }] },
      { label: 'Homebrew', platforms: ['darwin', 'linux'], needs: 'brew', steps: [{ cmd: 'brew', args: ['install', 'uv'] }] },
    ],
    update: [
      { label: 'self-update', needs: 'uv', steps: [{ cmd: 'uv', args: ['self', 'update'] }] },
    ],
    manual: 'https://docs.astral.sh/uv/getting-started/installation/',
  },
];

export const guideFor = (repo: string) => GUIDES.find((g) => g.repo.toLowerCase() === repo.toLowerCase());

export function has(cmd: string): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

// Pure choice of option, so tests can inject `exists`.
export function pickOption(options: Option[], platform: NodeJS.Platform, exists: (c: string) => boolean): Option | null {
  return options.find((o) => (!o.platforms || o.platforms.includes(platform)) && exists(o.needs)) ?? null;
}

export function describe(o: Option): string[] {
  return o.steps.map((s) => [s.cmd, ...s.args].join(' '));
}

// `claude mcp list` health-checks every server and takes many seconds, so read the config file instead.
// User-scope servers are top-level in ~/.claude.json; project-scope ones sit under projects[path].
let mcpCache: { at: number; names: Set<string> } | null = null;
function mcpNames(): Set<string> {
  if (mcpCache && Date.now() - mcpCache.at < 15_000) return mcpCache.names;
  const names = new Set<string>();
  try {
    const f = join(homedir(), '.claude.json');
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      Object.keys(j.mcpServers ?? {}).forEach((n) => names.add(n));
      for (const proj of Object.values<any>(j.projects ?? {})) Object.keys(proj?.mcpServers ?? {}).forEach((n) => names.add(n));
    }
  } catch { /* unreadable config: report not installed */ }
  mcpCache = { at: Date.now(), names };
  return names;
}

export function isToolInstalled(g: Guide): boolean {
  const d = g.detect;
  if (!d) return false;
  if (d.kind === 'cmd') return has(d.cmd);
  if (d.kind === 'env-dir') { const v = process.env[d.env]; return !!v && existsSync(v); }
  return mcpNames().has(d.name);
}

// `npm` and `npx` are .cmd shims on Windows, so they need a shell. The arguments are static strings from this file.
const NEEDS_SHELL = new Set(['npm', 'npx']);

export interface RunResult { ok: boolean; out: string }

export function runOption(o: Option, inherit = false): RunResult {
  let out = '';
  for (const s of o.steps) {
    const line = [s.cmd, ...s.args].join(' ');
    if (s.cmd === 'claude') {
      const r = claude(s.args);
      out += `${line}\n${r.out}\n`;
      if (!r.ok) return { ok: false, out: out.trim() };
      continue;
    }
    const r = spawnSync(s.cmd, s.args, {
      encoding: 'utf8', timeout: 10 * 60_000, stdio: inherit ? 'inherit' : 'pipe',
      shell: process.platform === 'win32' && NEEDS_SHELL.has(s.cmd),
    });
    out += `${line}\n${(r.stdout ?? '') + (r.stderr ?? '')}`.trim() + '\n';
    if (r.status !== 0) return { ok: false, out: out.trim() };
  }
  return { ok: true, out: out.trim() };
}

export function runGuide(g: Guide, opts: { inherit?: boolean } = {}): RunResult {
  const o = pickOption(g.options, process.platform, has);
  if (!o) return { ok: false, out: `No supported installer found (${g.options.map((x) => x.needs).join(' or ')}). Install manually: ${g.manual}` };
  if (g.interactive && !opts.inherit) {
    return { ok: false, out: `This installer asks questions, so run it in a terminal:\n  ${describe(o).join('\n  ')}` };
  }
  return runOption(o, opts.inherit);
}

export function runUpdate(g: Guide): RunResult & { skipped?: boolean } {
  if (!g.update) return { ok: true, skipped: true, out: g.after ?? 'Nothing to update.' };
  const o = pickOption(g.update, process.platform, has);
  if (!o) return { ok: false, out: `No supported updater found (${g.update.map((x) => x.needs).join(' or ')}). See ${g.manual}` };
  if (o.owns) {
    const r = spawnSync(o.owns.cmd, o.owns.args, { encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0 || !(r.stdout ?? '').includes(o.owns.match)) {
      return { ok: true, skipped: true, out: `Installed outside ${o.label}, so Tailgate will not touch it. Update it where you installed it: ${g.manual}` };
    }
  }
  return runOption(o);
}
