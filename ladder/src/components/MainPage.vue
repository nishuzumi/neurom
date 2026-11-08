<script setup>
// components/MainPage.vue — the long main page: hero (two columns), data strip, the sticky numbered nav and the
// sections [1] 开始, [2] 擂台榜, [3] 规则, [4] 最近的挑战. The hero, the guide and the data strip are the components
// beside this one.
import { onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import { t } from '../i18n.js';
import { href } from '../router.js';
import Hero from './Hero.vue';
import DataStrip from './DataStrip.vue';
import Guide from './Guide.vue';
import LadderTable from './LadderTable.vue';
import Rules from './Rules.vue';
import RecentChallenges from './RecentChallenges.vue';

const props = defineProps({ config: { type: Object, required: true }, route: { type: Object, required: true } });
const SECTIONS = [['start', '开始'], ['ladder', '擂台榜'], ['rules', '规则'], ['recent', '最近的挑战']];
const current = shallowRef('start');
// the section in view marks the nav
const scrollTo = section => { if (section) document.getElementById(section)?.scrollIntoView({ behavior: 'smooth' }); };
let io = null;
onMounted(() => {
  const els = SECTIONS.map(([id]) => document.getElementById(id)).filter(Boolean);
  io = new IntersectionObserver(entries => {
    const seen = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (seen[0]) current.value = seen[0].target.id;
  }, { rootMargin: '-30% 0px -60% 0px' });
  els.forEach(el => io.observe(el));
  scrollTo(props.route.section);
});
onBeforeUnmount(() => io?.disconnect());
watch(() => props.route.section, scrollTo, { flush: 'post' });
</script>

<template>
  <Hero />
  <DataStrip />
  <div class="body"><div class="wrap">
    <nav class="sidenav" :aria-label="t('章节导航')">
      <a v-for="([id, zh], i) in SECTIONS" :key="id" :href="href.main(id)" :class="current === id ? 'on' : ''"><span class="n">[{{ i + 1 }}]</span>{{ t(zh) }}</a>
    </nav>
    <div class="sections">
      <section id="start" class="section">
        <div class="section-head"><div><span class="label">{{ t('开始') }} / 01</span><h2>{{ t('怎样参赛') }}</h2></div></div>
        <Guide :config="config" />
      </section>
      <section id="ladder" class="section"><LadderTable /></section>
      <section id="rules" class="section"><Rules /></section>
      <section id="recent" class="section"><RecentChallenges /></section>
    </div>
  </div></div>
</template>
