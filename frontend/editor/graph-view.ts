// editor/graph-view.ts — plain view models for the node components. The projection (index.ts) builds them from the core
// graph. They are a node's port band (value ports solid, call ports marked ƒ, record outputs as an expandable field
// tree), its problems and a loop box's contract. Nothing here is reactive, so index.ts rebuilds it on every draw. Sizes
// are in editor/sizes.ts.
import type { ModuleGraph, PortDecl, Problem, Resolution } from './workbench-context';
import type { ProblemView } from './types';
import type { PortSpec } from './wiring';
import { typeName } from '../core/types.js';
import { kindOf } from '../core/registry.js';
import { loopBody, loopDrivers } from '../core/kinds/loop.js';
import { moduleOf, docOf } from '../core/kinds/code.js';
import { partitionEpisodes } from '../core/kinds/partition.js';
import { envBundle } from '../core/bundle.js';
import { t } from '../i18n.js';
import { facing } from './training-module.js';

/** One line naming a loop's body in evaluation order (`input bits → network → readout → action`), for boxes
 *  and the loop card. It says so when the loop is not closed. */
export function loopSummary(graph: ModuleGraph, loopId: string): string {
  const { nodes, closed } = loopBody(graph, loopId) as { nodes: string[]; closed: boolean };
  return closed ? t('输入位 → {body} → 动作', { body: nodes.map(id => graph.nodes.get(id)?.title ?? id).join(' → ') }) : t('回路未闭合');
}

/** What an expanded loop box draws besides its members. All of it comes from the graph:
 *  - which scenario roles the scenario module exports, with their JSDoc (shown on hover)
 *  - the evaluated `budget` / `actions` as the bundle has them (null while the bundle does not build)
 *  - the input width `I`
 *  - each driver with the partitions it runs the loop on */
export interface LoopContract {
  roles: Record<'init' | 'input' | 'step', { present: boolean; doc: string }>;
  budget: number | null; actions: string[] | null; I: number | null;
  drivers: { node: string; title: string; partitions: { role: string; count: number | null }[] }[];
}
export function loopContract(graph: ModuleGraph, res: Resolution, loopId: string): LoopContract {
  const scene = graph.producers(loopId, 'scenario')[0]?.node ?? null;
  const mod = scene ? moduleOf(graph.node(scene).config) : null;
  const role = (name: string) => {
    const fn = mod?.functions[name];
    return { present: !!fn, doc: fn ? (docOf(fn.doc).summary ?? '').split('\n').map((l: string) => l.trim()).filter(Boolean).join(' ') : '' };
  };
  let budget: number | null = null, actions: string[] | null = null;
  if (scene) try { const env = envBundle(graph, loopId, res); budget = env.budget; actions = env.actions; } catch { /* the loop's problems say why */ }
  const drivers = (loopDrivers(graph, loopId) as { node: string }[]).map(({ node }) => {
    const partitions: { role: string; count: number | null }[] = [];
    for (const p of res.portsOf(node).inputs) for (const w of graph.producers(node, p.id)) {
      const src = graph.node(w.node); if (src.kind !== 'partition') continue;
      let count: number | null = null;
      try { count = (partitionEpisodes(src.config, w.port) as unknown[]).length; } catch { /* a window partition counts against its table */ }
      partitions.push({ role: w.port, count });
    }
    return { node, title: graph.node(node).title, partitions };
  });
  return { roles: { init: role('init'), input: role('input'), step: role('step') }, budget, actions, I: (res.refsOf(loopId).I as number | undefined) ?? null, drivers };
}

/** The type a port carries, as the slot colour class and hover text. */
function portType(p: PortDecl): string {
  if (p.wire === 'call') return p.handle ? `handle-${p.handle}` : 'fn';
  const T = (p.type ?? p.constraint ?? null) as { type?: string; of?: string; binary?: boolean; binaryVector?: unknown } | null;
  if (!T) return 'any';
  if (T.type === 'handle') return `handle-${T.of}`;
  if (T.binaryVector || (T.type === 'vector' && T.binary)) return 'bits';
  return T.type ?? 'any';
}

function describe(p: PortDecl, resolvedType: unknown): string {
  if (p.wire === 'call') {
    if (p.handle) return t('调用端口 {port}：{handle} 句柄', { port: p.id, handle: p.handle });
    const sig = p.signature as { params?: unknown[]; result?: unknown; exact?: boolean } | undefined;
    if (!sig) return t('调用端口 {port}：函数', { port: p.id });
    return t('调用端口 {port}：fn({params}) → {result}{exact}', { port: p.id, params: (sig.params ?? []).map(x => typeName(x)).join(', '), result: typeName(sig.result), exact: sig.exact ? t('，精确') : '' });
  }
  const T = resolvedType ?? p.type ?? p.constraint ?? null;
  return t('值端口 {port}：{type}{required}', { port: p.id, type: typeName(T), required: p.required ? t('，必需') : '' });
}

/** Hover text: kind, port and type. Then the port's own doc text. On an input, also the doc of what feeds it. */
function spec(graph: ModuleGraph, p: PortDecl, dir: 'in' | 'out', node: string, res: Resolution): PortSpec {
  const label = p.wire === 'call' ? `ƒ ${p.id}` : p.id;
  const T = p.wire === 'value' ? (dir === 'out' ? res.typeOf(node, p.id) : res.inTypeOf(node, p.id)) : null;
  const lines = [describe(p, T)];
  if (typeof p.doc === 'string' && p.doc) lines.push(p.doc);
  if (dir === 'in') {
    for (const src of graph.producers(node, p.id)) {
      const out = res.portsOf(src.node).outputs.find(o => o.id === src.port.split('.')[0]);
      if (typeof out?.doc === 'string' && out.doc) lines.push(t('来自 {from}：{doc}', { from: `${graph.node(src.node).title}.${src.port}`, doc: out.doc }));
    }
  }
  const type = portType(p);
  // a driver's facing input (its loop / structure handle) sits on its right edge, towards the loop box it drives
  return { id: p.id, label, type, title: lines.join('\n'), class: { call: p.wire === 'call', required: !!p.required }, ...(dir === 'in' && facing(p) ? { right: true } : {}) };
}

/** The fields of a record type as `[key, type]` pairs. Anything else gives []. */
function recordFields(T: unknown): [string, unknown][] {
  if (!T || typeof T !== 'object' || !('type' in T) || T.type !== 'record' || !('fields' in T)) return [];
  const fields = T.fields;
  return fields && typeof fields === 'object' ? Object.entries(fields) : [];
}
function fieldSpec(id: string, label: string, T: unknown, extra: Partial<PortSpec>): PortSpec {
  const decl: PortDecl = { id, wire: 'value', type: T };
  return { id, label, type: portType(decl), title: describe(decl, T), ...extra };
}

/**
 * The port band of `node`. A record-typed value output is one port. Its fields are further output ports, addressed by
 * path (`params.steps`, `value.cfg.bonus`). `open` lists the expanded paths. It is set only for the node whose tree is
 * expanded, else it is null. An expanded port shows its fields as a tree below it. Each field is draggable, and records
 * in it are expandable again. The band always shows field paths that carry a wire, so every wire keeps its slot.
 * Outside the expanded tree, such a field shows its full path.
 */
export function portSpecs(graph: ModuleGraph, res: Resolution, node: string, open: ReadonlySet<string> | null = null): { inputs: PortSpec[]; outputs: PortSpec[] } {
  const ports = res.portsOf(node);
  const wired = new Set(graph.wiresOf(node).filter(w => w.from.node === node && w.from.port.includes('.')).map(w => w.from.port));
  const outputs: PortSpec[] = [];
  for (const p of ports.outputs) {
    const T = p.wire === 'value' ? res.typeOf(node, p.id) : null;
    const expandable = recordFields(T).length > 0;
    outputs.push({ ...spec(graph, p, 'out', node, res), ...(expandable ? { expandable, expanded: !!open?.has(p.id) } : {}) });
    if (!expandable) continue;
    const shown = new Set<string>();
    // the expanded tree, depth first, with box-drawing guides (`│ ` under an ancestor that has later siblings)
    const walk = (path: string, type: unknown, guide: string) => {
      const fields = recordFields(type);
      fields.forEach(([key, FT], i) => {
        const id = `${path}.${key}`, last = i === fields.length - 1, sub = recordFields(FT).length > 0;
        shown.add(id);
        outputs.push(fieldSpec(id, key, FT, { class: { tree: true }, tree: `${guide}${last ? '└─' : '├─'}`, expandable: sub, expanded: sub && !!open?.has(id) }));
        if (sub && open?.has(id)) walk(id, FT, `${guide}${last ? '  ' : '│ '}`);
      });
    };
    if (open?.has(p.id)) walk(p.id, T, '');
    // wired field paths outside the expanded tree: one row each, labelled by the full path
    for (const id of [...wired].filter(w => w.startsWith(`${p.id}.`) && !shown.has(w)).sort()) {
      outputs.push(fieldSpec(id, id, res.typeOf(node, id), { class: { path: true } }));
    }
  }
  return { inputs: ports.inputs.map(p => spec(graph, p, 'in', node, res)), outputs };
}

export function problemView(problems: Problem[]): ProblemView {
  const out: ProblemView = { errors: [], incomplete: [] };
  for (const p of problems) (p.incomplete ? out.incomplete : out.errors).push(p.port ? `${p.port}: ${p.message}` : p.message);
  return out;
}
/** A problem badge's hover text: the errors, then the incomplete items marked as such. */
export function problemHint(p: ProblemView): string {
  return [...p.errors, ...p.incomplete.map(m => t('（未完成）{message}', { message: m }))].join('\n');
}

export const kindLabel = (kind: string): string => t(kindOf(kind).label as string);
