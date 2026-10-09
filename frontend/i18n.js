// i18n.js — UI language. Chinese source text is the message key. `t('训练已取消')` returns the key itself in `zh` and
// the en.json entry in `en`. So every Chinese literal in the source stays readable. A missing entry shows as visible
// Chinese, not as a blank. After lookup, t() fills `{name}` placeholders from `params`, in either language.
//
// The locale is in a Vue shallowRef. A template, computed or watcher that calls t() re-renders when the language
// changes. This is also true when it calls t() through a domain function that builds a message. Strings already stored
// as state (a status line, a run error) keep their original language until their owner replaces them.
import { shallowRef } from 'vue';
import en from './i18n/en.json' with { type: 'json' };

export const LOCALES = Object.freeze(['zh', 'en']);
const DICTIONARIES = { en };
const STORAGE_KEY = 'neurom-locale';
const current = shallowRef('zh');
const listeners = new Set();

export function locale() { return current.value; }

/** Look up `zh` in the active dictionary and substitute `{name}` placeholders. Unknown placeholders stay verbatim.
 *  @param {string} zh  @param {Record<string, unknown>} [params]  @returns {string} */
export function t(zh, params) {
  const text = current.value === 'zh' ? zh : DICTIONARIES[current.value][zh] ?? zh;
  return params ? text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match)) : text;
}

/** Enumeration in running text: 甲、乙、丙 / A, B, C. */
export function joinList(items) { return items.join(current.value === 'zh' ? '、' : ', '); }   // i18n-ignore: the separator itself

export function setLocale(next) {
  if (!LOCALES.includes(next)) throw new Error(`unknown locale ${next}`);
  if (next === current.value) return;
  current.value = next;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, next); } catch { /* storage may be unavailable (file://, private mode) */ }
  for (const listener of listeners) listener(next);
}

/** Saved choice, else the browser language (zh-* → zh, anything else → en). Only the page entry calls this. Modules and
 *  tests do not call it, so they stay on `zh`, the language of the source. */
export function initLocale() {
  let saved = null;
  try { saved = globalThis.localStorage?.getItem(STORAGE_KEY); } catch { /* see setLocale */ }
  const fallback = /^zh\b/i.test(globalThis.navigator?.language ?? '') ? 'zh' : 'en';
  current.value = LOCALES.includes(saved) ? saved : fallback;
  return current.value;
}

/** For DOM that is rendered by hand (innerHTML) rather than by Vue: called after every language change. */
export function onLocaleChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
