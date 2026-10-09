<script setup lang="ts">
// BitsBody.vue — the bit-wiring module: an ordered list of parts. Each part is a slice [offset, offset+width) of one
// input port. The output is their concatenation. Rows edit in place. The summary shows the input widths and the total.
import { computed } from 'vue';
import { partPorts, partsWidth } from '../../core/kinds/bits.js';
import { t } from '../../i18n.js';
import { useWorkbench } from '../workbench-context';
import { useNode } from './common';
import { usePatch } from './body-utils';
import './bodies-a.css';

interface Part { port: string; offset: number; width: number }
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();
const { node, problems } = useNode(wb, () => props.nodeId);
const parts = computed(() => (node.value?.config.parts as Part[] | undefined) ?? []);
const total = computed(() => partsWidth(parts.value));
const inputs = computed(() => {
  void wb.version.value;
  const res = wb.resolution();
  return partPorts(parts.value).map((port: string) => { const T = res.inTypeOf(props.nodeId, port) as { type?: string; width?: number } | null; return { port, width: T?.type === 'vector' ? T.width : null }; });
});
const { error, patch } = usePatch(() => props.nodeId);
function setPart(i: number, key: keyof Part, raw: string) {
  const next = parts.value.map(p => ({ ...p }));
  if (key === 'port') { const name = raw.trim(); if (!IDENTIFIER.test(name)) { error.value = t('端口名必须是标识符'); return; } next[i].port = name; }
  else { const n = Number(raw); if (!Number.isInteger(n)) { error.value = t('必须是整数'); return; } next[i][key] = n; }
  patch(t('修改位线切片 {i}', { i }), { parts: next });
}
function addPart() { const last = parts.value[parts.value.length - 1]; patch(t('新增位线切片'), { parts: [...parts.value, { port: last?.port ?? 'in', offset: last ? last.offset + last.width : 0, width: last?.width ?? 8 }] }); }
function removePart(i: number) { if (parts.value.length <= 1) return; patch(t('删除位线切片 {i}', { i }), { parts: parts.value.filter((_, k) => k !== i) }); }
function move(i: number, d: -1 | 1) { const j = i + d; if (j < 0 || j >= parts.value.length) return; const next = [...parts.value]; [next[i], next[j]] = [next[j], next[i]]; patch(t('调整位线切片顺序'), { parts: next }); }
</script>

<template>
  <div v-if="node" class="body" @keydown.stop>
    <div class="bits-rows">
      <span class="bhint">{{ t('端口') }}</span><span class="bhint">{{ t('偏移') }}</span><span class="bhint">{{ t('宽度') }}</span><span></span>
      <template v-for="(p, i) in parts" :key="i">
        <input type="text" :value="p.port" spellcheck="false" :aria-label="t('切片 {i} 的端口', { i })" @change="setPart(i, 'port', ($event.target as HTMLInputElement).value)" />
        <input type="number" min="0" max="255" step="1" :value="p.offset" :aria-label="t('切片 {i} 的偏移', { i })" @change="setPart(i, 'offset', ($event.target as HTMLInputElement).value)" />
        <input type="number" min="1" max="256" step="1" :value="p.width" :aria-label="t('切片 {i} 的宽度', { i })" @change="setPart(i, 'width', ($event.target as HTMLInputElement).value)" />
        <span class="bits-ops">
          <button type="button" class="mini" :disabled="i === 0" :aria-label="t('上移切片 {i}', { i })" @click="move(i, -1)">↑</button>
          <button type="button" class="mini" :disabled="i === parts.length - 1" :aria-label="t('下移切片 {i}', { i })" @click="move(i, 1)">↓</button>
          <button type="button" class="mini" :disabled="parts.length <= 1" :aria-label="t('删除切片 {i}', { i })" @click="removePart(i)">×</button>
        </span>
      </template>
    </div>
    <div class="brow">
      <button type="button" class="mini" :disabled="parts.length >= 256" @click="addPart">{{ t('＋ 切片') }}</button>
      <span class="bhint">{{ t('输出 {total} 位', { total }) }} · {{ inputs.map(x => `${x.port}: ${x.width ?? '?'}`).join(', ') }}</span>
    </div>
    <div v-if="error" class="bproblem" role="alert">{{ error }}</div>
    <div v-for="(p, i) in problems" :key="i" class="bproblem" :class="{ incomplete: p.incomplete }">{{ p.message }}</div>
  </div>
</template>

<style scoped>
.bits-rows{display:grid;grid-template-columns:minmax(0,1fr) 5em 5em auto;gap:3px 5px;align-items:center;min-width:0}
.bits-rows input{width:100%;min-width:0}
.bits-ops{display:inline-flex;gap:0}
.bits-ops button{padding:0 5px;font-size:11px}
</style>
