// The chain node (ADR 0028): one call output `node` for script modules, a method allowlist that `write` widens, and
// writes only on a local node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './index.js';
import { ModuleGraph } from '../graph.js';
import { kindOf } from '../registry.js';
import { CHAINS } from '../../chain.js';
import { chainMethodProblem, chainNetwork, defaultChainId, READ_METHODS, WRITE_METHODS } from './chain-node.js';

const LOCAL = Number(Object.keys(CHAINS).find(id => CHAINS[id].local));
const PUBLIC = Number(Object.keys(CHAINS).find(id => !CHAINS[id].local));

test('a chain node has one call output and starts on the first fork of the registry, reading only', () => {
  const g = new ModuleGraph();
  const node = g.addNode({ kind: 'chain' });
  assert.deepEqual(node.config, { chainId: defaultChainId(), write: false });
  const fork = Object.keys(CHAINS).map(Number).find(id => CHAINS[id].fork);
  if (fork) assert.equal(node.config.chainId, fork);
  const ports = g.resolved().portsOf(node.id);
  assert.deepEqual(ports.inputs, []);
  assert.deepEqual(ports.outputs.map(p => [p.id, p.wire]), [['node', 'call']]);
});

test('the allowlist: reads always, writes only with write, nothing else', () => {
  for (const m of READ_METHODS) { assert.equal(chainMethodProblem(m, false), null); assert.equal(chainMethodProblem(m, true), null); }
  for (const m of WRITE_METHODS) { assert.match(chainMethodProblem(m, false), /不允许 /); assert.equal(chainMethodProblem(m, true), null); }
  assert.match(chainMethodProblem('eth_sign', true), /链节点不允许 eth_sign/);
  assert.match(chainMethodProblem('anvil_reset', true), /不允许 anvil_reset/);
});

test('write is a problem on a public chain, and the callee carries the chain for a script module only', () => {
  const g = new ModuleGraph();
  const node = g.addNode({ kind: 'chain', config: { chainId: LOCAL, write: true } });
  const script = g.addNode({ kind: 'script', config: { functions: ['node'], inputs: [] } });
  const code = g.addNode({ kind: 'code', config: { inputs: [], source: 'export function f(x) { return x; }\n' } });
  g.connect({ kind: 'call', from: { node: node.id, port: 'node' }, to: { node: script.id, port: 'node' } });
  let res = g.resolved();
  assert.deepEqual(res.problemsOf(node.id), []);
  assert.deepEqual(res.problemsOf(script.id), []);
  const [site] = res.callees(script.id, 'node');
  const r = site.callee.call([], { exact: false, caller: script.id });
  assert.equal(r.error, null);
  assert.deepEqual(r.carries, { kind: 'chain', nodeId: node.id, chainId: LOCAL, write: true });
  assert.deepEqual(chainNetwork(node.config), { chainId: LOCAL, name: CHAINS[LOCAL].name, local: true, write: true, factory: CHAINS[LOCAL].factory, ladder: CHAINS[LOCAL].ladder });
  assert.match(site.callee.call([], { exact: false, caller: code.id }).error.message, /只能接脚本模块/);
  assert.equal(kindOf('chain').callee(node, 'other', {}), null, 'only `node` is callable');

  g.patchConfig(node.id, { chainId: PUBLIC });
  res = g.resolved();
  assert.match(res.problemsOf(node.id)[0].message, /不是本地节点/);
  assert.match(res.problemsOf(script.id).find(p => p.port === 'node').message, /不是本地节点/, 'the script reports the wire too');
  assert.equal(chainNetwork(g.node(node.id).config).write, false, 'the sandbox never sees write on a public chain');
  g.patchConfig(node.id, { write: false });
  assert.deepEqual(g.resolved().problemsOf(node.id), []);
  const unknown = g.addNode({ kind: 'chain', config: { chainId: 424242 } });
  assert.match(g.resolved().problemsOf(unknown.id)[0].message, /没有链 id 424242/);
});
