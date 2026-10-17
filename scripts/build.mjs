// Build single-file binaries with Bun. Usage: node scripts/build.mjs [all]
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Bundle the freshest scraped catalog as the offline snapshot.
const local = join(homedir(), '.tailgate', 'catalog.json');
if (existsSync(local) && !process.env.KEEP_SNAPSHOT) copyFileSync(local, 'src/snapshot.json');

spawnSync('node', ['scripts/gen-page.mjs'], { stdio: 'inherit' });
mkdirSync('dist', { recursive: true });
const targets = process.argv[2] === 'all'
  ? [
      // Bun can only embed the icon and version info when running on Windows, so other hosts skip this target.
      ...(process.platform === 'win32' ? [['bun-windows-x64', 'tailgate-windows-x64.exe']] : []),
      ['bun-linux-x64', 'tailgate-linux-x64'],
      ['bun-darwin-arm64', 'tailgate-macos-arm64'],
      ['bun-darwin-x64', 'tailgate-macos-x64'],
    ]
  : [[null, process.platform === 'win32' ? 'tailgate.exe' : 'tailgate']];

const version = readFileSync('src/version.ts', 'utf8').match(/VERSION = '([\d.]+)'/)?.[1] ?? '0.0.0';
// Windows resources (icon, product name, version) only apply to Windows targets.
const winMeta = ['--windows-icon', 'assets/icon.ico', '--windows-title', 'Tailgate', '--windows-publisher', 'Thiago Ferreira',
  '--windows-version', `${version}.0`, '--windows-description', 'Skills and plugins manager for Claude Code'];

for (const [target, out] of targets) {
  const isWin = target ? target.includes('windows') : process.platform === 'win32';
  const args = ['build', 'src/cli.ts', '--compile', '--minify', '--outfile', join('dist', out), ...(target ? ['--target', target] : []), ...(isWin ? winMeta : [])];
  const r = spawnSync('bun', args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
