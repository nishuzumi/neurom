<script setup lang="ts">
// ConfigForm.vue — a module's config form generated from its kind's schema (registry.js descriptors). Reads
// `graph.node(nodeId).config`, renders one ConfigField per top-level key (optionally a subset / order via `fields`,
// minus `exclude`) and commits each change through `wb.edit()` as a patchConfig of that key. Registry validation runs
// inside patchConfig. A ConfigError becomes the field's message instead of a mutation.
import { computed, ref } from 'vue';
import { kindOf } from '../../core/registry.js';
import { t } from '../../i18n.js';
import { useWorkbench } from '../workbench-context';
import ConfigField, { type Descriptor, labelOf } from './ConfigField.vue';
import { useNode } from './common';
import './bodies-a.css';

const props = defineProps<{ nodeId: string; fields?: string[]; exclude?: string[]; disabled?: boolean; label?: string }>();
const wb = useWorkbench();
const { node } = useNode(wb, () => props.nodeId);
const schema = computed<Record<string, Descriptor>>(() => (node.value ? (kindOf(node.value.kind).config.schema as Record<string, Descriptor>) : {}));
const keys = computed(() => {
  const all = props.fields ?? Object.keys(schema.value);
  const skip = new Set(props.exclude ?? []);
  return all.filter(k => k in schema.value && !skip.has(k));
});
const rejected = ref<Record<string, string>>({});
function change(key: string, value: unknown) {
  const n = node.value; if (!n) return;
  try {
    wb.edit(props.label ?? t('修改 {title} 的 {field}', { title: n.title, field: labelOf(key, schema.value[key]) }), () => wb.graph.patchConfig(props.nodeId, { [key]: value }));
    if (rejected.value[key]) { const { [key]: _, ...rest } = rejected.value; rejected.value = rest; }
  } catch (e) { rejected.value = { ...rejected.value, [key]: (e as Error).message }; }
}
</script>

<template>
  <div class="cform">
    <ConfigField v-for="k in keys" :key="k" :name="k" :desc="schema[k]" :value="node?.config[k]" :disabled="disabled" :problem="rejected[k] ?? null" @change="change(k, $event)" />
  </div>
</template>
