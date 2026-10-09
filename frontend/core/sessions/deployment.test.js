import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workspace, makeArtifact } from '../store.js';
import { buildBundle } from '../bundle.js';
import { createDeploymentSession } from './deployment.js';
import { createExecutor } from './executor.js';
import { counterArtifact, counterModel, deepThresholdArtifact, firingCounterModel } from './fixtures.js';
import { builtinArtifacts } from '../../templates/artifacts/index.js';
import { NO_FOUNDRY, localChain } from '../../anvil.fixture.js';

const FACTORY = '0x' + '1'.repeat(40), MODULE = '0x' + '2'.repeat(40), ACCOUNT = '0x' + 'a'.repeat(40);
const VERSION = { address: '0x' + '3'.repeat(40), number: 2, latest: false };

/** An in-memory chain for the session's control flow: it runs the deployed artifact's integer model itself (what
 *  the contracts do), keyed by session. Parity with the Solidity modules is the anvil tests' job (below). Every
 *  artifact has CHUNKS weight chunks of 1,000 bytes, created one per transaction except the last, which comes with the
 *  module. `failAt = n` fails the n-th transaction sent from then on. */
const CHUNKS = 3;
function fakeChain() {
  const modules = new Map(), calls = [], onChain = new Set();
  let n = 0;
  const receipt = () => ({ txHash: '0x' + String(++n).padStart(64, '0'), gasUsed: '1000' });
  const decision = r => ({ scores: r.scores, counts: r.counts, voltages: r.voltages, action: r.scores.indexOf(Math.max(...r.scores)) });
  const chunksOf = artifact => Array.from({ length: CHUNKS }, (_, k) => `${artifact.id}:${k}`);
  const planOf = artifact => {
    const missing = chunksOf(artifact).filter(c => !onChain.has(c)), tx = (kind, chunks) => ({ artifactId: artifact.id, tool: false, kind, chunks, bytes: 1000 * chunks.length, gas: '500' });
    return { chunks: chunksOf(artifact).map(address => ({ artifactId: artifact.id, address, bytes: 1000, onChain: onChain.has(address) })), tools: [],
      transactions: [...missing.slice(0, -1).map(c => tx('chunk', [c])), tx('module', missing.slice(-1))] };
  };
  const chain = {
    calls, failAt: null,
    sessionId: label => '0x' + Buffer.from(label).toString('hex').padEnd(64, '0'),
    planDelay: 0,
    async planDeployment(provider, factory, artifact) { calls.push(['plan', factory]); const p = planOf(artifact); if (chain.planDelay) await new Promise(r => setTimeout(r, chain.planDelay)); return p; },
    async deployModule(signer, factory, artifact, { onProgress = () => {} } = {}) {
      calls.push(['deploy', factory]);
      let sent = 0;
      for (const tx of planOf(artifact).transactions) {
        onProgress({ ...tx, stage: 'sending' });
        if (++sent === chain.failAt) throw new Error('simulated failure');
        for (const c of tx.chunks) onChain.add(c);
        onProgress({ ...tx, stage: 'mined', ...receipt() });
      }
      modules.set(MODULE, { artifact, factory, sessions: new Map() });
      return { address: MODULE, artifactId: artifact.id, engineVersion: VERSION, ...receipt() };
    },
    async verifyModule(provider, address, artifact, { factory }) { calls.push(['verify', address]); const m = modules.get(address); if (!m || m.artifact.id !== artifact.id || m.factory !== factory) throw new Error('mismatch'); return { engineVersion: VERSION }; },
    async moduleState(provider, address, owner, session) { return modules.get(address).sessions.get(session)?.voltages() ?? []; },
    async inferModule(provider, address, input, { mode, session }) {
      const m = modules.get(address), stored = mode === 'peek' ? m.sessions.get(session) : null;
      return decision((stored ?? createExecutor(m.artifact.model)).peek(input));     // nothing persists
    },
    async stepModule(signer, address, input, session) {
      const m = modules.get(address); if (!m.sessions.has(session)) m.sessions.set(session, createExecutor(m.artifact.model));
      calls.push(['step', session]);
      return { ...decision(m.sessions.get(session).step(input)), ...receipt() };
    },
    async resetModule(signer, address, session) { modules.get(address).sessions.set(session, createExecutor(modules.get(address).artifact.model)); calls.push(['reset', session]); return receipt(); },
    modules,
  };
  return chain;
}
const connectChain = async chainId => ({ provider: {}, signer: {}, address: ACCOUNT, chainId });

async function setup() {
  const { graph, ids, artifact } = await counterArtifact(counterModel(1));
  const ws = new Workspace(graph);
  await ws.addArtifact(artifact);
  graph.patchConfig(ids.cands, { accepted: artifact.id });
  const dep = graph.addNode({ kind: 'deployment' });
  graph.connect({ kind: 'value', from: { node: ids.cands, port: 'artifact' }, to: { node: dep.id, port: 'artifact' } });
  ws.updateSettings({ chainId: 31337 });
  return { graph, ids, artifact, ws, dep };
}

test('deploy → record on the node → session; reset + step mirror the episode against the chain; verify reopens', async () => {
  const { graph, ids, artifact, ws, dep } = await setup();
  const chain = fakeChain();
  const s = createDeploymentSession({ workspace: ws, nodeId: dep.id, connectChain, chain, chains: { CHAINS: { 31337: { name: 'local', local: true, factory: FACTORY } }, explorerTx: () => null, explorerAddress: () => null } });
  let snap = s.snapshot();
  assert.equal(snap.artifact.id, artifact.id);
  assert.equal(snap.deployProblem, null);
  assert.equal(snap.can.deploy, true); assert.equal(snap.can.step, false);
  assert.match(snap.reasons.step, /会话/);
  snap = await s.deploy();
  assert.equal(snap.status.tone, 'ok');
  assert.deepEqual(graph.node(dep.id).config.deployments['31337'], { address: MODULE, artifactId: artifact.id, txHash: snap.deployment.txHash });
  assert.equal(snap.session.address, MODULE); assert.equal(snap.session.account, ACCOUNT);
  assert.deepEqual(snap.session.engineVersion, VERSION, 'the module\'s engine version');
  assert.equal(snap.can.reset, true); assert.equal(snap.can.step, false); assert.match(snap.reasons.step, /新一局/);
  snap = await s.reset();
  assert.equal(snap.episode.t, 0); assert.deepEqual(snap.episode.record, { seed: 1 });
  snap = await s.preview();
  assert.equal(snap.preview.action, 1); assert.equal(snap.preview.actionName, 'up'); assert.equal(snap.preview.mode, 'peek');
  assert.equal(snap.episode.t, 0, 'preview does not advance');
  snap = await s.step();
  assert.equal(snap.status.tone, 'ok', snap.status.text);
  assert.equal(snap.history.length, 1); assert.equal(snap.last.action, 1); assert.deepEqual(snap.episode.state, { count: 1, seed: 1 });
  await s.step(); snap = await s.step();
  assert.equal(snap.episode.done, true); assert.equal(snap.episode.success, true); assert.equal(snap.can.step, false);
  assert.equal(snap.episode.gasUsed, 3000);
  assert.deepEqual(chain.calls.filter(c => c[0] === 'step').length, 3);
  // label change kills the session, and verify against the record reopens it
  snap = s.setLabel('session-2');
  assert.equal(snap.session, null); assert.equal(snap.status.tone, 'warn');
  snap = await s.verify();
  assert.equal(snap.session.address, MODULE); assert.deepEqual(snap.session.engineVersion, VERSION);
  assert.equal(snap.history.length, 0);
  // a different accepted artifact invalidates and marks the deployment stale
  const other = await makeArtifact({ bundle: buildBundle(graph, ids.trainer), model: counterModel(0) });
  await ws.addArtifact(other);
  graph.patchConfig(ids.cands, { accepted: other.id });
  snap = s.snapshot();
  assert.equal(snap.session, null); assert.equal(snap.deployment.stale, true);
  snap = await s.verify();
  assert.equal(snap.status.tone, 'warn', 'verify fails: chain module is the old artifact');
  snap = s.bind(artifact.id);
  assert.equal(snap.deployment.stale, false);
  snap = await s.verify();
  assert.equal(snap.session.artifactId, artifact.id);
  s.dispose();
  assert.ok(s.snapshot().dead);
});

/** `chain[name]` answering honestly except for `edit(decision)`. */
const tamper = (chain, name, edit) => { const honest = chain[name]; chain[name] = async (...args) => edit(await honest(...args)); };

test('every chain decision is checked item by item: a read-only disagreement is reported, a step that disagrees kills the session (STATE_MISMATCH) and the env is not advanced', async () => {
  const { ws, dep } = await setup();
  const chain = fakeChain();
  const s = createDeploymentSession({ workspace: ws, nodeId: dep.id, connectChain, chain });
  await s.deploy(); await s.reset(); await s.step();
  tamper(chain, 'inferModule', r => ({ ...r, voltages: r.voltages.map(v => v + 1) }));
  let snap = await s.preview();
  assert.equal(snap.preview.same, false); assert.equal(snap.status.tone, 'warn'); assert.match(snap.status.text, /不一致/);
  assert.ok(snap.session, 'a preview persists nothing: the session lives on'); assert.equal(snap.episode.t, 1);
  tamper(chain, 'stepModule', r => ({ ...r, counts: r.counts.map(c => c + 1) }));
  snap = await s.step();
  assert.equal(snap.session, null, 'scores agree, counts do not');
  assert.match(snap.status.text, /不一致/);
  assert.equal(snap.history.length, 0); assert.equal(snap.episode, null);
});

test('a stateless module: infer and step compare counts too (a threshold artifact with two hidden layers)', async () => {
  const add4 = (await builtinArtifacts()).find(e => e.name === 'arithmetic-add4').artifact, deep = await deepThresholdArtifact(add4);
  const ws = new Workspace(); await ws.addArtifact(deep);
  const dep = ws.graph.addNode({ kind: 'deployment' });
  ws.updateSettings({ chainId: 31337 });
  const chain = fakeChain(), s = createDeploymentSession({ workspace: ws, nodeId: dep.id, connectChain, chain });
  s.bind(deep.id); await s.deploy();
  s.setInputBits([1, 0, 1, 1, 0, 0, 1, 0]);
  let snap = await s.infer();
  assert.equal(snap.infer.same, true); assert.equal(snap.status.tone, 'ok');
  snap = await s.step();
  assert.equal(snap.infer.source, 'step'); assert.equal(snap.status.tone, 'ok'); assert.equal(chain.calls.filter(c => c[0] === 'step').length, 1);
  tamper(chain, 'inferModule', r => ({ ...r, counts: r.counts.slice(0, 6) }));
  snap = await s.infer();
  assert.equal(snap.infer.same, false, 'only the first hidden layer: the old local projection'); assert.equal(snap.status.tone, 'warn'); assert.ok(snap.session);
  tamper(chain, 'stepModule', r => ({ ...r, counts: r.counts.slice(0, 6) }));
  snap = await s.step();
  assert.equal(snap.session, null); assert.match(snap.status.text, /不一致/);
});

test('the factory comes from the selected network, never from a setting; a network without an official factory says so and deploys, plans and verifies nothing', async () => {
  const { ws, dep } = await setup();
  const chain = fakeChain();
  const chains = { CHAINS: { 31337: { name: 'local', factory: FACTORY }, 10143: { name: 'testnet', factory: null } }, explorerTx: (id, h) => `https://x/${h}`, explorerAddress: (id, a) => `https://x/address/${a}` };
  const s = createDeploymentSession({ workspace: ws, nodeId: dep.id, connectChain, chain, chains });
  let snap = s.snapshot();
  assert.deepEqual([snap.factory, snap.factoryUrl, snap.factoryProblem], [FACTORY, `https://x/address/${FACTORY}`, null], 'the network\'s official factory, linked');
  await s.plan(); await s.deploy();
  const used = chain.calls.filter(c => c[0] === 'plan' || c[0] === 'deploy');
  assert.ok(used.some(c => c[0] === 'deploy') && used.every(c => c[1] === FACTORY), 'every plan and deployment goes to the network\'s factory');

  snap = s.setChainId(10143);
  assert.equal(ws.settings.chainId, 10143); assert.equal(snap.session, null); assert.equal(snap.deployment, null, 'no record on the other network');
  assert.deepEqual([snap.factory, snap.factoryUrl], [null, null]);
  assert.match(snap.factoryProblem, /testnet 还没有官方 Factory/);
  for (const k of ['deploy', 'plan', 'verify']) { assert.equal(snap.can[k], false, k); assert.equal(snap.reasons[k], snap.factoryProblem, k); }
  const asked = chain.calls.length;
  for (const op of ['deploy', 'plan', 'verify']) { snap = await s[op](); assert.equal(snap.status.tone, 'warn', op); assert.match(snap.status.text, /还没有官方 Factory/, op); }
  assert.equal(chain.calls.length, asked, 'nothing asked of the chain');
  assert.throws(() => s.setChainId(1), /不支持/);

  snap = s.setChainId(31337);
  assert.equal(snap.deployment.tx.url, `https://x/${snap.deployment.txHash}`);
  snap = await s.readState();
  assert.equal(snap.status.tone, 'warn', 'no session yet');
  snap = await s.verify();
  snap = await s.readState();
  assert.equal(snap.status.tone, 'info');
  assert.deepEqual(Object.keys(ws.settings), ['chainId'], 'no factory setting written');

  ws.updateSettings({ factory: '0x' + '4'.repeat(40) });   // a factory setting in the workspace: the session does not read it
  snap = await s.verify();
  assert.equal(snap.status.tone, 'ok', snap.status.text); assert.equal(snap.factory, FACTORY);
});

test('the deployment plan: chunks needed / on chain and the transactions left, per-transaction progress, and an interrupted deployment that resumes with only what is missing', async () => {
  const { graph, ids, ws, dep } = await setup();
  const chain = fakeChain(), statuses = [];
  const s = createDeploymentSession({ workspace: ws, nodeId: dep.id, connectChain, chain, chains: { CHAINS: { 31337: { name: 'local', local: true, factory: FACTORY }, 10143: { name: 'testnet', factory: '0x' + '3'.repeat(40) } }, explorerTx: (id, h) => `https://x/${h}`, explorerAddress: () => null }, onStatus: text => statuses.push(text) });
  let snap = s.snapshot();
  assert.equal(snap.deployPlan, null, 'nothing asked of the chain yet');
  assert.equal(snap.can.plan, true);
  snap = await s.connect();
  assert.deepEqual([snap.deployPlan.needed, snap.deployPlan.onChain, snap.deployPlan.transactions.length], [3, 0, 3], 'connecting asks for the plan');
  assert.match(snap.status.text, /权重块需要 3 个，链上已有 0 个。要发送 3 笔交易/);
  assert.deepEqual(snap.deployPlan.transactions.map(x => x.label), ['创建权重块（1,000 字节）', '创建权重块（1,000 字节）', '模块合约 + 1 个权重块（1,000 字节）']);

  chain.failAt = 2; chain.planDelay = 20;
  const seen = [], off = s.subscribe(kind => { if (kind === 'progress') { const p = s.snapshot(); seen.push([p.deployRun.done.length, p.deployPlan.onChain, p.deployPlan.transactions.length]); } });
  snap = await s.deploy();
  assert.equal(snap.status.tone, 'warn');
  assert.match(snap.status.text, /已上链 1 笔交易.*只发送还缺的 2 笔.*simulated failure/);
  off(); chain.planDelay = 0;
  assert.deepEqual(seen, [[1, 1, 2]], 'a mined transaction is crossed off at once, before the chain answers the new plan');
  const counted = () => statuses.map(x => x.match(/^第 \d+ \/ \d+ 笔/)?.[0]).filter(Boolean);
  assert.deepEqual(counted(), ['第 1 / 3 笔', '第 2 / 3 笔'], 'progress per transaction');
  assert.deepEqual(snap.deployRun.done.map(x => [x.kind, x.tx.url]), [['chunk', `https://x/0x${'1'.padStart(64, '0')}`]]);
  assert.equal(snap.deployRun.finished, false); assert.match(snap.deployRun.failed, /simulated/);
  assert.deepEqual([snap.deployPlan.onChain, snap.deployPlan.transactions.map(x => x.kind)], [1, ['chunk', 'module']], 'the plan after the failure: what is left');
  assert.equal(graph.node(dep.id).config.deployments['31337'], undefined, 'no module, no record');

  chain.failAt = null; statuses.length = 0;
  snap = await s.deploy();
  assert.equal(snap.status.tone, 'ok', snap.status.text);
  assert.deepEqual(counted(), ['第 1 / 2 笔', '第 2 / 2 笔'], 'only what was missing');
  assert.deepEqual([snap.deployRun.done.map(x => x.kind), snap.deployRun.finished], [['chunk', 'module'], true]);
  assert.deepEqual([snap.deployPlan.needed, snap.deployPlan.onChain], [3, 3], 'every chunk on chain now');
  snap = await s.plan();
  assert.deepEqual([snap.deployRun, snap.deployPlan.transactions.map(x => x.label)], [null, ['模块合约']], 'asked again: deploying once more sends the module alone');
  assert.equal(snap.session.address, MODULE);

  const other = await makeArtifact({ bundle: buildBundle(graph, ids.trainer), model: counterModel(0) });
  await ws.addArtifact(other);
  snap = s.bind(other.id);
  assert.deepEqual([snap.deployPlan, snap.deployRun], [null, null], 'plan and run belong to the artifact they describe');
  snap = await s.plan();
  assert.equal(snap.status.tone, 'info'); assert.equal(snap.deployPlan.onChain, 0);
  s.setChainId(10143);
  assert.equal(s.snapshot().deployPlan, null, 'and to the network (its factory)');
});

// ------------------------------------------------------------------------------------------------ over real contracts
// The same session interface on anvil (anvil.fixture.js) through the production bridge (module-chain.js): every
// decision it checks against the local mirror is the Solidity module's own. Skipped without Foundry.

/** A workspace holding the builtin artifacts plus `extra`, a deployment node on a fresh anvil's Factory, and its session. */
async function onAnvil(fn, extra = async () => null) {
  const net = await localChain(), ws = new Workspace(), builtins = await builtinArtifacts();
  for (const { artifact } of builtins) await ws.addArtifact(artifact);
  const byName = name => builtins.find(e => e.name === name).artifact, more = await extra(byName);
  if (more) await ws.addArtifact(more);
  const dep = ws.graph.addNode({ kind: 'deployment' });
  ws.updateSettings({ chainId: 31337 });
  const account = await net.signer.getAddress();
  const s = createDeploymentSession({ workspace: ws, nodeId: dep.id, connectChain: async chainId => ({ provider: net.provider, signer: net.signer, address: account, chainId }) });
  try { await fn({ s, byName, more }); } finally { s.dispose(); net.stop(); }
}
const ok = snap => assert.notEqual(snap.status.tone, 'warn', snap.status.text);

test('on anvil: a threshold artifact with two hidden layers infers and steps through the session, its counts agreeing with ThresholdLayersEngine', { skip: NO_FOUNDRY, timeout: 60_000 }, () => onAnvil(async ({ s, more: deep }) => {
  s.bind(deep.id);
  let snap = await s.deploy(); ok(snap);
  for (const bits of [[1, 0, 1, 1, 0, 0, 1, 0], [0, 1, 1, 0, 1, 1, 0, 1], [1, 1, 1, 1, 1, 1, 1, 1]]) {
    s.setInputBits(bits);
    snap = await s.infer(); ok(snap); assert.equal(snap.infer.same, true);
    snap = await s.step(); ok(snap); assert.equal(snap.infer.source, 'step'); assert.ok(snap.session);
  }
}, byName => deepThresholdArtifact(byName('arithmetic-add4'))));

test('on anvil: a LIF artifact plays an episode through the session — reset, peek previews and step transactions agree with the local mirror; verify reopens', { skip: NO_FOUNDRY, timeout: 60_000 }, () => onAnvil(async ({ s, more }) => {
  s.bind(more.id);
  let snap = await s.deploy(); ok(snap);
  assert.deepEqual([snap.session.engineVersion.number, snap.session.engineVersion.latest], [1, true], 'version 1 of dense-policy, the latest');
  snap = await s.reset(); ok(snap); assert.equal(snap.episode.t, 0);
  for (let k = 1; k <= 4 && !snap.episode.done; k++) {
    snap = await s.preview(); ok(snap); assert.equal(snap.preview.mode, 'peek'); assert.equal(snap.preview.same, true);
    const previewed = snap.preview.action;
    snap = await s.step(); ok(snap);
    assert.equal(snap.history.length, k); assert.equal(snap.last.action, previewed, 'the step takes the action the preview showed');
  }
  snap = await s.readState(); assert.equal(snap.status.tone, 'info');
  snap = s.setLabel('session-2'); assert.equal(snap.session, null);
  snap = await s.verify(); ok(snap); assert.equal(snap.session.engineVersion.number, 1);
  snap = await s.reset(); ok(snap);
  snap = await s.step(); ok(snap); assert.equal(snap.history.length, 1);
}, async () => (await counterArtifact(firingCounterModel())).artifact));

test('on anvil: the combiner (tool layers) deploys its tools through the session, a redeploy reuses them, and its episode steps to a correct answer', { skip: NO_FOUNDRY, timeout: 120_000 }, () => onAnvil(async ({ s, byName }) => {
  s.bind(byName('arithmetic-combiner-policy').id);
  let snap = await s.plan(); ok(snap);
  const tools = ['add4', 'sub4', 'mul4'].map(n => byName(`arithmetic-${n}`).id);
  assert.deepEqual(snap.deployPlan.tools.map(x => [x.artifactId, x.address]), tools.map(id => [id, null]), 'no tool module yet');
  assert.deepEqual(snap.deployPlan.transactions.map(x => [x.kind, x.tool]), [['module', true], ['module', true], ['module', true], ['module', false]], 'each tool, then the selector: one transaction each');
  assert.deepEqual([snap.deployPlan.needed, snap.deployPlan.onChain], [4, 0]);
  snap = await s.deploy(); ok(snap);
  assert.deepEqual(snap.session.tools.map(x => [x.artifactId, x.reused]), tools.map(id => [id, false]));
  assert.match(snap.status.text, /1 笔交易.*权重块 1 个，其中新建 1 个/);
  assert.deepEqual([snap.deployRun.done.length, snap.deployRun.finished], [4, true], 'the tools\' transactions are part of the run');
  assert.deepEqual(snap.deployPlan.tools.map(x => x.address), snap.session.tools.map(x => x.address), 'a redeploy would reuse them');
  assert.deepEqual([snap.deployPlan.needed, snap.deployPlan.onChain, snap.deployPlan.transactions.length], [1, 1, 1]);
  snap = await s.deploy(); ok(snap);
  assert.ok(snap.session.tools.every(x => x.reused === true), 'the second selector reuses the tool modules');
  assert.match(snap.status.text, /1 笔交易.*权重块 1 个，其中新建 0 个/, 'and its weight chunk');
  snap = await s.reset(); ok(snap);
  snap = await s.preview(); ok(snap); assert.equal(snap.preview.mode, 'forward'); assert.equal(snap.preview.same, true);
  snap = await s.step(); ok(snap);
  assert.equal(snap.episode.done, true); assert.equal(snap.episode.success, true, 'the chain answers the question right');
}));
