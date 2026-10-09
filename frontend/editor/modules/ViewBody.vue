<script setup lang="ts">
// ViewBody.vue — the view module: a renderer (grid / series / table / kv) over a path into a source. The source is
// the execution snapshot of the execution node wired into `execution`, or the report of the evaluator wired into
// `report`. Marks are name → path (or literal) pairs that the renderer interprets (renderers/scope.js). No scenario
// code: a template configures what its grid shows through marks. A template can also draw the grid itself with a view
// script (renderer `script`, ADR 0013). The script's frame gets `ctx`: the same run data at the scrubbed step, plus
// the training module's values by title.
import { computed, shallowRef, watch } from 'vue';
import { useWorkbench } from '../workbench-context';
import { useNode, useBuffered } from './common';
import { RENDERERS, scriptStub } from '../../core/kinds/view.js';
import { executionScope, reportScope, scriptContext, trainingModuleValues } from '../renderers/scope.js';
import GridRenderer from '../renderers/grid.vue';
import SeriesRenderer from '../renderers/series.vue';
import TableRenderer from '../renderers/table.vue';
import KvRenderer from '../renderers/kv.vue';
import ScriptRenderer from '../renderers/script.vue';
import ScriptEditor from './ScriptEditor.vue';
import { useSessionAt } from './body-utils';
import { t } from '../../i18n.js';
import './bodies-a.css';
import './bodies-b.css';

const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();
const { node } = useNode(wb, () => props.nodeId);
const RENDERER: Record<string, unknown> = { grid: GridRenderer, series: SeriesRenderer, table: TableRenderer, kv: KvRenderer };
const config = computed(() => (node.value?.config ?? {}) as { renderer: string; path: string; marks: Record<string, string>; script: string });
const isScript = computed(() => config.value.renderer === 'script');

// ------------------------------------------------------------------ the source: an execution or an evaluator session
type Source = { kind: 'execution' | 'evaluator'; id: string } | null;
/** keeps the previous object while kind and id are unchanged, so unrelated graph edits do not ripple into scope / ctx */
const source = computed<Source>(prev => {
  void wb.version.value;
  const ex = wb.graph.producers(props.nodeId, 'execution')[0], rp = wb.graph.producers(props.nodeId, 'report')[0];
  const next: Source = ex && wb.graph.node(ex.node)?.kind === 'execution' ? { kind: 'execution', id: ex.node }
    : rp && wb.graph.node(rp.node)?.kind === 'evaluator' ? { kind: 'evaluator', id: rp.node } : null;
  return prev && next && prev.kind === next.kind && prev.id === next.id ? prev : next;
});
const snap = useSessionAt(source);

// ------------------------------------------------------------------ scope (+ step scrubber over an execution history)
const at = shallowRef<number | null>(null);
const historyLength = computed(() => (source.value?.kind === 'execution' ? ((snap.value?.history as unknown[] | undefined)?.length ?? 0) : 0));
watch(historyLength, n => { if (at.value !== null && at.value >= n) at.value = null; });
const scope = computed(() => {
  const s = snap.value; if (!s || !source.value) return null;
  if (source.value.kind === 'evaluator') return reportScope(s.report);
  return executionScope(s, at.value);
});
// ------------------------------------------------------------------ a view script's ctx: run data + the training module's values
const moduleValues = computed(() => { void wb.version.value; return isScript.value ? trainingModuleValues(wb.graph, wb.resolution(), props.nodeId) : { modules: {}, errors: [] }; });
const ctx = computed(() => (isScript.value && scope.value ? scriptContext(scope.value as Record<string, unknown>, source.value?.kind ?? null, at.value === null, moduleValues.value) : null));
const script = useBuffered(() => String(config.value.script ?? ''), text => {
  if (!node.value) return false;
  wb.edit(t('编辑视图脚本 {title}', { title: node.value.title }), () => wb.graph.patchConfig(props.nodeId, { script: text }));
});
/** picking the script renderer on an empty script starts from the stub */
function setRenderer(renderer: string) {
  patch(t('切换渲染器'), renderer === 'script' && !String(config.value.script ?? '').trim() ? { renderer, script: scriptStub() } : { renderer });
}

const emptyWhy = computed(() => {
  if (!source.value) return t('接一个执行实例（execution）或评估器（report）');
  if (!snap.value) return null;
  if (snap.value.dead) return String(snap.value.dead);
  if (source.value.kind === 'evaluator') return snap.value.report ? null : t('评估器还没有报告：在评估器上点“评估”');
  return (snap.value.started || historyLength.value) ? null : t('执行实例还没有开始：在执行实例上点“重置”或“走一步”');
});

// ------------------------------------------------------------------ config
const marksRows = computed(() => Object.entries(config.value.marks ?? {}));
const newKey = shallowRef(''), newValue = shallowRef('');
function patch(label: string, p: Record<string, unknown>) { wb.edit(label, () => wb.graph.patchConfig(props.nodeId, p)); }
function setMark(key: string, value: string) { const marks = { ...config.value.marks }; if (value.trim() === '') delete marks[key]; else marks[key] = value.trim(); patch(t('修改视图标记'), { marks }); }
function addMark() { const k = newKey.value.trim(); if (!/^[A-Za-z_]\w*$/.test(k)) return; setMark(k, newValue.value); newKey.value = ''; newValue.value = ''; }
const configError = shallowRef<string | null>(null);
function setPath(e: Event) { configError.value = null; try { patch(t('修改视图路径'), { path: (e.target as HTMLInputElement).value.trim() }); } catch (err) { configError.value = (err as Error).message; } }
const HINTS: Record<string, string> = {
  grid: 'width,height · agent=x,y 或 x/y · base=x,y 或 baseX/baseY · target=x,y · radius · order=xy|yx · colors',
  series: 'x（横轴标签路径）· min/max · 其余键 = 额外数列路径',
  table: '键 = 列名，值 = 行内路径 · limit',
  kv: '键 = 名称，值 = 路径（留空则展开 path 的记录）',
};
</script>

<template>
  <div class="body vbody">
    <div class="brow">
      <select :value="config.renderer" :aria-label="t('渲染器')" @change="setRenderer(($event.target as HTMLSelectElement).value)">
        <option v-for="r in RENDERERS" :key="r" :value="r">{{ r }}</option>
      </select>
      <input v-if="!isScript" class="bgrow mono" :value="config.path" :aria-label="t('路径')" :placeholder="t('例如 state.map 或 report.metrics')" spellcheck="false" @change="setPath" />
      <span v-else class="bgrow" />
      <span class="bhint" :class="{ srcok: source }">{{ source ? (source.kind === 'execution' ? t('来源：执行实例') : t('来源：报告')) : t('无来源') }}</span>
    </div>
    <div v-if="configError" class="bproblem">{{ configError }}</div>

    <div v-if="emptyWhy" class="bhint vempty">{{ emptyWhy }}</div>
    <template v-else-if="scope">
      <div class="vfill bfill">
        <ScriptRenderer v-if="isScript && ctx" :ctx="ctx" :source="config.script ?? ''" />
        <component :is="RENDERER[config.renderer]" v-else-if="!isScript" :scope="scope" :path="config.path" :marks="config.marks ?? {}" />
      </div>
      <div v-if="historyLength" class="brow vscrub">
        <input type="range" class="bgrow" min="0" :max="historyLength - 1" :value="at ?? historyLength - 1" :aria-label="t('回看步')" @input="at = Number(($event.target as HTMLInputElement).value)" />
        <span class="bhint mono">{{ at === null ? t('实时 · {n} 步', { n: historyLength }) : t('第 {n} 步', { n: at + 1 }) }}</span>
        <button v-if="at !== null" type="button" class="mini" @click="at = null">{{ t('回到当前') }}</button>
      </div>
    </template>

    <details v-if="isScript" class="bsection">
      <summary>{{ t('视图脚本') }}</summary>
      <div class="bhint">{{ t('定义 const component（Vue 组件，props 声明 ctx）或 function render(ctx, el)。ctx 是滑条选中那一步的数据，例如 state、history、t、report。ctx.modules[标题][端口] 是训练模块成员的静态值。脚本在沙箱里运行，不能联网。') }}</div>
      <ScriptEditor :buffer="script" :label="t('{title} 的视图脚本', { title: node?.title ?? '' })" />
    </details>
    <details v-else class="bsection">
      <summary>{{ t('标记 {n} 项', { n: marksRows.length }) }}</summary>
      <div class="bhint">{{ t(HINTS[config.renderer] ?? '') }}</div>
      <div class="vmarks">
        <template v-for="[k, v] in marksRows" :key="k">
          <span class="mono vkey">{{ k }}</span>
          <input class="mono" :value="v" :aria-label="t('标记 {key}', { key: k })" spellcheck="false" @change="setMark(k, ($event.target as HTMLInputElement).value)" />
          <button type="button" class="mini" :title="t('删除标记')" @click="setMark(k, '')">×</button>
        </template>
        <input v-model="newKey" class="mono" :placeholder="t('名称')" :aria-label="t('新标记名称')" spellcheck="false" @keydown.enter.prevent="addMark" />
        <input v-model="newValue" class="mono" :placeholder="t('路径或字面量')" :aria-label="t('新标记值')" spellcheck="false" @keydown.enter.prevent="addMark" />
        <button type="button" class="mini" :disabled="!/^[A-Za-z_]\w*$/.test(newKey.trim())" @click="addMark">+</button>
      </div>
    </details>
  </div>
</template>
