<script setup lang="ts">
// ParamsHead.vue — the parameters module's header action (registry.ts `head`): the ⚙ settings button that opens the
// declarations dialog (ParamsDeclarations.vue). The host places it left of the collapse button. It stays in the
// header while the module is collapsed, so declarations are editable either way.
import { computed, ref } from 'vue';
import { t } from '../../i18n.js';
import { useWorkbench } from '../workbench-context';
import { useNode } from './common';
import ParamsDeclarations from './ParamsDeclarations.vue';
import HeadIcon from '../HeadIcon.vue';

const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();
const { node } = useNode(wb, () => props.nodeId);
const summary = computed(() => {
  const c = (node.value?.config ?? {}) as { fields?: Record<string, unknown>; functions?: string[] };
  return t('声明（{n} 个参数 · {m} 个函数输入）', { n: Object.keys(c.fields ?? {}).length, m: (c.functions ?? []).length });
});
const declaring = ref(false);
</script>

<template>
  <button type="button" class="mnode-act mnode-icon nodrag" aria-haspopup="dialog" :aria-label="summary" :title="`${summary}\n${t('打开参数声明：左侧可视化编辑，右侧 YAML')}`" @click.stop="declaring = true"><HeadIcon name="gear" /></button>
  <ParamsDeclarations v-if="declaring" :node-id="nodeId" @close="declaring = false" />
</template>
