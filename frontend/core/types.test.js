import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignable, checkValue, sameType, canonicalType, typeName, resolveSignature, unresolvedRefs, NUMBER, BOOLEAN, STRING, vector, bits, array, record, handle, binaryVector, recordWith, ref, ANY_RECORD } from './types.js';

test('assignability: widths, binary flag, handles with meta, records, constraints', () => {
  assert.ok(assignable(bits(8), vector(8)));
  assert.ok(!assignable(vector(8), bits(8)), 'plain vector cannot feed a binary port');
  assert.ok(!assignable(bits(8), bits(9)));
  assert.ok(assignable(vector(3), binaryVector(1, 256)), 'width checked statically, 0/1 at runtime');
  assert.ok(!assignable(vector(300), binaryVector(1, 256)));
  assert.ok(assignable(record({ b: NUMBER, a: STRING }), record({ a: STRING, b: NUMBER })));
  assert.ok(!assignable(record({ a: STRING }), record({ a: STRING, b: NUMBER })));
  assert.ok(assignable(record({ state: NUMBER, event: record({}), extra: BOOLEAN }), recordWith({ state: NUMBER, event: ANY_RECORD })));
  assert.ok(!assignable(record({ state: NUMBER }), recordWith({ state: NUMBER, event: ANY_RECORD })));
  assert.ok(assignable(handle('partition', { episode: { kind: 'seed' } }), handle('partition', { episode: { kind: 'seed' } })));
  assert.ok(!assignable(handle('partition', { episode: { kind: 'seed' } }), handle('partition', { episode: { kind: 'window' } })));
  assert.ok(!assignable(handle('structure'), handle('run')));
  assert.ok(!assignable(NUMBER, ref('State')), 'unresolved refs never match');
  assert.ok(assignable(array(2, STRING), array(2, STRING)) && !assignable(array(2, STRING), array(3, STRING)));
});

test('runtime values: binary vectors, records without extras, arrays of records', () => {
  assert.equal(checkValue(bits(3), [1, 0, 1]), null);
  assert.equal(checkValue(bits(3), new Float64Array([1, 0, 1])), null);
  assert.match(checkValue(bits(3), [1, 2, 0]), /0\/1/);
  assert.match(checkValue(bits(3), [1, 0]), /宽度 2/);
  assert.equal(checkValue(record({ a: NUMBER }), { a: 1 }), null);
  assert.match(checkValue(record({ a: NUMBER }), { a: 1, b: 2 }), /多余字段 b/);
  assert.match(checkValue(record({ a: NUMBER }), {}), /缺少字段 a/);
  assert.match(checkValue(array(2, record({ x: BOOLEAN })), [{ x: true }, { x: 1 }]), /第 1 项/);
});

test('canonical form, names, signature refs', () => {
  assert.ok(sameType({ type: 'vector', width: 4, binary: false }, vector(4)));
  assert.deepEqual(canonicalType({ type: 'record', fields: { b: NUMBER, a: { type: 'vector', width: 2, binary: true } } }), { type: 'record', fields: { a: bits(2), b: NUMBER } });
  assert.equal(typeName(record({ pos: array(2, NUMBER), hp: NUMBER })), '{hp: number, pos: number[2]}');
  assert.equal(typeName(binaryVector(1, 256)), 'bits[1..256]');
  const sig = { params: [ref('State'), NUMBER], result: recordWith({ state: ref('State'), event: ANY_RECORD }), exact: true };
  assert.deepEqual(unresolvedRefs(sig), ['State']);
  const resolved = resolveSignature(sig, { State: record({ n: NUMBER }) });
  assert.deepEqual(unresolvedRefs(resolved), []);
  assert.deepEqual(resolved.result.recordWith.state, record({ n: NUMBER }));
});
