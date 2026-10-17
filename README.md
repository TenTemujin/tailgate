<p align="center">
  <img src="assets/icon-256.png" width="96" alt="Tailgate">
</p>

<h1 align="center">tailgate</h1>
<p align="center"><em>don't tailgate your context</em></p>

Tailgate finds, installs and updates the things that make Claude Code better, and keeps count of the tokens they save. It is one small binary: a terminal interface, a clickable browser interface, and an odometer in the Windows taskbar.

The name is the truck part, the party, and the driving mistake. A tailgate is the flat shelf where you lay out what you carry. Following the car ahead too closely is what an overfull context window feels like. Hence: load light.

## What is in it

| Where | What |
| --- | --- |
| **Spread** | Plugins and skills, ranked. Token savers first, then everything else that helps. |
| **Toolbox** | Not plugins and not about tokens: REA, Ghidra, Playwright MCP, Context7, GitHub CLI, ripgrep, uv. |
| **Bed** | What you have installed, with the context each plugin adds to every session. |
| **Loadouts** | `minimal`, `balanced`, `max-savings`, or your own. Global, or for one project folder. |
| **Shotgun** | Gemini riding along through [agy-delegate](https://github.com/TenTemujin/delegate): is it running something, and what did it take off Claude's plate. |
| **Odometer** | Tokens saved so far, in the GUI header and as the taskbar icon. |

## Install

**Windows, with a window of its own:** download `Tailgate-Setup-x.y.z.exe` from the [latest release](../../releases/latest) and run it. It installs for your user only, adds a Desktop and Start Menu shortcut, and opens like any other app. No browser involved. It is an Electron window around the same binary below, which does all the work and stops when you close the window.

**Any system, single file:** download the binary for your system from the same page and run it. On first launch it offers to install itself (PATH, Start Menu and Desktop shortcut on Windows). `tailgate gui` opens the interface in your browser.

You need the `claude` CLI.

## Use

```
tailgate                              terminal interface
tailgate gui                          clickable interface in your browser (127.0.0.1 only)
tailgate tray                         Windows: odometer icon in the notification area

tailgate list [-t] [--json]           ranked catalog
tailgate tools                        the toolbox
tailgate install <owner/repo>...      from the catalog, or any GitHub repo or link
tailgate update-all                   plugins, git-cloned skills and installed tools
tailgate update [--check]             Tailgate itself

tailgate profile list|apply <name>    switch token savers (dry run unless --yes)
tailgate project <name> [--dir .]     same, for one project only
tailgate conflicts                    installed plugins that overlap

tailgate delegate                     what Gemini is doing and what it saved
tailgate stats                        total tokens saved
tailgate impact                       before and after, from your own sessions
tailgate audit <owner/repo>           static security scan
tailgate marketplace-init             scaffold a plugin you want to publish
```

## How the numbers are made

**Grade and score.** Out of 100: popularity 28, relevance 22, push activity 12, release recency 8, installable 10, valid manifest 5, license 5, issue health 5. Curated entries get +10 and a floor of 75, so a good small repo is not buried. S is 80 and up, A is 65 and up, B is the rest.

**Scan.** A pattern scan of hooks and scripts, run weekly. High means code that runs by itself and fetches-and-executes, reads credentials or wipes folders. Notes means network calls or install scripts. It skips comments and test fixtures. It is not a code review, and a clean scan is not proof of safety. Tailgate blocks installs with a high result unless you pass `--force`.

**Saved tokens.** Two sources, labelled as such. rtk reports its own savings, so that number is **measured**. For delegate it is an **estimate**: the source Claude did not have to read, minus the answer, at 4 bytes per token, counted only for jobs that succeeded. `tailgate impact` adds a before and after per plugin from your session transcripts, with sample sizes. It is observational: your work changes over time, so read it as a hint.

**Always-on load.** Context a plugin adds to every session, from `claude plugin details`.

## Updating

`update-all` does three things: updates plugins, runs `git pull --ff-only` in skills you cloned into `~/.claude/skills`, and runs each tool's own updater (winget, brew, npm, uv). It only upgrades a tool through the package manager that installed it. A Ghidra you unpacked by hand is left alone instead of getting a second copy. Folders that are not git clones and plugins synced from your account are skipped.

Tailgate itself checks the release page every 12 hours and replaces its own binary on request.

## Catalog freshness

A weekly workflow rescrapes GitHub, runs the scan and publishes `catalog.json` to the `catalog-latest` pre-release. The app downloads it at startup when its copy is older than 7 days, so nobody needs a GitHub token to stay current.

## Windows code signing

Unsigned binaries trigger SmartScreen. To sign releases, add two repository secrets: `WINDOWS_CERT_PFX_BASE64` (the `.pfx`, base64) and `WINDOWS_CERT_PASSWORD`. The release workflow signs when they exist. Open-source projects can apply for free signing through the SignPath Foundation.

## Build

```
npm ci
npm test               # 47 tests: scoring, scanner, profiles, delegate log, updates
npm run package        # dist/tailgate(.exe), needs Bun
npm run package:all    # all platforms
npm run desktop        # Windows installer (Electron shell + binary), needs `npm ci` in desktop/
```

CI runs the tests and builds and starts the real binary on Linux, macOS and Windows. Pushing a `v*` tag publishes a release.

## Limits

The taskbar icon is Windows only. Community plugins are scored, not vetted. MCP servers other than the curated few are not discovered yet.

MIT licensed.
