// core/sessions/common.js — helpers that sessions and browser trainers share. They compile bundle program entries,
// list the episodes a bundle partition entry describes (docs/design.md §6) and choose the episode a mirror runs. They
// also hold the observable-session plumbing (snapshot cache + subscribers) and small guards. The bundle a driver pins
// and the tables it needs: pinned.js.
import * as ir from '../../ir/index.js';
import { partitionEpisodes } from '../kinds/partition.js';
import { t } from '../../i18n.js';
import { canonicalJSON } from '../canonical.js';

export class SessionError extends Error {
  constructor(message) { super(message); this.name = 'SessionError'; }
}

/** Compile `{ program, bound, boundTypes, exact }` for the positional `paramTypes`. Returns `run(...args)`. Arguments
 *  are checked IR results or runner values already, so only results are checked (as core/runner.js does). */
export function compileEntry(entry, paramTypes, name) {
  const boundNames = entry.program.params.slice(paramTypes.length);
  const boundValues = boundNames.map(n => { if (!Object.hasOwn(entry.bound, n)) throw new SessionError(t('程序 {name} 的参数 {param} 没有绑定值', { name, param: n })); return entry.bound[n]; });
  const boundTypes = boundNames.map(n => { const T = entry.boundTypes[n]; if (!T) throw new SessionError(t('程序 {name} 的参数 {param} 没有类型', { name, param: n })); return T; });
  const compiled = ir.compile(entry.program, [...paramTypes, ...boundTypes], { exact: entry.exact, checkArgs: false });
  return boundValues.length ? (...args) => compiled.run(...args, ...boundValues) : (...args) => compiled.run(...args);
}

/** Episodes of a bundle partition entry (`{kind:'seed',seed,count}` / `{kind:'enumerate',axes,select}` / window). [] for none. */
export function episodesOf(entry) {
  if (!entry) return [];
  if (entry.kind === 'seed') return partitionEpisodes({ kind: 'seed', seed: { training: { seed: entry.seed, count: entry.count } } }, 'training');
  if (entry.kind === 'enumerate') return partitionEpisodes({ kind: 'enumerate', enumerate: { axes: entry.axes, roles: { training: entry.select } } }, 'training');
  if (entry.kind === 'window') {
    const { length, stride, embargo, range, first, rows } = entry;
    if (!range) return [];
    const lo = Math.floor(range[0] * rows) + (range[0] > first ? embargo : 0), hi = Math.floor(range[1] * rows);
    const out = [];
    for (let start = lo; start + length <= hi; start += stride) out.push({ start, length });
    return out;
  }
  throw new SessionError(t('未知分区种类：{kind}', { kind: String(entry.kind) }));
}

/** The seed a seed-episode env starts from when the bundle pins no partition. */
const DEFAULT_SEED_EPISODE = Object.freeze({ seed: 1 });
/**
 * The episode a mirror (execution instance, deployment) runs on `bundle`. `selection = { role, index? }` picks from the
 * bundle's partitions. Another object is an explicit episode record. With null, the mirror uses the first episode of
 * the first non-empty partition (training, validation, test), or DEFAULT_SEED_EPISODE when the env takes seeds.
 */
export function selectEpisode(bundle, selection) {
  if (selection && typeof selection === 'object' && 'role' in selection) {
    const list = episodesOf(bundle.partitions?.[selection.role]);
    if (!list.length) throw new SessionError(t('训练快照没有 {role} 分区的回合', { role: selection.role }));
    const i = selection.index ?? 0;
    if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new SessionError(t('回合下标 {index} 越界（共 {n} 个）', { index: i, n: list.length }));
    return list[i];
  }
  if (selection) return selection;
  for (const role of ['training', 'validation', 'test']) { const list = episodesOf(bundle.partitions?.[role]); if (list.length) return list[0]; }
  if (bundle.env?.start === 'seed') return DEFAULT_SEED_EPISODE;
  throw new SessionError(t('先选择回合'));
}

/** Snapshot cache + listeners shared by every session. `notify(kind)` invalidates the cache and calls every listener. */
export function observable(build) {
  const listeners = new Set();
  let cache = null;
  return {
    snapshot() { return cache ??= build(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    notify(kind) { cache = null; for (const fn of listeners) { try { fn(kind); } catch { /* a listener never breaks the session */ } } },
    clear() { listeners.clear(); cache = null; },
  };
}

export const shortId = id => `${String(id).slice(0, 10)}…`;
export const deepEqual = (a, b) => canonicalJSON(a ?? null) === canonicalJSON(b ?? null);

/** The single node of `kind` wired into `port` of `nodeId`, or null. */
export function producerNode(graph, nodeId, port, kind = null) {
  const p = graph.producers(nodeId, port)[0];
  if (!p) return null;
  const node = graph.node(p.node);
  return kind && node.kind !== kind ? null : node;
}
