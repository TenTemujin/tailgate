import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { green, dim } from './theme.js';

const win = process.platform === 'win32';
const exeName = win ? 'tailgate.exe' : 'tailgate';
const INSTALL_DIR = win
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Tailgate')
  : join(homedir(), '.local', 'bin');
const TARGET = join(INSTALL_DIR, exeName);

// True only for the compiled binary, never for `node`/`bun` running the sources.
export const isCompiled = () => basename(process.execPath).toLowerCase().startsWith('tailgate');
const isInstalled = () => dirname(process.execPath).toLowerCase() === INSTALL_DIR.toLowerCase();

const ps = (script: string) =>
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });

function addToPath() {
  if (!win) return;
  ps(`$d='${INSTALL_DIR}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not ($p -split ';' | Where-Object { $_ -eq $d })){[Environment]::SetEnvironmentVariable('Path',($p.TrimEnd(';')+';'+$d),'User')}`);
}

function shortcut(where: 'Programs' | 'Desktop') {
  if (!win) return;
  ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('${where}')) 'Tailgate.lnk')); $s.TargetPath='${TARGET}'; $s.WorkingDirectory='${INSTALL_DIR}'; $s.Save()`);
}

export function installSelf() {
  mkdirSync(INSTALL_DIR, { recursive: true });
  copyFileSync(process.execPath, TARGET);
  addToPath();
  shortcut('Programs');
  shortcut('Desktop');
}

export function uninstallSelf() {
  if (win) {
    ps(`$d='${INSTALL_DIR}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); [Environment]::SetEnvironmentVariable('Path',(($p -split ';' | Where-Object { $_ -and $_ -ne $d }) -join ';'),'User'); foreach($w in 'Programs','Desktop'){Remove-Item (Join-Path ([Environment]::GetFolderPath($w)) 'Tailgate.lnk') -ErrorAction SilentlyContinue}`);
  }
  // A running exe is locked on Windows, so removal of the binary itself can fail.
  try { rmSync(TARGET, { force: true }); } catch { /* locked */ }
  console.log(green('Tailgate removed.'), dim(existsSync(TARGET) ? `Delete ${INSTALL_DIR} manually.` : ''));
}

// First double-click from anywhere else: offer a one-key automatic install.
export async function maybeInstall(): Promise<boolean> {
  if (!isCompiled() || isInstalled()) return false;
  const yes = await p.confirm({
    message: `Install Tailgate to ${INSTALL_DIR} (PATH + Start Menu + Desktop shortcut)?`,
    initialValue: true,
  });
  if (p.isCancel(yes) || !yes) return false;
  installSelf();
  p.log.success(`Installed. Open ${green('Tailgate')} from the Desktop or type ${green('tailgate')} in any terminal.`);
  return true;
}
