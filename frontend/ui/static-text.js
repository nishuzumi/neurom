// ui/static-text.js — translation of the hand-written markup in index.html. Its Chinese text nodes and attributes are
// message keys (i18n/check.mjs checks them). This module records them once, before any script renders into the page.
// It translates them again after each language change. The markup does not contain text that a script owns (status
// lines, titles that a script rewrites). So the re-apply step never overwrites that text.
import { onLocaleChange, t } from '../i18n.js';

const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;          // ideographs, CJK punctuation, full-width forms
const ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'label'];

/** Record the static Chinese text under `root`, translate it now, and return the function that re-applies it. */
export function translateStatic(root) {
  const apply = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue, key = text.trim();
    if (!CJK.test(key) || node.parentElement?.closest('script,style')) continue;
    const at = text.indexOf(key), lead = text.slice(0, at), trail = text.slice(at + key.length);
    apply.push(() => { node.nodeValue = lead + t(key) + trail; });
  }
  for (const element of root.querySelectorAll('*')) {
    for (const name of ATTRIBUTES) {
      const key = element.getAttribute(name);
      if (key && CJK.test(key)) apply.push(() => element.setAttribute(name, t(key)));
    }
  }
  const translate = () => { for (const fn of apply) fn(); };
  translate();
  return translate;
}

/** Text in `element` that a script owns and that follows the language. `show(key, params)` writes t(key, params) now.
 *  After each language change, it writes the latest message again in the new language. */
export function liveText(element) {
  let message = null;
  const render = () => { if (message) element.textContent = t(message.key, message.params); };
  onLocaleChange(render);
  return { show(key, params) { message = { key, params }; render(); } };
}
