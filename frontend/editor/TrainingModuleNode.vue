<script setup lang="ts">
// TrainingModuleNode.vue — an expanded prefab (editor/training-module.js, core/prefab.js), drawn as one frame
// (ADR 0011).
// Header: badge `训练模块 · method`, title, problems (trainers + the well's loop boxes + missing expected wires),
// template tag, actions.
// Left, on top: the prefab's slots and each missing expected wire, beside the input slots. A slot shows what fills it
// (a click picks it) and 「+」 per create entry while the slot is open (rt.fillSlot). A missing expected wire shows
// 「恢复」 (rt.restoreWire). In .tm-top, with more than one section column, the inputs take the first column and the
// slot rows flow through the rest.
// Below: the trainers and their satellite modules as sections. A section has a head row (kind, title, problems, the
// kind's head action, fold, delete) and the kind's registry body. training-module.js splits the sections into section
// columns (view.columns). This component reports their heights back (rt.sectionSizes), and the corner handle changes
// the column count. The kind label of a section is its grip. When dragged, the section drops between two sections of
// a column. Dropped in the gap before a column, it goes into a new column (rt.moveSection stores the split, ADR 0011
// §5). There is no card chrome: the column is the bodies' host and owns their width (AGENTS.md). A click in a section
// picks it (rt.pickSection).
// Right: the well, a recessed sub-canvas behind the canvas members (ordinary flow nodes positioned inside it). The
// well is background only, and the pointer passes through to the pane.
// Feeds: one handle per section port wired into the well (or a facing input). Its dot is centred on the well's left
// edge, and its label is above the dot inside the well.
// Slots: section ports joined to the outside or unwired. Inputs are on the frame's outer left edge (rows at the top
// of the first column). Outputs are on its outer right edge (label outside).
// The flow node is `pointer-events:none` inline (index.ts). Header, column and handles take the pointer back
// (training-module.css).
import { computed, inject, onBeforeUnmount, onMounted, onUpdated, ref } from 'vue';
import { Handle, Position, type NodeProps } from '@vue-flow/core';
import HeadIcon from './HeadIcon.vue';
import GroupActions from './GroupActions.vue';
import { BODIES } from './modules/registry';
import CodeTabs from './modules/CodeTabs.vue';
import { problemHint } from './graph-view';
import { TRAIN_FRAME } from './sizes';
import { moveSection as movedSection } from './training-module.js';
import { RUNTIME_KEY, type EditorRuntime, type TrainingModuleView } from './types';
import { CANVAS_WIRING, slotAttrs, type Wiring } from './wiring';
import { t } from '../i18n.js';
import './training-module.css';

const props = defineProps<NodeProps<TrainingModuleView>>();
const rt = inject(RUNTIME_KEY) as EditorRuntime;
const wiring = inject(CANVAS_WIRING) as Wiring;
const view = computed(() => props.data);
const templateTag = computed(() => (view.value.template ? `${view.value.template.id}@${view.value.template.revision}` : ''));
/** feed dots: the first 40px below the well top, then 44px apart (ADR 0011) */
const FEED_TOP = 40, FEED_STEP = 44;
const frameVars = computed(() => ({
  '--tm-head': `${TRAIN_FRAME.head}px`, '--tm-pad': `${TRAIN_FRAME.pad}px`, '--tm-cx': `${view.value.column.x}px`,
  '--tm-colw': `${TRAIN_FRAME.column}px`, '--tm-gap': `${TRAIN_FRAME.gap}px`,
}));
const columnStyle = computed(() => ({
  width: `${view.value.column.w}px`,
  margin: `${view.value.column.y - TRAIN_FRAME.head}px 0 ${TRAIN_FRAME.pad}px ${view.value.column.x}px`,
}));
const wellStyle = computed(() => {
  const w = view.value.well;
  return { left: `${w.x}px`, top: `${w.y}px`, width: `${w.w}px`, height: `${w.h}px` };
});
/** the sections column by column (view.columns: training-module.js splits them, and a frame keeps its split while sections only grow) */
const columnSections = computed(() => {
  const by = new Map(view.value.sections.map(s => [s.nodeId, s]));
  return view.value.columns.map(ids => ids.flatMap(id => by.get(id) ?? []));
});

// ------------------------------------------------------------------ section heights → the split (rt.sectionSizes)
const col = ref<HTMLElement | null>(null);
let reported = '', frame = 0;
function report() {
  frame = 0;
  const el = col.value; if (!el) return;
  const sizes: Record<string, number> = {};
  for (const s of el.querySelectorAll<HTMLElement>('.tm-sec[data-node]')) sizes[s.dataset.node!] = s.offsetHeight;
  const top = el.querySelector<HTMLElement>('.tm-top'), ins = top?.offsetHeight ?? 0, key = JSON.stringify([ins, sizes]);
  if (key !== reported) { reported = key; rt.sectionSizes(view.value.groupId, ins, sizes); }
}
const observer = new ResizeObserver(() => { if (!frame) frame = requestAnimationFrame(report); });
function observe() { const el = col.value; if (el) for (const s of el.querySelectorAll('.tm-sec, .tm-top')) observer.observe(s); }
onMounted(observe); onUpdated(observe);
onBeforeUnmount(() => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); });

// ------------------------------------------------------------------ the corner handle: drag to change the column count
function startResize(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement, sx = e.clientX, sy = e.clientY;
  el.setPointerCapture(e.pointerId);
  const move = (m: PointerEvent) => rt.resizeColumns(view.value.groupId, m.clientX - sx, m.clientY - sy, false);
  const up = (u: PointerEvent) => {
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    rt.resizeColumns(view.value.groupId, u.clientX - sx, u.clientY - sy, true);
  };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}

// ------------------------------------------------------------------ a section dragged by its kind label (rt.moveSection)
type Target = { column: number; index: number } | { before: number };
const cols = ref<HTMLElement | null>(null);
/** the section that the user drags (its drawn key) and where it would land, with the drop line in .tm-cols' layout px */
const moving = ref<string | null>(null);
const drop = ref<{ to: Target; line: 'row' | 'column'; style: Record<string, string> } | null>(null);
/** screen px on either side of the gap before a column that still open a new column there */
const EDGE = 14;
function targetAt(x: number, y: number, key: string): { to: Target; line: 'row' | 'column'; style: Record<string, string> } | null {
  const host = cols.value; if (!host) return null;
  const sets = [...host.querySelectorAll<HTMLElement>(':scope > .tm-colset')], rects = sets.map(s => s.getBoundingClientRect());
  if (!sets.length) return null;
  const box = host.getBoundingClientRect(), k = box.width / host.offsetWidth || 1;   // the canvas zoom
  const px = (v: number) => `${v}px`;
  for (let c = 0; c < sets.length; c++) {
    const from = c === 0 ? -Infinity : rects[c - 1].right - EDGE;
    if (x < from || x > rects[c].left + EDGE) continue;
    const at = c === 0 ? -TRAIN_FRAME.gap / 2 : ((rects[c - 1].right + rects[c].left) / 2 - box.left) / k;
    return { to: { before: c }, line: 'column', style: { left: px(at) } };
  }
  let c = rects.findIndex(r => x < r.right); if (c < 0) c = sets.length - 1;
  const secs = [...sets[c].querySelectorAll<HTMLElement>(':scope > .tm-sec')].filter(s => s.dataset.node !== key).map(s => s.getBoundingClientRect());
  let index = secs.findIndex(r => y < r.top + r.height / 2); if (index < 0) index = secs.length;
  const lineY = index < secs.length ? secs[index].top : secs.length ? secs[secs.length - 1].bottom : rects[c].top;
  return { to: { column: c, index }, line: 'row', style: { left: px((rects[c].left - box.left) / k), top: px((lineY - box.top) / k), width: px(rects[c].width / k) } };
}
function startMove(e: PointerEvent, key: string) {
  if (e.button !== 0) return;
  e.preventDefault();   // no text selection in the column during the drag
  const el = e.currentTarget as HTMLElement, sx = e.clientX, sy = e.clientY;
  el.setPointerCapture(e.pointerId);
  const move = (m: PointerEvent) => {
    if (!moving.value && Math.hypot(m.clientX - sx, m.clientY - sy) < 4) return;
    moving.value = key;
    const at = targetAt(m.clientX, m.clientY, key);
    drop.value = at && movedSection(view.value.columns, key, at.to) ? at : null;   // nothing shown where nothing would change
  };
  const end = (u: Event) => {
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end);
    window.removeEventListener('keydown', cancel, true);
    const to = u.type === 'pointerup' ? drop.value?.to ?? null : null;
    moving.value = null; drop.value = null;
    if (to) rt.moveSection(view.value.groupId, key, to);
  };
  const cancel = (k: KeyboardEvent) => { if (k.key === 'Escape') { k.stopPropagation(); end(k); } };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  window.addEventListener('keydown', cancel, true);
}

/** a scrolling body keeps the wheel (pinch — a Ctrl wheel — and ⌘ / Ctrl + wheel still zoom the canvas), as in ModuleNode */
function onBodyWheel(e: WheelEvent) {
  const el = e.currentTarget as HTMLElement;
  if (!e.ctrlKey && !e.metaKey && el.scrollHeight > el.clientHeight + 1) e.stopPropagation();
}
</script>

<template>
  <section class="tmod" :style="frameVars" :aria-label="t('训练模块 {title}', { title: view.title })">
    <header class="group-head tm-head" :title="t('拖动来整体移动。双击标题，折叠为一个节点。')">
      <span class="tm-badge">{{ t('训练模块') }}<template v-if="view.method"><span class="tm-sep" aria-hidden="true">·</span><span class="tm-method">{{ view.method }}</span></template></span>
      <input class="cgroup-title tm-title nodrag" :value="view.title" maxlength="80" :aria-label="t('组合名称')" @keydown.stop @dblclick.stop
        @change="rt.renameGroup(view.groupId, ($event.target as HTMLInputElement).value)" />
      <span v-if="view.problems.errors.length" class="mnode-problem bad" :title="problemHint(view.problems)" :aria-label="t('{count} 个问题', { count: view.problems.errors.length })">{{ view.problems.errors.length }}</span>
      <span v-else-if="view.problems.incomplete.length" class="mnode-problem m" :title="problemHint(view.problems)" :aria-label="t('{count} 项未连接', { count: view.problems.incomplete.length })">{{ view.problems.incomplete.length }}</span>
      <span v-if="templateTag" class="cgroup-meta" :title="t('来自模板 {tag}。实例不随模板更新', { tag: templateTag })">{{ templateTag }}</span>
      <span class="cgroup-meta">{{ t('{count} 个模块', { count: view.members }) }}</span>
      <GroupActions :group-id="view.groupId" :collapsed="false" />
    </header>

    <div class="tm-well" :style="wellStyle" aria-hidden="true" />
    <div class="tm-feeds" :style="{ left: `${view.well.x}px`, top: `${view.well.y}px` }" role="list" :aria-label="t('{node} 的探头', { node: view.title })">
      <div v-for="(f, i) in view.feeds" :key="`${f.dir}:${f.spec.id}`" role="listitem" class="tm-feed" :class="{ bound: wiring.wiresAt(id, f.spec.id, f.dir).length > 0 }" :style="{ top: `${FEED_TOP + i * FEED_STEP}px` }">
        <Handle :id="f.spec.id" :type="f.dir === 'in' ? 'target' : 'source'" :position="Position.Right" v-bind="slotAttrs(wiring, id, f.spec, f.dir)" />
        <span class="tm-feed-name" :title="f.spec.title ?? f.spec.label">{{ f.spec.label }}</span>
      </div>
    </div>

    <div ref="col" class="tm-col" :style="columnStyle">
      <div v-if="view.slots.length || view.drift.length || view.inputs.length" class="tm-top" :class="{ split: view.columns.length > 1 && view.inputs.length > 0 }">
      <div v-if="view.slots.length || view.drift.length" class="tm-slots nodrag" role="list" :aria-label="t('{node} 的槽位', { node: view.title })">
        <div v-for="s in view.slots" :key="s.id" role="listitem" class="tm-chip" :class="{ missing: s.required && !s.filled.length }">
          <span class="tm-chip-name">{{ s.title }}</span>
          <button v-for="f in s.filled" :key="f.nodeId" type="button" class="tm-fill" :title="t('选中 {title}', { title: f.title })" @click.stop="rt.pickSection(view.groupId, f.nodeId)">{{ f.title }}</button>
          <template v-if="s.open">
            <button v-for="c in s.create" :key="c.index" type="button" class="tm-add" :title="t('新建{title}，接到槽位 {slot}', { title: c.label, slot: s.title })" @click.stop="rt.fillSlot(view.groupId, s.id, c.index)">+ {{ c.label }}</button>
            <span v-if="!s.create.length && !s.filled.length" class="tm-empty">{{ t('空') }}</span>
          </template>
        </div>
        <div v-for="d in view.drift" :key="`drift:${d.index}`" role="listitem" class="tm-drift">
          <span class="tm-drift-text" :title="t('模板预期的连线不在了')">{{ t('缺少 {wire}', { wire: d.label }) }}</span>
          <button type="button" class="tm-restore" @click.stop="rt.restoreWire(view.groupId, d.index)">{{ t('恢复') }}</button>
        </div>
      </div>
      <div v-if="view.inputs.length" class="tm-ins" role="list" :aria-label="t('{node} 的输入', { node: view.title })">
        <div v-for="p in view.inputs" :key="p.id" role="listitem" class="tm-slot" :class="[p.class, { bound: wiring.wiresAt(id, p.id, 'in').length > 0 }]">
          <Handle :id="p.id" type="target" :position="Position.Left" v-bind="slotAttrs(wiring, id, p, 'in')" />
          <span class="tm-slot-name" :title="p.title ?? p.label">{{ p.label }}</span>
        </div>
      </div>
      </div>
      <div ref="cols" class="tm-cols">
      <div v-if="drop" class="tm-drop" :class="drop.line" :style="drop.style" />
      <div v-for="(sections, c) in columnSections" :key="c" class="tm-colset">
      <section v-for="s in sections" :key="s.nodeId" class="tm-sec" :data-node="s.nodeId" :class="[`kind-${s.kind}`, { folded: s.collapsed, 'has-problem': s.problems.errors.length > 0, picked: view.picked === s.nodeId, moving: moving === s.nodeId }]" :aria-label="s.codeNodes ? t('代码') : t('{kind} 模块 {title}', { kind: s.kindLabel, title: s.title })"
        @pointerdown="rt.pickSection(view.groupId, s.nodeId)">
        <div class="tm-sec-head">
          <span class="tm-kind nodrag nopan" :title="t('{kind} · 拖动换位置', { kind: s.kindLabel })" @pointerdown="startMove($event, s.nodeId)">{{ s.kindLabel }}</span>
          <input v-if="!s.codeNodes" class="tm-sec-title nodrag" :value="s.title" maxlength="80" :aria-label="t('模块名称')" @keydown.stop @dblclick.stop
            @change="rt.rename(s.nodeId, ($event.target as HTMLInputElement).value)" />
          <span v-else class="tm-sec-fill" />
          <span v-if="s.problems.errors.length" class="mnode-problem bad" :title="problemHint(s.problems)" :aria-label="t('{count} 个问题', { count: s.problems.errors.length })">{{ s.problems.errors.length }}</span>
          <span v-else-if="s.problems.incomplete.length" class="mnode-problem m" :title="problemHint(s.problems)" :aria-label="t('{count} 项未连接', { count: s.problems.incomplete.length })">{{ s.problems.incomplete.length }}</span>
          <component :is="BODIES[s.kind].head" v-if="!s.codeNodes && BODIES[s.kind]?.head" :node-id="s.nodeId" />
          <button type="button" class="mnode-act mnode-icon nodrag" :aria-expanded="!s.collapsed" :title="s.collapsed ? t('展开模块内容') : t('折叠模块')" :aria-label="s.collapsed ? t('展开模块内容') : t('折叠模块')" @click.stop="rt.toggleCollapse(s.codeNodes ?? s.nodeId)"><HeadIcon :name="s.collapsed ? 'plus' : 'minus'" /></button>
          <button v-if="!s.codeNodes" type="button" class="mnode-del mnode-icon nodrag" :title="t('删除模块（可撤销）')" :aria-label="t('删除模块 {title}', { title: s.title })" @click.stop="rt.removeNode(s.nodeId)"><HeadIcon name="close" /></button>
        </div>
        <div v-if="!s.collapsed && s.codeNodes" class="tm-body nodrag" @dblclick.stop @keydown.stop @wheel="onBodyWheel">
          <CodeTabs :node-ids="s.codeNodes" grouped />
        </div>
        <div v-else-if="!s.collapsed && BODIES[s.kind]" class="tm-body nodrag" @dblclick.stop @keydown.stop @wheel="onBodyWheel">
          <component :is="BODIES[s.kind].body" :node-id="s.nodeId" />
        </div>
      </section>
      </div>
      </div>
    </div>
    <div v-if="view.resizable" class="tm-resize nodrag nopan" role="separator" :aria-label="t('左栏列数')"
      :title="t('拖动改变左栏列数：横向按列宽，纵向按高度。双击恢复自动')" @pointerdown.stop.prevent="startResize" @dblclick.stop="rt.resetColumns(view.groupId)" />

    <div v-if="view.outputs.length" class="tm-outs" :style="{ top: `${view.column.y}px` }" role="list" :aria-label="t('{node} 的输出', { node: view.title })">
      <div v-for="p in view.outputs" :key="p.id" role="listitem" class="tm-slot" :class="[p.class, { bound: wiring.wiresAt(id, p.id, 'out').length > 0 }]">
        <Handle :id="p.id" type="source" :position="Position.Right" v-bind="slotAttrs(wiring, id, p, 'out')" />
        <span class="tm-slot-name" :title="p.title ?? p.label">{{ p.label }}</span>
      </div>
    </div>
  </section>
</template>
