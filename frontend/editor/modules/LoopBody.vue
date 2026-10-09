<script setup lang="ts">
// LoopBody.vue — a loop drawn as a card (not inside its box). It shows whether its scenario is complete, the width I
// of the input bits it hands the body each step, and the body in evaluation order. The body comes from the wires:
// every module on a path from `input` to `action`. It also shows the drivers that run the loop. The loop's own
// problems (body kinds, box mismatch, drivers that disagree on the episode kind) follow.
import { computed } from 'vue';
import { t } from '../../i18n.js';
import { useWorkbench } from '../workbench-context';
import { useNode } from './common';
import { loopSummary } from '../graph-view';
import { loopDrivers } from '../../core/kinds/loop.js';
import { typeName } from '../../core/types.js';
import './bodies-a.css';

const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();
const { node, problems } = useNode(wb, () => props.nodeId);
const scenarioProblems = computed(() => problems.value.filter(p => p.port === 'scenario'));
const otherProblems = computed(() => problems.value.filter(p => p.port !== 'scenario'));
const refs = computed(() => { void wb.version.value; return node.value ? wb.resolution().refsOf(props.nodeId) : {}; });
const summary = computed(() => { void wb.version.value; return node.value ? loopSummary(wb.graph, props.nodeId) : ''; });
const drivers = computed(() => { void wb.version.value; return node.value ? (loopDrivers(wb.graph, props.nodeId) as { node: string; port: string }[]).map(d => `${wb.graph.nodes.get(d.node)?.title ?? d.node}.${d.port}`) : []; });
const scenarioWired = computed(() => { void wb.version.value; return wb.graph.producers(props.nodeId, 'scenario').length > 0; });
</script>

<template>
  <div v-if="node" class="body">
    <div class="brow bhint">
      <span>{{ t('场景') }}</span>
      <b v-if="!scenarioWired" class="pl">{{ t('未接') }}</b>
      <b v-else-if="scenarioProblems.some(p => !p.incomplete)" class="bad">{{ t('有错误') }}</b>
      <b v-else-if="scenarioProblems.length" class="pl">{{ t('不完整') }}</b>
      <b v-else class="ok">{{ t('就绪') }}</b>
      <span class="bgrow"></span>
      <span class="mono">I = {{ refs.I ?? '?' }}</span>
    </div>
    <div class="brow bhint"><span>Start</span><span class="mono">{{ refs.Start ? typeName(refs.Start) : t('由驱动它的分区决定') }}</span></div>
    <div class="brow bhint"><span>{{ t('每一步') }}</span><span class="mono">{{ summary }}</span></div>
    <div class="brow bhint"><span>{{ t('驱动') }}</span><span class="mono">{{ drivers.length ? drivers.join(', ') : '—' }}</span></div>
    <div v-for="(p, i) in [...scenarioProblems, ...otherProblems]" :key="i" class="bproblem" :class="{ incomplete: p.incomplete }">{{ p.message }}</div>
  </div>
</template>

<style scoped>
.brow>span{min-width:0;overflow-wrap:anywhere}
</style>
