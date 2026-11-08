// main.js — the entry of the ladder page (`/ladder/`). It sets the language, then mounts the App.
import { createApp, watchEffect } from 'vue';
import './styles.css';
import App from './App.vue';
import { initLocale, t } from './i18n.js';

initLocale();
watchEffect(() => { document.title = t('NEUROM 坦克擂台'); });

createApp(App).mount('#app');
