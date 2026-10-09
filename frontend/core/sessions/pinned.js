// core/sessions/pinned.js — the Bundle a driver's result was made from (its pin) versus the Bundle the graph describes
// for that driver now. Trainer, Evaluator and Execution build on it and keep their own meanings. A Training Run is an
// immutable record of its pin. A Report describes its pin. An Execution steps its pin until reset.
//
//   bundlePins(workspace, nodeId, { datasets }) →
//     current() → { bundle, problem }        what the graph describes now (the workspace's shared bundle cache)
//     pin() → Promise<{ bundle, tables }>     the current bundle plus the rows of every table its env names, read from
//                                             `datasets` and checked against the content hash the bundle pins. Throws
//                                             SessionError (graph problem, missing rows, changed rows). Frozen, and
//                                             the same pin while the graph is unchanged.
//     stale(pin) → boolean                    the graph describes another bundle now, or none
//     run(job) → Promise<{ pin, value }|null> pins, awaits job(pin) and publishes its value with the pin. null when a
//                                             later run() started or dispose() came first (the value describes a bundle
//                                             nobody asked about any more). A failing pin or job rejects.
//     dispose()
//
// A pin's `tables` are `{ datasetId: { column: Float64Array } }`, what the JS runner reads. The Python workspace gets
// the same rows as JSON (workspace-client.js submit).
import { buildBundle, BundleError } from '../bundle.js';
import { SessionError, deepEqual } from './common.js';
import { t } from '../../i18n.js';

/** `{ id: columns }` for every table a bundle's env names, read from a dataset store (`get(id) → {columns, hash}|null`). */
export async function tablesFor(bundle, datasets) {
  const out = {};
  for (const { id, hash } of bundle?.env?.tables ?? []) {
    const table = datasets ? await datasets.get(id) : null;
    if (!table) throw new SessionError(t('缺少数据集 {id} 的数据', { id }));
    if (table.hash !== hash) throw new SessionError(t('数据集 {id} 的内容已改变（哈希不符）', { id }));
    out[id] = table.columns;
  }
  return out;
}

const bundleCaches = new WeakMap();
/** The workspace's bundle cache: `get(consumerId) → { bundle, problem }` (buildBundle with the workspace's artifacts,
 *  and a BundleError becomes `problem`), kept until the graph or the artifacts change. One per workspace, shared by
 *  every session. A session asks for it before it subscribes to the workspace, so the cache is cleared before the
 *  session hears of a change. The bundles are shared: never mutate one. */
export function workspaceBundles(workspace) {
  let cache = bundleCaches.get(workspace);
  if (cache) return cache;
  const memo = new Map();
  workspace.subscribe(what => { if (what === 'graph' || what === 'artifacts') memo.clear(); });
  cache = {
    get(consumerId) {
      let entry = memo.get(consumerId);
      if (!entry) {
        try { entry = { bundle: buildBundle(workspace.graph, consumerId, { artifacts: id => workspace.artifact(id) }), problem: null }; }
        catch (e) { if (!(e instanceof BundleError)) throw e; entry = { bundle: null, problem: e.message }; }
        memo.set(consumerId, entry);
      }
      return entry;
    },
  };
  bundleCaches.set(workspace, cache);
  return cache;
}

export function bundlePins(workspace, nodeId, { datasets = null } = {}) {
  const bundles = workspaceBundles(workspace);
  const current = () => bundles.get(nodeId);
  let last = null;                                      // { entry, pin: Promise<pin> } — the pin of the current entry
  let compared = null;                                  // { pin, entry, stale } — the last stale() answer
  let generation = 0, disposed = false;

  function pin() {
    const entry = current();
    if (entry.problem) return Promise.reject(new SessionError(entry.problem));
    if (last?.entry !== entry) {
      const pending = tablesFor(entry.bundle, datasets).then(tables => Object.freeze({ bundle: entry.bundle, tables: Object.freeze(tables) }));
      last = { entry, pin: pending };
      pending.catch(() => { if (last?.pin === pending) last = null; });   // a failed read is retried on the next pin()
    }
    return last.pin;
  }
  function stale(p) {
    const entry = current();
    if (compared?.pin !== p || compared.entry !== entry) compared = { pin: p, entry, stale: p.bundle !== entry.bundle && !deepEqual(p.bundle, entry.bundle) };
    return compared.stale;
  }
  async function run(job) {
    if (disposed) return null;
    const mine = ++generation;
    const p = await pin();
    const value = await job(p);
    return !disposed && mine === generation ? { pin: p, value } : null;
  }
  function dispose() { disposed = true; generation++; last = null; compared = null; }
  return { current, pin, stale, run, dispose };
}
