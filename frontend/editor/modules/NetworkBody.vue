<script setup lang="ts">
// NetworkBody.vue — the network module. It shows engine / kind / the declared input width `inputs` (I) / the weight
// width `weightBits` (8 or 16). The trainer chooses the scale per layer (ADR 0015). It also shows the layer list and
// the LIF parameters (the fields the chosen engine uses). Then come O (the readout consuming `scores`), the weight
// size, and the on-chain deploy limit, as core/kinds/network.js deploymentProblem judges the derived structure.
// Edit the layer list here (add / remove / resize a layer, add a tool layer, set a tool layer's `data` width). Dense
// entries are `{ hidden }` or `{ tools, data? }`. Threshold entries are plain widths. Switching the engine keeps the
// widths and rewrites the plain entries in the other engine's form (threshold networks have no tool layers).
// A network that no trainer trains picks the artifact it runs here (`artifact`, ADR 0010 §8) through its network
// session (core/sessions/network.js). Choices: workspace and builtin artifacts with name, metric and compatibility,
// or a JSON import.
import { computed, shallowRef } from 'vue';
import { denseWeightBytes, thresholdWeightBytes, deploymentProblem, networkStructure, layersNotation, ENGINES, MAX_LAYERS, MAX_WIDTH } from '../../core/kinds/network.js';
import { t } from '../../i18n.js';
import { useWorkbench } from '../workbench-context';
import ConfigForm from './ConfigForm.vue';
import ArtifactImport from './ArtifactImport.vue';
import { useNode } from './common';
import { useSession, useAct, usePatch, fmt, shortId, structureLabel, compatLabel, compatClass } from './body-utils';
import './bodies-a.css';
import './bodies-b.css';

type Engine = 'dense-policy' | 'threshold-layers';
type Layer = number | { hidden?: number; tools?: string; data?: number };
type ToolWidths = Record<string, { K: number; D: number | null; R: number | null }>;
interface Config { engine: Engine; kind: 'feedforward' | 'lif'; inputs: number; weightBits: 8 | 16; layers: Layer[]; ticks: number; leak_shift: number; reset: number }
const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();
const { node, problems } = useNode(wb, () => props.nodeId);
const cfg = computed(() => node.value?.config as unknown as Config | undefined);
const refs = computed(() => { void wb.version.value; return node.value ? (wb.resolution().refsOf(props.nodeId) as { I?: number | null; O?: number | null; tools?: ToolWidths }) : {}; });
const fields = computed(() => {
  const c = cfg.value; if (!c) return [];
  if (c.engine === 'threshold-layers') return ['kind', 'inputs', 'weightBits'];
  return c.kind === 'lif' ? ['kind', 'inputs', 'weightBits', 'ticks', 'leak_shift', 'reset'] : ['kind', 'inputs', 'weightBits'];
});
/** the width of a plain entry in either engine's form. Null for a tool layer */
const widthOf = (L: Layer): number | null => (typeof L === 'number' ? L : typeof L.hidden === 'number' ? L.hidden : null);
const toolOf = (L: Layer): string | null => (typeof L === 'object' && typeof L.tools === 'string' ? L.tools : null);
/** every entry's widths are known: plain widths, and K / D / R of each tool layer */
const known = computed(() => (cfg.value?.layers ?? []).every(L => { const port = toolOf(L); return port === null ? widthOf(L) !== null : !!refs.value.tools?.[port]?.R; }));
const structure = computed(() => {
  const c = cfg.value, { I, O } = refs.value; if (!c || !I || !O || !known.value) return null;
  return networkStructure(c, I, O, refs.value.tools ?? {}) as { layers: unknown[] };
});
const bytes = computed(() => {
  const c = cfg.value, s = structure.value, { I, O } = refs.value; if (!c || !s) return null;
  return c.engine === 'dense-policy' ? denseWeightBytes(I, s.layers, O, c.weightBits) : thresholdWeightBytes([I, ...(c.layers as number[]), O], c.weightBits);
});
const deploy = computed(() => (structure.value ? deploymentProblem(structure.value) as string | null : null));
const shape = computed(() => {
  const c = cfg.value, { I, O } = refs.value; if (!c) return '';
  return `${I ?? '?'} → ${layersNotation(c.layers).split('/').join(' → ')} → ${O ?? '?'}`;
});

const { error: rejected, patch } = usePatch(() => props.nodeId);
const entry = (engine: Engine, width: number): Layer => (engine === 'dense-policy' ? { hidden: width } : width);
function setEngine(engine: Engine) {
  const c = cfg.value; if (!c || engine === c.engine) return;
  const plainLayers = c.layers.filter(L => toolOf(L) === null).map(L => entry(engine, widthOf(L) ?? 1));
  const layers = plainLayers.length ? plainLayers : [entry(engine, 16)];
  patch(t('修改 {title} 的 {field}', { title: node.value!.title, field: 'engine' }), { engine, layers });
}
function setWidth(i: number, raw: string) {
  const c = cfg.value; if (!c) return;
  const width = Number(raw);
  if (!Number.isInteger(width) || width < 1 || width > MAX_WIDTH) { rejected.value = t('层宽必须是 1..{max} 的整数', { max: MAX_WIDTH }); return; }
  if (width === widthOf(c.layers[i])) return;
  patch(t('修改 {title} 第 {index} 层的宽度', { title: node.value!.title, index: i + 1 }), { layers: c.layers.map((L, k) => (k === i ? entry(c.engine, width) : L)) });
}
function addLayer() {
  const c = cfg.value; if (!c || c.layers.length >= MAX_LAYERS) return;
  const width = widthOf(c.layers[c.layers.length - 1]) ?? 16;
  patch(t('给 {title} 加一层', { title: node.value!.title }), { layers: [...c.layers, entry(c.engine, width)] });
}
function removeLayer(i: number) {
  const c = cfg.value; if (!c || c.layers.length <= 1) return;
  patch(t('删除 {title} 的第 {index} 层', { title: node.value!.title, index: i + 1 }), { layers: c.layers.filter((_, k) => k !== i) });
}
/** a tool port name no layer uses yet: tools, tools2, tools3… */
function freshPort(layers: Layer[]): string {
  const used = new Set(layers.map(toolOf));
  for (let k = 1; ; k++) { const name = k === 1 ? 'tools' : `tools${k}`; if (!used.has(name)) return name; }
}
function addToolLayer() {
  const c = cfg.value; if (!c || c.engine !== 'dense-policy' || c.layers.length >= MAX_LAYERS) return;
  patch(t('给 {title} 加一个工具层', { title: node.value!.title }), { layers: [...c.layers, { tools: freshPort(c.layers) }] });
}
/** `data` of tool layer i: blank → derived from the network tools (the key is dropped) */
function setData(i: number, raw: string) {
  const c = cfg.value, L = c?.layers[i]; if (!c || typeof L !== 'object') return;
  const text = raw.trim(), data = Number(text);
  if (text && (!Number.isInteger(data) || data < 1 || data > MAX_WIDTH)) { rejected.value = t('data 必须是 1..{max} 的整数。留空时取最宽的网络工具的输入宽度', { max: MAX_WIDTH }); return; }
  if ((text ? data : undefined) === L.data) return;
  const rest = { ...L }; delete rest.data;
  patch(t('修改 {title} 第 {index} 层的 data', { title: node.value!.title, index: i + 1 }), { layers: c.layers.map((E, k) => (k === i ? (text ? { ...rest, data } : rest) : E)) });
}

// ------------------------------------------------------------------ the artifact a frozen network runs
type Choice = { id: string; name: string | null; builtin: boolean; metric: number | null; metricName: string | null; engine: string; kind: string; inputs: number; outputs: number; layers?: unknown[]; selected: boolean; compatible: { ok: boolean | null; reason: string } };
const { session: picker, snap: pick } = useSession('network', props.nodeId);
const { error: pickError, act } = useAct();
const trained = computed(() => pick.value.trained as boolean);
const weightsWired = computed(() => pick.value.weightsWired as boolean);
const locked = computed(() => pick.value.locked as string | null);
const choices = computed(() => (pick.value.choices as Choice[]) ?? []);
const current = computed(() => pick.value.current as (Choice & { missing?: boolean }) | null);
const choiceLabel = (c: Choice) => `${c.name ?? shortId(c.id)}${c.builtin ? ` · ${t('内置')}` : ''} · ${c.metricName ?? 'metric'} ${fmt(c.metric)} · ${compatLabel(c)}`;
function choose(id: string) {
  const title = node.value!.title;
  act(() => wb.edit(id ? t('给 {title} 选定产物', { title }) : t('清除 {title} 的产物', { title }), () => picker.select(id || null)));
}
const importing = shallowRef(false);
const importArtifact = (text: string) => wb.edit(t('给 {title} 导入产物', { title: node.value!.title }), () => picker.importArtifact(text));
</script>

<template>
  <div v-if="cfg" class="body">
    <div class="net-io">
      <span>I = <b>{{ refs.I ?? '?' }}</b></span><span>O = <b>{{ refs.O ?? '?' }}</b></span><span class="m">{{ shape }}</span>
    </div>
    <div class="cform">
      <div class="cf-row">
        <label class="cf-label" :for="`${nodeId}-engine`" title="engine">engine</label>
        <select :id="`${nodeId}-engine`" :value="cfg.engine" @change="setEngine(($event.target as HTMLSelectElement).value as Engine)">
          <option v-for="e in ENGINES" :key="e" :value="e">{{ e }}</option>
        </select>
      </div>
      <ConfigForm :node-id="nodeId" :fields="fields" />
      <div class="cf-group" role="list" :aria-label="t('隐藏层')">
        <div v-for="(L, i) in cfg.layers" :key="i" class="cf-row" role="listitem">
          <label class="cf-label" :for="`${nodeId}-layer-${i}`">{{ t('第 {index} 层', { index: i + 1 }) }}</label>
          <span class="net-ctl">
            <input v-if="widthOf(L) !== null" :id="`${nodeId}-layer-${i}`" type="number" min="1" :max="MAX_WIDTH" step="1" :value="widthOf(L)"
              :aria-label="t('第 {index} 层的宽度', { index: i + 1 })" @change="setWidth(i, ($event.target as HTMLInputElement).value)" />
            <span v-else class="net-tool">
              <span :id="`${nodeId}-layer-${i}`" class="m">{{ t('工具层 {port}', { port: toolOf(L) ?? '' }) }}</span>
              <input type="number" min="1" :max="MAX_WIDTH" step="1" :value="typeof L === 'object' ? L.data ?? '' : ''"
                :placeholder="`data ${refs.tools?.[toolOf(L) ?? '']?.D ?? '?'}`" :title="t('data：交给工具的数据位数。留空时取最宽的网络工具的输入宽度')"
                :aria-label="t('第 {index} 层的 data', { index: i + 1 })" @change="setData(i, ($event.target as HTMLInputElement).value)" />
            </span>
            <button type="button" class="mini" :disabled="cfg.layers.length <= 1" :title="t('删除这一层')" :aria-label="t('删除第 {index} 层', { index: i + 1 })" @click="removeLayer(i)">×</button>
          </span>
        </div>
        <div class="net-adds">
          <button type="button" class="mini" :disabled="cfg.layers.length >= MAX_LAYERS" @click="addLayer">{{ t('+ 层') }}</button>
          <button v-if="cfg.engine === 'dense-policy'" type="button" class="mini" :disabled="cfg.layers.length >= MAX_LAYERS" @click="addToolLayer">{{ t('+ 工具层') }}</button>
        </div>
        <div v-if="rejected" class="cf-error" role="alert">{{ rejected }}</div>
      </div>
      <div v-if="!trained || pick.artifact" class="cf-group">
        <div class="cf-row">
          <label class="cf-label" :for="`${nodeId}-artifact`">{{ t('产物') }}</label>
          <span class="net-ctl">
            <select :id="`${nodeId}-artifact`" :value="pick.artifact ?? ''" :disabled="!!locked && !pick.artifact" :title="locked ?? t('这个网络运行的产物（没有训练器训练它时）')" @change="choose(($event.target as HTMLSelectElement).value)">
              <option value="">{{ weightsWired ? t('（权重来自接入 weights 的候选）') : t('（未选定）') }}</option>
              <option v-if="current?.missing" :value="current.id">{{ t('{id}（不在工作区）', { id: shortId(current.id) }) }}</option>
              <option v-for="c in choices" :key="c.id" :value="c.id" :disabled="!!locked">{{ choiceLabel(c) }}</option>
            </select>
            <button type="button" class="mini" :disabled="!!locked" :title="locked ?? t('导入 neurom-module 产物并选定它')" @click="importing = !importing">{{ t('导入') }}</button>
          </span>
        </div>
        <div v-if="current && !current.missing" class="brow bhint">
          <span class="pin" :title="current.id">{{ current.name ?? shortId(current.id) }}</span>
          <span class="mono">{{ current.metricName ?? 'metric' }} <b>{{ fmt(current.metric) }}</b></span>
          <span>{{ structureLabel(current) }}</span>
          <span class="ctag" :class="compatClass(current)" :title="current.compatible.reason">{{ compatLabel(current) }}</span>
        </div>
        <div v-if="current && !current.missing && current.compatible.ok === false" class="bproblem">{{ current.compatible.reason }}</div>
        <div v-if="current?.missing" class="bproblem">{{ t('产物 {id} 不在工作区：重新选定或导入', { id: shortId(current.id) }) }}</div>
        <ArtifactImport v-if="importing" :run="importArtifact" @done="importing = false" />
        <div v-if="pickError" class="bproblem">{{ pickError }}</div>
      </div>
    </div>
    <div class="bhint">
      <template v-if="bytes !== null">{{ t('权重 {bytes} 字节', { bytes }) }} · </template>
      <span v-if="deploy === null && bytes !== null" class="ok">{{ t('可上链部署') }}</span>
      <span v-else-if="deploy" class="bad">{{ deploy }}</span>
      <span v-else-if="known">{{ t('O 未定：接入读出后可判断上链限制') }}</span>
    </div>
    <div v-for="(p, i) in problems" :key="i" class="bproblem" :class="{ incomplete: p.incomplete }">{{ p.message }}</div>
  </div>
</template>

<style scoped>
.net-ctl{display:flex;gap:4px;align-items:center;min-width:0}
.net-ctl>input,.net-ctl>select{flex:1;min-width:0;width:0}
.net-adds{display:flex;gap:4px;grid-column:2}
.net-tool{display:flex;gap:4px;align-items:center;flex:1;min-width:0}
.net-tool input{flex:1;min-width:0;width:0}
</style>
