import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readout, readoutBits, decodeBits, readoutProblem, INVALID_ACTION } from './readout.js';
import { toolCaller } from './loop.js';

test('argmax: first maximum wins ties, bits are one-hot, the map picks the physical action', () => {
  const spec = { mode: 'argmax', map: [3, 1, 1, null] };
  assert.deepEqual(readout(spec, [5, 5, 5, 5]), { action: 3, bits: [1, 0, 0, 0], slot: 0 });
  assert.deepEqual(readout(spec, [-2, 7, 7, 0]), { action: 1, bits: [0, 1, 0, 0], slot: 1 });
  assert.deepEqual(readout(spec, [-9, -9, -9, -1]), { action: INVALID_ACTION, bits: [0, 0, 0, 1], slot: 3 });
  assert.throws(() => readoutBits(spec, [1, 2]), /4 个分数/);
});

test('argmax run: its network forward, then the one-hot of the first maximum — the same rule as the chain\'s argmax', () => {
  // threshold layers 2 → 3, scores [a, a, b]: ties between slots 0 and 1, or all three
  const model = { format: 'threshold-layers', inputs: 2, outputs: 3, weightBits: 8, layers: [{ W: [[1, 0], [1, 0], [0, 1]], th: [0, 0, 0], scale: 1, k: 0 }] };
  const tool = { kind: 'net', structure: { engine: 'threshold-layers', inputs: 2, outputs: 3, layers: [], weightBits: 8 }, model, readout: { mode: 'argmax', map: [null, 4, 1], width: 3 } };
  const run = data => toolCaller('host', { structure: { layers: [{ tools: 't', K: 1, D: 2, R: 3 }] }, tools: { t: [tool] } }).call('t', 0, data, []);
  assert.deepEqual(run([0, 0]), [1, 0, 0], 'scores [0, 0, 0]: the lowest index');
  assert.deepEqual(run([1, 0]), [1, 0, 0], 'scores [1, 1, 0]: the lowest index');
  assert.deepEqual(run([0, 1]), [0, 0, 1], 'scores [0, 0, 1]');
  assert.deepEqual(run([1, 1]), [1, 0, 0], 'the map does not change the bits: a null slot is still one of them');
});

test('bits: score ≥ 0 → 1 (zero counts), lsb-int decode', () => {
  const spec = { mode: 'bits', width: 4, decode: 'lsb-int' };
  assert.deepEqual(readoutBits(spec, [0, -1, 3, -0.5]), [1, 0, 1, 0]);
  assert.equal(decodeBits(spec, [1, 0, 1, 0]), 5);
  assert.equal(decodeBits(spec, [0, 0, 0, 1]), 8);
  assert.deepEqual(readout(spec, [-1, -1, -1, -1]), { action: 0, bits: [0, 0, 0, 0], slot: null });
});

test('spec validation', () => {
  assert.equal(readoutProblem({ mode: 'argmax', map: [0, 1] }, 2), '');
  assert.match(readoutProblem({ mode: 'argmax', map: [0, 2] }, 2), /不存在的动作/);
  assert.match(readoutProblem({ mode: 'argmax', map: [0, -1] }), /动作下标或 null/);
  assert.match(readoutProblem({ mode: 'bits', width: 64, decode: 'lsb-int' }), /53/);
  assert.match(readoutProblem({ mode: 'bits', width: 4, decode: 'gray' }), /解码/);
  assert.match(readoutProblem({ mode: 'other' }), /未知读出模式/);
});
