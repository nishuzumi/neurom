<script setup lang="ts">
// DatasetBody.vue — the dataset module. It imports CSV / JSON (file picker, drop, or pasted text) through the node's
// dataset session (frontend/core/sessions/dataset.js: numeric columns, rectangular rows, content hash). Then it shows
// the metadata (name, columns, rows, hash) and a preview of the first rows from the store.
import { computed, ref, watch } from 'vue';
import { t } from '../../i18n.js';
import { useWorkbench } from '../workbench-context';
import { useNode } from './common';
import { useSession } from './body-utils';
import './bodies-a.css';

interface Meta { id: string; name: string; columns: string[]; rows: number; hash: string }
interface Snap { dead: string | null; meta: Meta | null; loaded: { hash: string; rows: number } | null; error: string | null }

const PREVIEW_ROWS = 8;
const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();
const { node, problems } = useNode(wb, () => props.nodeId);
const { session, snap: raw } = useSession('dataset', props.nodeId);
const snap = computed(() => raw.value as unknown as Snap);

const meta = computed(() => snap.value.meta);
const preview = ref<{ columns: string[]; rows: number[][] }>({ columns: [], rows: [] });
const showPreview = ref(false);
async function loadPreview() {
  if (!showPreview.value) return;
  try { preview.value = (await session.preview(PREVIEW_ROWS)) as { columns: string[]; rows: number[][] }; } catch (e) { wb.status((e as Error).message, 'bad'); }
}
watch([showPreview, () => meta.value?.hash], loadPreview, { immediate: true });

const busy = ref(false), error = ref<string | null>(null), over = ref(false);
const format = ref<'auto' | 'csv' | 'json'>('auto');
const pasted = ref('');
async function importText(text: string, name: string | null) {
  busy.value = true; error.value = null;
  try {
    const m = (await session.import(text, { format: format.value, name })) as Meta;
    wb.status(t('已导入数据集 {name}：{rows} 行 × {cols} 列', { name: m.name, rows: m.rows, cols: m.columns.length }), 'ok');
    pasted.value = '';
  } catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function onFile(files: FileList | null) {
  const file = files?.[0]; if (!file) return;
  if (format.value === 'auto' && /\.json$/i.test(file.name)) format.value = 'json';
  else if (format.value === 'auto' && /\.(csv|tsv|txt)$/i.test(file.name)) format.value = 'csv';
  await importText(await file.text(), file.name.replace(/\.[^.]+$/, ''));
  format.value = 'auto';
}
function onDrop(e: DragEvent) { over.value = false; onFile(e.dataTransfer?.files ?? null); }
function rename(raw: string) {
  const name = raw.trim(); if (!name || name === node.value?.config.name) return;
  wb.edit(t('重命名数据集'), () => wb.graph.patchConfig(props.nodeId, { name }));
}
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toPrecision(6).replace(/\.?0+$/, ''));
</script>

<template>
  <div class="body" @keydown.stop>
    <div v-if="snap.dead" class="bproblem">{{ snap.dead }}</div>
    <div class="brow">
      <input type="text" class="bgrow" :value="node?.config.name ?? ''" :placeholder="t('数据集名称')" :aria-label="t('数据集名称')" @change="rename(($event.target as HTMLInputElement).value)" />
      <select v-model="format" :aria-label="t('导入格式')" :title="t('导入格式（自动按内容判断）')">
        <option value="auto">{{ t('自动') }}</option><option value="csv">CSV</option><option value="json">JSON</option>
      </select>
    </div>
    <label class="ds-drop" :class="{ over }" @dragover.prevent="over = true" @dragleave="over = false" @drop.prevent="onDrop">
      <input type="file" accept=".csv,.tsv,.txt,.json,text/csv,application/json" :disabled="busy" @change="onFile(($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value = ''" />
      {{ busy ? t('导入中…') : t('点击选择或拖入 CSV / JSON 文件（首行列名，数值列）') }}
    </label>
    <details class="bsection">
      <summary>{{ t('粘贴文本导入') }}</summary>
      <textarea v-model="pasted" rows="4" spellcheck="false" wrap="off" :placeholder="t('列名行 + 数值行，或 JSON 记录数组')" :aria-label="t('粘贴的表格文本')"></textarea>
      <div class="brow"><button type="button" class="mini" :disabled="busy || !pasted.trim()" @click="importText(pasted, null)">{{ t('导入粘贴内容') }}</button></div>
    </details>
    <div v-if="error" class="bproblem" role="alert">{{ error }}</div>
    <dl v-if="meta" class="bkv">
      <dt>{{ t('列') }}</dt><dd :title="meta.columns.join(', ')">{{ meta.columns.length }} · {{ meta.columns.join(', ') }}</dd>
      <dt>{{ t('行') }}</dt><dd>{{ meta.rows }}</dd>
      <dt>{{ t('哈希') }}</dt><dd><span class="pin" :title="meta.hash">{{ short(meta.hash) }}</span></dd>
      <dt>{{ t('存储 id') }}</dt><dd>{{ meta.id }}</dd>
    </dl>
    <div v-else class="bhint">{{ t('尚未导入数据。导入的列决定输出的 table 类型。') }}</div>
    <details v-if="meta" class="bsection" @toggle="showPreview = ($event.target as HTMLDetailsElement).open">
      <summary>{{ t('预览前 {n} 行', { n: PREVIEW_ROWS }) }}</summary>
      <div v-if="showPreview" class="btable-wrap">
        <table class="btable">
          <thead><tr><th v-for="c in preview.columns" :key="c" :title="c">{{ c }}</th></tr></thead>
          <tbody>
            <tr v-for="(row, i) in preview.rows" :key="i"><td v-for="(v, j) in row" :key="j">{{ fmt(v) }}</td></tr>
            <tr v-if="!preview.rows.length"><td :colspan="Math.max(1, preview.columns.length)" class="m">{{ t('存储中没有这份数据（可能在另一台设备导入）。请重新导入。') }}</td></tr>
          </tbody>
        </table>
      </div>
    </details>
    <div v-for="(p, i) in problems" :key="i" class="bproblem" :class="{ incomplete: p.incomplete }">{{ p.message }}</div>
  </div>
</template>
