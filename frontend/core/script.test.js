import { test } from 'node:test';
import assert from 'node:assert/strict';
import './kinds/index.js';
import { ModuleGraph } from './graph.js';
import { ConfigError } from './registry.js';
import { buildBundle, envHash } from './bundle.js';
import { counterGraph } from './fixtures/counter.js';

const problemsOf = (graph, id) => graph.problems().filter(p => p.node === id).map(p => p.message);

test('script module: a new one has main.js, no ports and no problems', () => {
  const graph = new ModuleGraph();
  const script = graph.addNode({ kind: 'script' });
  assert.deepEqual(graph.node(script.id).config.files.map(f => f.name), ['main.js']);
  assert.match(graph.node(script.id).config.files[0].source, /export default/);
  assert.deepEqual(graph.ports(script.id), { inputs: [], outputs: [] });
  assert.deepEqual(problemsOf(graph, script.id), []);
});

test('script module: a missing main.js and a file name used twice are problems', () => {
  const graph = new ModuleGraph();
  const script = graph.addNode({ kind: 'script', config: { files: [{ name: 'views.js', source: '' }] } });
  assert.ok(problemsOf(graph, script.id).some(m => /main\.js/.test(m)), 'no main.js');
  graph.patchConfig(script.id, { files: [{ name: 'main.js', source: '' }, { name: 'a.js', source: '' }, { name: 'a.js', source: '' }] });
  const problems = problemsOf(graph, script.id);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /a\.js/);
  assert.throws(() => graph.patchConfig(script.id, { files: [{ name: 'main.js', source: '' }, { name: '../x.js', source: '' }] }), ConfigError, 'a file name is a plain .js name');
});

test('script module: no bundle contains it and it does not change the environment hash', async () => {
  const { graph, ids } = counterGraph();
  const before = { trainer: buildBundle(graph, ids.trainer) };
  const hash = await envHash(before.trainer);
  graph.addNode({ kind: 'script' });
  const after = buildBundle(graph, ids.trainer);
  assert.deepEqual(after, before.trainer);
  assert.equal(await envHash(after), hash);
  assert.doesNotMatch(JSON.stringify(after), /"script"/);
});

/** A frozen network N (2 bits in) behind a bits readout R, a code module with an exported function, and a script. */
function wiredGraph() {
  const graph = new ModuleGraph();
  const net = graph.addNode({ kind: 'network', title: 'N', config: { engine: 'threshold-layers', kind: 'feedforward', inputs: 2, layers: [2] } });
  const readout = graph.addNode({ kind: 'readout', title: 'R', config: { mode: 'bits', width: 2, decode: 'lsb-int' } });
  graph.connect({ kind: 'value', from: { node: net.id, port: 'scores' }, to: { node: readout.id, port: 'scores' } });
  const code = graph.addNode({ kind: 'code', title: 'C', config: { inputs: [], source: 'export function f(x) { return x + 1; }\n' } });
  const script = graph.addNode({ kind: 'script', config: { functions: ['net', 'f'], inputs: ['p'] } });
  return { graph, net, readout, code, script };
}
const callWire = (from, port, to, toPort) => ({ kind: 'call', from: { node: from.id, port }, to: { node: to.id, port: toPort } });

test('script module: each declared function input is a call port and each value input a value port', () => {
  const { graph, script } = wiredGraph();
  const { inputs, outputs } = graph.ports(script.id);
  assert.deepEqual(inputs.map(p => [p.id, p.wire]), [['net', 'call'], ['f', 'call'], ['p', 'value']]);
  assert.deepEqual(outputs, []);
  graph.patchConfig(script.id, { functions: ['红方', '蓝方'], inputs: [] });
  assert.deepEqual(graph.ports(script.id).inputs.map(p => p.id), ['红方', '蓝方'], 'a name can be Chinese');
  for (const name of ['__proto__', 'constructor', '1a', 'a.b']) assert.throws(() => graph.patchConfig(script.id, { functions: [], inputs: [name] }), ConfigError, name);
});

test('script module: a declared function input without a wire is a problem; a value input without one is not', () => {
  const { graph, readout, code, script } = wiredGraph();
  const unwired = problemsOf(graph, script.id);
  assert.equal(unwired.length, 2);
  assert.ok(unwired.some(m => /net/.test(m)) && unwired.some(m => /\bf\b/.test(m)));
  graph.connect(callWire(readout, 'run', script, 'net'));
  graph.connect(callWire(code, 'f', script, 'f'));
  assert.deepEqual(problemsOf(graph, script.id), []);
});

test('script module: a name declared twice is a problem, also across the two lists', () => {
  const graph = new ModuleGraph();
  const script = graph.addNode({ kind: 'script', config: { functions: ['a', 'a'], inputs: [] } });
  assert.ok(problemsOf(graph, script.id).some(m => /a/.test(m) && /重复/.test(m)));
  graph.patchConfig(script.id, { functions: [], inputs: ['b', 'b'] });
  assert.ok(problemsOf(graph, script.id).some(m => /b/.test(m) && /重复/.test(m)));
  graph.patchConfig(script.id, { functions: ['c'], inputs: ['c'] });
  assert.ok(problemsOf(graph, script.id).some(m => /c/.test(m)));
  assert.deepEqual(graph.ports(script.id).inputs.map(p => p.id), ['c'], 'one port per name');
});

test('script module: a network that a trainer trains cannot fill a function input (the tool-layer rule)', () => {
  const { graph, net, readout, code, script } = wiredGraph();
  graph.connect(callWire(readout, 'run', script, 'net'));
  graph.connect(callWire(code, 'f', script, 'f'));
  const trainer = graph.addNode({ kind: 'trainer', config: { method: 'hinge' } });
  graph.connect({ kind: 'value', from: { node: net.id, port: 'structure' }, to: { node: trainer.id, port: 'structure' } });
  assert.ok(problemsOf(graph, script.id).some(m => /训练器在训练工具 R 的网络/.test(m)));
});
