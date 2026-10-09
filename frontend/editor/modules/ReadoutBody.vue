<script setup lang="ts">
// ReadoutBody.vue — the readout module: argmax or bits. Argmax uses a map from output slot → action index, or
// null = an explicit invalid action (O = the map's length). Bits uses width + lsb-int decode. When a string array is
// wired into `actions`, the map rows offer the action names. Otherwise they take raw indices. The `scores` input's
// width follows O, so adding / removing slots re-types the network feeding it.
import { computed } from 'vue';
import { staticValue } from '../../core/bundle.js';
import { t } from '../../i18n.js';
import { useWorkbench } from '../workbench-context';
import { useNode } from './common';
import { usePatch } from './body-utils';
import './bodies-a.css';

interface Config { mode: 'argmax' | 'bits'; map: (number | null)[]; width: number; decode: 'lsb-int' }
const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();
const { node, problems } = useNode(wb, () => props.nodeId);
const cfg = computed(() => node.value?.config as unknown as Config | undefined);
/** action names from the wired `actions` (static string array), null when unknown */
const actions = computed<string[] | null>(() => {
  void wb.version.value;
  const p = wb.graph.producers(props.nodeId, 'actions')[0];
  if (!p) return null;
  try { const v = staticValue(wb.graph, wb.resolution(), p.node, p.port); return Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : null; } catch { return null; }
});
const O = computed(() => (cfg.value ? (cfg.value.mode === 'argmax' ? cfg.value.map.length : cfg.value.width) : 0));
const { error, patch } = usePatch(() => props.nodeId);
function setMode(mode: Config['mode']) { patch(t('切换读出模式为 {mode}', { mode }), { mode }); }
function setSlot(k: number, raw: string) {
  const c = cfg.value!;
  const value = raw === 'null' ? null : Number(raw);
  if (value !== null && !(Number.isInteger(value) && value >= 0)) { error.value = t('映射表第 {k} 项必须是动作下标或 null', { k }); return; }
  const map = [...c.map]; map[k] = value;
  patch(t('修改读出槽 {k}', { k }), { map });
}
function addSlot() {
  const c = cfg.value!;
  const used = new Set(c.map), n = actions.value?.length ?? Infinity;
  let a: number | null = 0; while (used.has(a) && a < n) a++;
  if (a >= n) a = null;
  patch(t('新增读出槽'), { map: [...c.map, a] });
}
function removeSlot(k: number) { const c = cfg.value!; if (c.map.length <= 1) return; patch(t('删除读出槽 {k}', { k }), { map: c.map.filter((_, i) => i !== k) }); }
function fillIdentity() { const n = actions.value?.length ?? cfg.value!.map.length; patch(t('映射表按顺序填充'), { map: Array.from({ length: n }, (_, i) => i) }); }
function setWidth(raw: string) { const n = Number(raw); if (!Number.isInteger(n)) { error.value = t('必须是整数'); return; } patch(t('修改位读出宽度'), { width: n }); }
const slotBad = (a: number | null) => a !== null && actions.value !== null && a >= actions.value.length;
const unmapped = computed(() => { const c = cfg.value; if (!c || c.mode !== 'argmax' || !actions.value) return []; const used = new Set(c.map); return actions.value.map((name, i) => ({ name, i })).filter(x => !used.has(x.i)); });
</script>

<template>
  <div v-if="cfg" class="body" @keydown.stop>
    <div class="brow">
      <label>{{ t('模式') }}
        <select :value="cfg.mode" @change="setMode(($event.target as HTMLSelectElement).value as any)">
          <option value="argmax">argmax</option><option value="bits">bits</option>
        </select>
      </label>
      <span class="bhint">O = {{ O }}</span>
    </div>
    <template v-if="cfg.mode === 'argmax'">
      <div class="ro-map">
        <template v-for="(a, k) in cfg.map" :key="k">
          <span class="ro-slot">{{ t('槽 {k}', { k }) }}</span>
          <span :class="{ invalid: a === null, bad: slotBad(a) }">
            <select v-if="actions" :value="a === null ? 'null' : String(a)" :aria-label="t('槽 {k} 的动作', { k })" @change="setSlot(k, ($event.target as HTMLSelectElement).value)">
              <option value="null">{{ t('— 无效动作 —') }}</option>
              <option v-for="(name, i) in actions" :key="i" :value="String(i)">{{ i }} · {{ name }}</option>
              <option v-if="slotBad(a)" :value="String(a)">{{ t('{a}（不存在）', { a }) }}</option>
            </select>
            <input v-else type="text" :value="a === null ? 'null' : String(a)" spellcheck="false" :aria-label="t('槽 {k} 的动作下标', { k })" :title="t('动作下标，或 null 表示无效动作')" @change="setSlot(k, ($event.target as HTMLInputElement).value.trim())" />
          </span>
          <button type="button" class="mini" :disabled="cfg.map.length <= 1" :aria-label="t('删除槽 {k}', { k })" @click="removeSlot(k)">×</button>
        </template>
      </div>
      <div class="brow">
        <button type="button" class="mini" :disabled="cfg.map.length >= 256" @click="addSlot">{{ t('＋ 槽') }}</button>
        <button type="button" class="mini" :title="t('槽 k → 动作 k')" @click="fillIdentity">{{ t('按顺序') }}</button>
        <span v-if="unmapped.length" class="bhint">{{ t('未映射的动作：{names}', { names: unmapped.map(x => `${x.i} · ${x.name}`).join(', ') }) }}</span>
      </div>
      <div v-if="!actions" class="bhint">{{ t('未接 actions（字符串数组）。按下标填写映射表。') }}</div>
    </template>
    <template v-else>
      <div class="brow">
        <label>{{ t('位宽') }}<input type="number" min="1" max="53" step="1" :value="cfg.width" @change="setWidth(($event.target as HTMLInputElement).value)" /></label>
        <label>{{ t('解码') }}<select :value="cfg.decode" disabled><option value="lsb-int">lsb-int</option></select></label>
      </div>
      <div class="bhint">{{ t('位 k = 分数[k] ≥ 0。动作 = 低位在前的整数。') }}</div>
    </template>
    <div v-if="error" class="bproblem" role="alert">{{ error }}</div>
    <div v-for="(p, i) in problems" :key="i" class="bproblem" :class="{ incomplete: p.incomplete }">{{ p.message }}</div>
  </div>
</template>
