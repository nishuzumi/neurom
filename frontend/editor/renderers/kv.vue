<script setup lang="ts">
// renderers/kv.vue — key / value list of a record (scope.js kvModel): report metrics, the current State, an artifact.
import { computed } from 'vue';
import { kvModel, formatCell } from './scope.js';
import { t } from '../../i18n.js';

const props = defineProps<{ scope: unknown; path: string; marks: Record<string, string> }>();
const rows = computed(() => kvModel(props.scope, props.path, props.marks));
</script>

<template>
  <div v-if="rows.length === 1 && rows[0].value === undefined" class="bhint">{{ t('路径 {path} 没有值', { path }) }}</div>
  <dl v-else class="bkv rkv">
    <template v-for="r in rows" :key="r.key"><dt>{{ r.key }}</dt><dd :title="formatCell(r.value, 8)">{{ formatCell(r.value) }}</dd></template>
  </dl>
</template>
