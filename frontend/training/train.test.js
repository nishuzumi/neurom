import test from 'node:test';
import assert from 'node:assert/strict';
import { counterGraph } from '../core/fixtures/counter.js';
import { ModuleGraph } from '../core/graph.js';
import { parseTemplate, instantiateInto } from '../core/template.js';
import { buildBundle } from '../core/bundle.js';
import { trainBundle, trainingProblem } from './train.js';
import { runEpisodes, toolCaller } from '../core/loop.js';
import { createExecutor } from '../core/sessions/executor.js';
import { partitionEpisodes } from '../core/kinds/partition.js';
import { validateGreedy, always, anySet } from './run.js';
import { episodesOf } from '../core/sessions/common.js';
import { QatPolicy, rngOf } from './dense-core.js';
import { quantizeRegion } from './quantize.js';
import { ThresholdNet } from './hinge.js';
import { integerStep, denseStateWidth } from '../runtime/dense-policy.js';
import { shapedArtifact } from '../core/sessions/fixtures.js';
import { layersStep } from '../runtime/threshold-layers.js';

/** Wires every task below shares: scene → loop, loop.input → net → readout → loop.action, the trainer on the loop. */
const LOOP_WIRES = `
    - params.params→scene.params
    - split.training→trainer.training
    - split.validation→trainer.validation
    - loop.loop→trainer.loop
    - loop.input→net.in
    - net.scores→readout.scores
    - readout.action→loop.action
    - net.structure→trainer.structure`;

/** Count up to a hidden goal (enumerate episodes). target mask = [stay, up] as a function of count vs goal. LIF/FF, argmax. */
const REACH_YAML = `
format: neurom-template
id: reach-task
revision: 1
name: reach
kind: composite
modules:
  params: { kind: params, config: { fields: { budget: { type: int, min: 1, max: 20, default: 5 } } } }
  target: { kind: code, config: { source: "export function target(state) { return [state.count >= state.goal ? 1 : 0, state.count < state.goal ? 1 : 0]; }" } }
  metric: { kind: code, config: { source: "export function metric(episode) { return episode.success ? 1 : 0; }" } }
  split:
    kind: partition
    config: { kind: enumerate, enumerate: { axes: { goal: [1, 2, 3, 4] }, roles: { training: all, validation: all, test: all } } }
  scene:
    kind: code
    config:
      inputs: [params]
      source: |-
        export const budget = params.budget;
        export function init(start) { return { count: 0, goal: start.goal }; }
        export function input(state) { return concat(thermometer(state.count, [1, 2, 3, 4]), thermometer(state.goal, [1, 2, 3, 4])); }
        export function step(state, action) { const c = state.count + (action === 1 ? 1 : 0); return { state: { count: c, goal: state.goal }, done: false, success: c === state.goal }; }
  loop: { kind: loop }
  readout: { kind: readout, config: { mode: argmax, map: [0, 1] } }
  net: { kind: network, config: { inputs: 8, layers: [{ hidden: 8 }], kind: feedforward, ticks: 1, leak_shift: 0, reset: 0 } }
  trainer: { kind: trainer, config: { method: cross-entropy, epochs: 30, evalEvery: 5, lr: 0.02, replicas: 2, calibrationEpisodes: 8 } }
wires:
  value:${LOOP_WIRES}
  call:
    - scene.module→loop.scenario
    - target→trainer.objective
`;

/** 2-bit truth table (xor, and) as exact output bits. Threshold layers, bits readout, budget 1. */
const XOR_YAML = `
format: neurom-template
id: xor-task
revision: 1
name: xor
kind: composite
modules:
  params: { kind: params, config: { fields: { budget: { type: int, min: 1, max: 4, default: 1 } } } }
  target: { kind: code, config: { source: "export function target(state) { return [state.a !== state.b ? 1 : 0, state.a === 1 && state.b === 1 ? 1 : 0]; }" } }
  split:
    kind: partition
    config: { kind: enumerate, enumerate: { axes: { a: [0, 1], b: [0, 1] }, roles: { training: all, validation: all, test: all } } }
  scene:
    kind: code
    config:
      inputs: [params]
      source: |-
        export const budget = params.budget;
        export function init(start) { return { a: start.a, b: start.b, out: -1 }; }
        export function input(state) { return [state.a, state.b]; }
        export function step(state, action) { return { state: { a: state.a, b: state.b, out: action }, done: false, success: action === (state.a !== state.b ? 1 : 0) + (state.a === 1 && state.b === 1 ? 2 : 0) }; }
  loop: { kind: loop }
  readout: { kind: readout, config: { mode: bits, width: 2, decode: lsb-int } }
  net: { kind: network, config: { engine: threshold-layers, kind: feedforward, inputs: 2, layers: [6] } }
  trainer: { kind: trainer, config: { method: hinge, epochs: 400, evalEvery: 10, lr: 0.02, seed: 3 } }
wires:
  value:${LOOP_WIRES}
  call:
    - scene.module→loop.scenario
    - target→trainer.objective
`;

function graphOf(yaml) {
  const graph = new ModuleGraph();
  const { ids } = instantiateInto(graph, parseTemplate(yaml), { x: 0, y: 0 });
  return { graph, ids };
}
const counterBundle = (trainer = {}, net = {}) => {
  const { graph, ids } = counterGraph();
  graph.patchConfig(ids.trainer, { epochs: 30, evalEvery: 5, replicas: 2, episodesPerEpoch: 8, calibrationEpisodes: 8, lr: 0.02, ...trainer });
  graph.patchConfig(ids.net, net);
  return buildBundle(graph, ids.trainer);
};
const reachBundle = (trainer = {}, net = {}, wireMetric = false) => {
  const { graph, ids } = graphOf(REACH_YAML);
  graph.patchConfig(ids.trainer, trainer); graph.patchConfig(ids.net, net);
  if (wireMetric) graph.connect({ kind: 'call', from: { node: ids.metric, port: 'metric' }, to: { node: ids.trainer, port: 'metric' } });
  return buildBundle(graph, ids.trainer);
};
const xorBundle = (weightBits = 8) => { const { graph, ids } = graphOf(XOR_YAML); graph.patchConfig(ids.net, { weightBits }); return buildBundle(graph, ids.trainer); };
const TWO_LAYERS = { layers: [{ hidden: 8 }, { hidden: 6 }] };
const LIF = { kind: 'lif', ticks: 2, leak_shift: 2, reset: 0 }, FF = { kind: 'feedforward', ticks: 1, leak_shift: 0, reset: 0 };

test('reinforce learns the counter task (FF and LIF) and the exported model reproduces the reported validation metric', async () => {
  for (const kind of ['feedforward', 'lif']) {
    const bundle = counterBundle({}, kind === 'lif' ? LIF : FF);
    const { model, evaluation, provenance } = await trainBundle(bundle);
    assert.equal(model.format, 'dense-policy'); assert.equal(model.kind, kind); assert.equal(model.weightBits, 8, 'int8 by default');
    assert.ok(!('task' in model) && !('taskDefinition' in model));
    assert.equal(evaluation.metricName, 'validationMeanReturn');
    assert.ok(evaluation.metric >= 2.5, `${kind}: mean return ${evaluation.metric} < 2.5 (target 3)`);
    const again = validateGreedy(bundle, model, episodesOf(bundle.partitions.validation), {});
    assert.equal(again.meanReturn, evaluation.metric);
    assert.equal(again.successRate, evaluation.validation.successRate);
    assert.equal(provenance.method, 'reinforce'); assert.equal(provenance.backend, 'browser'); assert.match(provenance.bundleHash, /^0x[0-9a-f]{64}$/);
    assert.equal(evaluation.curves.loss.length, 30); assert.equal(evaluation.curves.metric.length, 6);
  }
});

test('each layer gets its own scale: the largest weight takes the largest code, nothing is clipped, and the training record says so per layer', async () => {
  for (const weightBits of [8, 16]) {
    const { model, evaluation } = await trainBundle(counterBundle({ epochs: 6, evalEvery: 3 }, { ...LIF, ...TWO_LAYERS, weightBits }));
    const Q = weightBits === 8 ? 127 : 32767, regions = [...model.layers, model.output];
    assert.equal(model.weightBits, weightBits);
    for (const R of regions) assert.equal(Math.max(...R.W.flat().map(Math.abs)), Q, `${weightBits}: the largest |code| of every layer is ${Q}`);
    assert.deepEqual(evaluation.quantization.map(q => q.region), ['layers[0]', 'layers[1]', 'output']);
    evaluation.quantization.forEach((q, i) => {
      assert.equal(q.clippedWeights, 0, `${weightBits} ${q.region}: no weight clipped`);
      // int8 biases have 2^15 / 127 ≈ 258 times the largest weight of headroom. int16 biases have only the own range of
      // the largest weight. So a bias beyond it is clipped and reported (the scale follows the weights, ADR 0015)
      if (weightBits === 8) assert.equal(q.clippedBiases, 0, `${q.region}: no int8 bias clipped`);
      assert.deepEqual([q.scale, q.k], [regions[i].scale, regions[i].k], 'the record describes the exported model');
    });
    model.layers.forEach((L, l) => assert.equal(L.threshold, Math.floor(L.scale * 2 ** L.k + 0.5), `layer ${l}: the LIF threshold is 1.0 in its own unit`));
  }
});

test('quantizeRegion: scale from the largest weight, k from the biases, LIF threshold 1.0 in the accumulator unit', () => {
  const W = [[0.5, -1], [0.25, 0]], b = [0.1, -0.2];
  // 8 bits: s = 127 / 1. 0.2·127·2^k ≤ 32767 up to k = 10. gain 127·1024 = 130048
  assert.deepEqual(norm(quantizeRegion(W, b, 8, 'ff')), { W: [64, -127, 32, 0], b: [13005, -26010], scale: 127, k: 10, threshold: null, clippedWeights: 0, clippedBiases: 0 });
  assert.equal(quantizeRegion(W, b, 8, 'lif').threshold, 130048);
  // 16 bits: s = 32767. 0.2·32767·2^k ≤ 32767 up to k = 2. gain 131068
  assert.deepEqual(norm(quantizeRegion(W, b, 16, 'lif')), { W: [16384, -32767, 8192, 0], b: [13107, -26214], scale: 32767, k: 2, threshold: 131068, clippedWeights: 0, clippedBiases: 0 });
  // a bias that does not fit even at k = 0 is clipped and counted. The bias of a threshold layer must leave th = 1 − b in int16
  assert.deepEqual(norm(quantizeRegion([[0.01]], [5], 8, 'ff')), { W: [127], b: [32767], scale: 12700, k: 0, threshold: null, clippedWeights: 0, clippedBiases: 1 });
  assert.deepEqual([quantizeRegion([[1]], [-1], 16, 'ff').b[0], quantizeRegion([[1]], [-1], 16, 'ff').clippedBiases], [-32767, 0]);
  assert.deepEqual([quantizeRegion([[1]], [-1], 16, 'threshold').b[0], quantizeRegion([[1]], [-1], 16, 'threshold').clippedBiases], [-32766, 1]);
  // no biases to fit: the largest shift. All-zero weights: unit 1/Q
  assert.deepEqual(norm(quantizeRegion([[0, 0]], [0], 8, 'ff')), { W: [0, 0], b: [0], scale: 127, k: 20, threshold: null, clippedWeights: 0, clippedBiases: 0 });
});
const norm = ({ W, b, scale, k, threshold, clippedWeights, clippedBiases }) => ({ W: Array.from(W), b: Array.from(b), scale, k, threshold, clippedWeights, clippedBiases });

test('the same seed reproduces the same integer model; a different seed does not', async () => {
  const a = await trainBundle(counterBundle({ epochs: 3, evalEvery: 3 }));
  const b = await trainBundle(counterBundle({ epochs: 3, evalEvery: 3 }));
  const c = await trainBundle(counterBundle({ epochs: 3, evalEvery: 3, seed: 9 }));
  assert.deepEqual(a.model, b.model);
  assert.notDeepEqual(a.model, c.model);
});

test('cross-entropy learns a target mask (FF and LIF); accuracy is measured on labelled steps of the integer executor', async () => {
  for (const kind of ['feedforward', 'lif']) {
    const bundle = reachBundle({}, kind === 'lif' ? LIF : {});
    const { model, evaluation } = await trainBundle(bundle);
    assert.equal(evaluation.metricName, 'validationAccuracy');
    assert.ok(evaluation.metric >= 0.95, `${kind}: accuracy ${evaluation.metric}`);
    const again = validateGreedy(bundle, model, episodesOf(bundle.partitions.validation), { labelled: anySet });
    assert.equal(again.accuracy, evaluation.metric);
    assert.equal(again.labelledSteps, 4 * 5);
  }
});

test('a wired selection metric replaces the default and is what the run selects on', async () => {
  const bundle = reachBundle({}, {}, true);
  assert.ok(bundle.selection?.program);
  const { evaluation, model } = await trainBundle(bundle);
  assert.equal(evaluation.metricName, 'validationMetric');
  const again = validateGreedy(bundle, model, episodesOf(bundle.partitions.validation));
  assert.equal(evaluation.metric, again.successRate);
  assert.ok(evaluation.metric >= 0.75);
});

test('hinge solves a 2-bit truth table exactly at both widths, stops early, and the integer layers reproduce it', async () => {
  for (const weightBits of [8, 16]) {
    const bundle = xorBundle(weightBits);
    const { model, evaluation, provenance } = await trainBundle(bundle);
    assert.equal(model.format, 'threshold-layers'); assert.equal(model.weightBits, weightBits);
    assert.deepEqual([model.inputs, model.outputs, model.layers.length, model.layers[0].W.length, model.layers[1].W.length], [2, 2, 2, 6, 2]);
    assert.equal(evaluation.metric, 1);
    assert.ok(evaluation.selection.epochsRun < 400);
    assert.ok(evaluation.quantization.every(q => q.clippedWeights === 0), 'no weight clipped');
    const again = validateGreedy(bundle, model, episodesOf(bundle.partitions.validation), { labelled: always });
    assert.equal(again.accuracy, 1); assert.equal(again.successRate, 1);
    assert.equal(provenance.method, 'hinge');
  }
});

test('the hinge forward pass is the runtime threshold layers at both widths: every activation and score', () => {
  for (const weightBits of [8, 16]) {
    const net = new ThresholdNet([4, 9, 5, 3], 2, weightBits), rng = rngOf(5);
    for (const L of net.L) for (let j = 0; j < L.n; j++) L.b[j] = (rng() - 0.5) * 0.6;
    const q = net.quantized(), { model } = net.export(4, 3);
    assert.ok(model.layers.every(L => L.k > 0), 'every layer shifts its sum');
    for (let n = 0; n < 16; n++) {
      const x = [0, 1, 2, 3].map(i => (n >> i) & 1), { acts, zs } = net.forward(x, q), step = layersStep(model, x);
      assert.deepEqual(step.acts.slice(0, -1), acts.slice(1, -1).map(a => Array.from(a)), `int${weightBits} ${n}: hidden activations`);
      assert.deepEqual(step.scores.map(s => s >= 0), Array.from(zs.at(-1), z => z > 0), `int${weightBits} ${n}: output bits`);
      assert.deepEqual(step.scores, Array.from(zs.at(-1), z => Math.round(z * q.at(-1).gain) - 1), `int${weightBits} ${n}: scores = QAT sum − 1`);
    }
  }
});

test('hinge honours the recipe surrogateWidth and gradClip', async () => {
  const bundle = xorBundle(), short = { ...bundle.recipe, epochs: 5, evalEvery: 5 };
  const lossOf = async recipe => (await trainBundle({ ...bundle, recipe: { ...short, ...recipe } })).evaluation.curves.loss;
  const base = await lossOf({});
  assert.deepEqual(await lossOf({}), base);
  assert.notDeepEqual(await lossOf({ gradClip: 1e-9 }), base);                       // Adam is scale-free: only a clip near eps shows in 5 epochs
  assert.notDeepEqual(await lossOf({ surrogateWidth: 0.25 }), base);
});

test('method requirements are checked before any training happens', async () => {
  const dense = counterBundle();
  assert.match(trainingProblem({ ...dense, recipe: { ...dense.recipe, method: 'hinge' } }), /threshold-layers/);
  assert.match(trainingProblem({ ...dense, recipe: { ...dense.recipe, method: 'cross-entropy' } }), /target/);
  const readoutId = Object.keys(dense.loop.nodes).find(id => dense.loop.nodes[id].kind === 'readout');
  const bitsReadout = { ...dense.loop, nodes: { ...dense.loop.nodes, [readoutId]: { ...dense.loop.nodes[readoutId], readout: { mode: 'bits', width: 2, decode: 'lsb-int' } } } };
  assert.match(trainingProblem({ ...dense, loop: bitsReadout }), /argmax/);
  assert.match(trainingProblem({ ...dense, loop: { ...dense.loop, trained: null } }), /要训练的网络/);
  assert.match(trainingProblem({ ...dense, partitions: {} }), /training/);
  assert.equal(trainingProblem(dense), '');
  const reach = reachBundle();
  assert.match(trainingProblem({ ...reach, recipe: { ...reach.recipe, method: 'reinforce' } }), /reward/);
  await assert.rejects(trainBundle({ ...dense, format: 'nope' }), /neurom-bundle/);
});

test('bundles whose BPTT tape exceeds the browser budget are refused before training starts', async () => {
  const bundle = counterBundle({ replicas: 64, episodesPerEpoch: 4096 }, { kind: 'lif', layers: [{ hidden: 256 }], ticks: 64, leak_shift: 2, reset: 0 });
  let reported = 0;
  await assert.rejects(trainBundle(bundle, { onProgress: () => { reported++; } }), /超出浏览器预算/);
  assert.equal(reported, 0);
});

test('two-layer dense nets (FF and LIF) train by REINFORCE and cross-entropy; the exported model replays the reported metric', async () => {
  for (const kind of ['feedforward', 'lif']) {
    const shape = { ...(kind === 'lif' ? LIF : FF), ...TWO_LAYERS };
    const rl = counterBundle({}, shape), trained = await trainBundle(rl);
    assert.deepEqual(trained.model.layers.map(L => L.hidden), [8, 6]);
    assert.ok(trained.evaluation.metric >= 2.5, `${kind} reinforce: mean return ${trained.evaluation.metric} < 2.5 (target 3)`);
    assert.equal(validateGreedy(rl, trained.model, episodesOf(rl.partitions.validation), {}).meanReturn, trained.evaluation.metric);
    const ce = reachBundle({}, shape), learnt = await trainBundle(ce);
    assert.ok(learnt.evaluation.metric >= 0.95, `${kind} cross-entropy: accuracy ${learnt.evaluation.metric}`);
    assert.equal(validateGreedy(ce, learnt.model, episodesOf(ce.partitions.validation), { labelled: anySet }).accuracy, learnt.evaluation.metric);
  }
});

/** Nonzero shadows everywhere (init leaves head and output biases 0), so every region's k and bias are exercised. */
function jitter(policy, rng) { for (const p of policy.p) for (let k = 0; k < p.length; k++) p[k] += (rng() - 0.5) * 0.2; policy.quantize(); }

test('the trainer forward pass of a two-layer net is the runtime integer step at both widths: scores, counts and voltages over an episode', () => {
  for (const weightBits of [8, 16]) for (const kind of ['feedforward', 'lif']) {
    const label = `${kind} int${weightBits}`;
    const structure = { kind, inputs: 5, outputs: 3, weightBits, ...(kind === 'lif' ? { ...LIF, ticks: 3 } : FF), layers: [{ hidden: 7 }, { hidden: 4 }] };
    const policy = new QatPolicy(structure, 1), rng = rngOf(3);
    policy.init(rng);
    const inputs = Array.from({ length: 12 }, () => Array.from({ length: 5 }, () => (rng() < 0.5 ? 1 : 0)));
    policy.calibrateBias(Uint8Array.from(inputs.flat()), inputs.length, 0.5);
    jitter(policy, rng);
    const model = policy.export(), V = new Float64Array(policy.state), voltage = new Array(denseStateWidth(model)).fill(0);
    assert.ok([...model.layers, model.output].some(R => R.k > 0), `${label}: some layer shifts its sum`);
    let fired = 0;
    for (const x of inputs) {
      if (kind === 'feedforward') V.fill(0);
      const rec = policy.decide(1, Uint8Array.from(x), V), step = integerStep(model, x, voltage);
      assert.deepEqual(Array.from(rec.scores), step.scores, label);
      assert.deepEqual(rec.layers.flatMap(L => Array.from(L.counts)), step.count, label);
      if (kind === 'lif') assert.deepEqual(Array.from(V), voltage, label);
      fired += step.count.slice(7).reduce((s, c) => s + c, 0);
    }
    assert.ok(fired > 0, `${label}: the second layer fires`);
  }
});

/** A tool for the forward-pass comparison: choice 0 → [d0 | d1, 1], choice 1 → [d0 & d2] (zero-extended). */
const toolFn = (_port, choice, data) => (choice ? [data[0] & data[2]] : [data[0] | data[1], 1]);
const TOOL = { tools: 'tools', K: 2, D: 3, R: 2 };

test('the trainer forward pass of a tool-layer net is the runtime integer step at both widths: scores, counts, voltages and tool decisions', () => {
  const shapes = { between: [{ hidden: 7 }, TOOL, { hidden: 4 }], trailing: [{ hidden: 7 }, TOOL], first: [TOOL, { hidden: 4 }] };
  for (const weightBits of [8, 16]) for (const kind of ['feedforward', 'lif']) {
    for (const [name, layers] of Object.entries(shapes)) {
      const trailing = name === 'trailing', label = `${kind} ${name} int${weightBits}`;
      const structure = { kind, inputs: 5, outputs: trailing ? 2 : 3, weightBits, ...(kind === 'lif' ? { ...LIF, ticks: 3 } : FF), layers };
      const policy = new QatPolicy(structure, 1), rng = rngOf(2);
      policy.init(rng);
      const inputs = Array.from({ length: 16 }, () => Array.from({ length: 5 }, () => (rng() < 0.5 ? 1 : 0)));
      policy.calibrateBias(Uint8Array.from(inputs.flat()), inputs.length, 0.5, { call: toolFn, rng });
      jitter(policy, rng);
      const model = policy.export(), V = new Float64Array(policy.state), voltage = new Array(denseStateWidth(model)).fill(0), choices = new Set();
      assert.equal('output' in model, !trailing, label);
      for (const x of inputs) {
        if (kind === 'feedforward') V.fill(0);
        const rec = policy.decide(1, Uint8Array.from(x), V, null, { call: toolFn }), step = integerStep(model, x, voltage, toolFn), d = rec.decisions[0];
        assert.deepEqual(Array.from(rec.scores), step.scores, label);
        assert.deepEqual(rec.layers.flatMap(L => Array.from(L.counts)), step.count, label);
        assert.deepEqual({ choice: d.choice[0], data: Array.from(d.data), result: Array.from(d.result) }, step.tools.tools, label);
        if (kind === 'lif') assert.deepEqual(Array.from(V), voltage, label);
        choices.add(d.choice[0]);
      }
      assert.equal(choices.size, 2, `${label}: both tools are chosen on some input`);
    }
  }
});

/** Two LIF counter tools (2 bits → [fired, 1]. One neuron adds data bit 0 or bit 1 and fires at 2). They remember between calls. */
const counterTool = bit => ({ kind: 'net', readout: { mode: 'bits', width: 2, decode: 'lsb-int' },
  structure: { engine: 'dense-policy', kind: 'lif', inputs: 2, outputs: 2, weightBits: 8, layers: [{ hidden: 1 }], ticks: 1, leak_shift: 10, reset: 0 },
  model: { format: 'dense-policy', kind: 'lif', inputs: 2, outputs: 2, weightBits: 8, ticks: 1, leak_shift: 10, reset: 0,
    layers: [{ hidden: 1, W: [bit ? [0, 1] : [1, 0]], b: [0], scale: 1, k: 0, threshold: 2 }], output: { W: [[1], [0]], b: [-1, 0], scale: 1, k: 0 } } });

test('the trainer forward pass with stateful tools: each lane advances its own tools\' states, as one executor per session does', () => {
  for (const kind of ['feedforward', 'lif']) {
    const structure = { kind, inputs: 5, outputs: 3, weightBits: 8, ...(kind === 'lif' ? { ...LIF, ticks: 3 } : FF), layers: [{ hidden: 7 }, TOOL, { hidden: 4 }] };
    const policy = new QatPolicy(structure, 1), rng = rngOf(8), node = { structure, tools: { tools: [counterTool(0), counterTool(1)] } };
    const box = toolCaller('net', node), lanes = [new Array(box.width).fill(0), new Array(box.width).fill(0)];
    policy.init(rng);
    const inputs = Array.from({ length: 24 }, () => Array.from({ length: 5 }, () => (rng() < 0.5 ? 1 : 0)));
    policy.calibrateBias(Uint8Array.from(inputs.flat()), inputs.length, 0.5, { call: (port, choice, data) => box.call(port, choice, data, new Array(box.width).fill(0)), rng });
    jitter(policy, rng);
    const model = policy.export(), execs = [0, 1].map(() => createExecutor(model, null, { tools: box })), V = new Float64Array(2 * policy.state), seen = new Set();
    for (let t = 0; t + 1 < inputs.length; t += 2) {
      if (kind === 'feedforward') V.fill(0);
      const rec = policy.decide(2, Uint8Array.from([...inputs[t], ...inputs[t + 1]]), V, null, { call: (port, choice, data, b) => box.call(port, choice, data, lanes[b]) });
      [0, 1].forEach(b => {
        const step = execs[b].step(inputs[t + b]);
        assert.deepEqual(Array.from(rec.scores.subarray(3 * b, 3 * b + 3)), step.scores, `${kind} lane ${b} step ${t}`);
        assert.deepEqual(lanes[b], step.voltages.slice(-2), `${kind} lane ${b} step ${t}: the tools' states, after the executor's own potentials`);
        seen.add(lanes[b].join(','));
      });
    }
    assert.ok(seen.size > 2, `${kind}: the tools' states move`);
  }
});

/** The correct gate depends on the selector bit s. The gate reads a, b as its 2 data bits, and the network must copy
 *  them from its input: answer = s ? a OR b : a AND b. Tools: code AND, code OR. A trailing tool layer (its result bit
 *  is the action). Reward 1 for the right answer. */
const GATE_YAML = `
format: neurom-template
id: gate-task
revision: 1
name: gate
kind: composite
modules:
  reward: { kind: code, config: { source: "export function reward(transition) { return transition.success ? 1 : 0; }" } }
  split:
    kind: partition
    config: { kind: enumerate, enumerate: { axes: { s: [0, 1], a: [0, 1], b: [0, 1] }, roles: { training: all, validation: all, test: all } } }
  scene:
    kind: code
    config:
      inputs: [params]
      source: |-
        export const budget = 1;
        export function init(start) { return { s: start.s, a: start.a, b: start.b }; }
        export function input(state) { return [state.s, state.a, state.b]; }
        export function step(state, action) { return { state, done: true, success: action === (state.s === 1 ? (state.a + state.b > 0 ? 1 : 0) : state.a * state.b) }; }
  and: { kind: code, config: { source: "export function and(data) { return bits(at(data, 0) * at(data, 1), 1); }" } }
  or: { kind: code, config: { source: "export function or(data) { return bits(at(data, 0) + at(data, 1) > 0 ? 1 : 0, 1); }" } }
  loop: { kind: loop }
  readout: { kind: readout, config: { mode: bits, width: 1, decode: lsb-int } }
  net: { kind: network, config: { inputs: 3, layers: [{ hidden: 8 }, { tools: tools, data: 2 }], kind: feedforward, ticks: 1, leak_shift: 0, reset: 0 } }
  params: { kind: params, config: { fields: {} } }
  trainer: { kind: trainer, config: { method: reinforce, epochs: 60, evalEvery: 10, lr: 0.05, replicas: 8, calibrationEpisodes: 8 } }
wires:
  value:${LOOP_WIRES}
  call:
    - scene.module→loop.scenario
    - reward→trainer.objective
    - and.and→net.tools
    - or.or→net.tools
`;

test('REINFORCE through a tool layer: it learns which tool to call and which bits to hand it (FF and LIF); the executor replays its decisions', async () => {
  for (const kind of ['feedforward', 'lif']) {
    const { graph, ids } = graphOf(GATE_YAML);
    if (kind === 'lif') graph.patchConfig(ids.net, { ...LIF, ticks: 3 });
    const bundle = buildBundle(graph, ids.trainer);
    assert.equal(trainingProblem(bundle), '');
    const { model, evaluation } = await trainBundle(bundle);
    assert.deepEqual(model.layers.map(L => L.tools ?? L.hidden), [8, 'tools']); assert.ok(!('output' in model));
    const test = runEpisodes(bundle, { models: { [ids.net]: model }, episodes: partitionEpisodes(graph.node(ids.split).config, 'test'), trace: true });
    const success = test.filter(r => r.success).length / test.length;
    assert.ok(success >= 0.95, `${kind}: greedy success ${success} on the test partition`);
    assert.equal(evaluation.metric, test.reduce((s, r) => s + r.return, 0) / test.length, 'the reported validation return is what the executor replays');
    for (const r of test) {
      const { s, a, b } = r.start, { choice, data } = r.trace[0].tools[ids.net].tools;
      if (a !== b) assert.equal(choice, s ? 1 : 0, `${kind} ${s}${a}${b}: AND (0) for s = 0, OR (1) for s = 1`);
      assert.equal(data.length, 2);
    }
  }
  const { graph, ids } = graphOf(GATE_YAML);
  for (const method of ['cross-entropy', 'hinge']) {
    const bundle = buildBundle(graph, ids.trainer);
    assert.equal(trainingProblem({ ...bundle, recipe: { ...bundle.recipe, method } }), '带工具层的网络只能用强化学习训练', method);
  }
});

test('REINFORCE with a reward reading transition.loop: the bonus for handing a‖b enters the returns, the executor replays them', async () => {
  const yaml = GATE_YAML.replace('net: { kind: network, config:', 'net: { kind: network, title: 门, config:')
    .replace('"export function reward(transition) { return transition.success ? 1 : 0; }"',
      '"export function reward(transition) { const d = transition.loop.门.tools.data; return (transition.success ? 1 : 0) + (at(d, 0) === transition.prev.a && at(d, 1) === transition.prev.b ? 1 : 0); }"');
  const { graph, ids } = graphOf(yaml);
  const bundle = buildBundle(graph, ids.trainer);
  assert.equal(trainingProblem(bundle), '');
  const { model, evaluation } = await trainBundle(bundle);
  const returns = evaluation.curves.trainReturn;
  assert.ok(returns.at(-1) > 1.5, `the sampled decisions earn the bonus: final train return ${returns.at(-1)} (success alone is at most 1)`);
  const test = runEpisodes(bundle, { models: { [ids.net]: model }, episodes: partitionEpisodes(graph.node(ids.split).config, 'validation'), trace: true });
  assert.equal(evaluation.metric, test.reduce((s, r) => s + r.return, 0) / test.length, 'validation returns are what the executor replays, bonus included');
  for (const r of test) {
    const { data } = r.trace[0].tools[ids.net].tools, bonus = data[0] === r.start.a && data[1] === r.start.b ? 1 : 0;
    assert.equal(r.return, (r.success ? 1 : 0) + bonus);
  }
  assert.ok(test.every(r => r.return === 2), 'the greedy policy hands a‖b and answers right');
});

const LIF_OR_ID = '0x' + 'e'.repeat(64), NESTED_OR_ID = '0x' + 'f'.repeat(64);
/** The gate task with OR as a network with a tool layer of its own (ORN: 2 bits → its one tool on them). Its tool is a
 *  LIF network that computes a OR b (one neuron that fires at 1). → `{ graph, ids, artifacts }`. */
function nestedGate() {
  const { graph, ids } = graphOf(GATE_YAML);
  const add = (kind, title, config) => graph.addNode({ kind, title, config });
  const wire = (kind, a, p, b, q) => graph.connect({ kind, from: { node: a, port: p }, to: { node: b, port: q } });
  graph.disconnect(graph.producers(ids.net, 'tools').find(p => p.node === ids.or).wire.id);
  const lifOr = add('network', 'LIF OR', { engine: 'dense-policy', kind: 'lif', inputs: 2, layers: [{ hidden: 1 }], ticks: 1, leak_shift: 10, reset: 0, artifact: LIF_OR_ID });
  const orn = add('network', 'ORN', { engine: 'dense-policy', ...FF, inputs: 2, layers: [{ tools: 'tools', data: 2 }], artifact: NESTED_OR_ID });
  const lifOrR = add('readout', 'lifOrR', { mode: 'bits', width: 1, decode: 'lsb-int' }), ornR = add('readout', 'ornR', { mode: 'bits', width: 1, decode: 'lsb-int' });
  wire('value', lifOr.id, 'scores', lifOrR.id, 'scores'); wire('call', lifOrR.id, 'run', orn.id, 'tools');
  wire('value', orn.id, 'scores', ornR.id, 'scores'); wire('call', ornR.id, 'run', ids.net, 'tools');
  const unit = { scale: 1, k: 0 };
  const lifModel = { format: 'dense-policy', kind: 'lif', inputs: 2, outputs: 1, weightBits: 8, ticks: 1, leak_shift: 10, reset: 0, layers: [{ hidden: 1, W: [[1, 1]], b: [0], ...unit, threshold: 1 }], output: { W: [[1]], b: [-1], ...unit } };
  const ornModel = { format: 'dense-policy', inputs: 2, outputs: 1, weightBits: 8, ...FF, layers: [{ tools: 'tools', K: 1, D: 2, R: 1, Wc: [[0, 0]], bc: [0], Wd: [[1, 0], [0, 1]], bd: [0, 0], scale_c: 1, k_c: 0, scale_d: 1, k_d: 0 }] };
  const artifacts = id => {
    if (id === LIF_OR_ID) return shapedArtifact(graph, lifOr.id, lifModel);
    if (id !== NESTED_OR_ID) return null;
    const a = shapedArtifact(graph, orn.id, ornModel);
    a.bundle.loop.nodes.net.tools = { tools: [{ kind: 'net', artifactId: LIF_OR_ID }] };
    return a;
  };
  return { graph, ids, artifacts };
}

test('REINFORCE through a nested network tool (FF and LIF policies): OR is a network calling a LIF network; the executor replays its decisions', async () => {
  for (const kind of ['feedforward', 'lif']) {
    const { graph, ids, artifacts } = nestedGate();
    if (kind === 'lif') graph.patchConfig(ids.net, { ...LIF, ticks: 3 });
    const bundle = buildBundle(graph, ids.trainer, { artifacts }), orn = bundle.loop.nodes[ids.net].tools.tools[1];
    assert.deepEqual([orn.kind, orn.tools.tools[0].structure.kind], ['net', 'lif'], 'the bundle carries the tool\'s own LIF tool');
    assert.equal(trainingProblem(bundle), '');
    const { model, evaluation } = await trainBundle(bundle);
    const test = runEpisodes(bundle, { models: { [ids.net]: model }, episodes: partitionEpisodes(graph.node(ids.split).config, 'test'), trace: true });
    const success = test.filter(r => r.success).length / test.length;
    assert.ok(success >= 0.95, `${kind}: greedy success ${success} on the test partition`);
    assert.equal(evaluation.metric, test.reduce((s, r) => s + r.return, 0) / test.length, 'the reported validation return is what the executor replays');
    for (const r of test) if (r.start.a !== r.start.b) assert.equal(r.trace[0].tools[ids.net].tools.choice, r.start.s ? 1 : 0, `${kind}: AND (0) for s = 0, the nested OR (1) for s = 1`);
  }
});

test('cancellation rejects with AbortError and stops reporting', async () => {
  let reports = 0, cancelled = false;
  await assert.rejects(
    trainBundle(counterBundle({ epochs: 200, evalEvery: 1 }), { onProgress: () => { reports++; }, isCancelled: () => { if (reports >= 3) cancelled = true; return cancelled; } }),
    error => error.name === 'AbortError');
  const seen = reports;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reports, seen);
  await assert.rejects(trainBundle(counterBundle(), { isCancelled: () => true }), error => error.name === 'AbortError');
});
