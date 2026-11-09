<script setup>
// components/SiteBar.vue — the top bar of the site, shared by the home page and the ladder page. On the left: the
// wordmark, the site links (ladder, workbench, GitHub) and, through the `nav` slot, the own links of the page. On the
// right: the default slot (the login button or the wallet chip of the ladder) and the language toggle. The workbench
// shows the same links with its own header (frontend/graph_app.js).
import { locale, setLocale, t } from '../i18n.js';
import { site } from '../site.js';

defineProps({
  /** The page of the site that is open: `home` | `ladder`. Its site link is marked. */
  page: { type: String, required: true },
  /** The sub title after the wordmark, for example 坦克擂台 on the ladder. */
  sub: { type: String, default: '' },
});
const toggleLocale = () => setLocale(locale() === 'zh' ? 'en' : 'zh');
</script>

<template>
  <header class="topbar">
    <div class="wrap">
      <a class="brand" :href="site.home">NEUROM<span v-if="sub" class="sub">{{ sub }}</span></a>
      <nav class="topnav" :aria-label="t('站点导航')">
        <a :href="site.ladder" :class="page === 'ladder' ? 'on' : ''">{{ t('坦克擂台赛') }}</a>
        <a :href="site.studio">{{ t('工作台') }}</a>
        <a :href="site.github" rel="noopener">GitHub</a>
      </nav>
      <nav v-if="$slots.nav" class="topnav pagenav" :aria-label="t('页面导航')"><slot name="nav" /></nav>
      <div class="topbar-right">
        <slot />
        <button type="button" class="lang-toggle" title="中文 / English" aria-label="Language: 中文 / English" @click="toggleLocale">{{ locale() === 'zh' ? 'EN' : '中' }}</button><!-- i18n-ignore -->
      </div>
    </div>
  </header>
</template>
