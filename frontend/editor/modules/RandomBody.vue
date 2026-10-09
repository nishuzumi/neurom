<script setup lang="ts">
// RandomBody.vue — the random module (core/kinds/random.js). It shows its LCG constants and table length, and how a
// scenario draws from the tables it outputs. It also shows the first draws from an example seed, so a changed
// constant shows at once.
import { computed } from 'vue';
import { randomTables } from '../../core/kinds/random.js';
import { t } from '../../i18n.js';
import { useWorkbench } from '../workbench-context';
import ConfigForm from './ConfigForm.vue';
import { formatValue, useNode } from './common';
import './bodies-a.css';

const SEED = 1, SHOWN = 4, TWO32 = 4294967296;
const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();
const { node, problems } = useNode(wb, () => props.nodeId);
/** the first draws from SEED, as the formula in the hint computes them */
const first = computed(() => {
  const c = node.value?.config as { multiplier: number; increment: number; draws: number } | undefined;
  if (!c) return [];
  const { mul, add } = randomTables({ ...c, draws: Math.min(c.draws, SHOWN) });
  return mul.map((m, k) => formatValue(((Math.imul(m, SEED) >>> 0) + add[k]) % TWO32 / TWO32));
});
</script>

<template>
  <div v-if="node" class="body">
    <ConfigForm :node-id="nodeId" />
    <div class="bhint">{{ t('在场景代码里把输出接到一个输入（如 rng），第 k 次抽取（0 ≤ k < 抽取次数）：') }}</div>
    <div class="rnd-draw">add32(imul32(rng.mul[k], u32(seed)), rng.add[k]) / 4294967296</div>
    <dl class="bkv">
      <dt>{{ t('种子 {seed} 的前几个', { seed: SEED }) }}</dt><dd>{{ first.join(', ') }}</dd>
    </dl>
    <div v-for="(p, i) in problems" :key="i" class="bproblem" :class="{ incomplete: p.incomplete }">{{ p.message }}</div>
  </div>
</template>
