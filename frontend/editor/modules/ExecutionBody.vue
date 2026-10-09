<script setup lang="ts">
// ExecutionBody.vue — the execution instance. It steps episodes of the whole loop it drives (every network on its
// accepted weights). Pick an episode of the wired partition, step / run / pause / reset, force a manual action, and
// scrub the history. Each history step shows its input bits, the action, how the step ended, and the values every
// body module produced (the executor's `values`). For a network with tool layers, it also shows which tool each layer
// called with which data bits, and what the tool returned (the step's `tools` record). Only that tool ran. View
// modules wired to `execution` render the state.
import { computed, shallowRef, watch } from 'vue';
import { useWorkbench } from '../workbench-context';
import { useSession, useAct, toolLabel } from './body-utils';
import { ROLE_LABEL as ROLE, formatValue } from './common';
import { kindLabel } from '../graph-view';
import { formatCell } from '../renderers/scope.js';
import { t } from '../../i18n.js';
import './bodies-a.css';
import './bodies-b.css';

const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();
const { session, snap } = useSession('execution', props.nodeId);
const { error, act } = useAct();

type ToolCall = { choice: number; data: number[]; result: number[] };
type Entry = { t: number; input?: number[] | null; values?: Record<string, unknown>; ran?: string[]; tools?: Record<string, Record<string, ToolCall>>; action: number | null; policyAction?: number; manual: boolean; invalid?: boolean; done?: boolean; truncated?: boolean; success?: boolean };
type BodyNode = { id: string; kind: string; title: string };
/** the session pushes into one array (same identity every step): derived values read it through `snap`, a fresh
 *  object per notification */
const entries = () => (snap.value.history as Entry[] | undefined) ?? [];
const historyLength = computed(() => entries().length);
const actions = computed(() => (snap.value.actions as string[] | null) ?? null);
const episodes = computed(() => (snap.value.episodes as Record<string, number>) ?? {});
const running = computed(() => !!snap.value.running);
const ready = computed(() => !snap.value.problem && !snap.value.dead);
const body = computed(() => (snap.value.body as BodyNode[] | undefined) ?? []);

// ------------------------------------------------------------------ episode selection
const roles = computed(() => Object.entries(episodes.value).filter(([, n]) => n > 0).map(([r]) => r));
const selRole = shallowRef<string>('test'), selIndex = shallowRef('0'), customJson = shallowRef('');
watch(() => snap.value.selection, sel => {
  const s = sel as { role?: string; index?: number } | null;
  if (s && typeof s === 'object' && 'role' in s) { selRole.value = s.role!; selIndex.value = String(s.index ?? 0); }
}, { immediate: true });
watch(roles, rs => { if (rs.length && !rs.includes(selRole.value)) selRole.value = rs[0]; }, { immediate: true });
function pickRole() { act(() => session.setEpisode({ role: selRole.value, index: Math.max(0, Math.floor(Number(selIndex.value) || 0)) })); }
function pickCustom() { act(() => session.setEpisode(JSON.parse(customJson.value))); }
const intervalInput = shallowRef(String(snap.value.interval ?? 200));
watch(() => snap.value.interval, v => { intervalInput.value = String(v); });
function setInterval_() { act(() => session.setInterval(Number(intervalInput.value))); }

// ------------------------------------------------------------------ history scrubber
const selected = shallowRef<number | null>(null);
watch(historyLength, n => { if (selected.value !== null && selected.value >= n) selected.value = null; });
const shown = computed<Entry | null>(() => (selected.value === null ? (snap.value.last as Entry | null) ?? null : entries()[selected.value] ?? null));
const shownIndex = computed(() => (selected.value ?? historyLength.value - 1));
/** the last 40 steps, newest first, with their indices in the history */
const rows = computed(() => { const h = entries(), first = Math.max(0, h.length - 40); return h.slice(first).map((e, k) => ({ i: first + k, h: e })).reverse(); });
const actionLabel = (a: number | null | undefined) => (a === null || a === undefined ? '—' : a < 0 ? t('无效') : actions.value?.[a] != null ? `${a} ${t(actions.value[a])}` : `#${a}`);
const ending = (h: Entry) => (!h.done ? '' : h.truncated ? t('到 budget 截断') : h.success ? t('成功') : t('结束'));
/** each body module on the shown step: whether it ran, its output values, and per tool layer the tool it called */
const modules = computed(() => {
  const h = shown.value; if (!h) return [];
  void wb.version.value;
  const ran = new Set(h.ran ?? []), values = h.values ?? {};
  return body.value.map(n => {
    const ports = Object.entries(values).filter(([k]) => k.startsWith(`${n.id}.`)).map(([k, v]) => [k.slice(n.id.length + 1), v] as const);
    const calls = Object.entries(h.tools?.[n.id] ?? {}).map(([port, c]) => ({ port, tool: toolLabel(wb.graph, n.id, port, c.choice), data: c.data, result: c.result }));
    return { ...n, ran: ran.has(n.id), ports, calls };
  });
});
const voltages = computed(() => {
  if (selected.value !== null) return [];
  const v = (snap.value.voltages as Record<string, number[]> | null) ?? {};
  return Object.entries(v).filter(([, xs]) => Array.isArray(xs) && xs.length).map(([id, xs]) => ({ id, title: wb.graph.nodes.get(id)?.title ?? id, xs }));
});
</script>

<template>
  <div class="body">
    <div v-if="snap.dead" class="bproblem">{{ snap.dead }}</div>
    <div v-else-if="snap.problem" class="bproblem incomplete">{{ snap.problem }}</div>
    <div v-if="snap.stale" class="bhint warn">{{ t('图已改动，重置后生效') }}</div>

    <!-- episode -->
    <div v-if="ready" class="brow">
      <template v-if="roles.length">
        <select v-model="selRole" :aria-label="t('分区角色')" :disabled="running" @change="pickRole"><option v-for="r in roles" :key="r" :value="r">{{ t(ROLE[r] ?? r) }} ({{ episodes[r] }})</option></select>
        <input v-model="selIndex" type="number" min="0" :max="(episodes[selRole] ?? 1) - 1" class="xidx" :aria-label="t('回合下标')" :disabled="running" @change="pickRole" @keydown.enter.prevent="pickRole" />
      </template>
      <input v-model="customJson" class="mono bgrow" :placeholder="t('或自定义回合记录 JSON')" :aria-label="t('自定义回合')" :disabled="running" @change="pickCustom" @keydown.enter.prevent="pickCustom" />
      <span v-if="snap.episode" class="bhint mono xrec" :title="formatCell(snap.episode, 6)">{{ formatCell(snap.episode, 6) }}</span>
    </div>

    <!-- controls -->
    <div class="brow">
      <button type="button" :disabled="!ready || running" @click="act(() => session.reset())">{{ t('重置') }}</button>
      <button type="button" :disabled="!ready || running || !!snap.done" @click="act(() => session.step())">{{ t('走一步') }}</button>
      <button v-if="!running" type="button" :disabled="!ready || !!snap.done" @click="act(() => session.run())">{{ t('运行') }}</button>
      <button v-else type="button" @click="act(() => session.pause())">{{ t('暂停') }}</button>
      <label class="bhint">{{ t('间隔') }} <input v-model="intervalInput" type="number" min="0" step="50" class="xms" :aria-label="t('步进间隔（毫秒）')" @change="setInterval_" @keydown.enter.prevent="setInterval_" /> ms</label>
      <span class="bgrow"></span>
      <span class="bhint mono">t {{ snap.t ?? 0 }}<template v-if="snap.budget">/{{ snap.budget }}</template>
        <b v-if="snap.done" :class="snap.success ? 'ok' : 'bad'"> · {{ snap.success ? t('成功') : t('结束') }}</b></span>
    </div>
    <div v-if="actions" class="brow xmanual">
      <span class="bhint">{{ t('手动') }}</span>
      <button v-for="(name, i) in actions" :key="i" type="button" class="mini" :disabled="!ready || running || !!snap.done" :title="t('用动作 {i} 走一步（覆盖回路的动作）', { i })" @click="act(() => session.step(i))">{{ t(name) }}</button>
    </div>
    <div v-if="snap.error" class="bproblem">{{ snap.error }}</div>
    <div v-if="error" class="bproblem">{{ error }}</div>

    <!-- the shown step -->
    <div v-if="shown" class="xstep">
      <div class="brow bhint"><b>{{ selected === null ? t('本步') : t('第 {n} 步', { n: shownIndex + 1 }) }}</b>
        <span>{{ shown.manual ? t('手动') : t('回路') }} → <b class="ink">{{ actionLabel(shown.action) }}</b></span>
        <span v-if="shown.manual && shown.policyAction !== undefined">{{ t('（回路想选 {a}）', { a: actionLabel(shown.policyAction) }) }}</span>
        <span v-if="shown.invalid" class="warn">{{ t('无效动作') }}</span>
        <b v-if="shown.done" :class="shown.success ? 'ok' : 'bad'">{{ ending(shown) }}</b>
        <span class="bgrow"></span>
        <button v-if="selected !== null" type="button" class="mini" @click="selected = null">{{ t('回到当前') }}</button></div>
      <div v-if="shown.input" class="bits-line"><span class="bhint">{{ t('输入 {n} 位', { n: shown.input.length }) }}</span><span class="bits"><i v-for="(b, i) in shown.input" :key="i" :class="{ on: b === 1 }"></i></span></div>
      <ul class="xmods">
        <li v-for="m in modules" :key="m.id" class="xmod" :class="{ idle: !m.ran }" :title="m.ran ? '' : t('这一步没有运行（不需要）')">
          <span class="xmod-name"><b>{{ m.title }}</b> <span class="bhint">{{ kindLabel(m.kind) }}</span></span>
          <span v-for="c in m.calls" :key="c.port" class="xmod-call" :title="t('工具层 {port} 这一步只运行了被选中的工具', { port: c.port })">
            <span class="xmod-tool">{{ t('调用 {tool}', { tool: c.tool }) }}</span>
            <span class="mono xmod-val">data {{ formatValue(c.data, 24) }} → {{ formatValue(c.result, 24) }}</span>
          </span>
          <span v-for="[port, v] in m.ports" :key="port" class="mono xmod-val">{{ port }} {{ formatValue(v, 24) }}</span>
          <span v-if="!m.ran" class="bhint">{{ t('未运行') }}</span>
        </li>
      </ul>
      <div v-for="v in voltages" :key="v.id" class="bhint mono xvolts" :title="t('推理后保留的膜电位')">V {{ v.title }}: {{ v.xs.join(' ') }}</div>
    </div>

    <!-- history -->
    <details v-if="historyLength" class="bsection">
      <summary>{{ t('历史 {count} 步', { count: historyLength }) }}</summary>
      <div class="brow">
        <input type="range" class="bgrow" min="0" :max="historyLength - 1" :value="shownIndex" :aria-label="t('回看步')" @input="selected = Number(($event.target as HTMLInputElement).value)" />
      </div>
      <ol class="hist-list">
        <li v-for="{ i, h } in rows" :key="i"><button type="button" class="hist-row" :class="{ sel: i === shownIndex, manual: h.manual }" @click="selected = i === historyLength - 1 ? null : i">
          <span class="hist-i">{{ i + 1 }}</span><span>{{ h.manual ? t('手动') : t('回路') }} {{ actionLabel(h.action) }}</span><span class="bgrow"></span><span class="bhint">{{ ending(h) }}</span></button></li>
      </ol>
    </details>
  </div>
</template>

<style scoped>
.xmods{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;min-width:0}
.xmod{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;padding:3px 6px;border-left:2px solid var(--line-strong);min-width:0}
.xmod.idle{opacity:.45}
.xmod-val{min-width:0;overflow-wrap:anywhere}
.xmod-tool{color:var(--spike);font-weight:700}
.xmod-call{display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px;min-width:0}
</style>
