// editor/modules/common.ts — helpers shared by module bodies: version-tracked node / resolution accessors, a text
// field edited through a local buffer, input-port wires carried across a renamed name list, the partition-role labels
// and value formatting. `graph.node(id)` throws for a removed node (a body may render one tick longer than its node
// lives), so bodies read through `useNode`, whose node is null once it is gone.
import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue';
import { t } from '../../i18n.js';
import { trimNumber } from '../renderers/scope.js';
import type { GraphNode, Problem, Wire, Workbench } from '../workbench-context';

/** Version-tracked node snapshot (a fresh shallow copy per version, so computeds derived from `node.value` re-run
 *  after in-place config replacement) and the node's problems. */
export function useNode(wb: Workbench, nodeId: () => string): { node: ComputedRef<GraphNode | null>; problems: ComputedRef<Problem[]> } {
  const node = computed(() => { void wb.version.value; const id = nodeId(); return wb.graph.hasNode(id) ? { ...wb.graph.node(id) } : null; });
  const problems = computed(() => { void wb.version.value; return node.value ? wb.resolution().problemsOf(nodeId()) : []; });
  return { node, problems };
}

/** A text field edited through a local buffer, committed after a pause (`delay` ms) or on blur (one history entry).
 *  `seen` = the stored text this editor last observed. A store change overwrites the buffer only when it really
 *  differs. `commit` returns false when there is nothing to commit to any more (unmount flush after the node was
 *  removed). A flush writes only input typed here and not yet committed. The stored text can change elsewhere while the
 *  same update unmounts this editor (an undo, another tab's save adopted, a wire change that moves the module). Then the
 *  buffer still holds the old text, and a flush of it would write the old text back over the new. */
export interface Buffered { text: Ref<string>; flush(): void; input(text: string): void; typing: ComputedRef<boolean> }
export function useBuffered(stored: () => string, commit: (text: string) => boolean | void, delay = 250): Buffered {
  const current = computed(stored);
  const text = ref(current.value);
  let seen = current.value, timer: ReturnType<typeof setTimeout> | null = null;
  watch(current, v => { if (v !== seen) { text.value = v; seen = v; } });   // changed elsewhere (undo, template)
  function flush() {
    if (!timer) return;
    clearTimeout(timer); timer = null;
    if (text.value === current.value) return;
    const value = text.value;
    if (commit(value) !== false) seen = value;
  }
  function input(value: string) { text.value = value; clearTimeout(timer ?? undefined); timer = setTimeout(flush, delay); }
  onBeforeUnmount(flush);
  return { text, flush, input, typing: computed(() => text.value !== current.value) };
}

/** Apply `patch` to `nodeId` (one history entry, `label`) and rename its input ports `old` → `next`. The wires into
 *  them follow (same length → by position, otherwise by surviving name). Wires into vanished names are dropped. Throws
 *  when the patch is refused (nothing applied). Otherwise returns the message that names wires that could not be
 *  carried, or null. */
export function carryInputWires(wb: Workbench, nodeId: string, old: string[], next: string[], label: string, patch: Record<string, unknown>): string | null {
  const moves: { wire: Wire; to: string | null }[] = [];
  old.forEach((name, i) => {
    const to = next.length === old.length ? next[i] : next.includes(name) ? name : null;
    if (to === name) return;
    for (const p of wb.graph.producers(nodeId, name)) moves.push({ wire: p.wire, to });
  });
  const lost: string[] = [];
  wb.edit(label, () => {
    wb.graph.patchConfig(nodeId, patch);      // validates, and throws before anything changed
    for (const m of moves) wb.graph.disconnect(m.wire.id);
    for (const m of moves) {
      if (!m.to) continue;
      try { wb.graph.connect({ kind: m.wire.kind, from: m.wire.from, to: { node: nodeId, port: m.to } }); }
      catch (e) { lost.push(`${m.to}: ${(e as Error).message}`); }
    }
  });
  return lost.length ? t('连线未能保留：{list}', { list: lost.join(' · ') }) : null;
}

/** A comma-separated name list of the config (`key`), one input port per name. On change, it validates the list
 *  (`pattern`, no duplicates) and commits it with its input-port wires carried along (carryInputWires). `invalid` /
 *  `duplicate` word the rejections. */
export function useNameList(wb: Workbench, nodeId: () => string, opts: {
  key: string; names: () => string[]; pattern: RegExp; label: () => string;
  invalid: (name: string) => string; duplicate: (name: string) => string;
}) {
  const text = ref(opts.names().join(', '));
  const error: Ref<string | null> = ref(null);
  // sync: fires inside the edit, so a message set right after it (a wire that could not be carried) is not wiped
  watch(() => opts.names().join(','), () => { text.value = opts.names().join(', '); error.value = null; }, { flush: 'sync' });
  function commit(value: string) {
    text.value = value;
    const names = value.split(/[\s,，]+/).filter(Boolean);
    const bad = names.find(n => !opts.pattern.test(n));
    if (bad) { error.value = opts.invalid(bad); return; }
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) { error.value = opts.duplicate(dup); return; }
    error.value = null;
    const old = opts.names();
    text.value = names.join(', ');
    if (names.length === old.length && names.every((n, i) => n === old[i])) return;
    try { error.value = carryInputWires(wb, nodeId(), old, names, opts.label(), { [opts.key]: names }); }
    catch (e) { error.value = (e as Error).message; }
  }
  return { text, error, commit };
}

/** Chinese label (a message key) of each partition role. */
export const ROLE_LABEL: Record<string, string> = { training: '训练', validation: '验证', test: '测试' };

/** Compact value rendering for previews (bits as 0/1 strings, numbers trimmed). */
export function formatValue(v: unknown, max = 32): string {
  if (v === undefined) return t('未求值');
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return trimNumber(v, 4);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.length && v.every(x => x === 0 || x === 1)) return `[${v.length}] ${v.length > max ? `${v.slice(0, max).join('')}…` : v.join('')}`;
    const shown = v.slice(0, max).map(x => formatValue(x, 8));
    return `[${shown.join(', ')}${v.length > max ? ', …' : ''}]`;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).slice(0, max);
    return `{${entries.map(([k, x]) => `${k}: ${formatValue(x, 8)}`).join(', ')}}`;
  }
  return String(v);
}
