import type { Category, Entry } from './types.js';

// Tools that help Claude but are not plugins and not about saving tokens: CLIs, desktop apps and MCP servers.
// Hand-picked; install and update commands live in guides.ts. The score is fixed on purpose: these are curated,
// not discovered, so a GitHub star count would say nothing about how well they fit.

export type ToolKind = 'mcp' | 'app' | 'cli';

interface Tool { id: string; name: string; description: string; category: Category; toolKind: ToolKind }

export const TOOLS: Tool[] = [
  { id: 'morluto/rea', name: 'REA', toolKind: 'cli', category: 'security', description: 'Reverse engineer anything with agents: native binaries, .NET, Electron and web apps. Registers an MCP server with Claude.' },
  { id: 'NationalSecurityAgency/ghidra', name: 'Ghidra', toolKind: 'app', category: 'security', description: 'Software reverse engineering suite from the NSA. The analysis engine behind REA.' },
  { id: 'microsoft/playwright-mcp', name: 'Playwright MCP', toolKind: 'mcp', category: 'browser', description: 'Lets Claude drive a real browser: open pages, click, fill forms, read the result.' },
  { id: 'upstash/context7', name: 'Context7', toolKind: 'mcp', category: 'docs', description: 'Gives Claude current documentation for the libraries you use, so it stops guessing old APIs.' },
  { id: 'cli/cli', name: 'GitHub CLI', toolKind: 'cli', category: 'dev', description: 'Pull requests, issues and releases from the terminal. Claude uses it for most GitHub work.' },
  { id: 'BurntSushi/ripgrep', name: 'ripgrep', toolKind: 'cli', category: 'dev', description: 'Very fast code search. Claude Code leans on it, and it is much faster than the fallback.' },
  { id: 'astral-sh/uv', name: 'uv', toolKind: 'cli', category: 'dev', description: 'Fast Python package and tool manager. Needed by several Claude tools, including Graphify.' },
];

export function toolEntry(t: Tool): Entry {
  return {
    id: t.id, description: `${t.name}. ${t.description}`, stars: 0, pushedAt: '', license: null, kind: 'tool', category: t.category,
    tokenSaver: false, score: 80, tier: 'A', curated: true,
  };
}

// Catalog = scraped plugins and skills + the curated tools (never duplicated).
export function withTools(entries: Entry[]): Entry[] {
  const have = new Set(entries.map((e) => e.id.toLowerCase()));
  const extra = TOOLS.filter((t) => !have.has(t.id.toLowerCase())).map(toolEntry);
  // A scraped repo that is also a curated tool (REA, uv) becomes a tool: it is not a Claude plugin.
  const upgraded = entries.map((e) => (TOOLS.some((t) => t.id.toLowerCase() === e.id.toLowerCase()) && e.kind === 'unknown'
    ? { ...toolEntry(TOOLS.find((t) => t.id.toLowerCase() === e.id.toLowerCase())!), stars: e.stars, pushedAt: e.pushedAt, license: e.license }
    : e));
  return [...upgraded, ...extra];
}
