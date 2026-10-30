<script setup lang="ts">
// RunUpTo.vue — the header action 「运行到这里」 (ADR 0023) of the module hosts (ModuleNode.vue) and of the sections of a
// training module (TrainingModuleNode.vue). Only the kinds of core/sessions/run-chain.js CHAIN_KINDS have it. One
// chain runs at a time, so every button is disabled while a chain runs. The one of the running module is lit.
import { computed } from 'vue';
import HeadIcon from './HeadIcon.vue';
import { useWorkbench } from './workbench-context';
import { CHAIN_KINDS } from '../core/sessions/run-chain.js';
import { t } from '../i18n.js';

const props = defineProps<{ nodeId: string; kind: string; title: string }>();
const wb = useWorkbench();
const busy = computed(() => wb.chain.target.value !== null);
const hint = computed(() => (busy.value
  ? t('「运行到这里」正在运行：{step}', { step: wb.chain.step.value ?? '…' })
  : t('运行到这里：先补齐上游没有接受的训练和过时的评估，再运行这个模块')));
</script>

<template>
  <button v-if="CHAIN_KINDS.has(kind)" type="button" class="mnode-act mnode-icon nodrag" :class="{ 'mnode-run': wb.chain.target.value === nodeId }" :disabled="busy" :title="hint"
    :aria-label="t('运行到这里：{title}', { title })" @click.stop="wb.chain.run(nodeId)"><HeadIcon name="play" /></button>
</template>
