import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checkI18n } from '../../frontend/i18n/check.mjs';
import { setLocale, t } from './i18n.js';
import en from './i18n/en.json' with { type: 'json' };

const LADDER = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['dist', 'node_modules', 'i18n', 'data']);

/** The page sources: scripts and JSX (tests excluded) and index.html. */
function ladderFiles() {
  return readdirSync(LADDER, { recursive: true }).map(String)
    .filter(p => !p.split(/[\\/]/).some(part => SKIP.has(part)))
    .filter(p => /\.(js|jsx|mjs)$/.test(p) && !/\.test\.js$/.test(p) || p === 'index.html')
    .map(p => join(LADDER, p)).sort();
}

test('every Chinese string of the ladder page has an English entry and every entry is used', () => {
  const files = ladderFiles();
  assert.ok(files.some(f => f.endsWith('index.html')) && files.some(f => f.endsWith('App.jsx')), 'scans the page sources');
  const { errors } = checkI18n({ files, dictionary: en });
  assert.deepEqual(errors, []);
});

test('t() reads the page dictionary first and falls back to the workbench dictionary', t_ => {
  t_.after(() => setLocale('zh'));
  assert.equal(t('坦克擂台'), '坦克擂台');
  setLocale('en');
  assert.equal(t('坦克擂台'), 'Tank Ladder');
  assert.equal(t('不支持的链 id：{chainId}', { chainId: 7 }), 'Unsupported chain id: 7');
  assert.equal(t('没有这个词条'), '没有这个词条');
});
