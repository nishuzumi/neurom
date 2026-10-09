import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../core/kinds/index.js';
import { ModuleGraph } from '../core/graph.js';
import { toolLayers } from './tool-canvas.js';

const FF = { engine: 'threshold-layers', kind: 'feedforward', inputs: 8, layers: [12], ticks: 1, leak_shift: 0, reset: 0 };

/** A policy with two tool layers (`tools`, then `aux`) and one tool of every membership case. */
function policyGraph() {
  const g = new ModuleGraph();
  const call = (from, port, to, into) => g.connect({ kind: 'call', from: { node: from, port }, to: { node: to, port: into } });
  const value = (from, port, to, into) => g.connect({ kind: 'value', from: { node: from, port }, to: { node: to, port: into } });
  const policy = g.addNode({ kind: 'network', title: 'policy', config: { engine: 'dense-policy', kind: 'feedforward', inputs: 11, layers: [{ tools: 'aux', data: 8 }, { hidden: 8 }, { tools: 'tools', data: 8 }], ticks: 1, leak_shift: 0, reset: 0 } }).id;
  const code = source => g.addNode({ kind: 'code', config: { source } }).id;
  const frozen = title => {
    const net = g.addNode({ kind: 'network', title, config: FF }).id, readout = g.addNode({ kind: 'readout', config: { mode: 'bits', width: 5, decode: 'lsb-int' } }).id;
    value(net, 'scores', readout, 'scores');
    return { net, readout };
  };
  const only = code('export function only(data) { return data; }');
  call(only, 'only', policy, 'tools');
  const add = frozen('ADD4');
  call(add.readout, 'run', policy, 'tools');
  const shared = code('export function shared(data) { return data; }');
  call(shared, 'shared', policy, 'tools'); call(shared, 'shared', policy, 'aux');
  const trained = frozen('SUB4'), cands = g.addNode({ kind: 'candidates' }).id;
  call(trained.readout, 'run', policy, 'tools');
  value(cands, 'weights', trained.net, 'weights');   // its network takes weights from elsewhere
  const aux = code('export function a(data) { return data; }\nexport function b(data) { return data; }');
  call(aux, 'a', policy, 'aux'); call(aux, 'b', policy, 'aux');
  return { g, policy, only, add, shared, trained, aux };
}

test('tool layers in layer order: tools wired only into the port are inside, a frozen network with its readout as one unit', () => {
  const { g, policy, only, add, shared, trained, aux } = policyGraph();
  assert.deepEqual(toolLayers(g, policy), [
    // a module with two exports both wired into the port is one card
    { port: 'aux', inside: [{ node: aux, readout: null, tool: aux }], outside: [shared] },
    { port: 'tools', inside: [{ node: only, readout: null, tool: only }, { node: add.net, readout: add.readout, tool: add.readout }], outside: [shared, trained.readout] },
  ]);
});

test('a tool also wired elsewhere stays outside, whichever module of a unit carries that wire', () => {
  const { g, policy, only, add, shared, trained } = policyGraph();
  const next = g.addNode({ kind: 'network', config: { inputs: 5 } }).id;
  g.connect({ kind: 'value', from: { node: add.readout, port: 'bits' }, to: { node: next, port: 'in' } });
  const tools = () => toolLayers(g, policy).find(L => L.port === 'tools');
  assert.deepEqual(tools().outside, [add.readout, shared, trained.readout], 'the readout feeds another network too: outside, in wire order');
  assert.deepEqual(tools().inside.map(u => u.node), [only]);
  // a tool the editor cannot draw inside (held in a collapsed group) stays outside
  assert.deepEqual(toolLayers(g, policy, id => id !== only).find(L => L.port === 'tools').outside[0], only);
});

test('no tool layers: a threshold network, or a dense one without tool entries', () => {
  const { g, add } = policyGraph();
  assert.deepEqual(toolLayers(g, add.net), []);
  const plain = g.addNode({ kind: 'network', config: { layers: [{ hidden: 4 }] } }).id;
  assert.deepEqual(toolLayers(g, plain), []);
});
