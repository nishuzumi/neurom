<script setup>
// components/DataStrip.vue — the four numbers under the hero: entries, finished challenges, the first rank, the blocks
// left in the season.
import { computed } from 'vue';
import { t } from '../i18n.js';
import { useLadder } from '../ladder/use-ladder.js';
import { formatInt, nameOf } from '../ladder/format.js';

const ladder = useLadder();
const finished = computed(() => ladder.recent.filter(c => c.status >= 2).length);
const top = computed(() => ladder.entries.find(e => e.rank === 1) ?? null);
const left = computed(() => (ladder.config ? Math.max(0, Number(ladder.config.endBlock) - ladder.block) : null));
</script>

<template>
  <section class="strip"><div class="wrap">
    <div class="stat"><span class="big">{{ formatInt(ladder.entries.length) }}</span><div class="small">{{ t('出战模型') }}</div></div>
    <div class="stat"><span class="big plain">{{ formatInt(finished) }}</span><div class="small">{{ t('已结束的挑战（最近 {n} 场里）', { n: ladder.recent.length }) }}</div></div>
    <div class="stat"><span class="big" :title="top?.module ?? ''">{{ top ? nameOf(ladder.names, top.module) : '—' }}</span><div class="small">{{ t('当前第 1 名') }}</div></div>
    <div class="stat"><span class="big plain">{{ left === null ? '—' : formatInt(left) }}</span><div class="small">{{ t('赛季剩余块数（到第 {end} 块）', { end: ladder.config ? formatInt(ladder.config.endBlock) : '—' }) }}</div></div>
  </div></section>
</template>
