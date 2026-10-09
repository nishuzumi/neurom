import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, joinList, locale, setLocale, onLocaleChange } from './i18n.js';
import { checkI18n } from './i18n/check.mjs';
import en from './i18n/en.json' with { type: 'json' };

test('every Chinese UI string has an English entry and every entry is used', () => {
  const { errors } = checkI18n({ dictionary: en });
  assert.deepEqual(errors, []);
});

test('placeholders are filled after lookup, in either language; a missing entry falls back to the Chinese key', t_ => {
  const key = Object.keys(en).find(k => /\{\w+\}/.test(k));
  const name = /\{(\w+)\}/.exec(key)[1];
  t_.after(() => setLocale('zh'));
  assert.equal(locale(), 'zh');
  assert.ok(t(key, { [name]: 42 }).includes('42'));
  assert.equal(t('没有这个词条'), '没有这个词条');
  const seen = [];
  const off = onLocaleChange(next => seen.push(next));
  setLocale('en');
  off();
  assert.deepEqual(seen, ['en']);
  assert.equal(t(key, { [name]: 42 }), en[key].replace(`{${name}}`, '42'));
  assert.equal(t('没有这个词条'), '没有这个词条');
  assert.equal(joinList(['a', 'b']), 'a, b');
  assert.throws(() => setLocale('fr'));
});
