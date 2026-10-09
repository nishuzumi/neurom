<script setup lang="ts">
// EditorRoot.vue — the single Vue Flow surface. index.ts attaches the behaviour hooks to the store (useVueFlow with
// the same id). This component declares the interaction options and the three node types: module, group and trainmod
// (a training module frame). It declares the one edge type (wire, value or call by data.kind), the background and the
// minimap. In the minimap, module nodes carry their `kind-*` class, so editor.css colours them like the host boxes. A
// training module draws its outline, its well and each section where its column draws it, coloured by kind. Group
// frames are outlines. This component also owns the canvas wiring (wiring.ts) that the port bands read through
// CANVAS_WIRING.
import { computed, provide } from 'vue';
import { ConnectionLineType, ConnectionMode, Panel, useVueFlow, VueFlow, type ValidConnectionFunc } from '@vue-flow/core';
import { Background, BackgroundVariant } from '@vue-flow/background';
import { MiniMap } from '@vue-flow/minimap';
import ModuleNode from './ModuleNode.vue';
import GroupNode from './GroupNode.vue';
import TrainingModuleNode from './TrainingModuleNode.vue';
import CanvasEdge from './CanvasEdge.vue';
import EdgeSettings from './EdgeSettings.vue';
import EdgeMenu from './EdgeMenu.vue';
import { useEdgePresentation } from './edge-presentation';
import { ZOOM_MAX, ZOOM_MIN } from './layout';
import type { TrainingModuleView } from './types';
import { CANVAS_WIRING, useWiring, type Wire } from './wiring';

const props = defineProps<{ flowId: string; isValidConnection: ValidConnectionFunc }>();

const presentation = useEdgePresentation();
const PREVIEW_SHAPE = { curve: ConnectionLineType.Bezier, step: ConnectionLineType.Step, straight: ConnectionLineType.Straight };
/** ComfyUI's additive click: ⌘ / Ctrl / Shift + click adds a node to the selection. A left drag on empty canvas
 *  box-selects (Figma). The canvas pans with two fingers / the wheel, a middle drag, or Space held. */
const MULTI_SELECT_KEYS = ['Meta', 'Control', 'Shift'];

const flow = useVueFlow(props.flowId);
const wires = computed<Wire[]>(() => flow.getEdges.value.map(e => ({
  id: e.id, source: e.source, sourcePort: e.sourceHandle ?? '', target: e.target, targetPort: e.targetHandle ?? '',
  label: e.data?.label ?? '',
})));
provide(CANVAS_WIRING, useWiring(() => wires.value));
type MiniNode = { type?: string; data?: { kind?: string } };
/** a training module's view model (index.ts) as a list of one, none before it is drawn: what its minimap drawing reads */
const trainViews = (id: string) => { const v = flow.findNode<TrainingModuleView>(id)?.data; return v ? [v] : []; };
</script>

<template>
  <!-- Figma's wheel: two-finger scroll / the wheel pans 1:1 (Shift + wheel pans sideways). Pinch (a Ctrl wheel) or ⌘ / Ctrl + wheel zooms -->
  <VueFlow :id="flowId"
    :min-zoom="ZOOM_MIN" :max-zoom="ZOOM_MAX" :pan-on-drag="[1]" :selection-key-code="true" pan-activation-key-code="Space" :multi-selection-key-code="MULTI_SELECT_KEYS"
    :pan-on-scroll="true" :pan-on-scroll-speed="1"
    :zoom-on-double-click="false" :delete-key-code="null" :connection-mode="ConnectionMode.Strict" :is-valid-connection="isValidConnection"
    :elevate-nodes-on-select="true" :elevate-edges-on-select="false" :edges-updatable="false" :connect-on-click="true" :only-render-visible-elements="false" :disable-keyboard-a11y="true"
    :connection-line-options="{ type: PREVIEW_SHAPE[presentation.state.defaults.shape], style: { stroke: presentation.state.defaults.color ?? 'var(--wire)' } }"
    :default-edge-options="{ type: 'wire' }" :connection-radius="24" :node-drag-threshold="3" :auto-pan-on-node-drag="true" :auto-pan-on-connect="true">
    <template #node-module="props"><ModuleNode v-bind="props" /></template>
    <template #node-group="props"><GroupNode v-bind="props" /></template>
    <template #node-trainmod="props"><TrainingModuleNode v-bind="props" /></template>
    <template #edge-wire="props"><CanvasEdge v-bind="props" /></template>
    <Background :variant="BackgroundVariant.Dots" :gap="24" :size="2" color="var(--grid-dot)" />
    <MiniMap pannable zoomable position="bottom-left" mask-color="rgba(22,23,27,.72)" :node-class-name="(n: MiniNode) => n.type === 'module' ? `kind-${n.data?.kind}` : 'group'" :node-stroke-width="2">
      <!-- a training module: its outline, the well, and each section where the column draws it (its sections are no flow nodes) -->
      <template #node-trainmod="m">
        <g v-for="v in trainViews(m.id)" :key="m.id">
          <rect class="vue-flow__minimap-node group" :x="m.position.x" :y="m.position.y" :width="m.dimensions.width" :height="m.dimensions.height" :stroke-width="m.strokeWidth" />
          <rect class="vue-flow__minimap-node well" :x="m.position.x + v.well.x" :y="m.position.y + v.well.y" :width="v.well.w" :height="v.well.h" />
          <rect v-for="s in v.sections" :key="s.nodeId" :class="['vue-flow__minimap-node', `kind-${s.kind}`]" :x="m.position.x + s.rect.x" :y="m.position.y + s.rect.y" :width="s.rect.w" :height="s.rect.h" :stroke-width="m.strokeWidth" />
        </g>
      </template>
    </MiniMap>
    <Panel position="top-right"><EdgeSettings /></Panel>
    <EdgeMenu />
  </VueFlow>
</template>
