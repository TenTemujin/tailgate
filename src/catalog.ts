import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { CATALOG, REPORT, REJECTS, ensureHome } from './paths.js';
import type { Entry } from './types.js';
import type { ScrapeResult } from './github.js';
import snapshot from './snapshot.json' with { type: 'json' };

export function load(): Entry[] {
  // Local scrape wins; otherwise the snapshot bundled at build time.
  return existsSync(CATALOG) ? JSON.parse(readFileSync(CATALOG, 'utf8')) : (snapshot as Entry[]);
}

export function loadReport() {
  return existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : null;
}

// Persist catalog + audit trail (report.json, rejects.jsonl) so a human or an AI can monitor the scraper.
export function save(r: ScrapeResult) {
  ensureHome();
  writeFileSync(CATALOG, JSON.stringify(r.entries, null, 2));
  writeFileSync(REPORT, JSON.stringify(r.report, null, 2));
  writeFileSync(REJECTS, r.rejected.map((x) => JSON.stringify(x)).join('\n'));
  appendFileSync(`${REPORT}.history.jsonl`, JSON.stringify(r.report) + '\n');
}
