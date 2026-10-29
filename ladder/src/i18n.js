// i18n.js — UI language of the ladder page. The page shares the locale state of the workbench (`frontend/i18n.js`),
// so the messages of the imported workbench modules (chain errors, bridge messages) change language together with
// the page. The entries of the page itself are in `./i18n/en.json`. `t()` looks there first, then in the workbench
// dictionary. `useLocale()` re-renders a React component when the language changes.
import { useSyncExternalStore } from 'react';
import { t as workbenchT, locale, setLocale, onLocaleChange, initLocale, LOCALES } from '../../frontend/i18n.js';
import en from './i18n/en.json' with { type: 'json' };

export { locale, setLocale, onLocaleChange, initLocale, LOCALES };

/** Look up `zh` (page dictionary first, then the workbench dictionary) and fill `{name}` placeholders. */
export function t(zh, params) {
  if (locale() !== 'en' || !Object.hasOwn(en, zh)) return workbenchT(zh, params);
  const text = en[zh];
  return params ? text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match)) : text;
}

const serverLocale = () => 'zh';
/** The current locale as React state. */
export function useLocale() { return useSyncExternalStore(onLocaleChange, locale, serverLocale); }
