<script setup lang="ts">
// TextBody.vue — a note: one textarea over config.text. Typing buffers locally and commits (one history entry) on
// blur or after a short pause, so every keystroke does not become an undo step.
import { computed } from 'vue';
import { t } from '../../i18n.js';
import { useWorkbench } from '../workbench-context';
import { useBuffered, useNode } from './common';
import './bodies-a.css';

const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();
const { node } = useNode(wb, () => props.nodeId);
const buf = useBuffered(() => String(node.value?.config.text ?? ''), text => {
  if (!node.value) return false;
  wb.edit(t('编辑文字'), () => wb.graph.patchConfig(props.nodeId, { text }));
}, 600);
const rows = computed(() => Math.min(24, Math.max(3, buf.text.value.split('\n').length + 1)));
</script>

<template>
  <div class="body" @keydown.stop>
    <textarea class="tx-text bfill" :rows="rows" :value="buf.text.value" :placeholder="t('说明、注释…')" :aria-label="t('文字内容')" maxlength="20000" spellcheck="false" @input="buf.input(($event.target as HTMLTextAreaElement).value)" @blur="buf.flush"></textarea>
  </div>
</template>

<style scoped>
/* unsized: rows follow the text (3..24). Sized: 3 lines plus all the spare height */
.tx-text{width:100%;font-family:inherit;font-size:12.5px;line-height:1.5;field-sizing:fixed;max-height:none}
.mnode.sized .tx-text{height:calc(3lh + 8px)}
</style>
