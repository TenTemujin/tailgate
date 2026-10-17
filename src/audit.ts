import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Audit, Finding, Level } from './types.js';

interface Rule { id: string; severity: Finding['severity']; re: RegExp; files?: RegExp; hookOnly?: boolean }

const SCRIPT = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts)$/i;
const CONFIG = /(^|\/)(hooks?\.json|settings\.json|plugin\.json|marketplace\.json|package\.json|\.mcp\.json)$/i;

// High = code that fetches-and-runs, steals credentials or wipes disks. Warn = network or install-time execution.
export const RULES: Rule[] = [
  { id: 'curl-pipe-shell', severity: 'high', re: /(curl|wget|iwr|Invoke-WebRequest)\b[^\n|;]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|Invoke-Expression|pwsh|powershell)\b/i, hookOnly: true },
  { id: 'remote-eval', severity: 'high', re: /\b(eval|new Function|exec)\s*\([^)\n]*(fetch|https?:|atob|base64|requests\.)/i, files: SCRIPT, hookOnly: true },
  { id: 'base64-exec', severity: 'high', re: /(base64\s+(-d|--decode)|atob\(|b64decode|FromBase64String)[^\n]*(\|\s*(sh|bash)|\beval\b|\bexec\b|iex|Invoke-Expression)/i, hookOnly: true },
  { id: 'encoded-powershell', severity: 'high', re: /-enc(odedcommand)?\s+[A-Za-z0-9+/=]{40,}/i, hookOnly: true },
  // A credential path alone is just a string (deny-lists, secret scanners). It matters when the same line reads or sends it.
  { id: 'credential-read', severity: 'high', re: /(read(File|Text)?(Sync)?|open\(|Get-Content|\bcat\b|\bcp\b|\bscp\b|copy|upload|curl|fetch|send)[^\n]*(\.ssh[\/](id_|known_hosts)|\.aws[\/]credentials|\.git-credentials|\.netrc|\.config[\/]gh[\/]hosts|Login Data|keychain-db|wallet\.dat)/i, files: SCRIPT, hookOnly: true },
  { id: 'destructive', severity: 'high', re: /(rm\s+-rf\s+(\/(?!tmp)|~|\$HOME|"\$HOME")|Remove-Item[^\n]*-Recurse[^\n]*(\$HOME|\$env:USERPROFILE|C:\\?\s*["']?$)|format\s+[a-z]:|mkfs\.)/i, files: /\.(sh|bash|zsh|ps1|bat|cmd)$|(^|\/)hooks?\.json$/i, hookOnly: true },
  { id: 'network-call', severity: 'warn', re: /\b(fetch\(|axios\.|requests\.(get|post|put)|urllib\.request|http\.request|https\.request|socket\.connect|Invoke-RestMethod|Invoke-WebRequest|curl\s+-|wget\s)/i, files: SCRIPT },
  { id: 'install-script', severity: 'warn', re: /"(preinstall|install|postinstall)"\s*:\s*"[^"]+"/, files: /package\.json$/i },
  { id: 'hook-command', severity: 'info', re: /"command"\s*:\s*"[^"]+"/, files: /(^|\/)hooks?\.json$|plugin\.json$/i },
  { id: 'secret-env', severity: 'info', re: /(process\.env\.|os\.environ\[?|\$env:)[A-Z_]*(TOKEN|SECRET|PASSWORD|API_?KEY)/i, files: SCRIPT },
];

// Code that runs by itself: hook configs and anything under a hooks/ folder. Fetch-and-run there is high risk; in an
// installer or docs-style script the user runs on purpose, it is only worth a note.
export const isHookPath = (rel: string) => /(^|\/)hooks?(\/|\.json$)/i.test(rel);
const COMMENT = /^\s*(#|\/\/|\*|\/\*|--|<!--|REMb|;;?\s)/i;

const SKIP_DIR = /^(\.git|\.claude|node_modules|dist|build|vendor|__pycache__|\.venv|venv|tests?|__tests__|docs?|examples?|fixtures?|assets|coverage)$/i;
const MAX_FILE = 512 * 1024;
const MAX_FILES = 3000;

// Text, not behavior: a message passed to echo/printf, or a line inside a Python docstring.
const ECHO_BEFORE = /\b(echo|printf|Write-Host|Write-Output|console\.(log|error|warn))\b[^|;&]*['"`]?[^|;&]*\b(curl|wget|iwr|rm\s+-rf|base64)\b/i;
export const isProse = (line: string) => ECHO_BEFORE.test(line);

const TEST_FILE = /(^|\/)([^/]*[._-](test|spec)\.[a-z]+|test_[^/]+|[^/]*_test\.[a-z]+|conftest\.py)$/i;

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) break;
    const p = join(dir, name.name);
    if (name.isDirectory()) { if (!SKIP_DIR.test(name.name)) walk(root, p, out); continue; }
    if (name.isFile() && (SCRIPT.test(name.name) || CONFIG.test(p.replace(/\\/g, '/')))) out.push(p);
  }
  return out;
}

export function levelOf(counts: Audit['counts']): Level {
  return counts.high ? 'risky' : counts.warn ? 'notes' : 'clean';
}

// Scan a directory that is already on disk. Pure and fast, so it is what the tests exercise.
export function scanDir(root: string): Audit {
  const findings: Finding[] = [];
  const files = walk(root);
  for (const f of files) {
    let text: string;
    try { if (statSync(f).size > MAX_FILE) continue; text = readFileSync(f, 'utf8'); } catch { continue; }
    const rel = relative(root, f).replace(/\\/g, '/');
    const lines = text.split('\n');
    // Mark Python docstring lines so examples inside them are not read as code.
    const inDoc = new Array<boolean>(lines.length).fill(false);
    if (rel.endsWith('.py')) {
      let open = false;
      lines.forEach((l, i) => {
        const n = (l.match(/"""|'''/g) ?? []).length;
        inDoc[i] = open || n > 0;
        if (n % 2 === 1) open = !open;
      });
    }
    for (const rule of RULES) {
      if (rule.files && !rule.files.test(rel)) continue;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 4000) continue; // minified blobs: not reviewable, skip
        if (rule.re.test(lines[i])) {
          // Mentions in comments are documentation, not behavior. Hook configs are JSON so they are never skipped.
          if ((COMMENT.test(lines[i]) || inDoc[i] || isProse(lines[i])) && rule.severity !== 'info') continue;
          const severity = rule.hookOnly && rule.severity === 'high' && !isHookPath(rel) ? 'warn' : rule.severity;
          findings.push({ severity, rule: rule.id, file: rel, line: i + 1, snippet: lines[i].trim().slice(0, 140) });
          if (findings.filter((x) => x.rule === rule.id && x.file === rel).length >= 3) break; // cap noise per file
        }
      }
    }
  }
  const counts = { info: 0, warn: 0, high: 0 };
  findings.forEach((f) => counts[f.severity]++);
  const order = { high: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { level: levelOf(counts), at: new Date().toISOString(), files: files.length, counts, findings: findings.slice(0, 12) };
}

// Shallow-clone a GitHub repo into a temp dir, scan it, and always clean up.
export function auditRepo(id: string): Audit | null {
  if (!/^[\w.-]+\/[\w.-]+$/.test(id)) return null;
  const dir = mkdtempSync(join(tmpdir(), 'tailgate-audit-'));
  try {
    const r = spawnSync('git', ['clone', '--depth', '1', '--quiet', '--no-tags', `https://github.com/${id}.git`, join(dir, 'r')], {
      encoding: 'utf8', timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
    });
    if (r.status !== 0) return null;
    return scanDir(join(dir, 'r'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
