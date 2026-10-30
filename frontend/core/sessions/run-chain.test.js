import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workspace } from '../store.js';
import { createTrainerSession } from './trainer.js';
import { createCandidatesSession } from './candidates.js';
import { createEvaluatorSession } from './evaluator.js';
import { createExecutionSession } from './execution.js';
import { createRunChain } from './run-chain.js';
import { counterGraph } from '../fixtures/counter.js';
import { counterModel } from './fixtures.js';

const result = () => ({ model: counterModel(1), evaluation: { metricName: 'return', metric: 3, selectedEpoch: 1, curves: { loss: [1] }, validation: {} }, provenance: { method: 'reinforce', backend: 'browser', seed: 1, epochs: 10, bundleHash: '0x' + '0'.repeat(64), recipe: {} } });

/** The counter task with a second stage: trainer2 starts from the accepted weights of `cands` and waits for the gate on
 *  the evaluator, whose metric is the number of steps. */
function twoStages(min) {
  const { graph, ids } = counterGraph();
  const trainer2 = graph.addNode({ kind: 'trainer', title: 'stage 2', config: { method: 'reinforce', epochs: 10 } }).id;
  const cands2 = graph.addNode({ kind: 'candidates', title: 'candidates 2' }).id;
  const value = (from, to) => graph.connect({ kind: 'value', from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } });
  value([ids.loop, 'loop'], [trainer2, 'loop']);
  value([ids.seeds, 'training'], [trainer2, 'training']);
  value([ids.seeds, 'validation'], [trainer2, 'validation']);
  value([ids.net, 'structure'], [trainer2, 'structure']);
  value([trainer2, 'run'], [cands2, 'run']);
  value([ids.cands, 'weights'], [trainer2, 'init']);
  value([ids.evaluator, 'report'], [trainer2, 'gate']);
  graph.connect({ kind: 'call', from: { node: ids.reward, port: 'reward' }, to: { node: trainer2, port: 'objective' } });
  graph.patchConfig(trainer2, { gate: { metric: graph.node(ids.steps).title, min } });
  return { graph, ids: { ...ids, trainer2, cands2 } };
}

/** The sessions of the app (graph_app.js FACTORIES) over `ws`, with a worker stand-in that finishes each run at once. */
function app(ws) {
  const calls = [], sessions = new Map(), statuses = [];
  const browser = bundle => { calls.push(bundle); return { promise: Promise.resolve().then(result), cancel() {}, runId: 'w' }; };
  const make = {
    trainer: id => createTrainerSession({ workspace: ws, nodeId: id, browser, evaluators: e => session('evaluator', e) }),
    candidates: id => createCandidatesSession({ workspace: ws, nodeId: id }),
    evaluator: id => createEvaluatorSession({ workspace: ws, nodeId: id }),
    execution: id => createExecutionSession({ workspace: ws, nodeId: id }),
  };
  function session(kind, id) { const key = `${kind}:${id}`; if (!sessions.has(key)) sessions.set(key, make[kind](id)); return sessions.get(key); }
  const chain = createRunChain({ workspace: () => ws, session, status: (text, tone) => statuses.push({ text, tone }) });
  return { calls, session, chain, statuses };
}

test('运行到这里 trains each stage that has no accepted weights, in order, accepts the selected candidate, and evaluates the gate on the way', async () => {
  const { graph, ids } = twoStages(2);
  const ws = new Workspace(graph);
  const { calls, session, chain, statuses } = app(ws);
  await chain.run(ids.cands2);
  assert.equal(statuses.at(-1).tone, 'ok', statuses.at(-1).text);
  assert.equal(calls.length, 2, 'stage 1, then stage 2');
  const first = graph.node(ids.cands).config.accepted, second = graph.node(ids.cands2).config.accepted;
  assert.ok(first && second && first !== second);
  assert.equal(calls[1].init.artifactId, first, 'stage 2 starts from the weights that the chain accepted in stage 1');
  assert.equal(session('evaluator', ids.evaluator).snapshot().stale, false, 'the gate read a fresh report');
  assert.deepEqual(statuses.map(s => s.text).filter(s => s.endsWith('…')), ['训练 trainer…', '评估 evaluator…', '训练 stage 2…']);

  // the accepted artifacts are the cache: a second chain trains nothing
  await chain.run(ids.cands2);
  assert.equal(calls.length, 2);
  // a change above stage 1 makes its artifact incompatible: the chain trains both stages again
  graph.patchConfig(ids.params, { values: { target: 2, budget: 5 } });
  await chain.run(ids.cands2);
  assert.equal(calls.length, 4);
  assert.notEqual(graph.node(ids.cands).config.accepted, first);
});

test('运行到这里 stops at a gate that does not pass, and trains nothing after it', async () => {
  const { graph, ids } = twoStages(4);                                  // counterModel(1) needs 3 steps
  const ws = new Workspace(graph);
  const { calls, chain, statuses } = app(ws);
  await chain.run(ids.cands2);
  assert.equal(calls.length, 1, 'only stage 1');
  assert.equal(graph.node(ids.cands2).config.accepted, null);
  assert.equal(statuses.at(-1).tone, 'bad');
  assert.match(statuses.at(-1).text, /stage 2 的 gate 未通过.*≥ 4/);
  assert.equal(chain.snapshot().target, null, 'the chain ends');
});

test('运行到这里 refuses a trainer whose gate reads its own candidates, and a second chain while one runs', async () => {
  const { graph, ids } = counterGraph();
  graph.connect({ kind: 'value', from: { node: ids.evaluator, port: 'report' }, to: { node: ids.trainer, port: 'gate' } });
  graph.patchConfig(ids.trainer, { gate: { metric: graph.node(ids.steps).title, min: 1 } });
  const ws = new Workspace(graph);
  const { calls, chain, statuses } = app(ws);
  const running = chain.run(ids.evaluator);
  await assert.rejects(chain.run(ids.evaluator), /正在运行/);
  await running;
  assert.equal(calls.length, 0);
  assert.match(statuses.at(-1).text, /依赖它自己/);
});

test('运行到这里 on an execution gets the weights ready, then resets and runs the episode', async () => {
  const { graph, ids } = counterGraph();
  const ws = new Workspace(graph);
  const { calls, session, chain } = app(ws);
  await chain.run(ids.execution);
  assert.equal(calls.length, 1);
  const snap = session('execution', ids.execution).snapshot();
  assert.equal(snap.error, null);
  assert.ok(snap.running || snap.done, 'the clock runs after the reset');
});

test('运行到这里 trains again when a trainer cannot tell the fit of the accepted artifact', async () => {
  const { graph, ids } = twoStages(2);
  const ws = new Workspace(graph);
  const { calls, session, chain } = app(ws);
  await chain.run(ids.cands2);
  graph.patchConfig(ids.params, { values: { target: 2, budget: 5 } });  // a new environment
  graph.patchConfig(ids.cands, { accepted: null });                      // stage 2 has no init now: its trainer has no bundle
  assert.equal(session('candidates', ids.cands2).snapshot().candidates.find(c => c.accepted).compatible.ok, null);
  await chain.run(ids.cands2);
  assert.equal(calls.length, 4, 'both stages again, the unknown fit of stage 2 is not a cache hit');
});

test('stop ends a chain at any wait — a training, an evaluation — and frees the chain for the next one', async () => {
  const never = new Promise(() => {});
  const stopAt = async (ws, target, step, sessions) => {
    const statuses = [];
    const chain = createRunChain({ workspace: () => ws, session: (kind, id) => sessions[kind] ?? createCandidatesSession({ workspace: ws, nodeId: id }), status: (text, tone) => statuses.push({ text, tone }) });
    const running = chain.run(target);
    while (!statuses.some(s => s.text.startsWith(step))) await new Promise(r => setTimeout(r, 5));
    chain.stop();
    await running;
    assert.match(statuses.at(-1).text, /工作区换了/, step);
    assert.equal(chain.snapshot().target, null);
  };
  const first = counterGraph(), ws = new Workspace(first.graph);
  await stopAt(ws, first.ids.cands, '训练', { trainer: createTrainerSession({ workspace: ws, nodeId: first.ids.trainer, browser: () => ({ promise: never, cancel() {}, runId: 'w' }) }) });
  const { graph, ids } = counterGraph(), ready = new Workspace(graph);
  await app(ready).chain.run(ids.cands);                                   // accepted through a run, as in the app
  await stopAt(ready, ids.evaluator, '评估', { evaluator: { snapshot: () => ({ role: 'test', report: null }), run: () => never } });
});
