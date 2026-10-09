import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoop, createLockstep, runEpisodes, trainedOf, INPUT } from './loop.js';
import { buildBundle } from './bundle.js';
import { counterGraph } from './fixtures/counter.js';
import { counterModel } from './sessions/fixtures.js';

const IN = { node: INPUT, port: 'bits' };
const ref = (node, port) => ({ node, port });
/** A threshold network whose outputs copy the input bits `picks` (one per output). */
function copier(inputs, picks) {
  const row = i => Array.from({ length: inputs }, (_, k) => (k === i ? 1 : 0));
  const model = { format: 'threshold-layers', inputs, outputs: picks.length, weightBits: 8, layers: [{ W: picks.map(row), th: picks.map(() => 1), scale: 1, k: 0 }, { W: picks.map((_, j) => picks.map((__, k) => (k === j ? 1 : 0))), th: picks.map(() => 1), scale: 1, k: 0 }] };
  return { kind: 'network', structure: { engine: 'threshold-layers', kind: 'feedforward', inputs, outputs: picks.length, weightBits: 8, layers: [picks.length] }, in: IN, model, artifactId: null };
}
const argmax = scores => ({ kind: 'readout', readout: { mode: 'argmax', map: [0, 1], width: 2 }, scores });
const bitsReadout = (width, scores) => ({ kind: 'readout', readout: { mode: 'bits', width, decode: 'lsb-int' }, scores });
const trainedNet = input => ({ kind: 'network', structure: { engine: 'dense-policy', kind: 'feedforward', inputs: 2, outputs: 2, weightBits: 8, layers: [{ hidden: 4 }], ticks: 1, leak_shift: 0, reset: 0 }, in: input, model: null, artifactId: null });
/** The counter task (3 input bits: thermometer of the count, up to 3 within 5 steps, reward 1 per up) on loop `section`. */
const counterOn = section => { const { graph, ids } = counterGraph(); return { ...buildBundle(graph, ids.trainer), loop: section }; };
/** The counter task trained by cross-entropy on the target `source` (its count as 2 bits unless given). */
function targetCounter(source = 'export function target(state) {\n  return bits(state.count, 2);\n}') {
  const { graph, ids } = counterGraph();
  graph.patchConfig(ids.trainer, { method: 'cross-entropy' });
  graph.patchConfig(ids.net, { kind: 'feedforward', ticks: 1, leak_shift: 0, reset: 0 });
  graph.disconnect(graph.producers(ids.trainer, 'objective')[0].wire.id);
  const target = graph.addNode({ kind: 'code', title: 'target', config: { source } });
  graph.connect({ kind: 'call', from: { node: target.id, port: 'target' }, to: { node: ids.trainer, port: 'objective' } });
  return buildBundle(graph, ids.trainer);
}

test('lockstep: decide gets the trained network\'s input bits through a frozen upstream network, on the live lanes only', () => {
  // frozen: copies input bits 2 and 0. trained: reads those bits, and its argmax readout is the loop's action
  const bundle = counterOn({ I: 3, action: ref('tR', 'action'), trained: 't', nodes: { f: copier(3, [2, 0]), fR: bitsReadout(2, ref('f', 'scores')), t: trainedNet(ref('fR', 'bits')), tR: argmax(ref('t', 'scores')) } });
  const calls = [], seen = [];
  const out = createLockstep(bundle).run([{ seed: 1 }, { seed: 2 }], {
    decide(x, lanes, y) { calls.push([Array.from(x), Array.from(lanes), y]); return [{ slot: 1 }, { scores: [5, 1] }]; },   // lane 0 counts up, lane 1 stays
    onStep(steps) { seen.push(steps.map(s => s && [s.action, s.reward, s.transition.done, [...s.ran].sort(), s.values['fR.bits']])); },
  });
  assert.equal(out, undefined, 'a run with decide reports through decide and onStep only');
  assert.deepEqual(calls, [
    [[0, 0, 0, 0], [1, 1], null], [[0, 1, 0, 0], [1, 1], null], [[0, 1, 0, 0], [1, 1], null],   // the thermometer's bits 2, 0. No target objective
    [[0, 0, 0, 0], [0, 1], null], [[0, 0, 0, 0], [0, 1], null],                                  // lane 0 reached the count: it takes no decision
  ]);
  const ran = ['f', 'fR', 't', 'tR'];
  assert.deepEqual(seen, [
    [[1, 1, false, ran, [0, 0]], [0, 0, false, ran, [0, 0]]], [[1, 1, false, ran, [0, 1]], [0, 0, false, ran, [0, 0]]],
    [[1, 1, true, ran, [0, 1]], [0, 0, false, ran, [0, 0]]], [null, [0, 0, false, ran, [0, 0]]], [null, [0, 0, true, ran, [0, 0]]],
  ], 'a slot is mapped by the readout, scores are decoded by it; the reward reads the step\'s Transition; lane 1 is truncated by the budget');
  assert.throws(() => createLockstep(bundle).run([{ seed: 1 }]), /没有模型/, 'without decide the trained network runs on its model');
});

test('lockstep: the target is read on the state before the step, with decide and greedily, and must be 0/1 bits', () => {
  const bundle = targetCounter(), ys = [];
  createLockstep(bundle).run([{ seed: 1 }], { decide(x, lanes, y) { ys.push(Array.from(y)); return [{ slot: 1 }]; } });
  assert.deepEqual(ys, [[0, 0], [1, 0], [0, 1]], 'counts 0, 1, 2: the states the decisions are taken on');
  const greedy = [], model = counterModel(1, { kind: 'feedforward' });
  runEpisodes(bundle, { models: { [bundle.loop.trained]: model }, episodes: [{ seed: 1 }], onStep: steps => greedy.push(Array.from(steps[0].target)) });
  assert.deepEqual(greedy, ys);
  const loose = targetCounter('export function target(state) {\n  return [state.count, 0];\n}');
  assert.throws(() => createLockstep(loose).run([{ seed: 1 }], { decide: () => [{ slot: 1 }] }), /0\/1/, 'count 2 is not a bit');
});

test('lockstep: a step that does not demand the trained network takes no decision and still finishes', () => {
  const bundle = counterOn({ I: 3, action: ref('fA', 'action'), trained: 't', nodes: { f: copier(3, [2, 0]), fA: argmax(ref('f', 'scores')), g: copier(3, [0, 1]), gR: bitsReadout(2, ref('g', 'scores')), t: trainedNet(ref('gR', 'bits')), tR: argmax(ref('t', 'scores')) } });
  let decided = 0, steps = 0;
  createLockstep(bundle).run([{ seed: 1 }], { decide() { decided++; return []; }, onStep([s]) { steps++; assert.deepEqual([...s.ran].sort(), ['f', 'fA']); assert.equal(s.target, null); } });
  assert.deepEqual([decided, steps], [0, 5], 'the frozen network stays every step; the episode is truncated by the budget');
});

test('a network read by two readouts is refused by the executor and as the trained network', () => {
  const section = { I: 3, action: ref('tR', 'action'), trained: 't', nodes: { f: copier(3, [2, 0]), fR: bitsReadout(2, ref('f', 'scores')), t: trainedNet(ref('fR', 'bits')), tR: argmax(ref('t', 'scores')), tR2: argmax(ref('t', 'scores')) } };
  assert.throws(() => createLoop(section), /不止一个读出/);
  assert.throws(() => trainedOf(section), /不止一个读出/);
});
