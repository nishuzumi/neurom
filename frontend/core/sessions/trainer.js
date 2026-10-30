// core/sessions/trainer.js — the runtime behind one trainer node. start() pins the node's bundle (pinned.js). The pin
// holds its loop with the trained network open and every other network's accepted weights, plus the rows of every
// table its env names. start() then records a run in the workspace. It gives bundle and rows to the browser worker
// (frontend/training/client.js) or to the Python workspace (workspace-client.js). A Training Run is immutable: later
// graph edits do not touch it. Completion assembles the artifact (store.makeArtifact) and links it to the run.
// Failure / cancellation is recorded on the run. Active runs keep their bundle on the run record, so a Python run can
// be re-attached after a reload (`recover()`). The Python workspace keeps the rows it was given. A browser run cannot
// survive a reload and is marked failed there. Every change is a Workspace change: the app persists it from its
// Workspace subscription.
// A trainer with a `gate` wire starts only when the current report of that evaluator meets `config.gate` (ADR 0020).
// `evaluators(id)` gives the evaluator session of a node. The check runs at the start for both backends, so the
// Python workspace never gets a refused run. A later change of the report does not stop a run.
//
//   snapshot() → { nodeId, dead, backend, method, problem, gate:{evaluator,passed,reason,value}|null, active:{id,status,progress}|null, runs:[…], can:{start,cancel}, python }
//   start() → Promise<runId> · cancel(runId?) → Promise · recover() → Promise · remove(runId) · subscribe(fn) · dispose()
import { bundleHash } from '../bundle.js';
import { makeArtifact } from '../store.js';
import { gateEvaluatorOf, hasCondition } from '../kinds/trainer.js';
import { observable, SessionError } from './common.js';
import { bundlePins } from './pinned.js';
import { isTerminal } from './workspace-client.js';
import { t } from '../../i18n.js';

const ACTIVE = new Set(['queued', 'running']);
const PYTHON_STATUS = { queued: 'queued', running: 'running', completed: 'done', failed: 'failed', cancelled: 'cancelled' };
const PROGRESS_INTERVAL = 250;

async function defaultBrowser(bundle, options) {
  const { startBrowserTraining } = await import('../../training/client.js');
  return startBrowserTraining(bundle, options);
}

/**
 * The gate state of `gate` (a trainer's condition `{ metric, min?, max? }`) against the snapshot of the evaluator
 * session `title` (`{ report, stale }`, or null). → `{ passed, reason, value }`. value: the metric mean, or null.
 */
export function gateStatus(gate, evaluation, title) {
  const refuse = (reason, value = null) => ({ passed: false, reason, value });
  if (!hasCondition(gate)) return refuse(t('先选择指标，再填写最小值或最大值'));
  if (!evaluation?.report) return refuse(t('还没有评估器 {title} 的报告：先运行评估', { title }));
  if (evaluation.stale) return refuse(t('评估器 {title} 的报告已过时：再运行一次评估', { title }));
  const value = evaluation.report.metrics?.[gate.metric]?.mean;
  if (typeof value !== 'number') return refuse(t('评估器 {title} 的报告里没有指标 {metric}', { title, metric: gate.metric }));
  const shown = { metric: gate.metric, value: String(+value.toPrecision(4)), min: gate.min, max: gate.max };
  if (gate.min != null && value < gate.min) return refuse(t('{metric} 是 {value}，需要 ≥ {min}', shown), value);
  if (gate.max != null && value > gate.max) return refuse(t('{metric} 是 {value}，需要 ≤ {max}', shown), value);
  return { passed: true, reason: t('{metric} 是 {value}，满足条件', shown), value };
}

export function createTrainerSession({ workspace, nodeId, browser = defaultBrowser, client = null, datasets = null, evaluators = null, now = () => Date.now() }) {
  const graph = workspace.graph;
  const active = new Map();                                             // runId → { cancel(), progress }
  let disposed = false, starting = false;
  let gateWatch = null;                                                 // { id, off } — the evaluator session the gate follows
  const pins = bundlePins(workspace, nodeId, { datasets });
  const view = observable(build);
  const off = workspace.subscribe(() => { if (!disposed) { watchGate(); view.notify('workspace'); } });

  const node = () => (graph.hasNode(nodeId) && graph.node(nodeId).kind === 'trainer' ? graph.node(nodeId) : null);
  const runsOf = () => [...workspace.runs.values()].filter(r => r.trainer === nodeId).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const gateOf = n => gateEvaluatorOf(graph, n);
  /** Follow the evaluator session of the `gate` wire, so a new report or a stale one updates the snapshot. */
  function watchGate() {
    const n = node(), id = n ? gateOf(n)?.id ?? null : null;
    if (gateWatch?.id === id) return;
    gateWatch?.off(); gateWatch = null;
    const s = id ? evaluators?.(id) : null;
    if (s) gateWatch = { id, off: s.subscribe(() => { if (!disposed) view.notify('gate'); }) };
  }
  watchGate();
  /** The gate state of trainer `n` now, or null without a `gate` wire. */
  function gateView(n) {
    const evaluator = gateOf(n);
    if (!evaluator) return null;
    return { evaluator: evaluator.title, ...gateStatus(n.config.gate, evaluators?.(evaluator.id)?.snapshot() ?? null, evaluator.title) };
  }

  function build() {
    const n = node();
    if (!n || disposed) return { nodeId, dead: disposed ? t('训练会话已释放') : t('训练器模块已不存在'), backend: null, method: null, problem: null, gate: null, active: null, runs: [], can: { start: false, cancel: false }, python: pythonView() };
    let problem = pins.current().problem;
    const runs = runsOf().map(r => ({ ...r, progress: active.get(r.id)?.progress ?? r.progress ?? null, bundle: undefined }));
    const current = runs.find(r => ACTIVE.has(r.status)) ?? null;
    if (n.config.backend === 'python' && !client) problem ??= t('Python 后端需要 Workspace 客户端');
    const gate = gateView(n);
    return {
      nodeId, dead: null, backend: n.config.backend, method: n.config.method, problem, gate, runs,
      active: current ? { id: current.id, status: current.status, progress: current.progress, backend: current.backend } : null,
      can: { start: !problem && !current && !starting && (gate?.passed ?? true), cancel: !!current && active.has(current.id) },
      python: pythonView(),
    };
  }
  const pythonView = () => ({ available: !!client, connected: !!client?.connected, capabilities: client?.capabilities ?? null });

  function updateRun(id, patch) {
    if (!workspace.runs.has(id)) return null;                          // removed by the user while running
    return workspace.updateRun(id, patch);
  }
  function trackProgress(id) {
    let last = 0;
    return progress => {
      const entry = active.get(id); if (!entry) return;
      entry.progress = progress;
      const stamp = now();
      if (stamp - last >= PROGRESS_INTERVAL) { last = stamp; updateRun(id, { progress }); }
      view.notify('progress');
    };
  }
  async function finish(id, bundle, result) {
    const artifact = await makeArtifact({ bundle, model: result.model, provenance: result.provenance ?? {}, evaluation: result.evaluation ?? {} });
    if (!workspace.artifacts.has(artifact.id)) await workspace.addArtifact(artifact);
    updateRun(id, { status: 'done', candidates: [artifact.id], finishedAt: now(), progress: null, error: null, bundle: undefined, metric: result.evaluation?.metric ?? null, metricName: result.evaluation?.metricName ?? null });
    return artifact;
  }
  function settle(id, fn) {
    return fn.then(v => v, e => { updateRun(id, { status: e?.name === 'AbortError' ? 'cancelled' : 'failed', error: e?.name === 'AbortError' ? null : String(e?.message ?? e), finishedAt: now(), progress: null, bundle: undefined }); })
      .finally(() => { active.delete(id); view.notify('run'); });
  }

  /** Attach to a Python run that is (or was) in flight: follows it to a terminal state, then finalises the record. */
  function followPython(id, bundle) {
    const handle = client.follow(id, run => {
      const status = PYTHON_STATUS[run.status];
      if (status && ACTIVE.has(status)) { const entry = active.get(id); if (entry) entry.progress = run.progress ?? entry.progress; view.notify('progress'); }
    });
    active.set(id, { cancel: () => client.cancel(id).catch(() => {}), progress: null, stop: handle.stop });
    return settle(id, handle.promise.then(async run => {
      if (!run) return;                                                 // stopped by dispose()
      if (run.status === 'completed') { if (!run.result) throw new SessionError(t('Python 运行 {id} 完成但没有结果', { id })); await finish(id, bundle, run.result); }
      else if (run.status === 'failed') throw new Error(run.error ?? t('Python 训练失败'));
      else if (run.status === 'cancelled') { const e = new Error(t('训练已取消')); e.name = 'AbortError'; throw e; }
    }));
  }

  async function start() {
    if (disposed) throw new SessionError(t('训练会话已释放'));
    const n = node(); if (!n) throw new SessionError(t('训练器模块已不存在'));
    if (starting || runsOf().some(r => ACTIVE.has(r.status))) throw new SessionError(t('这个训练器已有运行中的训练'));
    const gate = gateView(n);
    if (gate && !gate.passed) throw new SessionError(gate.reason);
    starting = true; view.notify('start');
    try {
      const { bundle, tables } = await pins.pin();
      const hash = await bundleHash(bundle);
      const backend = n.config.backend, id = `run-${crypto.randomUUID()}`;
      const record = { id, trainer: nodeId, bundleHash: hash, status: 'running', candidates: [], backend, method: n.config.method, startedAt: now(), progress: null, error: null, bundle };
      if (backend === 'browser') {
        const handle = await browser(bundle, { onProgress: trackProgress(id), tables });
        workspace.addRun(record);
        active.set(id, { cancel: handle.cancel, progress: null });
        settle(id, handle.promise.then(result => finish(id, bundle, result)));
      } else {
        if (!client) throw new SessionError(t('Python 后端需要 Workspace 客户端'));
        if (!client.connected) await client.connect();
        workspace.addRun({ ...record, status: 'queued' });
        try { await client.submit({ id, bundle, bundleHash: hash, tables }); }
        catch (e) { updateRun(id, { status: 'failed', error: e.message, finishedAt: now(), bundle: undefined }); throw e; }
        followPython(id, bundle);
      }
      return id;
    } finally { starting = false; view.notify('run'); }
  }

  async function cancel(runId = null) {
    const id = runId ?? runsOf().find(r => ACTIVE.has(r.status))?.id;
    const entry = id ? active.get(id) : null;
    if (!entry) throw new SessionError(t('没有可取消的训练'));
    await entry.cancel();
  }

  /** After a reload: re-attach Python runs still marked active. Browser runs cannot be resumed and are failed. */
  async function recover() {
    for (const run of runsOf()) {
      if (!ACTIVE.has(run.status) || active.has(run.id)) continue;
      if (run.backend !== 'python' || !client || !run.bundle) { updateRun(run.id, { status: 'failed', error: t('页面已重新加载，训练中断'), finishedAt: now(), bundle: undefined }); continue; }
      try {
        if (!client.connected) await client.connect();
        const remote = await client.get(run.id);
        if (isTerminal(remote) && remote.status !== 'completed') { updateRun(run.id, { status: PYTHON_STATUS[remote.status], error: remote.error ?? null, finishedAt: now(), bundle: undefined }); continue; }
        followPython(run.id, run.bundle);
      } catch (e) { updateRun(run.id, { status: 'failed', error: e.message, finishedAt: now(), bundle: undefined }); }
    }
    view.notify('recover');
  }

  function remove(runId) {
    const run = workspace.runs.get(runId);
    if (!run || run.trainer !== nodeId) throw new SessionError(t('运行记录 {id} 不存在', { id: runId }));
    if (active.has(runId)) throw new SessionError(t('先取消运行中的训练'));
    workspace.removeRun(runId);
  }
  function dispose() {
    if (disposed) return;
    disposed = true; off(); pins.dispose(); gateWatch?.off(); gateWatch = null;
    for (const entry of active.values()) entry.stop?.();
    view.notify('dispose'); view.clear();
  }
  return { snapshot: view.snapshot, subscribe: view.subscribe, start, cancel, recover, remove, dispose };
}
