// The engine version check and adding an engine version on a local Anvil (frontend/anvil.fixture.js). The test drives
// them as the protocol would. The command runs against the network. An ADMIN sends the transactions that the command
// prints. The EngineVersion script broadcasts to the network. Skipped without Foundry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { FORGE, NO_FOUNDRY, deployOut, localChain } from '../../frontend/anvil.fixture.js';
import { trainedOf, toolCaller } from '../../frontend/core/loop.js';
import { createExecutor } from '../../frontend/core/sessions/executor.js';
import { deployModule, deploymentOf, inferModule, stepModule, sessionId, weightChunks } from '../../frontend/module-chain.js';
import FactoryABI from '../../frontend/abi/ModuleFactory.json' with { type: 'json' };
import ModuleABI from '../../frontend/abi/NeuromModule.json' with { type: 'json' };
import { engineCases } from './engine-cases.mjs';
import { checkVersion } from './engine-version-check.mjs';
import { run } from './foundry.mjs';

const CONTRACTS = new URL('../', import.meta.url);
const COMMAND = new URL('./engine-version-check.mjs', import.meta.url);

const { cases, artifacts } = await engineCases();
const caseNamed = name => cases.find(c => c.name === name);

/** The browser executor of an artifact's trained network, its tools called as the loop calls them. */
function browserExecutor(artifact) {
  const tr = trainedOf(artifact.bundle.loop), n = artifact.bundle.loop.nodes[tr.id];
  return createExecutor(artifact.model, tr.structure, { tools: n.tools ? toolCaller(tr.id, n) : null });
}
const decision = d => ({ scores: d.scores, action: d.scores.indexOf(Math.max(...d.scores)), counts: d.counts, voltages: d.voltages });

test('an equivalent candidate passes with 0 differences and only the add-version transactions are printed; once an ADMIN sends them, existing modules keep their version and still decide bit for bit as the browser executor, and a new deployment runs on the candidate', { skip: NO_FOUNDRY, timeout: 300_000 }, async () => {
  const chain = await localChain();
  try {
    const combiner = caseNamed('arithmetic-combiner-policy').artifact, lif = caseNamed('LIF 11→16→tools→12→8 int16').artifact;
    const combinerAt = (await deployModule(chain.signer, chain.factory, combiner, { artifacts })).address;
    const lifAt = (await deployModule(chain.signer, chain.factory, lif, { artifacts })).address;
    const lifLocal = browserExecutor(lif), session = sessionId('before the new version'), steps = caseNamed('LIF 11→16→tools→12→8 int16').inputs;
    const stepped = async (at, local, bits) => { const got = await stepModule(chain.signer, at, bits, session), want = local.step(bits); return [[got.scores, got.counts, got.voltages], [want.scores, want.counts, want.voltages]]; };
    for (const bits of steps.slice(0, 5)) assert.deepEqual(...await stepped(lifAt, lifLocal, bits), `a session started before the new version: ${bits.join('')}`);

    const candidate = await (await deployOut(chain.signer, 'VersionCandidates.sol:EquivalentDensePolicyEngine')).getAddress();
    const factory = new ethers.Contract(chain.factory, FactoryABI, chain.signer), id = ethers.id('dense-policy'), first = chain.engines['dense-policy'];
    const block = await chain.provider.getBlockNumber();
    const r = await run(process.execPath, [COMMAND.pathname, '--rpc-url', chain.url, '--factory', chain.factory, '--engine', 'dense-policy', '--candidate', candidate]);
    assert.equal(r.code, 0, r.stderr);
    const dense = cases.filter(c => c.engines.has('dense-policy'));
    assert.match(r.stdout, new RegExp(`${dense.length} cases, ${dense.reduce((n, c) => n + c.inputs.length, 0)} decisions: 0 differences`));
    assert.equal(await chain.provider.getBlockNumber(), block, 'the check sends nothing to the network');
    assert.equal(await factory.latestOf(id), first);
    const field = name => [...r.stdout.matchAll(new RegExp(`^ +(?:\\d\\. )?${name} +(0x[0-9a-fA-F]+)$`, 'gm'))].map(m => m[1]);
    assert.deepEqual(field('to'), [chain.factory, chain.factory]);
    assert.deepEqual(field('data'), [factory.interface.encodeFunctionData('addVersion', [id, candidate]), factory.interface.encodeFunctionData('setLatest', [id, candidate])]);

    for (const data of field('data')) await (await chain.signer.sendTransaction({ to: chain.factory, data })).wait();
    assert.deepEqual([[...await factory.versionsOf(id)], await factory.latestOf(id)], [[first, candidate], candidate], 'the printed transactions add the version and make it the latest');
    const engineOf = async at => (await new ethers.Contract(at, ModuleABI, chain.provider).descriptor()).engine;
    assert.deepEqual([await engineOf(combinerAt), await engineOf(lifAt)], [first, first], 'existing modules keep the version they were deployed with');
    const combinerLocal = browserExecutor(combiner);
    for (const bits of caseNamed('arithmetic-combiner-policy').inputs) assert.deepEqual(await inferModule(chain.provider, combinerAt, bits), decision(combinerLocal.step(bits)), `combiner ${bits.join('')}`);
    for (const bits of steps.slice(5)) assert.deepEqual(...await stepped(lifAt, lifLocal, bits), `the session continues on its own version: ${bits.join('')}`);
    const fresh = await deployModule(chain.signer, chain.factory, lif, { artifacts });
    assert.equal(fresh.engineVersion.address, candidate, 'a new deployment runs on the new latest version');
    const freshLocal = browserExecutor(lif);
    for (const bits of steps) assert.deepEqual(...await stepped(fresh.address, freshLocal, bits), `on the candidate: ${bits.join('')}`);
  } finally { chain.stop(); }
});

test('a candidate one bit off is reported with the first differing input, and no transaction', { skip: NO_FOUNDRY, timeout: 300_000 }, async () => {
  const chain = await localChain();
  try {
    const candidate = await (await deployOut(chain.signer, 'VersionCandidates.sol:OneBitDensePolicyEngine')).getAddress();
    const r = await checkVersion({ rpcUrl: chain.url, factory: chain.factory, engine: 'dense-policy', candidate });
    assert.equal(r.transactions, null);
    const first = r.differences[0], lif = caseNamed('LIF 12→8→4 int8');
    assert.deepEqual([first.case, first.index, first.input, first.fields], [lif.name, 1, lif.inputs[1].join(''), ['voltages']], 'the first LIF step whose last input bit is 1');
    assert.equal(first.current.voltages[0] ^ first.candidate.voltages[0], 1, 'one bit');
    assert.deepEqual(first.current.voltages.slice(1), first.candidate.voltages.slice(1));
    assert.ok(r.differences.every(d => caseNamed(d.case).stateful), 'every stateless decision is the same');
    assert.deepEqual(r.cases, cases.filter(c => c.engines.has('dense-policy')).map(c => c.name), 'every case computing with the engine, tools included, and no other');
  } finally { chain.stop(); }
});

test('the check compares against the latest version: a module the cases reuse from the network on an older version runs the latest in the reference run', { skip: NO_FOUNDRY, timeout: 300_000 }, async () => {
  const chain = await localChain();
  try {
    const reused = caseNamed('LIF 11→16→tools [LIF tool, SUB4, MUL4]→8 int8');
    await deployModule(chain.signer, chain.factory, reused.artifact, { artifacts });          // its LIF tool stays on the first version
    const factory = new ethers.Contract(chain.factory, FactoryABI, chain.signer), id = ethers.id('dense-policy');
    const latest = await (await deployOut(chain.signer, 'VersionCandidates.sol:OneBitDensePolicyEngine')).getAddress();
    await (await factory.addVersion(id, latest)).wait();
    await (await factory.setLatest(id, latest)).wait();
    const candidate = await (await deployOut(chain.signer, 'VersionCandidates.sol:OneBitDensePolicyEngine')).getAddress();
    const r = await checkVersion({ rpcUrl: chain.url, factory: chain.factory, engine: 'dense-policy', candidate });
    assert.equal(r.current, latest);
    assert.deepEqual(r.differences, [], 'the candidate computes as the latest, everywhere');
    assert.ok(r.cases.includes(reused.name));
  } finally { chain.stop(); }
});

test('the check refuses what it cannot check: an engine id without a latest version, a candidate without code, a candidate that already is a version', { skip: NO_FOUNDRY, timeout: 60_000 }, async () => {
  const chain = await localChain();
  try {
    const args = { rpcUrl: chain.url, factory: chain.factory, engine: 'dense-policy' };
    await assert.rejects(checkVersion({ ...args, engine: 'other-engine', candidate: chain.factory }), /no latest version/);
    await assert.rejects(checkVersion({ ...args, candidate: '0x' + '1'.repeat(40) }), /no code/);
    await assert.rejects(checkVersion({ ...args, candidate: chain.engines['dense-policy'] }), /already is an engine version/);
    await assert.rejects(checkVersion({ ...args, candidate: chain.engines['threshold-layers'] }), /already is an engine version/);
  } finally { chain.stop(); }
});

test('EngineVersion adds a version of a new engine id and sets it latest; the existing Factory deploys with it; adding a version again is refused and sends nothing', { skip: NO_FOUNDRY, timeout: 300_000 }, async () => {
  const chain = await localChain();
  try {
    const version = await (await deployOut(chain.signer, 'DensePolicyEngine.sol:DensePolicyEngine')).getAddress(), id = ethers.id('other-engine');
    const net = caseNamed('FF 12→8→4 int16').artifact, d = deploymentOf(net), chunks = weightChunks(d.weights);
    const spec = { engineId: id, version: ethers.ZeroAddress, kind: 0, inputs: d.inputs, outputs: d.outputs, shape: d.shape, tools: [], chunks: chunks.map(c => c.id), artifactId: net.id, taskId: ethers.ZeroHash };
    const factory = new ethers.Contract(chain.factory, FactoryABI, chain.signer), data = chunks.map(c => c.data);
    await assert.rejects(factory.checkDeploy(spec, data), /engine/, 'no version yet: the Factory refuses it');

    const script = (sig, engine, address) => run(FORGE, ['script', 'script/EngineVersion.s.sol', '--sig', sig, '--rpc-url', chain.url, '--unlocked', '--sender', chain.signer.address, '--broadcast'],
      { cwd: CONTRACTS.pathname, env: { ENGINE: engine, VERSION: address, FACTORY: chain.factory } });
    const register = (engine, address) => script('add()', engine, address);
    const done = await register('other-engine', version);
    assert.equal(done.code, 0, done.stdout + done.stderr);
    assert.deepEqual([[...await factory.versionsOf(id)], await factory.latestOf(id)], [[version], version], 'added and latest');

    const rc = await (await factory.deploy(spec, data)).wait();
    const module = rc.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'ModuleDeployed').args.module;
    const local = browserExecutor(net);
    const m = new ethers.Contract(module, ModuleABI, chain.provider);           // the bridge knows only the engine ids it deploys
    for (const bits of caseNamed('FF 12→8→4 int16').inputs) {
      const [scores, action, counts, voltages] = await m.forward(Uint8Array.from(bits));
      assert.deepEqual({ scores: Array.from(scores, Number), action: Number(action), counts: Array.from(counts, Number), voltages: Array.from(voltages, Number) }, decision(local.step(bits)), `the new engine id computes ${bits.join('')}`);
    }

    const nonce = await chain.provider.getTransactionCount(chain.signer.address);
    for (const [engine, address] of [['other-engine', version], ['other-engine', chain.engines['dense-policy']]]) {
      const again = await register(engine, address);
      assert.notEqual(again.code, 0, `${address} is a version already`);
      assert.match(again.stdout + again.stderr, /added/);
    }
    assert.equal(await chain.provider.getTransactionCount(chain.signer.address), nonce, 'nothing was sent');
    assert.deepEqual([[...await factory.versionsOf(id)], [...await factory.versionsOf(ethers.id('dense-policy'))]], [[version], [chain.engines['dense-policy']]], 'lists unchanged');

    const second = await (await deployOut(chain.signer, 'DensePolicyEngine.sol:DensePolicyEngine')).getAddress();
    assert.equal((await register('other-engine', second)).code, 0);
    assert.deepEqual([[...await factory.versionsOf(id)], await factory.latestOf(id)], [[version, second], second]);
    const back = await script('setLatest()', 'other-engine', version);
    assert.equal(back.code, 0, back.stdout + back.stderr);
    assert.equal(await factory.latestOf(id), version, 'set latest back to an added version, nothing added');
    assert.deepEqual([...await factory.versionsOf(id)], [version, second]);
    const before = await chain.provider.getTransactionCount(chain.signer.address);
    const foreign = await script('setLatest()', 'other-engine', chain.engines['dense-policy']);
    assert.notEqual(foreign.code, 0, 'a version of another engine id');
    assert.match(foreign.stdout + foreign.stderr, /not a version/);
    assert.equal(await chain.provider.getTransactionCount(chain.signer.address), before, 'nothing was sent');
  } finally { chain.stop(); }
});
