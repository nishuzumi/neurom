<script setup lang="ts">
// renderers/table.vue — rows of records (scope.js tableModel): report episodes, group rows, execution history.
import { computed } from 'vue';
import { tableModel, formatCell } from './scope.js';
import { t } from '../../i18n.js';

const props = defineProps<{ scope: unknown; path: string; marks: Record<string, string> }>();
const model = computed(() => tableModel(props.scope, props.path, props.marks));
</script>

<template>
  <div v-if="!model.columns.length" class="bhint">{{ t('没有可列表的记录：path 需要指向记录数组') }}</div>
  <div v-else class="btable-wrap rtable">
    <table class="btable">
      <thead><tr><th v-for="c in model.columns" :key="c.key" :title="c.path">{{ c.label }}</th></tr></thead>
      <tbody>
        <tr v-for="(row, i) in model.rows" :key="i"><td v-for="(cell, j) in row" :key="j" :title="formatCell(cell, 6)">{{ formatCell(cell) }}</td></tr>
      </tbody>
    </table>
    <div v-if="model.total > model.rows.length" class="bhint">{{ t('显示前 {shown} 行，共 {total} 行', { shown: model.rows.length, total: model.total }) }}</div>
  </div>
</template>
