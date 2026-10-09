// core/sessions/evaluator.js — `evaluate(bundle, role, options)` runs an evaluator bundle's loop greedily with the
// integer engines over one partition (core/loop.js runEpisodes, which training validation uses too). It summarises
// metrics fn(Episode) → number, optionally grouped by an enumerate axis.
// Pure: no workspace. `createEvaluatorSession` wraps it for a node.
import { runEpisodes } from '../loop.js';
import { envHash } from '../bundle.js';
import { episodeType } from '../kinds/scenario.js';
import { ROLES } from '../kinds/partition.js';
import { compileEntry, episodesOf, observable, SessionError } from './common.js';
import { bundlePins } from './pinned.js';
import { t } from '../../i18n.js';

const MAX_KEPT_EPISODES = 256;
const PROGRESS_EVERY = 16;                                                   // episodes between onProgress calls

const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const summarize = rows => { const out = {}; for (const name of Object.keys(rows[0]?.metrics ?? {})) out[name] = { mean: mean(rows.map(r => r.metrics[name])), n: rows.length }; return out; };
/** `{ <networkId>: artifactId }` of a loop section's networks. */
const artifactsOf = loop => Object.fromEntries(Object.entries(loop.nodes).filter(([, n]) => n.kind === 'network').map(([id, n]) => [id, n.artifactId]));

/**
 * Evaluate an evaluator bundle on `bundle.partitions[role]`. Every network runs its model (`models` overrides by id).
 * `tables` = { datasetId: columns } when the env reads a table. `groupBy` defaults to `bundle.groupBy`.
 */
export async function evaluate(bundle, role = 'test', { tables = {}, models = {}, groupBy = bundle.groupBy ?? null, keep = MAX_KEPT_EPISODES, onProgress = null } = {}) {
  if (!bundle?.env || !bundle.loop) throw new SessionError(t('训练快照没有环境'));
  const partition = bundle.partitions?.[role];
  if (!partition) throw new SessionError(t('训练快照没有 {role} 分区', { role }));
  const episodes = episodesOf(partition);
  if (!episodes.length) throw new SessionError(t('{role} 分区没有回合', { role }));
  if (groupBy && !(partition.kind === 'enumerate' && groupBy in (partition.axes ?? {}))) throw new SessionError(t('分组轴 {axis} 不是分区枚举回合的轴', { axis: groupBy }));
  const Episode = episodeType(bundle.env.types.State);
  const metrics = (bundle.metrics ?? []).map(m => ({ name: m.name, run: compileEntry(m, [Episode], m.name) }));
  const names = metrics.map(m => m.name);
  if (new Set(names).size !== names.length) throw new SessionError(t('指标名称重复'));

  const rows = [];
  for (let i = 0; i < episodes.length; i += PROGRESS_EVERY) {
    for (const r of runEpisodes(bundle, { models, episodes: episodes.slice(i, i + PROGRESS_EVERY), tables })) {
      const summary = { initial: r.initial, final: r.final, steps: r.steps, success: r.success, return: r.return }, values = {};
      for (const m of metrics) { const v = m.run(summary); if (!Number.isFinite(v)) throw new SessionError(t('指标 {name} 返回了非有限数', { name: m.name })); values[m.name] = v; }
      rows.push({ episode: r.start, steps: r.steps, success: r.success, ...(bundle.objective ? { return: r.return } : {}), metrics: values });
    }
    onProgress?.({ done: rows.length, total: episodes.length });
    await new Promise(resolve => setTimeout(resolve, 0));                    // let the progress paint between batches
  }
  // `return` sums the objective's rewards: without an objective wired there is no return to report (null, not 0)
  const returnOf = g => (bundle.objective ? mean(g.map(r => r.return)) : null);
  const report = {
    role, partition, artifacts: artifactsOf(bundle.loop), envHash: await envHash(bundle),
    n: rows.length, successRate: mean(rows.map(r => (r.success ? 1 : 0))), meanReturn: returnOf(rows), meanSteps: mean(rows.map(r => r.steps)),
    metrics: summarize(rows), episodes: rows.slice(0, keep),
  };
  if (groupBy) {
    const keys = [...new Set(rows.map(r => String(r.episode[groupBy])))];
    report.groups = { axis: groupBy, rows: keys.map(key => { const g = rows.filter(r => String(r.episode[groupBy]) === key); return { key, n: g.length, successRate: mean(g.map(r => (r.success ? 1 : 0))), meanReturn: returnOf(g), metrics: summarize(g) }; }) };
  }
  return report;
}

/**
 * Evaluator node session. It pins the node's bundle (every network of its loop with its accepted artifact, core/loop.js
 * acceptedArtifactId, plus the rows of its tables, pinned.js). It keeps the last report with the bundle it describes. A
 * graph edit never discards or recomputes the report. `stale` says that the graph describes another bundle now, also
 * when the edit came while the evaluation ran. The report is session state: it is not saved with the workspace.
 *   snapshot() → { nodeId, dead, problem, artifacts, bundleReady, busy, progress, report, stale, error, groupBy, roles, role }
 *   run(role='test') → Promise<report|null> (role ∈ roles, null on failure or when the session was disposed meanwhile)
 *   clear() · subscribe(fn) · dispose()
 */
export function createEvaluatorSession({ workspace, nodeId, datasets = null }) {
  const graph = workspace.graph;
  let result = null, error = null, busy = false, progress = null, disposed = false;   // result: { pin, value: report }
  const pins = bundlePins(workspace, nodeId, { datasets });
  const view = observable(build);
  const off = workspace.subscribe(() => { if (!disposed) view.notify('workspace'); });

  const node = () => (graph.hasNode(nodeId) && graph.node(nodeId).kind === 'evaluator' ? graph.node(nodeId) : null);
  function build() {
    const n = node();
    if (!n || disposed) return { nodeId, dead: disposed ? t('评估会话已释放') : t('评估器模块已不存在'), problem: null, artifacts: null, bundleReady: false, busy: false, progress: null, report: null, stale: false, error, roles: [], role: null };
    const { bundle, problem } = pins.current();
    const report = result?.value ?? null;
    return {
      nodeId, dead: null, problem, artifacts: bundle ? artifactsOf(bundle.loop) : null, bundleReady: !!bundle, busy, progress,
      report, stale: !!result && pins.stale(result.pin), error, groupBy: n.config.groupBy ?? null,
      roles: bundle ? ROLES.filter(r => bundle.partitions?.[r]) : [], role: report?.role ?? null,
    };
  }
  async function run(role = 'test') {
    if (disposed) throw new SessionError(t('评估会话已释放'));
    if (!ROLES.includes(role)) throw new SessionError(t('未知分区角色：{role}', { role: String(role) }));
    if (busy) return result?.value ?? null;
    busy = true; error = null; progress = null; view.notify('busy');
    try {
      if (!node()) throw new SessionError(t('评估器模块已不存在'));
      const out = await pins.run(pin => evaluate(pin.bundle, role, { tables: pin.tables, onProgress: p => { progress = p; view.notify('progress'); } }));
      if (out) result = out;
      return out?.value ?? null;
    } catch (e) { error = e.message; result = null; return null; }
    finally { busy = false; progress = null; if (!disposed) view.notify('report'); }
  }
  function clear() { result = null; error = null; view.notify('report'); return view.snapshot(); }
  function dispose() { if (disposed) return; disposed = true; off(); pins.dispose(); view.notify('dispose'); view.clear(); }
  return { snapshot: view.snapshot, subscribe: view.subscribe, run, clear, dispose };
}
