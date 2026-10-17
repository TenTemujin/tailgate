import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { categorize } from '../src/github.js';

// A bad escape once turned \b in a regex into a backspace character and silently broke matching.
test('source files contain no stray control characters', () => {
  const dirs = ['src', 'tests', 'scripts'];
  const bad: string[] = [];
  for (const d of dirs) {
    for (const f of readdirSync(d)) {
      if (!/\.(ts|mjs|html)$/.test(f) || f === 'page.gen.ts') continue;
      const text = readFileSync(join(d, f), 'utf8');
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 32 && c !== 10 && c !== 13 && c !== 9) { bad.push(`${d}/${f} @${i} (code ${c})`); break; }
      }
    }
  }
  assert.deepEqual(bad, []);
});

const repo = (name: string, description: string, topics: string[] = []) => ({ name, description, topics });

test('categories: token savers are narrow, other helpers are recognised', () => {
  assert.equal(categorize(repo('slim', 'Reduce tokens by compressing tool output')), 'token-saver');
  assert.equal(categorize(repo('caveman', 'why use many token when few token do trick')), 'token-saver');
  assert.notEqual(categorize(repo('marketingskills', 'Marketing skills. CRO, copywriting, SEO, analytics, and growth engineering.')), 'token-saver', 'marketing is not a token saver');
  assert.notEqual(categorize(repo('seo-kit', 'Optimize your SEO and reduce bounce rate')), 'token-saver');
  assert.equal(categorize(repo('pw', 'Playwright browser automation for agents')), 'browser');
  assert.equal(categorize(repo('figma-skill', 'Figma design system tokens to code')), 'design');
  assert.equal(categorize(repo('pentest', 'Penetration testing and vulnerability scanning skills')), 'security');
  assert.equal(categorize(repo('x', 'A thing')), 'other');
});
