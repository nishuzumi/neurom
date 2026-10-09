<script setup lang="ts">
// renderers/series.vue — line chart of one or more numeric series (scope.js seriesModel): training curves, a
// report's grouped metric over an enumerate axis, per-step rewards of an execution history.
import { computed } from 'vue';
import { seriesModel } from './scope.js';
import { linePath, fmt } from '../modules/body-utils';
import { t } from '../../i18n.js';

const props = defineProps<{ scope: unknown; path: string; marks: Record<string, string> }>();
const W = 240, H = 80;
const PALETTE = ['var(--ok)', 'var(--spike)', 'var(--plastic)', 'var(--sens)', 'var(--inh)', 'var(--focus)'];
const model = computed(() => seriesModel(props.scope, props.path, props.marks));
const lastFinite = (xs: number[]) => { for (let i = xs.length - 1; i >= 0; i--) if (Number.isFinite(xs[i])) return xs[i]; return undefined; };
const lines = computed(() => model.value.series.map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length], d: linePath(s.values, W, H, model.value.min, model.value.max), last: lastFinite(s.values) })));
const longest = computed(() => Math.max(0, ...model.value.series.map(s => s.values.length)));
const ticks = computed(() => {
  const labels = model.value.labels, n = longest.value; if (n < 2) return [];
  const idx = n <= 6 ? [...Array(n).keys()] : [0, Math.floor((n - 1) / 2), n - 1];
  return idx.map(i => ({ x: (i * W) / (n - 1), text: labels?.[i] ?? String(i + 1) }));
});
const points = computed(() => (longest.value <= 12 ? lines.value.flatMap(l => l.values.map((v, i) => ({ key: `${l.name}${i}`, color: l.color, cx: longest.value > 1 ? (i * W) / (longest.value - 1) : W / 2, cy: H - ((v - model.value.min) / (model.value.max - model.value.min || 1)) * (H - 2) - 1 })).filter(p => Number.isFinite(p.cy))) : []));
</script>

<template>
  <div v-if="!model.series.length" class="bhint">{{ t('没有可绘制的数列：path 需要指向数字数组或数列记录') }}</div>
  <div v-else class="rseries">
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="t('曲线 {names}', { names: lines.map(l => l.name).join(', ') })">
      <line :x1="0" :y1="H - 1" :x2="W" :y2="H - 1" stroke="var(--line)" />
      <path v-for="l in lines" :key="l.name" :d="l.d" fill="none" :stroke="l.color" stroke-width="1.5" />
      <circle v-for="p in points" :key="p.key" :cx="p.cx" :cy="p.cy" r="2.5" :fill="p.color" />
    </svg>
    <div class="rseries-axis">
      <span v-for="tk in ticks" :key="tk.text + tk.x" class="rseries-x" :class="{ last: tk === ticks[ticks.length - 1] && ticks.length > 1 }" :style="{ left: `${(100 * tk.x) / W}%` }">{{ tk.text }}</span>
    </div>
    <div class="rseries-legend">
      <span v-for="l in lines" :key="l.name"><i :style="{ background: l.color }"></i>{{ l.name }} <b>{{ fmt(l.last) }}</b></span>
      <span class="rseries-y" :title="t('纵轴范围')">{{ fmt(model.min) }} … {{ fmt(model.max) }}</span>
    </div>
  </div>
</template>
