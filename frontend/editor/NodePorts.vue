<script setup lang="ts">
// NodePorts.vue — the port band of a node (module or collapsed group), ComfyUI-style. It has one row per declared
// port. Inputs are top-left and outputs are top-right. The slot of each row is fixed on the node border at that row
// (left edge for inputs, right edge for outputs). An input marked `right` (a driver's `loop` / `structure` input,
// graph-view.ts) is listed at the top of the right column. Its slot is on the right edge, facing the loop box it points
// at. Every wire of a port starts / ends at that one slot. Nothing moves with the peer. A slot is a hollow ring in its
// reference-type colour while unconnected. It is filled when connected (in the wire's own palette colour when it
// carries exactly one wire).
// A record output carries a +/− toggle left of its name (emits `toggle` with the port id). Its fields appear as more
// output rows below it, drawn as a tree (`tree` guide). Every field row has its own slot, and the user can drag from it.
// The slot is absolutely positioned against the node frame, so the host must be the positioned node box.
import { computed } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import { slotAttrs, type PortKind, type PortSpec, type Wiring } from './wiring';
import { joinList, t } from '../i18n.js';

const props = withDefaults(defineProps<{
  node: string;
  inputs: readonly PortSpec[];
  outputs: readonly PortSpec[];
  wiring: Wiring;
  /** accessible name of the node the ports belong to */
  label?: string;
}>(), { label: '' });
const emit = defineEmits<{ toggle: [port: string] }>();
/** the rows of each column: left = inputs, right = right-facing inputs then outputs */
const columns = computed(() => ({
  in: props.inputs.filter(p => !p.right).map(p => ({ p, kind: 'in' as PortKind })),
  out: [...props.inputs.filter(p => p.right).map(p => ({ p, kind: 'in' as PortKind })), ...props.outputs.map(p => ({ p, kind: 'out' as PortKind }))],
}));

/** the slot's hint: what it carries, or the gesture it takes */
function slotTitle(p: PortSpec, kind: PortKind): string {
  const wires = props.wiring.wiresAt(props.node, p.id, kind);
  if (wires.length) return t('{port} 的连线：{wires}', { port: p.label, wires: joinList(wires.map(w => w.label)) });
  return kind === 'in' ? t('{port}（把输出口拖到这里，或先点一个输出口再点这里）', { port: p.title ?? p.label }) : t('{port}（拖到另一个输入口，或者点一下，再点一个输入口）', { port: p.title ?? p.label });
}
</script>

<template>
  <div class="ports">
    <div v-for="side in (['in', 'out'] as const)" :key="side" class="ports-col" :class="`ports-${side}`" role="list" :aria-label="side === 'in' ? t('{node} 的输入', { node: props.label }) : t('{node} 的输出', { node: props.label })">
      <div v-for="{ p, kind } in columns[side]" :key="`${kind}:${p.id}`" role="listitem" class="port-row"
        :class="[p.class, { bound: wiring.wiresAt(node, p.id, kind).length > 0, expanded: !!p.expanded, 'can-expand': !!p.expandable }]">
        <Handle :id="p.id" :type="kind === 'in' ? 'target' : 'source'" :position="kind === 'in' && !p.right ? Position.Left : Position.Right"
          v-bind="slotAttrs(wiring, node, p, kind)" :class="{ facing: kind === 'in' && p.right }" :title="slotTitle(p, kind)" />
        <span v-if="p.tree" class="port-tree" aria-hidden="true">{{ p.tree }}</span>
        <button v-if="kind === 'out' && p.expandable" type="button" class="port-toggle nodrag" :aria-expanded="!!p.expanded"
          :title="p.expanded ? t('收起 {port} 的字段', { port: p.label }) : t('展开 {port} 的字段', { port: p.label })" @click.stop="emit('toggle', p.id)">{{ p.expanded ? '−' : '+' }}</button>
        <span class="port-name" :title="p.title ?? p.label">{{ p.label }}</span>
      </div>
    </div>
  </div>
</template>
