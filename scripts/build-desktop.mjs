// Builds the Windows desktop app: the Tailgate binary (backend) wrapped in an Electron window, packaged as an installer.
// Usage: node scripts/build-desktop.mjs [--skip-binary]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error(`${cmd} ${args.join(' ')} failed`); process.exit(r.status ?? 1); }
};

const version = readFileSync('src/version.ts', 'utf8').match(/VERSION = '([\d.]+)'/)?.[1];
if (!version) throw new Error('could not read the version from src/version.ts');

if (!process.argv.includes('--skip-binary')) run('node', ['scripts/build.mjs'], '.');
const exe = process.platform === 'win32' ? 'tailgate.exe' : 'tailgate';
if (!existsSync(join('dist', exe))) throw new Error(`dist/${exe} is missing. Build the binary first.`);

// Backend goes into desktop/backend, and electron-builder copies that folder into the app resources.
mkdirSync('desktop/backend', { recursive: true });
copyFileSync(join('dist', exe), join('desktop/backend', exe));

// Keep the shell and the binary on one version number.
const pkgPath = 'desktop/package.json';
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

run('npx', ['electron-builder', '--win', '--x64', '--publish', 'never'], 'desktop');
console.log(`\nInstaller: desktop/out/Tailgate-Setup-${version}.exe`);
