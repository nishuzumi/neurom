import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExecutor, modelProblem } from './executor.js';
import { layersStep } from '../../runtime/threshold-layers.js';
import { integerStep } from '../../runtime/dense-policy.js';
import { counterModel, counterArtifact } from './fixtures.js';
import { trainedOf } from '../loop.js';

const unit = layer => ({ ...layer, scale: 1, k: 0 });
const threshold = { format: 'threshold-layers', inputs: 2, outputs: 1, weightBits: 8, layers: [{ W: [[1, 1], [1, -1]], th: [2, 1] }, { W: [[1, 1]], th: [1] }].map(unit) };
/** AND / A-and-not-B, then OR / copy of AND, then "OR and not AND" on top: two hidden layers. */
const deep = { format: 'threshold-layers', inputs: 2, outputs: 1, weightBits: 8, layers: [{ W: [[1, 1], [1, -1]], th: [2, 1] }, { W: [[1, 1], [1, 0]], th: [1, 1] }, { W: [[1, -1]], th: [0] }].map(unit) };

test('threshold layers: AND / A-and-not-B first layer, OR on top', () => {
  assert.deepEqual(layersStep(threshold, [1, 1]), { scores: [0], acts: [[1, 0], [1]] });
  assert.deepEqual(layersStep(threshold, [1, 0]), { scores: [0], acts: [[0, 1], [1]] });
  assert.deepEqual(layersStep(threshold, [0, 1]), { scores: [-1], acts: [[0, 0], [0]] });
  const e = createExecutor(threshold);
  assert.deepEqual(e.step([1, 0]), { scores: [0], counts: [0, 1], voltages: [], tools: null });
  assert.equal(e.stateful, false);
  assert.throws(() => e.step([1, 2]), /0\/1/);
  assert.throws(() => e.step([1]), /2 个/);
});

test('threshold counts are what ThresholdLayersEngine reports: the activations of every hidden layer, concatenated in layer order', () => {
  const e = createExecutor(deep);
  assert.deepEqual(e.step([1, 0]), { scores: [1], counts: [0, 1, 1, 0], voltages: [], tools: null });
  assert.deepEqual(e.step([1, 1]), { scores: [0], counts: [1, 0, 1, 1], voltages: [], tools: null });
  assert.deepEqual(e.step([0, 0]).counts, [0, 0, 0, 0]);
});

test('dense LIF: state persists across steps, peek decides from it without moving it, reset returns to rest; the network structure must fit the model', async () => {
  const base = counterModel(1), model = { ...base, layers: base.layers.map(layer => ({ ...layer, threshold: 3 })) };
  const e = createExecutor(model);
  const v = new Array(8).fill(0);
  const a = e.step([1, 1, 1]), ra = integerStep(model, [1, 1, 1], v);
  assert.deepEqual(a.scores, ra.scores); assert.deepEqual(a.voltages, v); assert.deepEqual(a.counts, ra.count);
  const after = e.voltages(), peeked = e.peek([1, 1, 1]);
  assert.deepEqual(e.voltages(), after, 'peek leaves the state where it was');
  const b = e.step([1, 1, 1]), rb = integerStep(model, [1, 1, 1], v);
  assert.deepEqual(b.voltages, v, 'second step continues from the first');
  assert.deepEqual(peeked, b, 'peek is the decision the next step makes');
  e.reset();
  assert.deepEqual(e.voltages(), new Array(8).fill(0));
  assert.deepEqual(e.step([1, 1, 1]).scores, a.scores);
  const { artifact } = await counterArtifact(), structure = trainedOf(artifact.bundle.loop).structure;
  assert.equal(modelProblem(artifact.model, structure), '');
  assert.match(modelProblem(counterModel(1, { hidden: 4 }), structure), /网络结构/);
  assert.match(modelProblem({ format: 'csr' }), /未知/);
  assert.match(modelProblem({ ...threshold, layers: [threshold.layers[0]] }), /最后一层/);
  assert.equal(modelProblem(threshold, { engine: 'threshold-layers', inputs: 2, outputs: 1, weightBits: 8, layers: [2] }), '');
  assert.match(modelProblem(threshold, { engine: 'threshold-layers', inputs: 2, outputs: 1, weightBits: 8, layers: [3] }), /层宽/);
  assert.match(modelProblem(threshold, { engine: 'threshold-layers', inputs: 2, outputs: 1, weightBits: 16, layers: [2] }), /16 位/);
  void rb;
});
