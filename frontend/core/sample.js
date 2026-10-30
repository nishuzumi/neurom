// core/sample.js — real example values for the code editor's role help (ADR 0012 §5). `sampleOf` runs a loop's
// environment once on the first episode of its driver's partition with the constant action 0. It resets, then steps
// until done (at most SAMPLE_STEPS steps). It sums the reward of the first driver that has a reward objective. A loop
// with tool layers also makes constant tool choices: every tool layer picks tool 0 on all-zero data. The sample runs
// that tool, so the Transition's `loop` holds real results (net tools need `artifacts` for their weights).
// `exampleOf` runs one role function of a code module, where its first caller (core/roles.js) runs it, on the
// arguments that sample gives its signature. Both are memoised per resolution. A sample is also memoised per the
// artifacts it looked up: when one arrives or disappears, the sample and the examples built on it are rebuilt. Values
// are deep-frozen.
import { envBundle, partitionEntry, programEntry } from './bundle.js';
import { toolsSection, toolCaller } from './loop.js';
import { createEnv } from './runner.js';
import { compileEntry, episodesOf } from './sessions/common.js';
import { METHODS } from './kinds/trainer.js';
import { loopBody, loopNetworks } from './kinds/loop.js';
import { networkStructure, isToolLayer } from './kinds/network.js';
import { callTool } from '../runtime/dense-policy.js';
import { rolesOf } from './roles.js';
import { NUMBER, isRef } from './types.js';
import { deepFreeze } from './canonical.js';
import { t } from '../i18n.js';

/** The action every sample step takes. Every tool layer chooses tool TOOL on all-zero data. */
const ACTION = 0, TOOL = 0;
/** Steps after which a sample episode that is still running is cut (`truncated`). */
const SAMPLE_STEPS = 4096;
/** Driver kinds in preference order, with the port their partition comes in on. */
const DRIVERS = Object.freeze([['trainer', 'training'], ['evaluator', 'partition'], ['execution', 'partition']]);
/** The refs a sample provides values for. */
const SAMPLE_REFS = new Set(['Start', 'State', 'Transition', 'Episode']);

const memoIn = (memo, res) => { let m = memo.get(res); if (!m) memo.set(res, (m = new Map())); return m; };
const messageOf = e => (e instanceof Error ? e.message : String(e));
const producerOf = (graph, nodeId, port) => graph.producers(nodeId, port)[0] ?? null;

/** The loop's driver a sample runs as: the first trainer consuming its `loop`, else evaluator, else execution. */
function driverOf(graph, loopId) {
  const drivers = graph.consumers(loopId, 'loop').map(c => graph.node(c.node));
  for (const [kind, port] of DRIVERS) { const node = drivers.find(d => d.kind === kind); if (node) return { node, port }; }
  return null;
}

/** The compiled reward of the first driver of `loopId` with a reward objective, with its code module, or null. */
function rewardOf(graph, res, loopId, Transition) {
  for (const c of graph.consumers(loopId, 'loop')) {
    const d = graph.node(c.node);
    const reward = (d.kind === 'trainer' && METHODS[d.config.method]?.objective === 'reward') || d.kind === 'evaluator';
    if (!reward || !producerOf(graph, d.id, 'objective')) continue;
    const entry = programEntry(graph, res, d.id, 'objective');
    return { run: compileEntry(entry, [Transition], 'reward'), title: entry.node.title };
  }
  return null;
}

/** The Transition's `loop` of a sample step: every tool layer of the body's networks chose TOOL on zero data. Each got
 *  what that tool returns from its rest state. null when the loop has no tool layers. */
function sampleLoop(graph, res, loopId, artifacts) {
  const { tools } = loopNetworks(graph, loopBody(graph, loopId).nodes);
  if (!tools.length) return null;
  return Object.fromEntries(tools.map(node => {
    const { I, O, tools: widths } = res.refsOf(node.id), structure = networkStructure(node.config, I, O, widths);
    const box = toolCaller(node.id, { structure, tools: toolsSection(graph, res, node, structure, artifacts) });
    const call = (port, choice, data) => box.call(port, choice, data, new Array(box.width).fill(0));
    return [node.title, Object.fromEntries(structure.layers.filter(isToolLayer).map(L => {
      const data = new Array(L.D).fill(0);
      return [L.tools, { choice: TOOL, data, result: callTool(L, call, TOOL, data) }];
    }))];
  }));
}

function buildSample(graph, res, loopId, artifacts) {
  const bundle = envBundle(graph, loopId, res);
  if (bundle.tables?.length) return { ok: false, reason: t('场景读数据集，所以这里不生成例子') };
  const driver = driverOf(graph, loopId);
  if (!driver) return { ok: false, reason: t('回路 {title} 还没有驱动它的分区', { title: graph.node(loopId).title }) };
  const part = producerOf(graph, driver.node.id, driver.port);
  const start = episodesOf(partitionEntry(graph, driver.node.id, driver.port))[0];
  if (!part || !start) return { ok: false, reason: t('{title} 的分区没有回合', { title: driver.node.title }) };
  const loop = sampleLoop(graph, res, loopId, artifacts), Transition = res.refsOf(loopId).Transition;
  if (!Transition) return { ok: false, reason: t('回路 {title} 的 Transition 类型尚未确定', { title: graph.node(loopId).title }) };
  const env = createEnv(bundle), reward = rewardOf(graph, res, loopId, Transition);
  const stepOnce = () => { const tr = env.step(ACTION); return loop ? { ...tr, loop } : tr; };
  const initial = structuredClone(env.reset(start));
  const first = stepOnce();
  let last = first, steps = 1, ret = reward ? reward.run(first) : 0;
  while (!last.done && steps < SAMPLE_STEPS) { last = stepOnce(); steps += 1; if (reward) ret += reward.run(last); }
  const values = { Start: start, State: initial, Transition: first, Episode: { initial, final: last.next, steps, success: last.success, return: ret } };
  return {
    ok: true,
    label: loop
      ? t('{partition} · {role} 第 1 个回合 · 动作取 {action} · 工具层选工具 {tool}、数据位全 0', { partition: graph.node(part.node).title, role: part.port, action: ACTION, tool: TOOL })
      : t('{partition} · {role} 第 1 个回合 · 动作取 {action}', { partition: graph.node(part.node).title, role: part.port, action: ACTION }),
    action: ACTION,
    values: deepFreeze(structuredClone(values)),
    rewardFrom: reward ? reward.title : null,
    truncated: !last.done,
    bundle,
  };
}

const sampleMemo = new WeakMap();
/** Example values of loop `loopId`: `{ ok: true, label, action, values: { Start, State, Transition, Episode },
 *  rewardFrom, truncated }` or `{ ok: false, reason }`. `artifacts(id) → artifact | null` gives net tools' weights.
 *  The memo holds while every artifact the sample looked up is still what `artifacts` gives. */
function sampleOf(graph, res, loopId, { artifacts = null } = {}) {
  const memo = memoIn(sampleMemo, res), hit = memo.get(loopId);
  if (hit && [...hit.seen].every(([id, a]) => (artifacts?.(id) ?? null) === a)) return hit.sample;
  const seen = new Map(), look = id => { const a = artifacts?.(id) ?? null; seen.set(id, a); return a; };
  let sample;
  try { sample = buildSample(graph, res, loopId, look); } catch (e) { sample = { ok: false, reason: messageOf(e) }; }
  const { bundle, ...shown } = sample;
  Object.defineProperty(shown, 'bundle', { value: bundle, enumerable: false });   // exampleOf reruns its programs
  memo.set(loopId, { sample: Object.freeze(shown), seen });
  return memo.get(loopId).sample;
}

/** `run()` → the example of a role called on `args`. Errors become the example's `error`. */
function runExample(sample, args, run) {
  if (!sample.ok) return { label: '', args: [], error: sample.reason };
  try { return deepFreeze({ label: sample.label, args, result: structuredClone(run()) }); }
  catch (e) { return deepFreeze({ label: sample.label, args, error: messageOf(e) }); }
}

/** Example of scenario role `role` (init / input / step) on `sample` (of the loop the scene is wired into). The
 *  bundle keys its programs by role, whatever export fills it. */
function scenarioExample(sample, role) {
  if (!sample.ok) return runExample(sample, [], null);
  const { programs, types } = sample.bundle, { Start, State } = sample.values;
  if (!programs[role]) return null;
  if (role === 'init') return runExample(sample, [Start], () => compileEntry(programs.init, [types.Start], 'init')(Start));
  if (role === 'input') return runExample(sample, [State], () => Array.from(compileEntry(programs.input, [types.State], 'input')(State)));
  return runExample(sample, [State, sample.action], () => compileEntry(programs.step, [types.State, NUMBER], 'step')(State, sample.action));
}

/** Where the role's first caller `first` — a call wire into a call port with contract `signature` — gets its example:
 *  `{ loopId, run(sample) }`, or null when its arguments are not sampled. */
function callSite(graph, res, first, signature) {
  const loop = producerOf(graph, first.node, 'loop');
  if (!loop) return null;
  const refName = p => (isRef(p) ? p.slice(1, -1) : null);
  if (!signature.params.every(p => SAMPLE_REFS.has(refName(p)) || p?.type === NUMBER.type)) return null;
  return {
    loopId: loop.node,
    run: sample => {
      if (!sample.ok) return runExample(sample, [], null);
      const args = signature.params.map(p => (isRef(p) ? sample.values[refName(p)] : sample.action));
      return runExample(sample, args, () => {
        const entry = programEntry(graph, res, first.node, first.port, first.wire), site = res.calls.get(first.wire);
        return compileEntry(entry, site.paramTypes.slice(0, site.k), entry.node.title)(...args);
      });
    },
  };
}

/** The role of `fn` of `codeId`, run where its first caller runs it: `{ loopId, run(sample) → example | null }`, or
 *  null when it has none. */
function exampleSite(graph, res, codeId, fn) {
  const role = rolesOf(graph, res, codeId).role(fn), first = role?.kind === 'function' ? role.callers[0] : null;
  if (!first) return null;
  if (first.via === 'scenario') return { loopId: first.node, run: sample => scenarioExample(sample, first.role) };
  return callSite(graph, res, first, role.signature);
}

const siteMemo = new WeakMap(), exampleMemo = new WeakMap();
/** Example call of the exported function `fn` of code module `codeId` in its role. null when it has none (no role,
 *  or arguments a sample cannot give — a table, params). Else `{ label, args, result }` or `{ label, args, error }`.
 *  `artifacts` as sampleOf. Memoised per resolution and per the sample it runs on. */
export function exampleOf(graph, res, codeId, fn, opts = {}) {
  const sites = memoIn(siteMemo, res), key = `${codeId}\u0000${fn}`;
  if (!sites.has(key)) sites.set(key, exampleSite(graph, res, codeId, fn));
  const site = sites.get(key);
  if (!site) return null;
  const sample = sampleOf(graph, res, site.loopId, opts), memo = memoIn(exampleMemo, sample);
  if (!memo.has(key)) memo.set(key, site.run(sample));
  return memo.get(key);
}
