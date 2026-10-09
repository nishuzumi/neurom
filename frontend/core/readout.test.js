import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readout, readoutBits, decodeBits, readoutProblem, INVALID_ACTION } from './readout.js';

test('argmax: first maximum wins ties, bits are one-hot, the map picks the physical action', () => {
  const spec = { mode: 'argmax', map: [3, 1, 1, null] };
  assert.deepEqual(readout(spec, [5, 5, 5, 5]), { action: 3, bits: [1, 0, 0, 0], slot: 0 });
  assert.deepEqual(readout(spec, [-2, 7, 7, 0]), { action: 1, bits: [0, 1, 0, 0], slot: 1 });
  assert.deepEqual(readout(spec, [-9, -9, -9, -1]), { action: INVALID_ACTION, bits: [0, 0, 0, 1], slot: 3 });
  assert.throws(() => readoutBits(spec, [1, 2]), /4 个分数/);
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
