// main.jsx — the entry of the ladder page. It sets the language, then mounts the App.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.jsx';
import { initLocale, onLocaleChange, t } from './i18n.js';

initLocale();
const title = () => { document.title = t('NEUROM 坦克擂台'); };
title();
onLocaleChange(title);

createRoot(document.getElementById('app')).render(<StrictMode><App /></StrictMode>);
