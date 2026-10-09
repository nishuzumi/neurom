<script setup lang="ts">
// renderers/grid.vue — a tile grid over a scope (see scope.js gridModel): tiles coloured by value, or an empty grid.
// It draws the agent dot, trail, base outline, dashed target and visibility radius only when the mark of each one
// resolves, so the renderer knows no scenario.
import { computed } from 'vue';
import { gridModel } from './scope.js';
import { t } from '../../i18n.js';

const props = defineProps<{ scope: unknown; path: string; marks: Record<string, string> }>();
const C = 20;
const model = computed(() => gridModel(props.scope, props.path, props.marks));
const W = computed(() => model.value.width * C), H = computed(() => model.value.height * C);
const cells = computed(() => {
  const m = model.value; if (m.problem) return [];
  const out: { x: number; y: number; fill: string; opacity: number }[] = [];
  const [ax, ay] = m.agent ?? [NaN, NaN];
  for (let x = 0; x < m.width; x++) for (let y = 0; y < m.height; y++) {
    const tile = m.tiles ? m.tiles[m.index!(x, y)] ?? 0 : 0;
    const seen = m.radius === null || m.agent === null || Math.max(Math.abs(x - ax), Math.abs(y - ay)) <= m.radius;
    out.push({ x, y, fill: m.colors[tile] ?? m.colors[m.colors.length - 1], opacity: m.tiles ? (seen ? (tile ? 0.9 : 0.35) : (tile ? 0.3 : 0.12)) : 1 });
  }
  return out;
});
const radiusBox = computed(() => {
  const m = model.value; if (m.radius === null || !m.agent) return null;
  const x0 = Math.max(0, m.agent[0] - m.radius), y0 = Math.max(0, m.agent[1] - m.radius), x1 = Math.min(m.width - 1, m.agent[0] + m.radius), y1 = Math.min(m.height - 1, m.agent[1] + m.radius);
  return { x: x0 * C, y: y0 * C, w: (x1 - x0 + 1) * C - 1, h: (y1 - y0 + 1) * C - 1 };
});
const trail = computed(() => model.value.trail.map(p => `${p[0] * C + C / 2},${p[1] * C + C / 2}`).join(' '));
</script>

<template>
  <div v-if="model.problem === 'size'" class="bhint">{{ t('网格需要 width / height 标记，或 path 指向一个平铺数组') }}</div>
  <svg v-else class="rgrid" :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="t('网格视图 {w}×{h}', { w: model.width, h: model.height })">
    <rect v-for="c in cells" :key="`${c.x},${c.y}`" :x="c.x * C" :y="c.y * C" :width="C - 1" :height="C - 1" :fill="c.fill" :opacity="c.opacity" :stroke="model.tiles ? 'none' : 'var(--line)'" />
    <rect v-if="radiusBox" :x="radiusBox.x" :y="radiusBox.y" :width="radiusBox.w" :height="radiusBox.h" fill="none" stroke="var(--ink)" stroke-dasharray="3 3" opacity=".6" />
    <rect v-if="model.base" :x="model.base[0] * C + 1" :y="model.base[1] * C + 1" :width="C - 3" :height="C - 3" fill="none" stroke="var(--ok)" stroke-width="2" />
    <rect v-if="model.target" :x="model.target[0] * C + 4" :y="model.target[1] * C + 4" :width="C - 9" :height="C - 9" fill="none" stroke="var(--plastic)" stroke-width="2" stroke-dasharray="4 3" />
    <polyline v-if="model.trail.length > 1" :points="trail" fill="none" stroke="var(--spike)" stroke-width="2" opacity=".8" />
    <circle v-if="model.agent" :cx="model.agent[0] * C + C / 2" :cy="model.agent[1] * C + C / 2" :r="C / 4" fill="var(--spike)" stroke="#000" />
  </svg>
</template>
