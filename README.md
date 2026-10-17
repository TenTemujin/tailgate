# Tailgate

A manager for Claude Code skills and plugins, built around saving tokens. It scrapes GitHub, keeps only the best-scoring repos, and installs them in one step.

## Install

Download the binary for your OS from the [latest release](../../releases/latest) and run it. On first launch it offers to install itself (PATH, Start Menu and Desktop shortcut on Windows).

Requires the `claude` CLI. Re-scraping needs a GitHub token (`gh auth login` or `GITHUB_TOKEN`).

## Use

**Clickable interface:** run `tailgate gui` (the Desktop and Start Menu shortcuts do this). It opens a local page in your browser with search, one-click install, on/off switches, per-plugin token cost and profiles. It listens on `127.0.0.1` only, behind a random per-session token, and exits when you close the tab.

**Terminal interface:** run `tailgate` for the TUI: pick token savers with space, press Enter to install, or manage installed plugins (enable, disable, update, uninstall, token cost).

**Profiles:** `minimal`, `balanced` and `max-savings` switch your token-saver plugins in one step. Applying shows a plan first (dry run by default on the CLI) and only touches plugins that are token savers in the catalog; your other plugins are never disabled. Save your current setup from the GUI.

**Conflicts:** Tailgate warns when two enabled plugins do the same job (for example two memory plugins).

```
tailgate list [-t] [-n 20] [--json]   ranked catalog
tailgate install <owner/repo...>      install from the catalog
tailgate scrape [--json]              refresh catalog, print audit report
tailgate report                       last scrape report (JSON)
tailgate rejects [-r <reason>]        why repos were filtered out (JSONL)
tailgate update [--check]             update Tailgate itself from GitHub Releases
tailgate update-plugins               update every installed plugin
tailgate details <plugin@market>      always-on token cost of a plugin
tailgate gui                          clickable interface in the browser
tailgate profile list|apply <name>    switch plugin sets (add --yes to apply)
tailgate conflicts                    overlapping installed plugins
tailgate self-uninstall               remove Tailgate
```

## Catalog freshness

`.github/workflows/catalog.yml` scrapes weekly and publishes `catalog.json` to the rolling `catalog-latest` pre-release. The app downloads it at startup when its local catalog is older than 7 days, so users do not need a GitHub token to stay current.

## Windows code signing (optional)

Unsigned exes trigger SmartScreen. To sign releases, buy a code-signing certificate and add two repository secrets: `WINDOWS_CERT_PFX_BASE64` (base64 of the `.pfx`) and `WINDOWS_CERT_PASSWORD`. The release workflow signs automatically when they exist. Reputation with SmartScreen still builds over time for standard certificates.

## How ranking works

Candidates come from GitHub topics and keyword searches. Rejected: archived, forks, under 50 stars, stale over 365 days, no description, no installable manifest (`.claude-plugin/marketplace.json` or root `SKILL.md`), off-topic, score under 55.

Score (0-100) = popularity 35 + relevance 24 + freshness 15 + installability 10 + license 5 + curated 10. Tiers: S ≥ 80, A ≥ 65, B below. The scraper writes `~/.tailgate/scrape-report.json` and `rejects.jsonl` so a person or an AI can audit every decision.

Community repos are scored, not manually vetted. Review the code before trusting it.

## Build

```
npm ci
npm run package        # dist/tailgate(.exe), needs Bun
npm run package:all    # all platforms
```

Pushing a `v*` tag builds and publishes the release binaries.
