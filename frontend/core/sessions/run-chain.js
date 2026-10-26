// core/sessions/run-chain.js — 「运行到这里」 (ADR 0023). From one module, the chain walks upstream along every wire and
// makes each candidates module that it reaches ready, then it runs the action of that module.
//
// - A candidates module is ready when its accepted artifact is compatible with the current graph (`ok === true`; an
//   unknown fit counts only without a trainer). A ready one stays as it is: its accepted artifact is the cache of
//   everything above it.
// - A candidates module that is not ready gets its trainer ready (below), then the trainer trains, and the chain accepts
//   the candidate that the run selected (`run.candidates[0]`).
// - A trainer is ready when the candidates modules above it are ready, and its `gate` passes. For the gate, the chain
//   runs the evaluator only when its report is missing or stale (it makes the candidates above the evaluator ready
//   first).
// - The action of the module: an evaluator evaluates, an execution resets and runs, a trainer trains and its result is
//   accepted, a script module plays (`onScript`, the editor starts the frame). A candidates module only gets ready.
// The chain stops at the first step that fails, and tells why. One chain runs at a time. stop() ends the chain that
// runs (the app calls it when it replaces the workspace).
//
//   snapshot() → { target: nodeId|null, step: string|null } · run(nodeId) → Promise<void> · stop() · subscribe(fn) ·
//   dispose()
import { gateEvaluatorOf } from '../kinds/trainer.js';
import { gateStatus } from './trainer.js';
import { observable, SessionError } from './common.js';
import { t } from '../../i18n.js';

/** the kinds that have the action 「运行到这里」 */
export const CHAIN_KINDS = new Set(['candidates', 'trainer', 'evaluator', 'execution', 'script']);
const ACTIVE = new Set(['queued', 'running']);

/**
 * The candidates modules that `nodeId` reads upstream: the walk follows every wire into the module and into each module
 * above it. It stops at a candidates module (that one is a need) and does not go into a module of `skip`.
 */
function upstreamCandidates(graph, nodeId, skip = new Set()) {
  const out = [], seen = new Set([nodeId, ...skip]);
  const visit = id => {
    for (const w of graph.wires.values()) {
      if (w.to.node !== id || seen.has(w.from.node)) continue;
      seen.add(w.from.node);
      if (graph.node(w.from.node).kind === 'candidates') out.push(w.from.node);
      else visit(w.from.node);
    }
  };
  visit(nodeId);
  return out;
}

/**
 * workspace() and session(kind, id) are read on each use, because the app can swap the workspace. status(text, tone)
 * reports each step and the end. onScript(id) starts the run of a script module.
 * @param {{ workspace: () => any, session: (kind: any, id: string) => any, status?: (text: string, tone?: 'ok' | 'warn' | 'bad') => void, onScript?: (id: string) => void }} deps
 */
export function createRunChain({ workspace, session, status = () => {}, onScript = () => {} }) {
  let target = null, step = null, disposed = false;
  /** rejects when the running chain stops from outside (stop) */
  let halted = null, halt = () => {};
  const view = observable(() => ({ target, step }));
  const graph = () => workspace().graph;
  const title = id => graph().node(id).title;
  const say = text => { step = text; status(text); view.notify('step'); };

  const trainerOf = candsId => graph().producers(candsId, 'run').map(p => graph().node(p.node)).find(n => n.kind === 'trainer') ?? null;
  const candidatesOf = trainerId => graph().consumers(trainerId, 'run').map(c => graph().node(c.node)).filter(n => n.kind === 'candidates');
  /** ready: the accepted artifact fits the current graph. Unknown fit counts only where no trainer could tell */
  function ready(candsId) {
    const accepted = session('candidates', candsId).snapshot().candidates.find(c => c.accepted);
    return !!accepted && (accepted.compatible.ok === true || (accepted.compatible.ok === null && !trainerOf(candsId)));
  }
  /** `promise`, or the error of stop() when that comes first: every wait of a chain goes through it */
  const guard = promise => Promise.race([promise, halted]);
  /** the run `runId` once it leaves queued / running */
  function settled(runId) {
    const ws = workspace();
    let off = () => {};
    const done = new Promise(resolve => {
      const check = () => { const r = ws.runs.get(runId); if (!r || !ACTIVE.has(r.status)) { resolve(r ?? null); return true; } return false; };
      if (!check()) off = ws.subscribe(check);
    });
    return guard(done).finally(() => off());
  }

  async function ensureAll(ids, stack) { for (const id of ids) await ensureCandidates(id, stack); }
  async function ensureCandidates(id, stack) {
    if (ready(id)) return;
    if (stack.has(id)) throw new SessionError(t('候选 {title} 依赖它自己：先手动接受一个产物', { title: title(id) }));
    const trainer = trainerOf(id);
    if (!trainer) throw new SessionError(t('候选 {title} 没有兼容的已接受产物，也没有接训练器', { title: title(id) }));
    const artifact = await train(trainer.id, new Set([...stack, id]));
    session('candidates', id).accept(artifact);
  }
  async function evaluate(id) {
    const s = session('evaluator', id);
    say(t('评估 {title}…', { title: title(id) }));
    if (!(await guard(s.run(s.snapshot().role ?? 'test')))) throw new SessionError(t('{title} 的评估没有完成：{reason}', { title: title(id), reason: s.snapshot().error ?? s.snapshot().problem ?? '—' }));
  }
  /** a fresh report of evaluator `id`: the candidates above it get ready, then it evaluates when its report is missing or stale */
  async function fresh(id, stack) {
    await ensureAll(upstreamCandidates(graph(), id), stack);
    const snap = session('evaluator', id).snapshot();
    if (!snap.report || snap.stale) await evaluate(id);
  }
  /** train `id` once everything above it is ready → the id of the artifact that the run selected */
  async function train(id, stack) {
    const node = graph().node(id);
    await ensureAll(upstreamCandidates(graph(), id, new Set(candidatesOf(id).map(n => n.id))), stack);
    const evaluator = gateEvaluatorOf(graph(), node);
    if (evaluator) {
      await fresh(evaluator.id, stack);
      const gate = gateStatus(node.config.gate, session('evaluator', evaluator.id).snapshot(), evaluator.title);
      if (!gate.passed) throw new SessionError(t('{title} 的 gate 未通过：{reason}', { title: node.title, reason: gate.reason }));
    }
    say(t('训练 {title}…', { title: node.title }));
    const run = await settled(await guard(session('trainer', id).start()));
    if (run?.status !== 'done' || !run.candidates[0]) throw new SessionError(t('{title} 的训练没有完成：{reason}', { title: node.title, reason: run?.error ?? run?.status ?? '—' }));
    return run.candidates[0];
  }

  async function act(id) {
    const kind = graph().node(id).kind, stack = new Set();
    if (kind === 'candidates') return ensureCandidates(id, stack);
    if (kind === 'trainer') { const artifact = await train(id, stack); for (const c of candidatesOf(id)) session('candidates', c.id).accept(artifact); return; }
    await ensureAll(upstreamCandidates(graph(), id), stack);
    if (kind === 'evaluator') return evaluate(id);
    if (kind === 'execution') {
      const s = session('execution', id);
      await guard(s.reset());
      const error = s.snapshot().error;
      if (error) throw new SessionError(error);
      s.run();
      return;
    }
    if (kind === 'script') onScript(id);
  }

  async function run(id) {
    if (disposed) throw new SessionError(t('「运行到这里」已释放'));
    if (target) throw new SessionError(t('「运行到这里」正在运行 {title}', { title: title(target) }));
    const node = graph().hasNode(id) ? graph().node(id) : null;
    if (!node || !CHAIN_KINDS.has(node.kind)) throw new SessionError(t('这个模块没有「运行到这里」'));
    target = id; view.notify('start');
    halted = new Promise((_, reject) => { halt = () => reject(new SessionError(t('工作区换了，所以链停下'))); });
    halted.catch(() => {});
    try {
      await act(id);
      status(t('「运行到这里」完成：{title}', { title: node.title }), 'ok');
    } catch (e) {
      status(t('「运行到这里」停在这一步：{reason}', { reason: e?.message ?? String(e) }), 'bad');
    } finally {
      target = null; step = null; halt = () => {};
      if (!disposed) view.notify('end');
    }
  }
  function dispose() { disposed = true; halt(); view.clear(); }
  /** stop the running chain: the app replaced its workspace. The training that runs stays as the trainer has it */
  return { snapshot: view.snapshot, subscribe: view.subscribe, run, stop: () => halt(), dispose };
}
