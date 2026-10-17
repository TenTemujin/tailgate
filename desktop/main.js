'use strict';
// Tailgate desktop: a window around the Tailgate binary. The binary does all the work (catalog, installs, updates,
// scans) and serves the interface on 127.0.0.1 with a per-session token. This file only starts it and shows it.
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const exeName = process.platform === 'win32' ? 'tailgate.exe' : 'tailgate';
const URL_RE = /http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/;

let win = null;
let server = null;
let origin = '';
let quitting = false;

// Packaged: the binary sits in resources next to the app. Dev: use ../dist, then fall back to PATH.
function backendPath() {
  const bundled = path.join(process.resourcesPath, exeName);
  if (app.isPackaged && fs.existsSync(bundled)) return bundled;
  const dev = path.join(__dirname, '..', 'dist', exeName);
  if (fs.existsSync(dev)) return dev;
  return exeName;
}

function startBackend() {
  return new Promise((resolve, reject) => {
    const child = spawn(backendPath(), ['gui', '--no-open'], {
      windowsHide: true,
      env: { ...process.env, TAILGATE_NOPAUSE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server = child;
    let out = '';
    const timer = setTimeout(() => reject(new Error('The Tailgate backend did not start within 40 seconds.')), 40_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(URL_RE);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Could not run ${backendPath()}: ${e.message}`)); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!quitting) reject(new Error(`The backend stopped (exit ${code}).\n${out.slice(-400)}`));
    });
  });
}

const isHttps = (u) => /^https:\/\//i.test(u);

function openWindow(url) {
  origin = new URL(url).origin;
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'Tailgate',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#F3F0E8',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // Links to GitHub and friends open in the real browser; the window itself never leaves our own origin.
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (isHttps(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, u) => {
    if (new URL(u).origin !== origin) { e.preventDefault(); if (isHttps(u)) shell.openExternal(u); }
  });
  win.loadURL(url);
}

function buildMenu() {
  const dev = !app.isPackaged;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'View', submenu: [{ role: 'reload' }, ...(dev ? [{ role: 'toggleDevTools' }] : []), { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'editMenu' },
  ]));
}

function stopBackend() {
  quitting = true;
  if (server && !server.killed) { try { server.kill(); } catch { /* already gone */ } }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', stopBackend);

  app.whenReady().then(async () => {
    buildMenu();
    try {
      openWindow(await startBackend());
    } catch (e) {
      dialog.showErrorBox('Tailgate could not start', String(e.message || e));
      stopBackend();
      app.quit();
    }
  });
}
