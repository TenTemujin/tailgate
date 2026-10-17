import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, ensureHome } from './paths.js';

// Windows notification-area icon. It is a hidden PowerShell process (WinForms NotifyIcon), so no native
// dependency is bundled. The icon is the odometer: total tokens saved. An orange block means Gemini is running a job.

export const TRAY_SCRIPT = join(HOME, 'tray.ps1');
const STOP_FILE = join(HOME, 'tray.stop');

const SCRIPT = String.raw`$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Native -Name Icons -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr h);'
$exe = '__EXE__'
$stopFile = '__STOP__'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runCmd = 'powershell.exe -NoProfile -WindowStyle Hidden -STA -ExecutionPolicy Bypass -File "__SCRIPT__"'
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\TailgateTray', [ref]$created)
if (-not $created) { exit }
Remove-Item $stopFile -Force

function Compact($n) {
  if ($n -ge 1000000) { return ('{0:0.0}M' -f ($n / 1000000)) }
  if ($n -ge 10000) { return ('{0:0}k' -f ($n / 1000)) }
  if ($n -ge 1000) { return ('{0:0.0}k' -f ($n / 1000)) }
  return "$n"
}

function New-TrayIcon($text, $active) {
  # Flat mark: ink square, paper numerals, orange bar along the bottom. An orange block in the corner means Gemini is running.
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(21, 23, 26))
  $paper = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(243, 240, 232))
  $signal = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(232, 89, 12))
  $g.FillRectangle($ink, 0, 0, 32, 32)
  $g.FillRectangle($signal, 0, 27, 32, 5)
  if ($text.Length -le 2) { $size = 19 } elseif ($text.Length -eq 3) { $size = 15 } else { $size = 12 }
  $font = New-Object System.Drawing.Font 'Consolas', $size, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $g.DrawString($text, $font, $paper, (New-Object System.Drawing.RectangleF 0, 0, 32, 28), $fmt)
  if ($active) { $g.FillRectangle($signal, 21, 0, 11, 11) }
  $h = $bmp.GetHicon()
  $tmp = [System.Drawing.Icon]::FromHandle($h)
  $icon = $tmp.Clone()
  $tmp.Dispose()
  [Native.Icons]::DestroyIcon($h) | Out-Null
  $g.Dispose(); $bmp.Dispose(); $ink.Dispose(); $paper.Dispose(); $signal.Dispose(); $font.Dispose()
  return $icon
}

$ni = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$mOpen = $menu.Items.Add('Open Tailgate')
$mDel = $menu.Items.Add('Shotgun (Gemini) status')
$null = $menu.Items.Add('-')
$mRtk = $menu.Items.Add('rtk: ...')
$mRtk.Enabled = $false
$mDg = $menu.Items.Add('delegate: ...')
$mDg.Enabled = $false
$null = $menu.Items.Add('-')
$mAuto = New-Object System.Windows.Forms.ToolStripMenuItem 'Start with Windows'
$mAuto.Checked = [bool](Get-ItemProperty -Path $runKey -Name Tailgate)
$null = $menu.Items.Add($mAuto)
$mQuit = $menu.Items.Add('Quit')
$ni.ContextMenuStrip = $menu
$ni.Text = 'Tailgate'
$ni.Icon = New-TrayIcon '...' $false
$ni.Visible = $true

function Open-Gui($tab) {
  $desktop = Join-Path $env:LOCALAPPDATA 'Programs\Tailgate\Tailgate.exe'
  if ((-not $tab) -and (Test-Path $desktop)) { Start-Process -FilePath $desktop; return }
  if ($tab) { Start-Process -FilePath $exe -ArgumentList 'gui', '--tab', $tab -WindowStyle Hidden }
  else { Start-Process -FilePath $exe -ArgumentList 'gui' -WindowStyle Hidden }
}

function Quit-Tray {
  $timer.Stop()
  $ni.Visible = $false
  $ni.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

function Update-Tray {
  $raw = & $exe stats --json 2>$null | Out-String
  $s = $null
  try { $s = $raw | ConvertFrom-Json } catch {}
  if ($s) {
    $total = [long]$s.total
    $active = [bool]$s.delegate.active
    $old = $ni.Icon
    $ni.Icon = New-TrayIcon (Compact $total) $active
    if ($old) { $old.Dispose() }
    $tip = "Tailgate: $(Compact $total) tokens saved"
    if ($active) { $tip += ' | Gemini running' }
    if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
    $ni.Text = $tip
    if ($null -ne $s.rtk.saved) { $rtkTxt = Compact ([long]$s.rtk.saved) } else { $rtkTxt = 'n/a' }
    $mRtk.Text = "rtk (measured): $rtkTxt"
    $dgTxt = "delegate (est.): $(Compact ([long]$s.delegate.saved)), $($s.delegate.jobs) jobs"
    if ($active) { $dgTxt += ", $($s.delegate.running) running" }
    $mDg.Text = $dgTxt
  }
  if (Test-Path $stopFile) { Quit-Tray }
}

$mOpen.Add_Click({ Open-Gui $null })
$mDel.Add_Click({ Open-Gui 'delegate' })
$ni.Add_DoubleClick({ Open-Gui $null })
$mAuto.Add_Click({
  if ($mAuto.Checked) { Remove-ItemProperty -Path $runKey -Name Tailgate; $mAuto.Checked = $false }
  else { Set-ItemProperty -Path $runKey -Name Tailgate -Value $runCmd; $mAuto.Checked = $true }
})
$mQuit.Add_Click({ Quit-Tray })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 10000
$timer.Add_Tick({ Update-Tray })
$timer.Start()
Update-Tray
[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
`;

const q = (s: string) => s.replace(/'/g, "''");

export function writeTrayScript(exe: string): void {
  ensureHome();
  mkdirSync(HOME, { recursive: true });
  const body = SCRIPT.replace('__EXE__', q(exe)).replace('__STOP__', q(STOP_FILE)).replace(/__SCRIPT__/g, TRAY_SCRIPT);
  // PowerShell 5.1 reads a BOM-less file as ANSI, so write a BOM to keep non-ASCII paths intact.
  writeFileSync(TRAY_SCRIPT, '﻿' + body.replace(/\r?\n/g, '\r\n'), 'utf8');
}

export function startTray(exe: string): { ok: boolean; msg: string } {
  if (process.platform !== 'win32') return { ok: false, msg: 'The tray icon is Windows-only for now.' };
  writeTrayScript(exe);
  rmSync(STOP_FILE, { force: true });
  // Start-Process makes a truly independent process. A plain detached spawn from a compiled binary can die with its parent.
  const args = ['-NoProfile', '-WindowStyle', 'Hidden', '-STA', '-ExecutionPolicy', 'Bypass', '-File', `"${TRAY_SCRIPT}"`].map((a) => `'${q(a)}'`).join(',');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList ${args}`], { encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) return { ok: false, msg: `Could not start the tray: ${(r.stderr ?? '').trim().slice(0, 200)}` };
  return { ok: true, msg: 'Tray icon started. Look in the taskbar notification area (click ^ if hidden).' };
}

// Graceful: the tray polls for this file and exits itself, so Windows removes the icon cleanly.
export function stopTray(): void {
  ensureHome();
  writeFileSync(STOP_FILE, '1');
}

export function setAutostart(exe: string, on: boolean): boolean {
  if (process.platform !== 'win32') return false;
  writeTrayScript(exe);
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const cmd = `powershell.exe -NoProfile -WindowStyle Hidden -STA -ExecutionPolicy Bypass -File "${TRAY_SCRIPT}"`;
  const r = on
    ? spawnSync('reg', ['add', key, '/v', 'Tailgate', '/t', 'REG_SZ', '/d', cmd, '/f'], { encoding: 'utf8' })
    : spawnSync('reg', ['delete', key, '/v', 'Tailgate', '/f'], { encoding: 'utf8' });
  return r.status === 0;
}

export const trayScriptExists = () => existsSync(TRAY_SCRIPT);
