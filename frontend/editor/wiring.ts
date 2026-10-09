// editor/wiring.ts — the wiring model of the canvas. EditorRoot.vue gives the wires (node + declared port at both ends).
// This file derives what every port shows: which wires it carries and each wire's palette colour (wire-palette.js). It
// also derives if the wire under the pointer / the selected wire is one of them. Presentation keys are wire ids, shared
// with the canvas edge presentation. NodePorts.vue renders a node's port band from it.
import { computed, onBeforeUnmount, watch, type InjectionKey } from 'vue';
import { useEdgePresentation } from './edge-presentation';
import { colorEdges, wireColor } from './wire-palette.js';
import { t } from '../i18n.js';

export type PortKind = 'in' | 'out';
/** One declared port of a node. `type` names its reference type (colour of its slot). Record outputs are field trees:
 *  `expandable` shows a +/− toggle, `expanded` its state, `tree` the box-drawing guide before a field's name. An
 *  input with `right` sits on the right edge (a driver's `loop` / `structure` input faces the loop it drives). */
export interface PortSpec { id: string; label: string; type: string; title?: string; class?: string | Record<string, boolean>; expandable?: boolean; expanded?: boolean; tree?: string; right?: boolean }
/** One wire of the canvas: the declared ports (Handle ids) it joins. */
export interface Wire { id: string; source: string; sourcePort: string; target: string; targetPort: string; label: string }

export interface Wiring {
  wiresAt(node: string, port: string, kind: PortKind): readonly Wire[];
  colorOf(wireId: string): string;
  isHot(wire: Wire): boolean;
  isSelected(wire: Wire): boolean;
}

/** The canvas wiring, provided by EditorRoot.vue to the node components. */
export const CANVAS_WIRING: InjectionKey<Wiring> = Symbol('neurom-canvas-wiring');

/** What a slot of flow node `node` wears: bound / hot / selected, and the colour of its only wire. The slot can be in a
 *  port band (NodePorts.vue), on a loop box's edge, or a training module's feed or slot. */
export function slotAttrs(wiring: Wiring, node: string, p: PortSpec, kind: PortKind) {
  const wires = wiring.wiresAt(node, p.id, kind);
  return {
    class: ['port-slot', { bound: wires.length > 0, hot: wires.some(wiring.isHot), sel: wires.some(wiring.isSelected) }],
    style: wires.length === 1 ? { '--wc': wiring.colorOf(wires[0].id) } : undefined,
    'data-type': p.type, title: p.title ?? p.label,
    'aria-label': kind === 'in' ? t('输入 {port}', { port: p.label }) : t('输出 {port}', { port: p.label }),
  };
}

const NONE: readonly never[] = Object.freeze([]);
const endKey = (node: string, kind: PortKind, port: string) => `${node}\u0000${kind}\u0000${port}`;

/** Call from a component setup: the selection / hover it owns are released on unmount and when their wire disappears. */
export function useWiring(wires: () => readonly Wire[]): Wiring {
  const presentation = useEdgePresentation();
  const list = computed(wires);
  const palette = computed(() => colorEdges(list.value));
  const byEnd = computed(() => {
    const out = new Map<string, Wire[]>();
    const add = (key: string, w: Wire) => { const at = out.get(key); if (at) at.push(w); else out.set(key, [w]); };
    for (const w of list.value) { add(endKey(w.source, 'out', w.sourcePort), w); add(endKey(w.target, 'in', w.targetPort), w); }
    return out;
  });

  const hotId = presentation.hover, selectedId = computed(() => presentation.selection.value?.key ?? null);

  // a wire that no longer exists (disconnected, node removed, port renamed) cannot stay selected
  watch(list, ws => { const id = selectedId.value; if (id !== null && !ws.some(w => w.id === id)) presentation.clear(); });
  onBeforeUnmount(() => {
    if (selectedId.value !== null) presentation.clear();
    if (hotId.value !== null) presentation.hoverLeave(hotId.value);
  });

  return {
    wiresAt: (node, port, kind) => byEnd.value.get(endKey(node, kind, port)) ?? NONE,
    colorOf: id => wireColor(palette.value.get(id) ?? 0),
    isHot: w => hotId.value === w.id,
    isSelected: w => selectedId.value === w.id,
  };
}
