// core/sessions/execution.js — one execution instance. It steps episodes of the loop wired into its `loop` with the
// accepted weights of every network (core/loop.js). It owns ALL temporal state of the run: the environment episode, the
// LIF potentials of the networks, the step clock and the history. The history holds the per-step values of every body
// module. Nothing here knows a scenario: views read `snapshot().state` / `.history` and render whatever the env's State
// record holds.
// Episodes come from the partition wired into `partition` (`setEpisode({ role: 'test', index })`) or an explicit
// Start record (`setEpisode({ seed: 7 })`). The running loop is a pin of the node's bundle (pinned.js). A graph edit
// leaves it running and makes it `stale` until reset() pins the bundle the graph describes now.
//
//   snapshot() → { nodeId, dead, problem, error, stale, started, running, interval, episode, selection, episodes,
//                  actions, state, t, done, budget, success, voltages, body, last, history }
//     body     [{ id, kind, title }] the loop body in evaluation order
//     history  [{ t, input, values: { '<node>.<port>': value }, ran: [nodeId…], tools: { <network>: { <port>: { choice,
//                data, result } } }, action, policyAction, manual, invalid, actionName, prev, next, done, truncated, success,
//                loop? }]. tools: each tool layer's decision of the step (core/loop.js). loop: the same records keyed by
//                network title, the Transition's `loop` a reward reads. `loop` is present only when the loop has tool
//                layers.
//   setEpisode(sel) · reset() · step(action?) · run(interval?) · pause() · setInterval(ms) · subscribe(fn) · dispose()
import { createEnv } from '../runner.js';
import { createLoop, loopTransition } from '../loop.js';
import { INVALID_ACTION } from '../readout.js';
import { loopBody, loopOf } from '../kinds/loop.js';
import { episodesOf, selectEpisode, observable, SessionError } from './common.js';
import { bundlePins } from './pinned.js';
import { t } from '../../i18n.js';

const DEFAULT_STEP_INTERVAL = 200;                                  // ms between steps of run()
const MAX_HISTORY = 4096;                                           // entries kept in snapshot().history

export function createExecutionSession({ workspace, nodeId, datasets = null, timers = globalThis }) {
  const graph = workspace.graph;
  let disposed = false, error = null;
  let selection = null;                                          // { role, index } | Start record | null
  const temporal = { env: null, loop: null, withLoop: null, pin: null, episode: null, history: [], last: null, success: null };
  const clock = { timer: null, running: false, interval: DEFAULT_STEP_INTERVAL };
  const pins = bundlePins(workspace, nodeId, { datasets });
  const view = observable(build);
  const off = workspace.subscribe(() => { if (!disposed) view.notify('workspace'); });

  const node = () => (graph.hasNode(nodeId) && graph.node(nodeId).kind === 'execution' ? graph.node(nodeId) : null);
  const halt = () => { clock.running = false; timers.clearTimeout(clock.timer); clock.timer = null; };
  function clearTemporal() { halt(); Object.assign(temporal, { env: null, loop: null, withLoop: null, pin: null, episode: null, history: [], last: null, success: null }); error = null; }
  const episodeOf = bundle => selectEpisode(bundle, selection);

  /** Pin the current bundle and start an episode on it. A build overtaken by a later one installs nothing. */
  async function build_() {
    const out = await pins.run(async pin => {
      const env = createEnv(pin.bundle.env, { tables: pin.tables }), episode = episodeOf(pin.bundle);
      env.reset(episode);
      return { env, episode };
    });
    if (!out) return;
    const { pin, value: { env, episode } } = out;
    Object.assign(temporal, { pin, env, episode, loop: createLoop(pin.bundle.loop), withLoop: loopTransition(pin.bundle.loop), history: [], last: null, success: null });
  }

  // ------------------------------------------------------------------ snapshot
  function body() {
    const L = loopOf(graph, node());
    if (!L) return [];
    return loopBody(graph, L.id).nodes.map(id => { const n = graph.node(id); return { id, kind: n.kind, title: n.title }; });
  }
  /** What a snapshot derives from the current bundle entry, recomputed only when the entry, the selection or the running
   *  pin changes (not per step). */
  let derived = null;
  function derive(entry) {
    if (derived?.entry === entry && derived.selection === selection && derived.running === temporal.pin) return derived;
    const { bundle, problem } = entry;
    let episodeProblem = null;
    if (bundle) { try { episodeOf(bundle); } catch (e) { episodeProblem = e.message; } }
    derived = {
      entry, selection, running: temporal.pin, problem: problem ?? episodeProblem,
      stale: !!temporal.pin && pins.stale(temporal.pin),
      episodes: bundle ? { test: episodesOf(bundle.partitions.test).length } : {}, body: body(),
    };
    return derived;
  }
  function build() {
    const n = node();
    if (!n || disposed) return { nodeId, dead: disposed ? t('执行实例已释放') : t('执行实例模块已不存在'), problem: null, error, history: [], running: false, body: [] };
    const entry = pins.current(), d = derive(entry), env = temporal.env;
    return {
      nodeId, dead: null, problem: d.problem, error,
      stale: d.stale,
      started: !!env, running: clock.running, interval: clock.interval,
      episode: temporal.episode, selection, episodes: d.episodes,
      actions: (temporal.pin?.bundle ?? entry.bundle)?.env.actions ?? null,
      state: env?.state ?? null, t: env?.t ?? 0, done: env?.done ?? false, budget: env?.budget ?? null, success: temporal.success,
      voltages: temporal.loop?.states() ?? null, body: d.body,
      last: temporal.last, history: temporal.history,
    };
  }

  // ------------------------------------------------------------------ operations
  const fail = e => { error = e.message; halt(); view.notify('error'); throw e; };
  const alive = () => { if (disposed) throw new SessionError(t('执行实例已释放')); if (!node()) throw new SessionError(t('执行实例模块已不存在')); };
  function setEpisode(sel) { alive(); selection = sel ?? null; clearTemporal(); view.notify('episode'); return view.snapshot(); }
  async function reset() {
    alive(); clearTemporal();
    try { await build_(); } catch (e) { fail(e); }
    view.notify('reset'); return view.snapshot();
  }
  /** One step of the loop. `action` overrides the loop's action (manual action). The body still runs. */
  async function step(action = null) {
    alive();
    if (!temporal.env) { try { await build_(); } catch (e) { fail(e); } if (!temporal.env) return view.snapshot(); }
    try {
      const env = temporal.env;
      if (env.done) throw new SessionError(t('回合已结束，先重置'));
      const input = env.input(), r = temporal.loop.step(input);
      const manual = action !== null, act = manual ? action : r.action;
      if (typeof act !== 'number' || !Number.isInteger(act)) throw new SessionError(t('动作必须是整数'));
      const tr = temporal.withLoop(env.step(act), r.tools);
      const entry = { t: temporal.history.length, input, values: r.values, ran: [...r.ran], tools: r.tools, action: act, policyAction: r.action, manual, invalid: act === INVALID_ACTION,
        actionName: temporal.pin.bundle.env.actions?.[act] ?? null, prev: tr.prev, next: tr.next, done: tr.done, truncated: tr.truncated, success: tr.success, ...(tr.loop ? { loop: tr.loop } : {}) };
      temporal.history.push(entry);
      if (temporal.history.length > MAX_HISTORY) temporal.history.shift();
      temporal.last = entry;
      if (env.done) { temporal.success = tr.success; halt(); }
      error = null;
    } catch (e) { fail(e); }
    view.notify('step'); return view.snapshot();
  }
  function run(interval = clock.interval) {
    alive();
    clock.interval = interval;
    if (clock.running) return view.snapshot();
    clock.running = true;
    const tick = async () => {
      if (!clock.running || disposed) return;
      try { await step(); } catch { return; }
      if (clock.running && !(temporal.env?.done ?? false)) clock.timer = timers.setTimeout(tick, clock.interval);
      else halt();
      view.notify('clock');
    };
    clock.timer = timers.setTimeout(tick, 0);
    view.notify('clock'); return view.snapshot();
  }
  function pause() { alive(); halt(); view.notify('clock'); return view.snapshot(); }
  function setInterval(ms) { alive(); if (!Number.isFinite(ms) || ms < 0) throw new SessionError(t('步进间隔必须是非负数')); clock.interval = ms; view.notify('clock'); return view.snapshot(); }
  function dispose() { if (disposed) return; disposed = true; halt(); off(); pins.dispose(); view.notify('dispose'); view.clear(); }
  return { snapshot: view.snapshot, subscribe: view.subscribe, setEpisode, reset, step, run, pause, setInterval, dispose };
}
