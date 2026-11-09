// guide/main.js — the participation guide at `/guide/` (site/guide/index.html). The guide is static HTML that holds
// the Chinese and the English text. This entry loads the brand tokens and shows one language. The language is the
// locale of the site (../i18n.js), so the guide, the ladder and the workbench keep the same choice.
import '../../../frontend/ui/brand.css';
import { initLocale, locale, onLocaleChange, setLocale } from '../i18n.js';

const root = document.documentElement;
const toggle = document.getElementById('lang');

function show(lang) {
  root.dataset.lang = lang;
  root.lang = lang === 'zh' ? 'zh-CN' : 'en';
  toggle.textContent = lang === 'zh' ? 'EN' : '中';   // i18n-ignore: the language names themselves
}

show(initLocale());
onLocaleChange(show);
toggle.addEventListener('click', () => setLocale(locale() === 'zh' ? 'en' : 'zh'));
