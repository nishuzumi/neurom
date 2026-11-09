// guide/main.js — the entry of the participation guide (`/guide/`). It sets the language, then mounts the page.
import { createApp, watchEffect } from 'vue';
import '../styles.css';
import GuidePage from './GuidePage.vue';
import { initLocale, locale, t } from '../i18n.js';

initLocale();
watchEffect(() => {
  document.title = t('NEUROM 参与指南');
  document.documentElement.lang = locale() === 'en' ? 'en' : 'zh-CN';
});

createApp(GuidePage).mount('#app');
