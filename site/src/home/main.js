// home/main.js — the entry of the home page (`/`). It sets the language, then mounts the page.
import { createApp, watchEffect } from 'vue';
import '../styles.css';
import HomePage from './HomePage.vue';
import { initLocale, t } from '../i18n.js';

initLocale();
watchEffect(() => { document.title = t('NEUROM：神经网络工作台'); });

createApp(HomePage).mount('#app');
