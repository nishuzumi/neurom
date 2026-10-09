<script setup lang="ts">
// GroupNode.vue — a nested composite on the canvas (a graph group, usually a template instance). When collapsed, it is
// a node like any other: title, template badge `id@revision`, and the port band that lists the exposed member ports
// (`成员 · 端口`, each slot stands for that member port). The members themselves are not drawn. When expanded, it is
// the frame around its members, edited in place. Groups nest without limit. The executable graph is always the flat
// graph: wires still join member ports. The canvas draws them to the group's slots only while the group is collapsed.
// A loop's box (group.loop, view.box) is the loop drawn as this frame (ADR 0011 §4). The loop node has no card. The
// frame draws the loop's run around the members:
// - `Start ← loop` on top (the `loop` handle, where drivers connect, and the partitions each driver runs it on).
// - `ƒ scenario` under it on the left border.
// - `init(start) → State`, `State` and `input(state) → bits[I]` (the `input` handle) in the left column.
// - `action: number` (the `action` handle) on the right.
// - `step(state, action)` and the end below.
// The return to State runs in a gutter away from the border. Every word the frame writes comes from the loop protocol
// (signatures, the conditions `¬done ∧ t < budget` / `done ∨ t = budget`) or is a value from the graph (graph-view.ts
// loopContract). The scenario's JSDoc is the hover text of its functions. When an execution drives the loop, its last
// step shows: t, the input bits, the action. The thick lines are the loop's own run (not graph wires), measured from
// the stations. Collapsed, a box names its body in one line.
import { computed, inject, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { Handle, Position, type NodeProps } from '@vue-flow/core';
import NodePorts from './NodePorts.vue';
import GroupActions from './GroupActions.vue';
import { problemHint } from './graph-view';
import { useExecutionOf } from './modules/body-utils';
import { ROLE_LABEL } from './modules/common';
import { RUNTIME_KEY, type EditorRuntime, type GroupNodeView } from './types';
import { CANVAS_WIRING, slotAttrs, type Wiring } from './wiring';
import { t } from '../i18n.js';

const props = defineProps<NodeProps<GroupNodeView>>();
const rt = inject(RUNTIME_KEY) as EditorRuntime;
const wiring = inject(CANVAS_WIRING) as Wiring;
const view = computed(() => props.data);
const box = computed(() => view.value.box);
const contract = computed(() => box.value?.contract ?? null);
const templateTag = computed(() => (view.value.template ? `${view.value.template.id}@${view.value.template.revision}` : ''));
const boxProblems = computed(() => (box.value?.inTraining ? { errors: [], incomplete: [] } : box.value?.problems ?? { errors: [], incomplete: [] }));

// ------------------------------------------------------------------ the last step of the execution driving the loop
const run = useExecutionOf(() => props.data.box?.loop ?? '');
type Step = { input?: number[] | null; action: number | null };
const last = computed(() => (run.value?.last as Step | null | undefined) ?? null);
const stepT = computed(() => (run.value?.t as number | undefined) ?? 0);
const actionOf = (a: number) => {
  const names = contract.value?.actions;
  return a < 0 ? `${a} ${t('无效')}` : names?.[a] != null ? `${a} ${names[a]}` : String(a);
};
const fnTitle = (name: 'init' | 'input' | 'step') => contract.value?.roles[name].doc || t('点击查看代码');
const budgetText = computed(() => String(contract.value?.budget ?? 'budget'));

// ------------------------------------------------------------------ the run's lines, measured off the stations
const runEl = ref<HTMLElement | null>(null);
const paths = shallowRef<{ d: string; cls: string }[]>([]);
const cond = shallowRef<{ x: number; y: number } | null>(null);
/** `el`'s box in the frame's layout px (offsets, not client rects: the canvas is zoomed) */
function rectOf(el: HTMLElement, root: HTMLElement) {
  let x = 0, y = 0;
  for (let e: HTMLElement | null = el; e && e !== root; e = e.offsetParent as HTMLElement | null) { x += e.offsetLeft; y += e.offsetTop; }
  const w = el.offsetWidth, h = el.offsetHeight;
  return { l: x, r: x + w, t: y, b: y + h, cx: x + w / 2, cy: y + h / 2 };
}
let frame = 0;
function measure() {
  frame = 0;
  const root = runEl.value?.parentElement; if (!root || !runEl.value) return;
  const at = (k: string) => { const el = runEl.value!.querySelector<HTMLElement>(`[data-st="${k}"]`); return el ? rectOf(el, root) : null; };
  const start = at('start'), init = at('init'), state = at('state'), input = at('input'), action = at('action'), step = at('step'), end = at('end');
  if (!start || !init || !state || !input || !action || !step || !end) return;
  // the return to State runs in the gutter between the frame's border and the column, not on the border
  const once = contract.value?.budget === 1, gutter = 18, entry = init.r - 28;
  const next = [
    { d: `M${entry},${start.b} L${entry},${init.t - 2}`, cls: 'entry' },
    { d: `M${state.cx},${init.b} L${state.cx},${state.t - 2}`, cls: 'entry' },
    { d: `M${state.cx},${state.b} L${state.cx},${input.t - 2}`, cls: 'run' },
    { d: `M${action.cx},${action.b} L${action.cx},${step.cy} L${step.r + 2},${step.cy}`, cls: 'run' },
    { d: `M${step.l},${step.cy} L${gutter},${step.cy} L${gutter},${state.cy} L${state.l - 2},${state.cy}`, cls: once ? 'run faint' : 'run' },
    { d: `M${step.cx},${step.b} L${step.cx},${end.cy} L${end.l - 2},${end.cy}`, cls: 'exit' },
  ];
  if (JSON.stringify(next) !== JSON.stringify(paths.value)) paths.value = next;
  if (cond.value?.x !== gutter + 10 || cond.value?.y !== step.cy - 6) cond.value = { x: gutter + 10, y: step.cy - 6 };
}
const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
const observer = new ResizeObserver(schedule);
// the stations are static children of the run: observe them whenever it appears, re-measure when one resizes or the
// budget (the faint return line) changes
watch(runEl, el => { observer.disconnect(); if (el) { observer.observe(el); for (const s of el.querySelectorAll('[data-st]')) observer.observe(s); schedule(); } }, { flush: 'post' });
watch(() => contract.value?.budget, schedule);
onBeforeUnmount(() => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); });
</script>

<template>
  <section class="cgroup" :class="{ collapsed: view.collapsed, box: !!box }" :aria-label="box ? t('回路 {title}', { title: view.title }) : t('组合 {title}', { title: view.title })">
    <header class="group-head" :title="view.collapsed ? t('拖动来移动。双击标题，展开编辑。') : t('拖动来整体移动。双击标题，折叠为一个节点。')">
      <span class="cgroup-badge">{{ box ? t('回路') : t('组合') }}</span>
      <input class="cgroup-title nodrag" :value="view.title" maxlength="80" :aria-label="t('组合名称')" @keydown.stop @dblclick.stop
        @change="rt.renameGroup(view.groupId, ($event.target as HTMLInputElement).value)" />
      <span v-if="boxProblems.errors.length" class="mnode-problem bad" :title="problemHint(boxProblems)" :aria-label="t('{count} 个问题', { count: boxProblems.errors.length })">{{ boxProblems.errors.length }}</span>
      <span v-else-if="boxProblems.incomplete.length" class="mnode-problem m" :title="problemHint(boxProblems)" :aria-label="t('{count} 项未连接', { count: boxProblems.incomplete.length })">{{ boxProblems.incomplete.length }}</span>
      <span v-if="contract?.budget != null" class="cgroup-meta">budget {{ contract.budget }}</span>
      <span v-if="templateTag" class="cgroup-meta" :title="t('来自模板 {tag}。实例不随模板更新', { tag: templateTag })">{{ templateTag }}</span>
      <span class="cgroup-meta">{{ t('{count} 个模块', { count: view.members }) }}</span>
      <GroupActions :group-id="view.groupId" :collapsed="view.collapsed" />
    </header>
    <template v-if="view.collapsed">
      <NodePorts v-if="view.inputs.length || view.outputs.length" :node="id" :inputs="view.inputs" :outputs="view.outputs" :wiring="wiring" :label="view.title" />
      <p v-if="box" class="cgroup-body box-summary" :title="box.summary">{{ t('每一步：{summary}', { summary: box.summary }) }}</p>
      <p v-else-if="!view.inputs.length && !view.outputs.length" class="cgroup-body">{{ t('没有暴露的端口。展开后可以直接连到成员模块。') }}</p>
    </template>
    <div v-else-if="box && contract" ref="runEl" class="lb">
      <svg class="lb-flow" aria-hidden="true">
        <defs><marker :id="`lb-arr-${id}`" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" /></marker></defs>
        <path v-for="(p, i) in paths" :key="i" :d="p.d" :class="p.cls" :marker-end="`url(#lb-arr-${id})`" />
        <text v-if="cond" :x="cond.x" :y="cond.y" :class="{ faint: contract.budget === 1 }">¬done ∧ t &lt; {{ budgetText }}</text>
      </svg>

      <div class="lb-st edge lb-start" data-st="start">
        <Handle v-if="box.handle" :id="box.handle.id" type="source" :position="Position.Left" v-bind="slotAttrs(wiring, id, box.handle, 'out')" />
        <h4>Start ← loop</h4>
        <p v-if="contract.drivers.length" class="lb-drivers">
          <span v-for="d in contract.drivers" :key="d.node" class="lb-driver">{{ d.title }} <small>{{ d.partitions.length ? d.partitions.map(p => `${t(ROLE_LABEL[p.role] ?? p.role)}${p.count != null ? ` ${p.count}` : ''}`).join(' · ') : t('无分区') }}</small></span>
        </p>
        <p v-else class="lb-none">{{ t('未连接') }}</p>
      </div>

      <div class="lb-col">
        <div class="lb-st fn opt lb-init" data-st="init" :class="{ absent: !contract.roles.init.present }">
          <h4>init(start) → State <small>{{ t('可选') }}</small></h4>
          <button v-if="box.source && contract.roles.init.present" type="button" class="lb-fn nodrag" :title="fnTitle('init')" @click.stop="rt.revealCode(box.source.node, 'init')">{{ box.source.title }}.init</button>
          <p v-else class="lb-none">{{ box.source ? t('未导出') : t('未接场景') }}</p>
        </div>
        <div class="lb-st val lb-state" data-st="state">
          <h4>State</h4>
          <p v-if="last" class="lb-mono">t {{ stepT }} / {{ budgetText }}</p>
        </div>
        <div class="lb-st fn lb-input" data-st="input">
          <h4>input(state) → bits[{{ contract.I ?? '?' }}]</h4>
          <button v-if="box.source" type="button" class="lb-fn nodrag" :title="fnTitle('input')" @click.stop="rt.revealCode(box.source.node, 'input')">{{ box.source.title }}.input</button>
          <p v-else class="lb-none">{{ t('未接场景') }}</p>
          <p v-if="last?.input" class="lb-bits"><i v-for="(b, i) in last.input" :key="i" :class="{ on: b === 1 }" /></p>
          <Handle v-if="box.input" :id="box.input.id" type="source" :position="Position.Right" v-bind="slotAttrs(wiring, id, box.input, 'out')" />
        </div>
      </div>

      <div class="lb-st val lb-action" data-st="action">
        <Handle v-if="box.action" :id="box.action.id" type="target" :position="Position.Left" v-bind="slotAttrs(wiring, id, box.action, 'in')" />
        <h4>action: number</h4>
        <p v-if="contract.actions" class="lb-mono lb-actions">{{ contract.actions.map((a, i) => `${i} ${a}`).join(' · ') }}</p>
        <p v-if="last && last.action != null" class="lb-mono"><span class="lb-tag">{{ actionOf(last.action) }}</span></p>
      </div>

      <div class="lb-st fn lb-step" data-st="step">
        <h4>step(state, action) → { state, done, success }</h4>
        <button v-if="box.source" type="button" class="lb-fn nodrag" :title="fnTitle('step')" @click.stop="rt.revealCode(box.source.node, 'step')">{{ box.source.title }}.step</button>
        <p v-else class="lb-none">{{ t('未接场景') }}</p>
      </div>
      <div class="lb-st edge lb-end" data-st="end">
        <h4>{{ t('结束') }}</h4>
        <p class="lb-mono">done ∨ t = {{ budgetText }}</p>
      </div>

      <div class="lb-scen">
        <Handle v-if="box.scenario" :id="box.scenario.id" type="target" :position="Position.Left" v-bind="slotAttrs(wiring, id, box.scenario, 'in')" />
        <span>ƒ scenario ← {{ box.source?.title ?? t('未接场景') }}</span>
      </div>
    </div>
  </section>
</template>
