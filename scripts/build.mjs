// Build single-file binaries with Bun. Usage: node scripts/build.mjs [all]
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Bundle the freshest scraped catalog as the offline snapshot.
const local = join(homedir(), '.tailgate', 'catalog.json');
if (existsSync(local) && !process.env.KEEP_SNAPSHOT) copyFileSync(local, 'src/snapshot.json');

mkdirSync('dist', { recursive: true });
const targets = process.argv[2] === 'all'
  ? [
      ['bun-windows-x64', 'tailgate-windows-x64.exe'],
      ['bun-linux-x64', 'tailgate-linux-x64'],
      ['bun-darwin-arm64', 'tailgate-macos-arm64'],
      ['bun-darwin-x64', 'tailgate-macos-x64'],
    ]
  : [[null, process.platform === 'win32' ? 'tailgate.exe' : 'tailgate']];

for (const [target, out] of targets) {
  const args = ['build', 'src/cli.ts', '--compile', '--minify', '--outfile', join('dist', out), ...(target ? ['--target', target] : [])];
  const r = spawnSync('bun', args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
