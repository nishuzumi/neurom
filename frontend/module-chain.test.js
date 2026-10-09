import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_FOUNDRY, FORGE, deployOut, localChain } from './anvil.fixture.js';
import { startAnvil } from '../contracts/scripts/foundry.mjs';
import { ethers } from 'ethers';
import { denseWeightBytes, deploymentProblem } from './core/kinds/network.js';
import { makeArtifact, validateArtifact } from './core/store.js';
import { ModuleGraph } from './core/graph.js';
import { buildBundle, envHash } from './core/bundle.js';
import { counterGraph } from './core/fixtures/counter.js';
import { instantiateInto } from './core/template.js';
import { episodesOf } from './core/sessions/common.js';
import { createExecutor } from './core/sessions/executor.js';
import { deepThresholdArtifact, toolNetworkArtifacts } from './core/sessions/fixtures.js';
import { createEnv } from './core/runner.js';
import { trainedOf, toolCaller } from './core/loop.js';
import { readout } from './core/readout.js';
import { builtinTemplate } from './templates/index.js';
import { builtinArtifacts } from './templates/artifacts/index.js';
import FactoryABI from './abi/ModuleFactory.json' with { type: 'json' };
import { deploymentOf, taskIdOf, deployModule, planDeployment, verifyModule, inferModule, stepModule, resetModule, moduleState, sessionId, weightChunks, chunkAddress, CHUNK_BYTES } from './module-chain.js';
import { CHAINS } from './chain.js';

/** An artifact that carries an I → H → O dense model (default 12 → 8 → 4) on the counter loop (the trained network and
 *  its readout widened to match). Weight k = ((29k + 13) mod 25) − 12 in row-major order times 10 (int8) or 2500
 *  (int16), or 0 everywhere (`zero`). `tail` is added to the output biases (the end of the weight blob). The hidden
 *  layer shifts its sums by `kHidden`, and the output by `kOut`. A LIF layer fires at `threshold`. */
async function denseArtifact({ kind = 'lif', weightBits = 8, ticks = 3, leak = 2, threshold = 60, reset = -2, kHidden = 1, kOut = 2, I = 12, H = 8, O = 4, zero = false, tail = 0, provenance = { test: 'module-chain' } } = {}) {
  const unit = weightBits === 8 ? 10 : 2500, weight = k => (zero ? 0 : (((k * 29 + 13) % 25) - 12) * unit);
  let k = 0;
  const W1 = Array.from({ length: H }, () => Array.from({ length: I }, () => weight(k++)));
  const b1 = Array.from({ length: H }, () => weight(k++));
  const W2 = Array.from({ length: O }, () => Array.from({ length: H }, () => weight(k++)));
  const b2 = Array.from({ length: O }, () => weight(k++) + tail);
  const model = { format: 'dense-policy', kind, inputs: I, outputs: O, weightBits, ticks, leak_shift: leak, reset,
    layers: [{ hidden: H, W: W1, b: b1, scale: unit, k: kHidden, ...(kind === 'lif' ? { threshold: threshold * unit } : {}) }], output: { W: W2, b: b2, scale: unit, k: kOut } };
  const { graph, ids } = counterGraph();
  const bundle = buildBundle(graph, ids.trainer), net = bundle.loop.nodes[ids.net], readout = bundle.loop.nodes[ids.readout];
  net.structure = { ...net.structure, kind, inputs: I, outputs: O, layers: [{ hidden: H }], weightBits, ticks, leak_shift: leak, reset };
  readout.readout = { mode: 'argmax', map: Array.from({ length: O }, (_, a) => a % 2), width: O };
  return makeArtifact({ bundle, model, provenance });
}
const FF = { kind: 'feedforward', ticks: 1, leak: 0, reset: 0 };

test('deploymentOf: a dense artifact maps to Factory arguments; taskId is the env hash, artifactId the content id', async () => {
  const a = await denseArtifact();
  const d = deploymentOf(await validateArtifact(JSON.parse(JSON.stringify(a))));
  assert.deepEqual({ ...d, weights: undefined }, { engine: 'dense-policy', kind: 'lif', inputs: 12, outputs: 4, stateWidth: 8, weights: undefined, tools: [],
    shape: [7n, 1n | (3n << 8n) | (2n << 16n) | (8n << 24n) | (0xfffen << 32n) | (1n << 48n) | (2n << 128n), 600n] }, 'layout; layers, ticks, leak, int8, reset −2, k 1 (hidden) and 2 (output); the hidden layer\'s threshold');
  assert.equal((d.weights.length - 2) / 2, denseWeightBytes(12, [{ hidden: 8 }], 4, 8));
  assert.equal(denseWeightBytes(12, [{ hidden: 8 }], 4, 8), 13 * 32 + 9 * 32, 'one 32-byte word per column (up to 32 int8 rows), the int16 bias column included');
  assert.equal(denseWeightBytes(40, [{ hidden: 40 }], 4, 8), 40 * 64 + 3 * 32 + 40 * 32 + 32, '40 rows: two int8 words per column, three int16 bias words');
  assert.equal(denseWeightBytes(40, [{ hidden: 40 }], 4, 16), 41 * 96 + 41 * 32, 'int16: three words per column, bias column alike');
  assert.equal(d.weights.slice(2, 6), '0af6', 'column 0 starts with W1[0][0] = 1·10, then W1[1][0] = −1·10, one byte each');
  assert.equal(d.weights.slice(2 + 64 * 12, 2 + 64 * 12 + 8), '0064ff92', 'the bias column is int16: b1[0] = 10·10, b1[1] = −11·10');
  const wide = deploymentOf(await denseArtifact({ weightBits: 16 }));
  assert.equal(wide.weights.slice(2, 10), '09c4f63c', 'int16: W1[0][0] = 2500, W1[1][0] = −2500, two bytes each');
  assert.equal(wide.shape[1] >> 24n & 0xffn, 16n);
  const taskId = await taskIdOf(a);
  assert.match(taskId, /^0x[0-9a-f]{64}$/);
  assert.equal(taskId, await envHash(a.bundle));
  const other = await denseArtifact(FF);
  assert.notEqual(other.id, a.id);
  assert.equal(await taskIdOf(other), taskId, 'a different model on the same loop keeps the task identity');
  assert.equal(deploymentOf(other).shape[2], 1n, 'an FF layer fires at 1');
});

test('the threshold engine\'s shape carries the width and every layer\'s shift', async () => {
  const deep = await deepThresholdArtifact((await builtinArtifacts()).find(e => e.name === 'arithmetic-add4').artifact);
  assert.deepEqual(deploymentOf(deep).shape, [8n | (6n << 16n) | (4n << 32n) | (5n << 48n), 8n | (1n << 13n)]);
});

test('deploymentOf rejects width disagreement between the model and the snapshot network', async () => {
  const a = await denseArtifact();
  const net = Object.keys(a.bundle.loop.nodes).find(id => a.bundle.loop.nodes[id].kind === 'network');
  const mutated = structuredClone(a); mutated.bundle.loop.nodes[net].structure.layers = [{ hidden: 9 }];
  assert.throws(() => deploymentOf(mutated), /稠密模型宽度/);
});

test('deploymentProblem mirrors the on-chain limits', () => {
  const dense = (inputs, hidden, outputs, kind = 'feedforward') => ({ engine: 'dense-policy', kind, inputs, layers: [hidden].flat().map(h => ({ hidden: h })), outputs });
  assert.equal(deploymentProblem(dense(12, 8, 4)), null);
  assert.equal(deploymentProblem(dense(240, 256, 240)), null, 'weights over one chunk deploy across several');
  assert.match(deploymentProblem(dense(0, 8, 4)), /inputs/);
  assert.match(deploymentProblem(dense(12, 8, 257)), /outputs/);
  assert.match(deploymentProblem(dense(12, 300, 4)), /hidden/);
  assert.equal(deploymentProblem(dense(12, [8, 8], 4)), null, 'several plain layers deploy');
  assert.match(deploymentProblem(dense(12, [1, 1, 1, 1, 1, 1, 1, 1, 1], 4)), /1\.\.8/);
  assert.equal(deploymentProblem(dense(12, [128, 128], 4, 'lif')), null, '256 LIF neurons fill the state');
  assert.match(deploymentProblem(dense(12, [128, 129], 4, 'lif')), /257/);
  assert.equal(deploymentProblem(dense(12, [128, 129], 4)), null, 'FF keeps no state');
  const toolLayer = { engine: 'dense-policy', kind: 'feedforward', inputs: 4, layers: [{ hidden: 4 }, { tools: 'tools', K: 2, D: 2, R: 1 }], outputs: 1 };
  const net = { kind: 'net', artifactId: '0x' + '1'.repeat(64), structure: { engine: 'threshold-layers', kind: 'feedforward', inputs: 2, outputs: 1, layers: [2] } };
  assert.equal(deploymentProblem(toolLayer, [net, net]), null);
  assert.match(deploymentProblem(toolLayer, [net, { kind: 'program' }]), /代码工具不能部署/);
  assert.match(deploymentProblem(toolLayer, [net, { ...net, structure: { ...net.structure, inputs: 300 } }]), /工具 2.*inputs/);
  const threshold = (inputs, layers, outputs) => ({ engine: 'threshold-layers', inputs, layers, outputs });
  assert.equal(deploymentProblem(threshold(8, [16], 4)), null);
  assert.equal(deploymentProblem(threshold(8, [1, 1, 1, 1, 1, 1, 1], 4)), null, '7 hidden + output = 8 layers');
  assert.match(deploymentProblem(threshold(8, [1, 1, 1, 1, 1, 1, 1, 1], 4)), /1\.\.8/);
  assert.equal(deploymentProblem(threshold(256, [256, 256], 256)), null);
  assert.match(deploymentProblem({ engine: 'other' }), /other/);
});

// ------------------------------------------------------------------------------------------------ on a local chain
// The contracts on anvil (anvil.fixture.js), driven through this module exactly as the deployment session drives it.
// Skipped without Foundry.

const builtins = await builtinArtifacts();
const builtin = name => builtins.find(e => e.name === name).artifact;
const artifacts = id => builtins.find(e => e.artifact.id === id)?.artifact ?? null;
/** The browser executor of an artifact's trained network, its tools called as the loop calls them. */
function browserExecutor(artifact) {
  const tr = trainedOf(artifact.bundle.loop), n = artifact.bundle.loop.nodes[tr.id];
  return createExecutor(artifact.model, tr.structure, { tools: n.tools ? toolCaller(tr.id, n) : null });
}

test('the combiner on chain: ADD4 / SUB4 / MUL4 deploy once, a second selector reuses them, and every test question decides bit for bit as in the browser', { skip: NO_FOUNDRY, timeout: 120_000 }, async () => {
  const chain = await localChain();
  try {
    const combiner = builtin('arithmetic-combiner-policy'), toolIds = ['add4', 'sub4', 'mul4'].map(n => builtin(`arithmetic-${n}`).id);
    const factory = new ethers.Contract(chain.factory, FactoryABI, chain.provider), sent = () => chain.provider.getTransactionCount(chain.signer.address);
    let nonce = await sent();
    const first = await deployModule(chain.signer, chain.factory, combiner, { artifacts });
    assert.deepEqual(first.tools.map(x => [x.artifactId, x.reused]), toolIds.map(id => [id, false]), 'tools deployed first, in wire order');
    assert.equal(await factory.count(), 4n);
    assert.equal(await sent() - nonce, 4, 'one transaction per module, its weight chunk included');
    assert.deepEqual([...first.tools, first].map(x => x.transactions.map(tx => tx.kind)), [['module'], ['module'], ['module'], ['module']]);
    nonce = await sent();
    const second = await deployModule(chain.signer, chain.factory, combiner, { artifacts });
    assert.equal(await sent() - nonce, 1, 'the second selector: one transaction');
    assert.deepEqual(second.tools.map(x => [x.address, x.reused]), first.tools.map(x => [x.address, true]), 'the second selector reuses the three tool modules');
    assert.equal(await factory.count(), 5n, 'only the selector was deployed again');
    assert.notEqual(second.address, first.address);
    assert.ok(first.chunks.length === 1 && first.chunks[0].created, 'the selector\'s weights: one new chunk');
    assert.deepEqual(second.chunks.map(c => [c.address, c.created]), first.chunks.map(c => [c.address, false]), 'the same weights: no new chunk');
    assert.equal(await factory.chunkAddress(first.chunks[0].id), first.chunks[0].address, 'the bridge computes chunk addresses as the Factory does');
    const checked = await verifyModule(chain.provider, second.address, combiner, { artifacts, factory: chain.factory });
    assert.deepEqual(checked.toolModules.map(x => x.address), first.tools.map(x => x.address));
    await assert.rejects(verifyModule(chain.provider, second.address, combiner, { factory: chain.factory }), /不在工作区/, 'verification covers the tools, so it needs their artifacts');
    await assert.rejects(verifyModule(chain.provider, second.address, combiner, { artifacts }), /官方 Factory/, 'verification needs the official factory');
    await assert.rejects(verifyModule(chain.provider, second.address, combiner, { artifacts, factory: '0x' + '1'.repeat(40) }), /factory/, 'a module of another Factory does not verify');

    const graph = new ModuleGraph(), { ids } = instantiateInto(graph, builtinTemplate('arithmetic-combiner'), { x: 0, y: 0 });
    const episodes = episodesOf(buildBundle(graph, ids.evaluator, { artifacts }).partitions.test);
    assert.equal(episodes.length, 154);
    const local = browserExecutor(combiner), spec = trainedOf(combiner.bundle.loop).readout;
    for (const start of episodes) {
      const env = createEnv(combiner.bundle.env); env.reset(start);
      const input = env.input(), want = local.step(input), got = await inferModule(chain.provider, first.address, input);
      assert.deepEqual(got, { scores: want.scores, action: want.scores.indexOf(Math.max(...want.scores)), counts: want.counts, voltages: want.voltages }, `${start.op} ${start.a} ${start.b}`);
      assert.equal(env.step(readout(spec, got.scores).action).success, true, `${start.op} ${start.a} ${start.b}: the chain's answer is right`);
    }
    const env = createEnv(combiner.bundle.env); env.reset(episodes[1]);
    const stepped = await stepModule(chain.signer, first.address, env.input(), sessionId('combiner'));
    assert.deepEqual(stepped.scores, local.step(env.input()).scores, 'a step transaction commits the same decision');
  } finally { chain.stop(); }
});

test('the official factory on local dev: contracts/script/Deploy.s.sol broadcast from account 0 on a fresh anvil, and the fixture deploying in its order, both put the factory proxy at the address frontend/chain.js lists for 31337', { skip: NO_FOUNDRY, timeout: 180_000 }, async () => {
  const drift = 'the deployment order or account changed: update CHAINS[31337].factory together with Deploy.s.sol and anvil.fixture.js';
  const node = await startAnvil();
  try {
    const [account0] = await node.provider.listAccounts();
    execFileSync(FORGE, ['script', 'script/Deploy.s.sol', '--rpc-url', node.url, '--unlocked', '--sender', account0.address, '--broadcast'], { cwd: new URL('../contracts/', import.meta.url), stdio: 'ignore' });
    const official = new ethers.Contract(CHAINS[31337].factory, FactoryABI, node.provider);
    for (const id of ['dense-policy', 'threshold-layers']) assert.notEqual(await official.latestOf(ethers.id(id)).catch(() => ethers.ZeroAddress), ethers.ZeroAddress, `${drift} (the script's factory with ${id} is not there)`);
  } finally { node.stop(); }
  const chain = await localChain();
  try {
    assert.equal(await chain.signer.getAddress(), (await chain.provider.listAccounts())[0].address, 'the fixture deploys from account 0');
    assert.equal(chain.factory, CHAINS[31337].factory, drift);
  } finally { chain.stop(); }
});

test('only the official factory: modules of a second factory with the same code and weights are refused for verify and are never reused as tools', { skip: NO_FOUNDRY, timeout: 180_000 }, async () => {
  const chain = await localChain();
  try {
    const combiner = builtin('arithmetic-combiner-policy'), add4 = builtin('arithmetic-add4'), other = await chain.otherFactory();
    const copy = await deployModule(chain.signer, other, combiner, { artifacts });
    const there = await verifyModule(chain.provider, copy.address, combiner, { artifacts, factory: other });
    assert.deepEqual(there.toolModules.map(x => x.address), copy.tools.map(x => x.address), 'genuine on its own factory: the same code and weights');
    await assert.rejects(verifyModule(chain.provider, copy.address, combiner, { artifacts, factory: chain.factory }), /factory/, 'the selector of another factory does not verify');
    await assert.rejects(verifyModule(chain.provider, copy.tools[0].address, add4, { artifacts, factory: chain.factory }), /factory/, 'nor its tool');

    const plan = await planDeployment(chain.provider, chain.factory, combiner, { artifacts, from: chain.signer.address });
    assert.deepEqual(plan.tools.map(x => x.address), [null, null, null], 'the other factory\'s tool modules are not offered for reuse');
    const mine = await deployModule(chain.signer, chain.factory, combiner, { artifacts });
    assert.ok(mine.tools.every((x, k) => x.reused === false && x.address !== copy.tools[k].address), 'the official deployment creates its own tool modules');
    const checked = await verifyModule(chain.provider, mine.address, combiner, { artifacts, factory: chain.factory });
    assert.deepEqual(checked.toolModules.map(x => x.address), mine.tools.map(x => x.address));
    await assert.rejects(verifyModule(chain.provider, mine.address, combiner, { artifacts, factory: other }), /factory/, 'and the official module is no module of the other factory');
  } finally { chain.stop(); }
});

test('the default mining-sized network (FF 185 → 32 → 7) deploys in one transaction, its weight chunk included, and decides bit for bit at both widths', { skip: NO_FOUNDRY, timeout: 120_000 }, async () => {
  const chain = await localChain();
  try {
    for (const weightBits of [8, 16]) {
      const net = await denseArtifact({ ...FF, weightBits, I: 185, H: 32, O: 7 });
      const nonce = await chain.provider.getTransactionCount(chain.signer.address);
      const r = await deployModule(chain.signer, chain.factory, net, { artifacts });
      assert.equal(await chain.provider.getTransactionCount(chain.signer.address) - nonce, 1);
      assert.deepEqual(r.transactions.map(tx => [tx.kind, tx.txHash]), [['module', r.txHash]]);
      assert.deepEqual(r.chunks.map(c => [c.created, c.txHash, c.bytes]), [[true, r.txHash, denseWeightBytes(185, [{ hidden: 32 }], 7, weightBits)]], `int${weightBits}: the chunk came with the module`);
      const local = browserExecutor(net);
      for (let t = 0; t < 4; t++) {
        const bits = Array.from({ length: 185 }, (_, i) => ((5 * t + 7 * i) % 9 === 0 ? 1 : 0)), want = local.step(bits);
        assert.deepEqual(await inferModule(chain.provider, r.address, bits), { scores: want.scores, action: want.scores.indexOf(Math.max(...want.scores)), counts: want.counts, voltages: want.voltages }, `int${weightBits} input ${t}`);
      }
    }
  } finally { chain.stop(); }
});

/** The deployment plan of `artifact` read through the provider, as the deployer would send it (the deployment session's way). */
const planOf = (chain, artifact) => planDeployment(chain.provider, chain.factory, artifact, { artifacts, from: chain.signer.address });
/** The kinds of a plan's transactions, each with the number of chunks it creates. */
const planned = plan => plan.transactions.map(tx => [tx.kind, tx.chunks.length]);
const counts = plan => ({ needed: plan.chunks.length, onChain: plan.chunks.filter(c => c.onChain).length });

test('weights too big for one transaction: the plan and the deployment send the missing chunks first, the module and the rest in the last; it decides bit for bit, an artifact with the same weights creates no chunk, one sharing the first chunk creates only the second', { skip: NO_FOUNDRY, timeout: 180_000 }, async () => {
  const chain = await localChain();
  try {
    const big = await denseArtifact({ ...FF, weightBits: 16, I: 240, H: 256, O: 16 });
    const bytes = (deploymentOf(big).weights.length - 2) / 2;
    assert.equal(bytes, 241 * 16 * 32 + 257 * 32, '131,616 weight bytes');
    const plan = await planOf(chain, big);
    assert.deepEqual(counts(plan), { needed: 2, onChain: 0 });
    assert.deepEqual(planned(plan), [['chunk', 1], ['module', 1]], 'planned: chunk 1 alone, chunk 2 with the module');
    assert.deepEqual(plan.transactions.map(tx => tx.bytes), [CHUNK_BYTES, bytes - CHUNK_BYTES]);
    assert.ok(BigInt(plan.transactions[0].gas) > 0n, 'the chunk transaction has its gas estimate');
    const moduleGas = plan.transactions[1].gas;   // known only when the whole deployment fits the node's estimate allowance (anvil: the 30M block limit), which it straddles
    assert.ok(moduleGas === null || BigInt(moduleGas) > 0n, 'the module transaction: an estimate, or pending');
    const first = await deployModule(chain.signer, chain.factory, big, { artifacts });
    assert.deepEqual(first.transactions.map(tx => tx.kind), ['chunk', 'module'], 'split by gas: chunk 1 alone, chunk 2 with the module');
    assert.deepEqual(first.chunks.map(c => [c.bytes, c.created, c.txHash]), [[CHUNK_BYTES, true, first.transactions[0].txHash], [bytes - CHUNK_BYTES, true, first.txHash]]);
    const local = browserExecutor(big);
    for (let t = 0; t < 6; t++) {
      const bits = Array.from({ length: 240 }, (_, i) => ((7 * t + 3 * i) % 11 < 2 ? 1 : 0)), want = local.step(bits);
      const got = await inferModule(chain.provider, first.address, bits);
      assert.deepEqual(got, { scores: want.scores, action: want.scores.indexOf(Math.max(...want.scores)), counts: want.counts, voltages: want.voltages }, `input ${t}`);
    }
    const twin = await denseArtifact({ ...FF, weightBits: 16, I: 240, H: 256, O: 16, provenance: { test: 'module-chain', twin: true } });
    assert.notEqual(twin.id, big.id);
    const twinPlan = await planOf(chain, twin);
    assert.deepEqual([counts(twinPlan), planned(twinPlan)], [{ needed: 2, onChain: 2 }, [['module', 0]]]);
    const second = await deployModule(chain.signer, chain.factory, twin, { artifacts });
    assert.notEqual(second.address, first.address);
    assert.deepEqual(second.chunks.map(c => [c.address, c.created]), first.chunks.map(c => [c.address, false]), 'every chunk reused');
    assert.deepEqual(second.transactions.map(tx => tx.kind), ['module'], 'one transaction: the module alone');
    assert.deepEqual(weightChunks(deploymentOf(twin).weights).map(c => chunkAddress(chain.factory, c.id)), first.chunks.map(c => c.address));

    const sibling = await denseArtifact({ ...FF, weightBits: 16, I: 240, H: 256, O: 16, tail: 1 });
    const siblingPlan = await planOf(chain, sibling);
    assert.equal(siblingPlan.chunks[0].address, first.chunks[0].address, 'the first chunk is shared');
    assert.notEqual(siblingPlan.chunks[1].address, first.chunks[1].address, 'the output biases sit in the second');
    assert.deepEqual([counts(siblingPlan), planned(siblingPlan)], [{ needed: 2, onChain: 1 }, [['module', 1]]]);
    assert.ok(BigInt(siblingPlan.transactions[0].gas) > 0n, 'with chunk 1 on chain the whole deployment can be estimated');
    const third = await deployModule(chain.signer, chain.factory, sibling, { artifacts });
    assert.deepEqual(third.chunks.map(c => c.created), [false, true], 'only the new chunk is created');
    assert.deepEqual(third.transactions.map(tx => tx.kind), ['module'], 'with the module, in one transaction');
    const bits = Array.from({ length: 240 }, (_, i) => (i % 3 === 0 ? 1 : 0)), want = browserExecutor(sibling).step(bits);
    assert.deepEqual((await inferModule(chain.provider, third.address, bits)).scores, want.scores);
  } finally { chain.stop(); }
});

/** `signer` whose `n`-th transaction fails before it is sent (a rejected wallet prompt, a dropped connection). */
function failingAt(signer, n) {
  let sent = 0;
  return new Proxy(signer, {
    get(target, key) {
      if (key === 'sendTransaction') return async tx => { if (++sent === n) throw new Error('simulated failure'); return target.sendTransaction(tx); };
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

test('an interrupted split deployment resumes: the second of three transactions fails, deploying again sends only what is missing, no chunk is created twice, and the module decides bit for bit', { skip: NO_FOUNDRY, timeout: 240_000 }, async () => {
  const chain = await localChain();
  try {
    const net = await denseArtifact({ ...FF, weightBits: 16, I: 256, H: 256, O: 256 });
    const before = await planOf(chain, net);
    assert.equal(new Set(before.chunks.map(c => c.address)).size, 3, 'three distinct chunks');
    assert.deepEqual([counts(before), planned(before)], [{ needed: 3, onChain: 0 }, [['chunk', 1], ['chunk', 1], ['module', 1]]]);
    const events = [];
    await assert.rejects(deployModule(failingAt(chain.signer, 2), chain.factory, net, { artifacts, onProgress: e => events.push([e.stage, e.kind, e.chunks.length]) }), /simulated failure/);
    assert.deepEqual(events, [['sending', 'chunk', 1], ['mined', 'chunk', 1], ['sending', 'chunk', 1]], 'progress per transaction: the first mined, the second failed');
    const after = await planOf(chain, net);
    assert.deepEqual(after.chunks.map(c => c.onChain), [true, false, false]);
    assert.deepEqual(planned(after), [['chunk', 1], ['module', 1]], 'what is left: chunk 2, then chunk 3 with the module');
    const resumed = [], r = await deployModule(chain.signer, chain.factory, net, { artifacts, onProgress: e => { if (e.stage === 'mined') resumed.push([e.kind, e.txHash, e.gasUsed]); } });
    assert.deepEqual(r.chunks.map(c => c.created), [false, true, true], 'the chunk already on chain is not sent again');
    assert.deepEqual(resumed, r.transactions.map(tx => [tx.kind, tx.txHash, tx.gasUsed]));
    assert.deepEqual(resumed.map(x => x[0]), ['chunk', 'module']);
    const factory = new ethers.Contract(chain.factory, FactoryABI, chain.provider);
    const created = (await factory.queryFilter(factory.filters.ChunkCreated())).map(ev => ev.args.chunk);
    assert.deepEqual(created, r.chunks.map(c => c.address), 'every chunk created exactly once, in order');
    assert.equal(await factory.count(), 1n);
    const local = browserExecutor(net);
    for (let t = 0; t < 4; t++) {
      const bits = Array.from({ length: 256 }, (_, i) => ((5 * t + 3 * i) % 7 < 2 ? 1 : 0)), want = local.step(bits);
      assert.deepEqual(await inferModule(chain.provider, r.address, bits), { scores: want.scores, action: want.scores.indexOf(Math.max(...want.scores)), counts: want.counts, voltages: want.voltages }, `input ${t}`);
    }
  } finally { chain.stop(); }
});

test('identical chunks of one artifact are created once: all-zero weights over three chunks, two of them the same', { skip: NO_FOUNDRY, timeout: 180_000 }, async () => {
  const chain = await localChain();
  try {
    const flat = await denseArtifact({ ...FF, weightBits: 16, I: 256, H: 256, O: 256, zero: true });
    const r = await deployModule(chain.signer, chain.factory, flat, { artifacts });
    assert.equal(r.chunks.length, 3);
    assert.equal(r.chunks[0].address, r.chunks[1].address, 'chunks 1 and 2 hold the same zeros');
    assert.deepEqual(r.chunks.map(c => c.created), [true, false, true], 'the repeat is never sent');
    assert.deepEqual(r.transactions.map(tx => tx.kind), ['chunk', 'module'], 'no transaction for the repeat');
    const want = browserExecutor(flat).step(Array(256).fill(1));
    assert.deepEqual((await inferModule(chain.provider, r.address, Array(256).fill(1))).scores, want.scores);
  } finally { chain.stop(); }
});

test('a one-layer LIF artifact steps on chain exactly as the browser executor at both widths, its potentials included', { skip: NO_FOUNDRY, timeout: 60_000 }, async () => {
  const chain = await localChain();
  try {
    for (const weightBits of [8, 16]) {
      const lif = await denseArtifact({ weightBits }), I = trainedOf(lif.bundle.loop).structure.inputs, local = browserExecutor(lif);
      const { address } = await deployModule(chain.signer, chain.factory, lif, { artifacts });
      let spikes = 0;
      for (let t = 0; t < 6; t++) {
        const bits = Array.from({ length: I }, (_, i) => ((7 * t + 3 * i) % 5 < 2 ? 1 : 0));
        const got = await stepModule(chain.signer, address, bits, sessionId('lif')), want = local.step(bits);
        assert.deepEqual([got.scores, got.counts, got.voltages], [want.scores, want.counts, want.voltages], `int${weightBits} step ${t}`);
        spikes += want.counts.reduce((s, c) => s + c, 0);
      }
      assert.ok(spikes > 0, `int${weightBits}: the hidden layer fires`);
    }
  } finally { chain.stop(); }
});

test('engine versions: a deployment takes the latest unless it names an older version of its engine id, reusing the chunks; each module keeps its version and steps bit for bit; verification reports the version and refuses one the Factory does not list', { skip: NO_FOUNDRY, timeout: 120_000 }, async () => {
  const chain = await localChain();
  try {
    const lif = await denseArtifact(), I = trainedOf(lif.bundle.loop).structure.inputs, id = ethers.id('dense-policy'), v1 = chain.engines['dense-policy'];
    const factory = new ethers.Contract(chain.factory, FactoryABI, chain.signer);
    const first = await deployModule(chain.signer, chain.factory, lif, { artifacts });
    assert.deepEqual(first.engineVersion, { address: v1, number: 1, latest: true });
    const v2 = await (await deployOut(chain.signer, 'DensePolicyEngine')).getAddress();
    await (await factory.addVersion(id, v2)).wait();
    await (await factory.setLatest(id, v2)).wait();
    const plan = await planDeployment(chain.provider, chain.factory, lif, { artifacts, from: chain.signer.address });
    assert.deepEqual([plan.chunks.every(c => c.onChain), plan.transactions.length], [true, 1], 'the module alone');
    const second = await deployModule(chain.signer, chain.factory, lif, { artifacts });
    assert.deepEqual(second.engineVersion, { address: v2, number: 2, latest: true }, 'a new deployment takes the latest');
    assert.ok(second.chunks.every(c => !c.created), 'on the chunks already on chain');
    const older = await deployModule(chain.signer, chain.factory, lif, { artifacts, version: v1 });
    assert.deepEqual(older.engineVersion, { address: v1, number: 1, latest: false }, 'an older version can be named');
    const h = await verifyModule(chain.provider, first.address, lif, { artifacts, factory: chain.factory });
    assert.deepEqual([h.engineAddress, h.engineVersion], [v1, { address: v1, number: 1, latest: false }], 'the first module keeps version 1');
    for (const address of [first.address, second.address, older.address]) {
      const local = browserExecutor(lif), session = sessionId(`versions ${address}`);
      for (let t = 0; t < 4; t++) {
        const bits = Array.from({ length: I }, (_, i) => ((5 * t + 3 * i) % 4 < 2 ? 1 : 0));
        const got = await stepModule(chain.signer, address, bits, session), want = local.step(bits);
        assert.deepEqual([got.scores, got.counts, got.voltages], [want.scores, want.counts, want.voltages], `${address} step ${t}`);
      }
      await resetModule(chain.signer, address, session);
    }
    await assert.rejects(deployModule(chain.signer, chain.factory, lif, { artifacts, version: chain.engines['threshold-layers'] }), /version/, 'a version of another engine id is refused');

    // A Factory whose list no longer holds the version of the module (only a faulty upgrade could cause this). Empty
    // the dense-policy list in the storage of the proxy. Verification then refuses the module.
    const layout = JSON.parse(execFileSync(FORGE, ['inspect', 'ModuleFactory', 'storageLayout', '--json'], { cwd: new URL('../contracts/', import.meta.url), encoding: 'utf8' }));
    const slot = layout.storage.find(s => s.label === '_versions').slot;
    await chain.provider.send('anvil_setStorageAt', [chain.factory, ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [id, slot])), ethers.ZeroHash]);
    assert.equal((await factory.versionsOf(id)).length, 0);
    await assert.rejects(verifyModule(chain.provider, first.address, lif, { artifacts, factory: chain.factory }), /不是 Factory 为 dense-policy 列出的版本/);
  } finally { chain.stop(); }
});

test('stateful and nested tools on chain: a LIF selector with a LIF tool and a selector whose tool has its own tool layer step bit for bit as the browser, state included, across resets and sessions', { skip: NO_FOUNDRY, timeout: 180_000 }, async () => {
  const chain = await localChain();
  try {
    const factory = new ethers.Contract(chain.factory, FactoryABI, chain.provider);
    for (const weightBits of [8, 16]) {
      const made = await toolNetworkArtifacts({ add4: builtin('arithmetic-add4'), sub4: builtin('arithmetic-sub4'), mul4: builtin('arithmetic-mul4'), combiner: builtin('arithmetic-combiner-policy') }, { weightBits });
      const known = id => Object.values(made).find(a => a.id === id) ?? artifacts(id);
      for (const [name, artifact, width, depth] of [['LIF selector', made.lifSelector, 16 + 6, 1], ['nested selector', made.nestedSelector, 6, 2]]) {
        const label = `${name} int${weightBits}`, d = await deployModule(chain.signer, chain.factory, artifact, { artifacts: known });
        const h = await verifyModule(chain.provider, d.address, artifact, { artifacts: known, factory: chain.factory });
        assert.deepEqual([h.stateWidth, Number(await factory.depthOf(d.address))], [width, depth], `${label}: the selector keeps its tools' state; depth ${depth}`);
        const I = trainedOf(artifact.bundle.loop).structure.inputs, local = browserExecutor(artifact), other = browserExecutor(artifact);
        const bitsAt = t => Array.from({ length: I }, (_, i) => ((7 * t + 3 * i + (t >> 2)) % 5 < 2 ? 1 : 0));
        const states = new Set(), choices = new Set();
        for (let t = 0; t < 10; t++) {
          if (t === 6) { await resetModule(chain.signer, d.address, sessionId('a')); local.reset(); }
          const got = await stepModule(chain.signer, d.address, bitsAt(t), sessionId('a')), want = local.step(bitsAt(t));
          assert.deepEqual([got.scores, got.counts, got.voltages], [want.scores, want.counts, want.voltages], `${label} step ${t}`);
          states.add(want.voltages.join(',')); choices.add(want.tools.tools.choice);
        }
        assert.ok(states.size > 3 && choices.size > 1, `${label}: the tools' state moves and more than one tool is chosen`);
        const b = await stepModule(chain.signer, d.address, bitsAt(3), sessionId('b'));
        assert.deepEqual(b.voltages, other.step(bitsAt(3)).voltages, `${label}: another session starts from rest`);
        assert.deepEqual(await moduleState(chain.provider, d.address, chain.signer.address, sessionId('a')), local.voltages(), `${label}: session a is untouched by session b`);
        const tool = h.toolModules[0].address;
        assert.ok((await moduleState(chain.provider, tool, d.address, sessionId('a'))).every(v => v === 0), `${label}: the tool module keeps nothing of its own for the selector`);
      }
    }
  } finally { chain.stop(); }
});

test('a threshold artifact with two hidden layers decides on chain exactly as the browser executor at both widths, counts included', { skip: NO_FOUNDRY, timeout: 60_000 }, async () => {
  const chain = await localChain();
  try {
    for (const weightBits of [8, 16]) {
      const deep = await deepThresholdArtifact(builtin('arithmetic-add4'), { weightBits }), local = browserExecutor(deep), second = new Set();
      const { address } = await deployModule(chain.signer, chain.factory, deep, { artifacts });
      for (let x = 0; x < 256; x++) {
        const bits = Array.from({ length: 8 }, (_, i) => (x >> i) & 1), want = local.step(bits);
        const got = await inferModule(chain.provider, address, bits);
        assert.deepEqual(got, { scores: want.scores, action: want.scores.indexOf(Math.max(...want.scores)), counts: want.counts, voltages: want.voltages }, `int${weightBits} input ${x}`);
        second.add(got.counts.slice(6).join(''));
      }
      assert.ok(second.size > 1, 'the second hidden layer is not constant over the inputs');
      const stepped = await stepModule(chain.signer, address, [1, 0, 1, 1, 0, 0, 1, 0], sessionId('deep'));
      assert.deepEqual(stepped.counts, local.step([1, 0, 1, 1, 0, 0, 1, 0]).counts, 'a step transaction commits the same counts');
    }
  } finally { chain.stop(); }
});
