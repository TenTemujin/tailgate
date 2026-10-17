import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const HOME = join(homedir(), '.tailgate');
export const CATALOG = join(HOME, 'catalog.json');
export const REPORT = join(HOME, 'scrape-report.json');
export const REJECTS = join(HOME, 'rejects.jsonl');
export function ensureHome() { mkdirSync(HOME, { recursive: true }); }
