# Tailgate

A manager for Claude Code skills and plugins, built around saving tokens. It scrapes GitHub, keeps only the best-scoring repos, and installs them in one step.

## Install

Download the binary for your OS from the [latest release](../../releases/latest) and run it. On first launch it offers to install itself (PATH, Start Menu and Desktop shortcut on Windows).

Requires the `claude` CLI. Re-scraping needs a GitHub token (`gh auth login` or `GITHUB_TOKEN`).

## Use

Run `tailgate` for the TUI: pick token savers with space, press Enter to install, or manage installed plugins (enable, disable, update, uninstall, token cost).

```
tailgate list [-t] [-n 20] [--json]   ranked catalog
tailgate install <owner/repo...>      install from the catalog
tailgate scrape [--json]              refresh catalog, print audit report
tailgate report                       last scrape report (JSON)
tailgate rejects [-r <reason>]        why repos were filtered out (JSONL)
tailgate self-uninstall               remove Tailgate
```

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
