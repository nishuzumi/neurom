import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse as parseSfc } from 'vue/compiler-sfc';
import { checkI18n } from '../../frontend/i18n/check.mjs';
import { setLocale, t } from './i18n.js';
import en from './i18n/en.json' with { type: 'json' };

const SITE = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['dist', 'node_modules', 'i18n', 'data']);

/** The entry html files of the pages. The page entries translate their Chinese text in place. */
const ENTRIES = new Set(['index.html', join('ladder', 'index.html'), join('guide', 'index.html')]);
/** The participation guide holds its text as zh / en `lang` pairs in one file, not as t() keys (GuidePage.vue). */
const PAIRED = new Set([join('src', 'guide', 'GuidePage.vue')]);

/** The page sources: scripts and Vue components (tests and the paired guide excluded) and the entry html files. */
function siteFiles() {
  return readdirSync(SITE, { recursive: true }).map(String)
    .filter(p => !p.split(/[\\/]/).some(part => SKIP.has(part)))
    .filter(p => /\.(js|mjs|vue)$/.test(p) && !/\.test\.js$/.test(p) && !PAIRED.has(p) || ENTRIES.has(p))
    .map(p => join(SITE, p)).sort();
}

test('every Chinese string of the site pages has an English entry and every entry is used', () => {
  const files = siteFiles();
  assert.ok(files.some(f => f.endsWith(join('guide', 'index.html'))) && files.some(f => f.endsWith('App.vue')) && files.some(f => f.endsWith('HomePage.vue')), 'scans the page sources');
  const { errors } = checkI18n({ files, dictionary: en });
  assert.deepEqual(errors, []);
});

// @vue/compiler-core NodeTypes
const ELEMENT = 1, TEXT = 2;
const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const langOf = node => node.props?.find(p => p.type === 6 && p.name === 'lang')?.value?.content ?? null;

/** The errors of the zh / en pairs of a template: Chinese text outside a `lang` element, and a `lang="zh"` element
 *  without a `lang="en"` element directly after it (or the reverse). */
function pairErrors(node, inLang = false, out = []) {
  const kids = (node.children ?? []).filter(c => c.type === ELEMENT || (c.type === TEXT && c.content.trim()));
  kids.forEach((c, i) => {
    if (c.type === TEXT) {
      if (!inLang && CJK.test(c.content)) out.push(`${c.loc.start.line}: Chinese text outside a lang pair: "${c.content.trim()}"`);
      return;
    }
    const lang = langOf(c);
    if (lang === 'zh' && langOf(kids[i + 1] ?? {}) !== 'en') out.push(`${c.loc.start.line}: lang="zh" without lang="en" after it`);
    if (lang === 'en' && langOf(kids[i - 1] ?? {}) !== 'zh') out.push(`${c.loc.start.line}: lang="en" without lang="zh" before it`);
    pairErrors(c, inLang || lang !== null, out);
  });
  return out;
}

test('the guide shows every text in both languages: each lang="zh" element has a lang="en" element after it', () => {
  const { descriptor } = parseSfc(readFileSync(join(SITE, 'src', 'guide', 'GuidePage.vue'), 'utf8'));
  assert.ok(descriptor.template.ast.children.length > 0, 'parses the template');
  assert.deepEqual(pairErrors(descriptor.template.ast), []);
  const broken = parseSfc('<template><div><p lang="zh">只有中文</p><p>没有标记</p></div></template>').descriptor.template.ast;
  assert.deepEqual(pairErrors(broken).map(e => e.replace(/^\d+: /, '')), ['lang="zh" without lang="en" after it', 'Chinese text outside a lang pair: "没有标记"']);
});

test('t() reads the page dictionary first and falls back to the workbench dictionary', t_ => {
  t_.after(() => setLocale('zh'));
  assert.equal(t('坦克擂台'), '坦克擂台');
  setLocale('en');
  assert.equal(t('坦克擂台'), 'Tank Ladder');
  assert.equal(t('不支持的链 id：{chainId}', { chainId: 7 }), 'Unsupported chain id: 7');
  assert.equal(t('没有这个词条'), '没有这个词条');
});
