<script setup lang="ts">
// ScriptBody.vue — the script module on the canvas (ADR 0019). One row with 「✎ 编辑代码」, which opens the editor
// dialog (ScriptFiles.vue). Under the row, the views of the script (renderers/script-module.vue) fill the rest of the
// host. The host is a vertical box that the user resizes freely, and the views follow its size. The declared inputs
// are ports on the left (the standard port band). The calls of the script run on the page (core/script-calls.js),
// against the graph of the moment. 「运行到这里」 (ADR 0023) asks through `wb.play`: the script starts again in a new
// frame and plays.
import { computed, ref, watch } from 'vue';
import { useWorkbench } from '../workbench-context';
import { useNode } from './common';
import ScriptModule from '../renderers/script-module.vue';
import ScriptFiles from './ScriptFiles.vue';
import { scriptCalls } from '../../core/script-calls.js';
import { t } from '../../i18n.js';
import './bodies-a.css';

const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();
const { node } = useNode(wb, () => props.nodeId);
const files = computed(() => (node.value?.config.files ?? []) as { name: string; source: string }[]);
/** the function and value inputs over the current graph: a new one per graph or workspace change */
const inputs = computed(() => {
  void wb.version.value;
  return scriptCalls(wb.graph, wb.resolution(), props.nodeId, { artifacts: (id: string) => wb.workspace.artifact(id) });
});
const editing = ref(false);
/** bumped by 「保存并重新运行」: the script starts again, also when no file changed */
const run = ref(0);
/** bumped by each `wb.play` request for this module: a new frame that plays once it has loaded */
const play = ref(0);
watch(() => wb.play.value, p => { if (p?.node === props.nodeId) play.value++; });
</script>

<template>
  <div class="body sbody">
    <div class="brow">
      <button type="button" class="mini" aria-haspopup="dialog" @click="editing = true">{{ t('✎ 编辑代码') }}</button>
    </div>
    <ScriptModule class="bfill sbody-stage" :files="files" :run="run" :play="play" :inputs="inputs" />
    <ScriptFiles v-if="editing" :node-id="nodeId" @close="editing = false" @saved="run++" />
  </div>
</template>

<style scoped>
/* unsized: a stage of fixed height. Sized: a small base plus all the spare height (.bfill) */
.sbody-stage{height:440px}
.mnode.sized .sbody-stage{height:120px}
</style>
