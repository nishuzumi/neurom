<script setup lang="ts">
// ModuleNode.vue — the host box of every module on the canvas, whatever its kind. From top to bottom:
// - a kind-coloured header (title, kind badge, problem badge, the kind's own header actions, collapse / delete).
// - the standard port band (NodePorts.vue: value ports solid, call ports marked ƒ).
// - the kind's body from modules/registry.ts.
// The host owns the width (node.uiSize.w or the kind default, AGENTS.md). The body fills it. Collapsed, only header and
// ports remain. A host with an explicit height (node.uiSize.h, or while the resizer drags) is `sized`. Its body fills
// the height left under the header and ports, and the `.bfill` element of each body takes the extra space. The body
// scrolls when the content does not fit, so nothing spills over the frame (AGENTS.md). Unsized, the host follows its
// content. The frame never gets shorter than header + port band + a strip of body (those cannot scroll). The tool
// layers of a network (ToolCanvas.vue) come at the end of its body.
import { computed, inject, ref } from 'vue';
import type { NodeProps } from '@vue-flow/core';
import { NodeResizer } from '@vue-flow/node-resizer';
import NodePorts from './NodePorts.vue';
import ToolCanvas from './ToolCanvas.vue';
import HeadIcon from './HeadIcon.vue';
import { BODIES } from './modules/registry';
import { problemHint } from './graph-view';
import { RUNTIME_KEY, type EditorRuntime, type ModuleNodeView } from './types';
import { CANVAS_WIRING, type Wiring } from './wiring';
import { NODE_H_MAX, NODE_H_MIN, NODE_W_MAX, NODE_W_MIN } from './layout';
import { t } from '../i18n.js';

const props = defineProps<NodeProps<ModuleNodeView>>();
const rt = inject(RUNTIME_KEY) as EditorRuntime;
const wiring = inject(CANVAS_WIRING) as Wiring;
const view = computed(() => props.data);
const body = computed(() => BODIES[view.value.kind]?.body ?? null);
const head = computed(() => BODIES[view.value.kind]?.head ?? null);
const problemCount = computed(() => view.value.problems.errors.length);
const incompleteCount = computed(() => view.value.problems.incomplete.length);
const root = ref<HTMLElement | null>(null);
const resizing = ref(false);
const sized = computed(() => view.value.height !== null || resizing.value);
/** body strip kept under the port band: its padding plus about one line */
const BODY_MIN = 40;
const minHeight = ref(NODE_H_MIN);
/** measured at gesture start (layout px, unaffected by zoom). Borders are part of the border-box host */
function floor(): number {
  const el = root.value; if (!el) return NODE_H_MIN;
  let h = el.offsetHeight - el.clientHeight + (body.value ? BODY_MIN : 0);
  for (const c of el.children) if (c.matches('.mnode-head, .ports')) h += (c as HTMLElement).offsetHeight;
  return Math.max(NODE_H_MIN, Math.ceil(h));
}
function onResizeStart() { minHeight.value = floor(); resizing.value = true; rt.resizeStart(props.id); }
function onResizeEnd() { resizing.value = false; rt.resizeEnd(props.id); }
function onResizeKey(e: KeyboardEvent) {
  if (rt.keyboardResize(props.id, e.key, e.shiftKey, floor())) { e.preventDefault(); e.stopPropagation(); }
}
/** a scrolling body keeps the wheel (pinch — a Ctrl wheel — and ⌘ / Ctrl + wheel still zoom the canvas) */
function onBodyWheel(e: WheelEvent) {
  const el = e.currentTarget as HTMLElement;
  if (!e.ctrlKey && !e.metaKey && el.scrollHeight > el.clientHeight + 1) e.stopPropagation();
}
function rename(e: Event) { rt.rename(view.value.nodeId, (e.target as HTMLInputElement).value); }
</script>

<template>
  <section ref="root" class="mnode" :class="[`kind-${view.kind}`, { collapsed: view.collapsed, sized, 'has-problem': problemCount > 0 }]" :aria-label="t('{kind} 模块 {title}', { kind: view.kindLabel, title: view.title })">
    <NodeResizer v-if="!view.collapsed" :min-width="NODE_W_MIN" :max-width="NODE_W_MAX" :min-height="minHeight" :max-height="NODE_H_MAX" line-class-name="editor-resize-line" handle-class-name="editor-resize-handle"
      @resize-start="onResizeStart" @resize-end="onResizeEnd" />
    <header class="mnode-head" :title="t('拖动移动。双击标题折叠 / 展开')">
      <span class="mnode-kind" :title="view.kindLabel">{{ view.kindLabel }}</span>
      <input class="mnode-title nodrag" :value="view.title" maxlength="80" :aria-label="t('模块名称')" @keydown.stop @dblclick.stop @change="rename" />
      <span v-if="problemCount" class="mnode-problem bad" :title="problemHint(view.problems)" :aria-label="t('{count} 个问题', { count: problemCount })">{{ problemCount }}</span>
      <span v-else-if="incompleteCount" class="mnode-problem m" :title="problemHint(view.problems)" :aria-label="t('{count} 项未连接', { count: incompleteCount })">{{ incompleteCount }}</span>
      <component :is="head" v-if="head" :node-id="view.nodeId" />
      <button type="button" class="mnode-act mnode-icon nodrag" :aria-expanded="!view.collapsed" :title="view.collapsed ? t('展开模块内容') : t('折叠为只显示端口')" :aria-label="view.collapsed ? t('展开模块内容') : t('折叠为只显示端口')" @click.stop="rt.toggleCollapse(view.nodeId)"><HeadIcon :name="view.collapsed ? 'plus' : 'minus'" /></button>
      <button type="button" class="mnode-del mnode-icon nodrag" :title="t('删除模块（可撤销）')" :aria-label="t('删除模块 {title}', { title: view.title })" @click.stop="rt.removeNode(view.nodeId)"><HeadIcon name="close" /></button>
    </header>
    <NodePorts v-if="view.inputs.length || view.outputs.length" :node="id" :inputs="view.inputs" :outputs="view.outputs" :wiring="wiring" :label="view.title" @toggle="port => rt.togglePort(view.nodeId, port)" />
    <div v-if="!view.collapsed && body" class="mnode-body nodrag" @dblclick.stop @keydown.stop @wheel="onBodyWheel">
      <component :is="body" :node-id="view.nodeId" />
      <ToolCanvas v-if="view.tools.length" :node-id="view.nodeId" :layers="view.tools" />
    </div>
    <button v-if="!view.collapsed" type="button" class="editor-resize-key nodrag" :title="t('调整大小：方向键（Shift 微调），Home 恢复默认')" :aria-label="t('调整 {title} 的大小', { title: view.title })" @keydown="onResizeKey" />
  </section>
</template>
