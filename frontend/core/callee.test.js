// The callee hook (core/registry.js): what the kind behind a call wire answers for it — the width it reads, the result
// type or why the call does not type, the program's params and what a bundle carries. One adapter per kind with call
// outputs: a code module's exported functions and a bits readout's `run`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './kinds/index.js';
import { ModuleGraph } from './graph.js';
import { kindOf } from './registry.js';
import { NUMBER, bits } from './types.js';

/** The ctx a kind sees (core/resolve.js), over a graph's current resolution. */
function ctxOf(g) {
  const res = g.resolved();
  return {
    node: id => g.node(id),
    producers: (n, p) => g.producers(n, p),
    consumers: (n, p) => g.consumers(n, p),
    inType: (n, p) => { const x = g.producers(n, p)[0]; return x ? res.typeOf(x.node, x.port) : null; },
  };
}
const callee = (g, node, port) => kindOf(node.kind).callee(node, port, ctxOf(g));

test('code: an exported function types with the caller\'s arguments and carries its program and bound names', () => {
  const g = new ModuleGraph();
  const code = g.addNode({ kind: 'code', config: { inputs: ['w'], source: 'export const K = 3;\nexport function f(x) { return x + K; }\nexport function g(x) { return x + w; }\n' } });
  assert.equal(callee(g, code, 'K'), null, 'a const is a value output, not callable');
  assert.equal(callee(g, code, 'module'), null, 'the whole file goes to a kind that calls it by role, not through a call port');
  assert.equal(callee(g, code, 'h'), null);
  const f = callee(g, code, 'f');
  assert.equal(f.width, null, 'typed by its arguments alone');
  const r = f.call([NUMBER], { exact: false });
  assert.equal(r.error, null);
  assert.deepEqual(r.result, NUMBER);
  assert.deepEqual(r.paramTypes, [NUMBER, NUMBER], 'the argument, then the bound const');
  assert.equal(r.carries.kind, 'program');
  assert.deepEqual(r.carries.program.params, ['x', 'K']);
  assert.deepEqual(r.carries.bound, { K: NUMBER });
  assert.match(f.call([NUMBER, NUMBER], { exact: false }).error.message, /有 1 个参数，调用方传入 2 个/);
  assert.equal(f.call([null], { exact: false }).error.incomplete, true, 'an untyped argument: still to be wired');
  const unwired = callee(g, code, 'g').call([NUMBER], { exact: false });
  assert.equal(unwired.error.incomplete, true, 'an input without a wire is not typed yet');
  assert.match(unwired.error.message, /读的 w 类型尚未确定/);
});

/** net (FF, `inputs` bits) → readout (bits, width 3). */
function runGraph(net = {}) {
  const g = new ModuleGraph();
  const network = g.addNode({ kind: 'network', title: 'N', config: { engine: 'dense-policy', kind: 'feedforward', ticks: 1, leak_shift: 0, reset: 0, inputs: 2, layers: [{ hidden: 2 }], ...net } });
  const readout = g.addNode({ kind: 'readout', title: 'R', config: { mode: 'bits', width: 3, decode: 'lsb-int' } });
  g.connect({ kind: 'value', from: { node: network.id, port: 'scores' }, to: { node: readout.id, port: 'scores' } });
  return { g, network, readout };
}

test('bits readout run: reads the first I bits of one bit vector; carries its frozen network and its readout spec', () => {
  const { g, network, readout } = runGraph();
  const run = callee(g, readout, 'run');
  assert.equal(run.width, 2, 'its network\'s inputs');
  const r = run.call([bits(5)], { exact: false, caller: 'caller' });
  assert.equal(r.error, null);
  assert.deepEqual(r.result, bits(3));
  assert.deepEqual(r.paramTypes, [bits(2)]);
  assert.deepEqual(r.carries, { kind: 'net', network: g.node(network.id), readout: { mode: 'bits', width: 3, decode: 'lsb-int' } });
  assert.match(run.call([bits(1)], { caller: 'caller' }).error.message, /R 的 run 需要 2 位输入，调用方只给 1 位/);
  assert.match(run.call([NUMBER], { caller: 'caller' }).error.message, /只收一个位向量参数/);
  assert.match(run.call([bits(2), bits(2)], { caller: 'caller' }).error.message, /只收一个位向量参数/);
  assert.equal(callee(g, readout, 'bits'), null);
  g.patchConfig(readout.id, { mode: 'argmax', map: [0, 1] });
  assert.equal(callee(g, g.node(readout.id), 'run'), null, 'an argmax readout has no run');
  const lone = g.addNode({ kind: 'readout', title: 'L', config: { mode: 'bits', width: 2, decode: 'lsb-int' } });
  const none = callee(g, lone, 'run');
  assert.equal(none.width, null);
  assert.match(none.call([bits(2)], { caller: 'caller' }).error.message, /L 的 run 需要它的 scores 接一个网络/);
});

test('bits readout run: its network must be fit to be a tool — any kind, its own tool layers included, untrained, not the caller', () => {
  const error = (h, caller = 'caller') => callee(h.g, h.g.node(h.readout.id), 'run').call([bits(2)], { caller }).error?.message ?? null;
  const ok = runGraph();
  assert.equal(error(ok), null);
  assert.match(error(ok, ok.network.id), /网络不能把自己当工具/);
  assert.equal(error(runGraph({ kind: 'lif', ticks: 2, leak_shift: 2 })), null, 'a LIF network is a tool (ADR 0014)');
  assert.equal(error(runGraph({ layers: [{ hidden: 2 }, { tools: 'tools', data: 2 }] })), null, 'so is one with tool layers of its own');
  const trained = runGraph({ engine: 'threshold-layers', layers: [2] });
  const trainer = trained.g.addNode({ kind: 'trainer', config: { method: 'hinge' } });
  trained.g.connect({ kind: 'value', from: { node: trained.network.id, port: 'structure' }, to: { node: trainer.id, port: 'structure' } });
  assert.match(error(trained), /训练器在训练工具 R 的网络/);
});
