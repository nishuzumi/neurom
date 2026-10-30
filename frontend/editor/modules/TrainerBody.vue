<script setup lang="ts">
// TrainerBody.vue — the trainer module. It shows method + backend + hyper-parameters (ConfigForm over the kind
// schema, only the fields the chosen method reads). It shows which network of the loop it trains: the one wired into
// `structure`. Every other network runs frozen. When `init` has a wire, it shows the candidates whose accepted artifact
// is the start of the next run (ADR 0020). When `gate` has a wire, it shows the condition (a metric of that evaluator,
// a minimum and a maximum) and, below start / cancel, whether the current report meets it. It also shows the Python
// workspace connection state, start / cancel, and the active run's progress with live loss / metric curves
// (accumulated from progress messages). Last comes the run list with each run's candidate.
import { computed, shallowRef, watch } from 'vue';
import { useWorkbench } from '../workbench-context';
import { useSession, useAct, fmt, shortId, duration, when } from './body-utils';
import { useNode } from './common';
import ConfigForm from './ConfigForm.vue';
import SeriesRenderer from '../renderers/series.vue';
import { METHODS, COMMON_FIELDS, gateEvaluatorOf, metricNamesOf } from '../../core/kinds/trainer.js';
import { t } from '../../i18n.js';
import './bodies-a.css';
import './bodies-b.css';

const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();
const { node } = useNode(wb, () => props.nodeId);
const { session, snap } = useSession('trainer', props.nodeId);
const { error, act } = useAct();

type Progress = { phase?: string; epoch?: number; epochs?: number; loss?: number | null; metric?: number | null; metricName?: string; selectedEpoch?: number | null; elapsed?: number };
type Run = { id: string; status: string; method?: string; backend?: string; startedAt?: number; finishedAt?: number; progress?: Progress | null; error?: string | null; metric?: number | null; metricName?: string | null; candidates: string[] };
const method = computed(() => String(node.value?.config.method ?? 'reinforce'));
const trained = computed(() => { void wb.version.value; const p = wb.graph.producers(props.nodeId, 'structure')[0]; return p ? wb.graph.nodes.get(p.node)?.title ?? p.node : null; });
/** The candidates wired into `init` and its accepted artifact: the start of the next run (ADR 0020). */
const start = computed(() => {
  void wb.version.value;
  const p = wb.graph.producers(props.nodeId, 'init')[0], cands = p ? wb.graph.nodes.get(p.node) : null;
  return cands ? { title: cands.title, accepted: (cands.config.accepted as string | null | undefined) ?? null } : null;
});
const fields = computed(() => [...COMMON_FIELDS, ...((METHODS as Record<string, { fields: readonly string[] } | undefined>)[method.value]?.fields ?? [])]);
/** The evaluator wired into `gate` and the metrics of its report: the choices of the condition (ADR 0020). */
const gateSource = computed(() => {
  void wb.version.value;
  const n = wb.graph.nodes.get(props.nodeId), evaluator = n ? gateEvaluatorOf(wb.graph, n) : null;
  return evaluator ? { title: evaluator.title, metrics: metricNamesOf(wb.graph, evaluator.id) as string[] } : null;
});
type Gate = { metric?: string; min?: number | null; max?: number | null };
const condition = computed(() => (node.value?.config.gate ?? {}) as Gate);
/** The wired metrics, plus the configured one when it is not wired any more (the graph problem tells why). */
const metricChoices = computed(() => {
  const metrics = gateSource.value?.metrics ?? [], chosen = condition.value.metric;
  return chosen && !metrics.includes(chosen) ? [...metrics, chosen] : metrics;
});
const gate = computed(() => snap.value.gate as { passed: boolean; reason: string } | null);
function setCondition(patch: Gate) {
  const next = { metric: '', ...condition.value, ...patch };
  wb.edit(t('修改 gate 条件'), () => wb.graph.patchConfig(props.nodeId, { gate: next }));
}
/** An empty bound field is no bound. */
const boundOf = (e: Event) => { const text = (e.target as HTMLInputElement).value.trim(); return text === '' ? null : Number(text); };
const runs = computed(() => (snap.value.runs as Run[]) ?? []);
const active = computed(() => snap.value.active as { id: string; status: string; progress: Progress | null; backend: string } | null);
const can = computed(() => (snap.value.can as { start: boolean; cancel: boolean }) ?? { start: false, cancel: false });
const python = computed(() => (snap.value.python as { available: boolean; connected: boolean; capabilities: { methods?: string[]; engines?: string[] } | null }) ?? { available: false, connected: false, capabilities: null });
const backend = computed(() => String(snap.value.backend ?? node.value?.config.backend ?? 'browser'));
const pythonState = computed(() => {
  if (backend.value !== 'python') return null;
  if (!python.value.available) return { tone: 'bad', text: t('Python 后端不可用：页面没有 Workspace 客户端') };
  if (!(python.value.connected || wb.python.connected.value)) return { tone: 'warn', text: t('Python Workspace 未连接') };
  const caps = python.value.capabilities;
  const ok = !caps?.methods || caps.methods.includes(method.value);
  return ok ? { tone: 'ok', text: t('Python Workspace 已连接{methods}', { methods: caps?.methods ? ` · ${caps.methods.join(', ')}` : '' }) } : { tone: 'bad', text: t('Python Workspace 不支持 {method}', { method: method.value }) };
});
const PHASE: Record<string, string> = { init: '初始化', train: '训练', eval: '验证', select: '选择' };
const pct = computed(() => { const p = active.value?.progress; return p?.epochs ? Math.min(100, Math.round((100 * (p.epoch ?? 0)) / p.epochs)) : 0; });

// ------------------------------------------------------------------ live curves: one point per progress message
const live = shallowRef<{ id: string; loss: number[]; metric: number[]; epochs: number[] } | null>(null);
watch(() => active.value?.progress, p => {
  const a = active.value; if (!a || !p) return;
  const cur = live.value?.id === a.id ? live.value : { id: a.id, loss: [], metric: [], epochs: [] };
  if (cur.epochs.length && cur.epochs.at(-1) === (p.epoch ?? 0)) {
    if (!Number.isNaN(cur.metric.at(-1)) || p.metric == null) return;
    cur.metric[cur.metric.length - 1] = p.metric;                                // a run from init: the start evaluation fills the epoch 0 point
  } else { cur.epochs.push(p.epoch ?? 0); cur.loss.push(p.loss ?? NaN); cur.metric.push(p.metric ?? NaN); }
  live.value = { ...cur };
});
const liveScope = computed(() => (live.value && active.value?.id === live.value.id ? { loss: live.value.loss, metric: live.value.metric, epochs: live.value.epochs.map(String) } : null));

// ------------------------------------------------------------------ finished runs: curves from the artifact
const open = shallowRef<string | null>(null);
function curvesOf(run: Run) {
  const a = run.candidates[0] ? (wb.workspace.artifact(run.candidates[0]) as { evaluation?: { curves?: Record<string, number[]>; selectedEpoch?: number } } | undefined) : undefined;
  return a?.evaluation?.curves ?? null;
}
type Quantized = { region: string; scale: number; k: number; threshold?: number; clippedWeights: number; clippedBiases: number };
/** The selected candidate's quantisation record (ADR 0015): per layer its shift k and the weights / biases clipped. */
function quantizationOf(run: Run): { bits: number | null; layers: Quantized[] } | null {
  const a = run.candidates[0] ? (wb.workspace.artifact(run.candidates[0]) as { model?: { weightBits?: number }; evaluation?: { quantization?: Quantized[] } } | undefined) : undefined;
  const layers = a?.evaluation?.quantization;
  return layers?.length ? { bits: a?.model?.weightBits ?? null, layers } : null;
}
const quantLabel = (q: Quantized) => `${q.region} k ${q.k} · ${q.clippedWeights}/${q.clippedBiases}`;
const STATUS: Record<string, string> = { queued: '排队', running: '训练中', done: '完成', failed: '失败', cancelled: '已取消' };
function remove(run: Run) { act(() => session.remove(run.id)); }
</script>

<template>
  <div class="body">
    <ConfigForm :node-id="nodeId" :fields="fields" :disabled="!!active" />
    <div v-if="pythonState" class="bhint tpy" :class="pythonState.tone">{{ pythonState.text }}</div>
    <div v-if="trained" class="bhint">{{ t('训练 {net}。回路里其余网络用已接受的权重冻结运行', { net: trained }) }}</div>
    <div v-if="start?.accepted" class="brow bhint"><span>{{ t('从 {cands} 已接受的产物开始训练', { cands: start.title }) }}</span><span class="pin" :title="start.accepted">{{ shortId(start.accepted) }}</span></div>
    <div v-if="gateSource" class="bhint">{{ t('gate：{title} 的报告', { title: gateSource.title }) }}</div>
    <div v-if="gateSource" class="brow bhint tgate-form">
      <label>{{ t('指标') }} <select :value="condition.metric ?? ''" :aria-label="t('gate 指标')" :disabled="!!active" @change="act(() => setCondition({ metric: ($event.target as HTMLSelectElement).value }))">
        <option value="" disabled>{{ t('选择指标') }}</option>
        <option v-for="m in metricChoices" :key="m" :value="m">{{ m }}</option>
      </select></label>
      <label>≥ <input type="number" step="any" :value="condition.min ?? ''" :aria-label="t('gate 最小值')" :disabled="!!active" @change="act(() => setCondition({ min: boundOf($event) }))"></label>
      <label>≤ <input type="number" step="any" :value="condition.max ?? ''" :aria-label="t('gate 最大值')" :disabled="!!active" @change="act(() => setCondition({ max: boundOf($event) }))"></label>
    </div>
    <div v-if="snap.dead" class="bproblem">{{ snap.dead }}</div>
    <div v-else-if="snap.problem" class="bproblem" :class="{ incomplete: !active }">{{ snap.problem }}</div>

    <div class="brow">
      <button type="button" :disabled="!can.start" :title="String(snap.problem ?? (gate && !gate.passed ? gate.reason : ''))" @click="act(() => session.start())">{{ t('开始训练') }}</button>
      <button type="button" class="mini" :disabled="!can.cancel" @click="act(() => session.cancel())">{{ t('取消') }}</button>
      <span class="bgrow"></span>
      <span class="bhint">{{ backend === 'python' ? 'Python' : t('浏览器 Worker') }} · {{ method }}</span>
    </div>
    <div v-if="gate" class="bhint tgate" :class="gate.passed ? 'ok' : 'bad'">{{ gate.passed ? t('gate 已通过：{reason}', { reason: gate.reason }) : t('gate 未通过：{reason}', { reason: gate.reason }) }}</div>
    <div v-if="error" class="bproblem">{{ error }}</div>

    <div v-if="active" class="trun active">
      <div class="brow"><b>{{ t(STATUS[active.status] ?? active.status) }}</b><span class="pin" :title="active.id">{{ shortId(active.id) }}</span><span class="bgrow"></span>
        <span class="bhint" v-if="active.progress">{{ t(PHASE[active.progress.phase ?? ''] ?? active.progress.phase ?? '') }} {{ active.progress.epoch ?? 0 }}/{{ active.progress.epochs ?? '?' }} · loss {{ fmt(active.progress.loss) }} · {{ active.progress.metricName ?? 'metric' }} {{ fmt(active.progress.metric) }}</span></div>
      <div class="tbar"><i :style="{ width: `${pct}%` }"></i></div>
      <div v-if="liveScope && liveScope.epochs.length > 1" class="tcurves">
        <SeriesRenderer :scope="liveScope" path="loss" :marks="{ x: 'epochs' }" />
        <SeriesRenderer :scope="liveScope" path="metric" :marks="{ x: 'epochs' }" />
      </div>
    </div>

    <details v-if="runs.length" class="bsection" :open="runs.length <= 3">
      <summary>{{ t('运行 {n} 次', { n: runs.length }) }}</summary>
      <ul class="truns">
        <li v-for="r in runs" :key="r.id" class="trun" :class="`st-${r.status}`">
          <div class="brow trun-head">
            <b>{{ t(STATUS[r.status] ?? r.status) }}</b>
            <span class="bhint">{{ r.method ?? '' }} · {{ r.backend === 'python' ? 'Python' : t('浏览器') }} · {{ when(r.startedAt) }} · {{ duration(r.startedAt, r.finishedAt ?? Date.now()) }}</span>
            <span class="bgrow"></span>
            <button v-if="r.status === 'done' && curvesOf(r)" type="button" class="mini" @click="open = open === r.id ? null : r.id">{{ open === r.id ? t('收起曲线') : t('曲线') }}</button>
            <button v-if="r.status !== 'running' && r.status !== 'queued'" type="button" class="mini" :title="t('删除运行记录')" @click="remove(r)">×</button>
          </div>
          <div v-if="r.error" class="bproblem">{{ r.error }}</div>
          <div v-if="r.status === 'done' || r.candidates.length" class="brow bhint">
            <span v-if="r.status === 'done'" class="mono tmetric">{{ r.metricName ?? 'metric' }} <b>{{ fmt(r.metric) }}</b></span>
            <template v-if="r.candidates.length"><span>{{ t('候选') }}</span><span v-for="c in r.candidates" :key="c" class="pin" :title="c">{{ shortId(c) }}</span></template>
          </div>
          <div v-if="quantizationOf(r)" class="brow bhint tquant" :title="t('训练按最大权重选定每层的 scale。k 是偏置单位比权重单位细的位数。斜杠前后是截断的权重 / 偏置个数（应为 0）')">
            <span>{{ t('int{bits} 每层截断（权重/偏置）', { bits: quantizationOf(r)!.bits ?? '?' }) }}</span>
            <span v-for="q in quantizationOf(r)!.layers" :key="q.region" class="mono" :class="{ bad: q.clippedWeights || q.clippedBiases }">{{ quantLabel(q) }}</span>
          </div>
          <div v-if="open === r.id && curvesOf(r)" class="tcurves">
            <SeriesRenderer :scope="curvesOf(r)" path="loss" :marks="{}" />
            <SeriesRenderer :scope="curvesOf(r)" path="metric" :marks="{}" />
          </div>
        </li>
      </ul>
    </details>
  </div>
</template>
