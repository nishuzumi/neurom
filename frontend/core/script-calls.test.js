// The page side of the script module's call bridge (ADR 0019): a call of a declared function input runs outside the
// sandbox. A code function runs its IR program, a frozen network its readout's `run`, a chain node (ADR 0028) sends
// one allowed request through the injected connection. A reply of a run that was reset is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './kinds/index.js';
import { ModuleGraph } from './graph.js';
import { scriptCalls, callBridge, chainError } from './script-calls.js';
import { CHAINS } from '../chain.js';
import { shapedArtifact } from './sessions/fixtures.js';
import { createExecutor } from './sessions/executor.js';
import { readoutBits } from './readout.js';

const OR_ID = '0x' + 'b'.repeat(64);
const identity = n => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, k) => (k === i ? 1 : 0)));
/** The OR network: 2 input bits → [a | b, 1] (threshold layers: OR and a constant-1 unit, then a copy). */
const OR_MODEL = { format: 'threshold-layers', inputs: 2, outputs: 2, weightBits: 8, layers: [{ W: [[1, 1], [0, 0]], th: [1, 0], scale: 1, k: 0 }, { W: identity(2), th: [1, 1], scale: 1, k: 0 }] };
const SOURCE = 'export function score(state, side) { return { sum: state.a[side] + params.k, on: state.b.on }; }\nexport function pair(x) { return [x, x * 2]; }\n';

/** params → code C (score, pair); network N (the OR model) → readout R; a script with function inputs or/score and
 *  value inputs p/none. */
function bridgeGraph(readout = { mode: 'bits', width: 2, decode: 'lsb-int' }) {
  const g = new ModuleGraph();
  const params = g.addNode({ kind: 'params', title: 'P', config: { fields: { k: { type: 'int', default: 2 } }, values: {}, functions: [] } });
  const code = g.addNode({ kind: 'code', title: 'C', config: { inputs: ['params'], source: SOURCE } });
  const net = g.addNode({ kind: 'network', title: 'N', config: { engine: 'threshold-layers', kind: 'feedforward', inputs: 2, layers: [2], artifact: OR_ID } });
  const r = g.addNode({ kind: 'readout', title: 'R', config: readout });
  const script = g.addNode({ kind: 'script', config: { functions: ['or', 'score', 'pair', 'loose'], inputs: ['p', 'none'] } });
  const wire = (kind, from, port, to, toPort) => g.connect({ kind, from: { node: from.id, port }, to: { node: to.id, port: toPort } });
  wire('value', params, 'params', code, 'params');
  wire('value', net, 'scores', r, 'scores');
  wire('call', r, 'run', script, 'or');
  wire('call', code, 'score', script, 'score');
  wire('call', code, 'pair', script, 'pair');
  wire('value', params, 'params', script, 'p');
  const artifacts = id => (id === OR_ID ? shapedArtifact(g, net.id, OR_MODEL) : null);
  const calls = () => scriptCalls(g, g.resolved(), script.id, { artifacts });
  return { g, net, r, script, calls };
}

test('a code function called through a function input runs its program with the values it reads', () => {
  const { calls } = bridgeGraph();
  assert.deepEqual(calls().call('score', [{ a: [3, 4], b: { on: true } }, 1]), { sum: 6, on: true });
  assert.deepEqual(calls().call('score', [{ a: [3, 4], b: { on: false } }, 0]), { sum: 5, on: false });
  assert.deepEqual(calls().call('pair', [5]), [5, 10]);
  assert.throws(() => calls().call('score', [{ a: [3, 4], b: { on: true } }]), /2 个参数，调用方传入 1 个/);
});

test('a frozen network called through its readout run gives the bits of a direct forward pass', () => {
  const direct = (spec, x) => readoutBits(spec, createExecutor(OR_MODEL).step(x).scores);
  const bitsGraph = bridgeGraph();
  for (const [x, expected] of [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, 1], [1, 1]]]) {
    assert.deepEqual(bitsGraph.calls().call('or', [x]), expected);
    assert.deepEqual(direct({ mode: 'bits', width: 2, decode: 'lsb-int' }, x), expected);
  }
  assert.deepEqual(bitsGraph.calls().call('or', [[1, 0, 1, 1]]), [1, 1], 'it reads the first I bits');
  assert.deepEqual(bitsGraph.calls().call('or', [new Uint8Array([0, 1])]), [1, 1], 'a typed array is a bit vector too');
  const argmax = bridgeGraph({ mode: 'argmax', map: [0, 1] });
  for (const x of [[0, 0], [1, 0], [1, 1]]) assert.deepEqual(argmax.calls().call('or', [x]), direct({ mode: 'argmax', map: [0, 1] }, x));
  assert.throws(() => bitsGraph.calls().call('or', [[1]]), /需要 2 位输入/);
  assert.throws(() => bitsGraph.calls().call('or', [[1, 2]]), /0\/1/);
});

test('a call that cannot run says why: an undeclared name, an unwired input, no weights, a trained network', () => {
  const { g, net, calls } = bridgeGraph();
  assert.throws(() => calls().call('nope', []), /没有声明函数输入 nope/);
  assert.throws(() => calls().call('loose', []), /loose 尚未连接/);
  g.patchConfig(net.id, { artifact: '0x' + 'c'.repeat(64) });
  assert.throws(() => calls().call('or', [[0, 0]]), /没有已接受的权重/);
  g.patchConfig(net.id, { artifact: null });
  const trainer = g.addNode({ kind: 'trainer', config: { method: 'hinge' } });
  g.connect({ kind: 'value', from: { node: net.id, port: 'structure' }, to: { node: trainer.id, port: 'structure' } });
  assert.throws(() => calls().call('or', [[0, 0]]), /训练器在训练工具 R 的网络/);
});

test('value inputs give the values wired in, or why there is none', () => {
  const { calls } = bridgeGraph();
  const values = calls().values();
  assert.deepEqual(values.p, { value: { k: 2 } });
  assert.match(values.none.error, /none 尚未连接/);
});

test('the bridge answers each call with its id, and drops the replies of a run that was reset', async () => {
  const posted = [], bridge = callBridge(m => posted.push(m));
  const settled = () => new Promise(resolve => setTimeout(resolve, 0));
  let release = null;
  bridge.handle({ type: 'call', id: 1, name: 'slow', args: [] }, () => new Promise(resolve => { release = resolve; }));
  await settled();
  bridge.reset();
  release(5);
  await settled();
  assert.deepEqual(posted, [], 'the reply of the old run is dropped');
  bridge.handle({ type: 'call', id: 2, name: 'f', args: [3] }, (name, args) => ({ name, x: args[0] }));
  bridge.handle({ type: 'call', id: 3, name: 'g', args: [] }, () => { throw new Error('bad call'); });
  await settled();
  assert.deepEqual(posted, [{ type: 'reply', id: 2, result: { name: 'f', x: 3 } }, { type: 'reply', id: 3, error: 'bad call' }]);
});

const LOCAL = Number(Object.keys(CHAINS).find(id => CHAINS[id].local));
/** a script with the function input `node` wired to a chain node on the local chain, and `request` recording each
 *  request it gets */
function chainGraph(write) {
  const g = new ModuleGraph();
  const chain = g.addNode({ kind: 'chain', config: { chainId: LOCAL, write } });
  const script = g.addNode({ kind: 'script', config: { functions: ['node'], inputs: [] } });
  g.connect({ kind: 'call', from: { node: chain.id, port: 'node' }, to: { node: script.id, port: 'node' } });
  const sent = [];
  const request = async (chainId, req) => { sent.push([chainId, req]); if (req.method === 'eth_call') throw Object.assign(new Error('execution reverted'), { info: { error: { data: '0xdeadbeef' } } }); return '0x10'; };
  return { g, chain, script, sent, calls: () => scriptCalls(g, g.resolved(), script.id, { artifacts: () => null, request }) };
}

test('a chain node forwards an allowed request to the injected connection, with its chain id', async () => {
  const { g, chain, sent, calls } = chainGraph(false);
  assert.equal(await calls().call('node', [{ method: 'eth_blockNumber', params: [] }]), '0x10');
  assert.equal(await calls().call('node', [{ method: 'eth_chainId' }]), '0x10', 'params default to []');
  assert.deepEqual(sent, [[LOCAL, { method: 'eth_blockNumber', params: [] }], [LOCAL, { method: 'eth_chainId', params: [] }]]);
  assert.deepEqual(calls().chains(), { node: { chainId: LOCAL, name: CHAINS[LOCAL].name, local: true, write: false, factory: CHAINS[LOCAL].factory, ladder: CHAINS[LOCAL].ladder } });
  const e = await calls().call('node', [{ method: 'eth_call', params: [{}, 'latest'] }]).catch(x => x);
  assert.equal(e.data, '0xdeadbeef', 'revert data stays on the error');
  assert.match(e.message, /execution reverted data=0xdeadbeef/);
  g.patchConfig(chain.id, { write: true });
  assert.equal(await calls().call('node', [{ method: 'evm_snapshot', params: [] }]), '0x10', 'write opens the write methods');
  assert.equal(calls().chains().node.write, true);
});

test('a chain node refuses a method outside its allowlist, a write without write, and a malformed request', () => {
  const { g, script, sent, calls } = chainGraph(false);
  assert.throws(() => calls().call('node', [{ method: 'eth_sign', params: [] }]), /链节点不允许 eth_sign/);
  assert.throws(() => calls().call('node', [{ method: 'eth_sendTransaction', params: [{}] }]), /链节点不允许 eth_sendTransaction/);
  assert.throws(() => calls().call('node', [{ method: 'evm_revert', params: ['0x1'] }]), /不允许 evm_revert/);
  assert.throws(() => calls().call('node', ['eth_chainId']), /一次调用传一个 \{ method, params \}/);
  assert.throws(() => calls().call('node', [{ method: 'eth_chainId' }, 1]), /一次调用传一个/);
  assert.throws(() => calls().call('node', [{ method: 'eth_chainId', params: 'latest' }]), /一次调用传一个/);
  assert.deepEqual(sent, [], 'nothing reached the chain');
  const pageless = scriptCalls(g, g.resolved(), script.id, { artifacts: () => null });
  assert.throws(() => pageless.call('node', [{ method: 'eth_chainId', params: [] }]), /不能连接链/);
});

test('the bridge forwards the revert data of a failed chain request', async () => {
  const posted = [], bridge = callBridge(m => posted.push(m));
  bridge.handle({ type: 'call', id: 1, name: 'node', args: [] }, () => { throw chainError(Object.assign(new Error('reverted'), { data: '0x08c379a0' })); });
  bridge.handle({ type: 'call', id: 2, name: 'node', args: [] }, () => { throw new Error('plain'); });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(posted, [{ type: 'reply', id: 1, error: 'reverted data=0x08c379a0', data: '0x08c379a0' }, { type: 'reply', id: 2, error: 'plain' }]);
});
