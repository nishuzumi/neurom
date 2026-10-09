// editor/modules/body-utils.ts — what the runtime bodies (trainer, candidates, evaluator, execution, view, deployment)
// share: a reactive session snapshot, error capture for imperative session calls and small formatters. The workbench
// owns the sessions (it creates them lazily and disposes of them with the node). A body only subscribes. Node access is
// common.ts `useNode`.
import { computed, onBeforeUnmount, shallowRef, toValue, watch, type MaybeRefOrGetter, type ShallowRef } from 'vue';
import { useWorkbench, type ModuleGraph, type SessionKind, type SessionOf, type Snap } from '../workbench-context';
import { loopBody, loopDrivers } from '../../core/kinds/loop.js';
import { layersNotation } from '../../core/kinds/network.js';
import { trimNumber } from '../renderers/scope.js';
import { t } from '../../i18n.js';

/** Subscribe to a session of `kind` for `nodeId`. `snap` follows every notification. */
export function useSession<K extends SessionKind>(kind: K, nodeId: string): { session: SessionOf<K>; snap: ShallowRef<Snap> } {
  const wb = useWorkbench();
  const session = wb.session(kind, nodeId);
  const snap = shallowRef<Snap>(session.snapshot());
  const off = session.subscribe(() => { snap.value = session.snapshot(); });
  onBeforeUnmount(off);
  return { session, snap };
}

/** The snapshot of the session `source` names (null while it names none). Re-subscribes only when its kind or id
 *  changes, so a fresh but equal source object (recomputed on an unrelated graph edit) keeps the subscription. */
export function useSessionAt(source: MaybeRefOrGetter<{ kind: SessionKind; id: string } | null>): ShallowRef<Snap | null> {
  const wb = useWorkbench();
  const snap = shallowRef<Snap | null>(null);
  let off: (() => void) | null = null;
  watch([() => toValue(source)?.kind, () => toValue(source)?.id], ([kind, id]) => {
    off?.(); off = null; snap.value = null; if (!kind || !id) return;
    const s = wb.session(kind, id); snap.value = s.snapshot(); off = s.subscribe(() => { snap.value = s.snapshot(); });
  }, { immediate: true });
  onBeforeUnmount(() => off?.());
  return snap;
}

/** The snapshot of the execution instance that runs `nodeId` (a loop, or a module in the body of a loop). It is the
 *  first execution among the drivers of that loop, or null while none runs it. Follows rewiring and a changing `nodeId`. */
export function useExecutionOf(nodeId: MaybeRefOrGetter<string>): ShallowRef<Snap | null> {
  const wb = useWorkbench();
  const executionId = computed<string | null>(() => {
    void wb.version.value;
    const g = wb.graph, id = toValue(nodeId);
    for (const n of g.nodes.values()) {
      if (n.kind !== 'loop' || (n.id !== id && !(loopBody(g, n.id) as { nodes: string[] }).nodes.includes(id))) continue;
      const run = (loopDrivers(g, n.id) as { node: string }[]).find(d => g.nodes.get(d.node)?.kind === 'execution');
      if (run) return run.node;
    }
    return null;
  });
  return useSessionAt(() => (executionId.value ? { kind: 'execution', id: executionId.value } : null));
}

/** What the execution calls the k-th tool wired into tool port `port` of network `networkId` (wire order, as the
 *  loop section): a bits readout's `run` by the network it reads, a code export by `module.function`. */
export function toolLabel(graph: ModuleGraph, networkId: string, port: string, k: number): string {
  const p = graph.producers(networkId, port)[k], source = p ? graph.nodes.get(p.node) : null;
  if (!p || !source) return `#${k}`;
  if (source.kind !== 'readout') return `${source.title}.${p.port}`;
  const net = graph.producers(source.id, 'scores')[0];
  return (net && graph.nodes.get(net.node)?.title) || source.title;
}

/** Run an imperative session call, capturing a thrown / rejected message into `error`. */
export function useAct() {
  const error = shallowRef<string | null>(null);
  const message = (e: unknown) => String((e as Error)?.message ?? e);
  function act(fn: () => unknown) {
    error.value = null;
    try {
      const r = fn();
      if (r instanceof Promise) r.catch(e => { error.value = message(e); });
    } catch (e) { error.value = message(e); }
  }
  return { error, act };
}

/** Patch `nodeId`'s config (one history entry), capturing a refusal (core's ConfigError) into `error`. */
export function usePatch(nodeId: () => string) {
  const wb = useWorkbench();
  const { error, act } = useAct();
  return { error, patch: (label: string, p: Record<string, unknown>) => act(() => wb.edit(label, () => wb.graph.patchConfig(nodeId(), p))) };
}

/** An artifact's compatibility verdict (core/sessions: `ok` true / false / null = unknown) as tag text and class. */
type Compat = { compatible: { ok: boolean | null } };
export const compatLabel = (c: Compat) => (c.compatible.ok === true ? t('兼容') : c.compatible.ok === false ? t('不兼容') : t('未知'));
export const compatClass = (c: Compat) => (c.compatible.ok === true ? 'ok' : c.compatible.ok === false ? 'bad' : 'unknown');

export function fmt(v: unknown, digits = 3): string {
  if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return '—';
  if (typeof v !== 'number') return String(v);
  return trimNumber(v, digits);
}
export const shortId = (id: unknown, n = 10) => (id ? `${String(id).slice(0, n)}…` : '—');
/** `kind I→h1/h2→O int8` of a network structure as the sessions summarise it (dense `{ hidden }` or threshold widths,
 *  and the weight width when known). */
export const structureLabel = (n: { kind: string; inputs: number; outputs: number; layers?: unknown[]; weightBits?: number }) => `${n.kind} ${n.inputs}→${layersNotation(n.layers)}→${n.outputs}${n.weightBits ? ` int${n.weightBits}` : ''}`;
export function when(ms: unknown): string {
  if (typeof ms !== 'number' && typeof ms !== 'string') return '—';
  const d = new Date(ms); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString();
}
export function duration(a: unknown, b: unknown): string {
  if (typeof a !== 'number' || typeof b !== 'number') return '—';
  const s = Math.max(0, Math.round((b - a) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
/** Polyline path for an SVG sparkline of `values` in a `w`×`h` box (NaN gaps break the line). */
export function linePath(values: number[], w: number, h: number, min: number, max: number): string {
  const n = values.length; if (!n) return '';
  const span = max - min || 1, dx = n > 1 ? w / (n - 1) : 0;
  let d = '', pen = false;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { pen = false; continue; }
    const x = n > 1 ? i * dx : w / 2, y = h - ((v - min) / span) * (h - 2) - 1;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; pen = true;
  }
  return d;
}
