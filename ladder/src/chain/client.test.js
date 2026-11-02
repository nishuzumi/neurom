// chain/client.test.js — the ladder client over a fresh anvil with the protocol and a TankLadder on it
// (frontend/ladder.fixture.js). Two fixed 中 networks of the template (572 → 32 → 32 → 9, int16, different seeds) are
// the entries: built as artifacts from the stage 1 trainer of the template, so the deployment goes the way of the
// workbench. The challenges run under manual mining (one block every 150 ms, one 30M transaction per block), so the
// pipeline really has transactions in flight. Skips with NO_FOUNDRY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { NO_FOUNDRY } from '../../../frontend/anvil.fixture.js';
import { localLadder, LADDER_DEFAULTS } from '../../../frontend/ladder.fixture.js';
import { ModuleGraph } from '../../../frontend/core/graph.js';
import { instantiateInto } from '../../../frontend/core/template.js';
import { buildBundle } from '../../../frontend/core/bundle.js';
import { builtinTemplate } from '../../../frontend/templates/index.js';
import { makeArtifact } from '../../../frontend/core/store.js';
import { scriptCalls } from '../../../frontend/core/script-calls.js';
import { createExecutor } from '../../../frontend/core/sessions/executor.js';
import { DENSE_FORMAT } from '../../../frontend/runtime/dense-policy.js';
import stepGas from '../../data/step-gas.json' with { type: 'json' };
import TankLadderABI from '../../../frontend/abi/TankLadder.json' with { type: 'json' };
import { createLadderClient, decodeLadderError, episodeSeed, unpackActions, PLAY_GAS, MAX_IN_FLIGHT, STATUS, EPISODES } from './client.js';
import { readProvider } from '../wallet/read-provider.js';

const [INPUTS, ACTIONS] = [572, 9];
const iface = new ethers.Interface(TankLadderABI);

/** A fixed dense FF model at int16 (as templates/tank-battle.test.js fixedModel). */
function fixedModel(inputs, hidden, outputs, seed) {
  let k = seed;
  const w = () => ((((k++) * 29 + 13) % 7) - 3) * 1000, b = () => ((((k++) * 17 + 5) % 5) - 1) * 1000;
  const region = (rows, cols) => ({ W: Array.from({ length: rows }, () => Array.from({ length: cols }, w)), b: Array.from({ length: rows }, b) });
  return { format: DENSE_FORMAT, kind: 'feedforward', inputs, outputs, weightBits: 16, ticks: 1, leak_shift: 0, reset: 0,
    layers: hidden.map((h, i) => ({ hidden: h, ...region(h, i ? hidden[i - 1] : inputs), scale: 1000, k: 0 })),
    output: { ...region(outputs, hidden.at(-1)), scale: 1000, k: 0 } };
}

/** The template instance: an artifact of the 中 structure of stage 1 with `model`, and the scene calls of the battle script. */
function template() {
  const graph = new ModuleGraph();
  const { ids } = instantiateInto(graph, builtinTemplate('tank-battle'));
  const page = scriptCalls(graph, graph.resolved(), ids.vs_battle, { artifacts: () => null });
  const call = (name, ...args) => page.call(name, args);
  return { artifactOf: model => makeArtifact({ bundle: buildBundle(graph, ids.s1_a_trainer), model }), call };
}

/** A network that runs `model` directly on the bits of its side: the first maximum score. */
const policy = model => { const ex = createExecutor(model); return bits => { const o = ex.step(bits).scores; return o.indexOf(Math.max(...o)); }; };

test('the ladder client on a local anvil', { skip: NO_FOUNDRY }, async t => {
  // a reserve of 24M leaves about 6M gas of play per transaction (≈ 25 steps of 中 against 中), so a challenge takes
  // several transactions and the pipeline fills; the cooldown is short so the pair can play again
  const OVERRIDES = { cooldownBlocks: 10, reserveGas: 24_000_000 };
  const chain = await localLadder(OVERRIDES);
  const { provider, factory, ladder } = chain;
  const chainId = Number((await provider.getNetwork()).chainId);
  const { artifactOf, call } = template();
  const models = { a: fixedModel(INPUTS, [32, 32], ACTIONS, 11), b: fixedModel(INPUTS, [32, 32], ACTIONS, 13) };
  const [alice, bob] = [await provider.getSigner(1), await provider.getSigner(2)];
  const clientOf = signer => createLadderClient({ provider, signer, ladder, factory, chainId, pollMs: 20 });
  const [reader, asAlice, asBob] = [createLadderClient({ provider, ladder, factory, chainId }), clientOf(alice), clientOf(bob)];
  /** Manual mining: a block every `ms` → stop(). */
  const mining = async ms => {
    await provider.send('evm_setAutomine', [false]);
    const timer = setInterval(() => provider.send('evm_mine', []).catch(() => {}), ms);
    return async () => { clearInterval(timer); await provider.send('evm_setAutomine', [true]); };
  };
  const mine = n => provider.send('anvil_mine', [ethers.toQuantity(n)]);
  const modules = {};
  try {
    await t.test('config reads the deployed configuration as numbers', async () => {
      const c = await reader.config();
      assert.deepEqual({ ...c, endBlock: undefined, factory: undefined }, { ...LADDER_DEFAULTS, ...OVERRIDES, endBlock: undefined, factory: undefined });
      assert.equal(c.factory, factory);
      assert.equal(typeof c.endBlock, 'number');
      assert.deepEqual(await reader.ladder(), []);
    });

    await t.test('register deploys the artifact through the chain bridge and registers it; the ladder, entry and entriesOf read it back', async () => {
      const status = [];
      const a = await asAlice.register(await artifactOf(models.a), { onStatus: s => status.push(s) });
      assert.match(a.module, /^0x[0-9a-fA-F]{40}$/);
      assert.deepEqual({ rank: a.rank, owner: a.owner, weightBytes: a.weightBytes }, { rank: 1, owner: await alice.getAddress(), weightBytes: 39840 });
      assert.ok(status.some(s => s.stage === 'deploy' && s.kind === 'module' && s.deployStage === 'mined'), 'the deployment reports its transactions');
      assert.ok(status.every(s => typeof s.message === 'string'), 'every status has a message');
      assert.deepEqual(status.map(s => s.stage).filter(s => s !== 'deploy'), ['deploying', 'registering', 'registered']);
      const b = await asBob.register(await artifactOf(models.b));
      assert.deepEqual({ rank: b.rank, owner: b.owner }, { rank: 2, owner: await bob.getAddress() });
      modules.a = a.module; modules.b = b.module;
      const rows = await reader.ladder({ fromRank: 1 });
      assert.deepEqual(rows, [
        { rank: 1, module: a.module, owner: a.owner, weightBytes: 39840, wins: 0, losses: 0, activeChallenge: 0 },
        { rank: 2, module: b.module, owner: b.owner, weightBytes: 39840, wins: 0, losses: 0, activeChallenge: 0 },
      ]);
      assert.deepEqual(await reader.ladder({ fromRank: 2, count: 5 }), [rows[1]]);
      assert.deepEqual(await reader.ladder({ fromRank: 3 }), []);
      assert.deepEqual(await reader.entry(b.module), rows[1]);
      assert.equal(await reader.entry(ladder), null);
      assert.deepEqual(await reader.entriesOf(b.owner), [rows[1]]);
      assert.deepEqual(await reader.entriesOf(ladder), []);
      assert.equal(await reader.activeChallengeOf(a.module), null);
    });

    await t.test('registering the same weights again is refused with DuplicateWeights, which decodeLadderError names', async () => {
      await assert.rejects(asBob.register(await artifactOf(models.a)), e => decodeLadderError(e) === 'DuplicateWeights' && e.ladderError === 'DuplicateWeights');
    });

    await t.test('targets lists the entries in range with the refusal of the moment', async () => {
      assert.deepEqual(await reader.targets(modules.a), [], 'rank 1 has nobody above');
      assert.deepEqual(await reader.targets(ladder), [], 'not entered');
      const [forBob] = await asBob.targets(modules.b);
      assert.deepEqual({ module: forBob.module, rank: forBob.rank, cooldownUntil: forBob.cooldownUntil, reason: forBob.reason }, { module: modules.a, rank: 1, cooldownUntil: 0, reason: null });
      const [forAlice] = await asAlice.targets(modules.b);
      assert.equal(forAlice.reason, 'NotOwner', 'alice does not own b');
      const [noSigner] = await reader.targets(modules.b);
      assert.equal(noSigner.reason, null, 'without a signer the owner is not checked');
    });

    await t.test('estimate follows step-gas.json and the weight bytes', async () => {
      const e = await asBob.estimate(modules.b, modules.a);
      const fwd = Math.round(stepGas.forward.intercept + stepGas.forward.perByte * 39840), step = 2 * fwd + stepGas.scenePerStep;
      const perTx = Math.floor((PLAY_GAS - OVERRIDES.reserveGas - stepGas.perTransaction) / step);
      assert.equal(e.stepsPerTransaction, perTx);
      assert.equal(e.txWorst, Math.ceil(600 / perTx));
      assert.equal(e.gasWorst, 600 * step + e.txWorst * stepGas.perTransaction);
      assert.equal(e.gasTypical, 6 * stepGas.stepsPerEpisode.mean * step + e.txTypical * stepGas.perTransaction);
      assert.ok(e.gasTypical < e.gasWorst && e.txTypical <= e.txWorst);
      const price = (await provider.getFeeData()).maxFeePerGas;
      assert.equal(e.costWorstWei, BigInt(e.txWorst) * BigInt(PLAY_GAS) * price, 'Monad charges the gas limit of every transaction');
      assert.equal(e.costTypicalWei, BigInt(e.txTypical) * BigInt(PLAY_GAS) * price);
    });

    await t.test('challenge refusals are decoded before any transaction', async () => {
      await assert.rejects(asAlice.challenge(modules.b, modules.a), e => decodeLadderError(e) === 'NotOwner');
      await assert.rejects(asAlice.challenge(modules.a, modules.b), e => decodeLadderError(e) === 'OutOfRange');
      await assert.rejects(reader.challenge(modules.b, modules.a), /signer/);
      assert.equal(await reader.challengeInfo(1), null);
    });

    let first = null;
    await t.test('a challenge plays to the settlement with at most 3 transactions in flight and reports its progress', async () => {
      const stop = await mining(150);
      const progress = [];
      let sent = 0, confirmed = 0;
      const send = bob.sendTransaction.bind(bob);
      bob.sendTransaction = tx => { sent++; assert.ok(sent - confirmed <= MAX_IN_FLIGHT, `in flight after sending: ${sent - confirmed}`); assert.equal(tx.gasLimit, PLAY_GAS); assert.equal(typeof tx.nonce, 'number'); return send(tx); };
      try {
        first = await asBob.challenge(modules.b, modules.a, { onProgress: p => { progress.push(p); confirmed = p.confirmed; assert.ok(p.inFlight <= MAX_IN_FLIGHT); } });
      } finally { bob.sendTransaction = send; await stop(); }
      assert.ok([STATUS.CHALLENGER_WON, STATUS.DEFENSE].includes(first.status), `settled: ${first.status}`);
      assert.deepEqual({ id: first.id, challenger: first.challenger, defender: first.defender, episode: first.episode, step: first.step }, { id: 1, challenger: modules.b, defender: modules.a, episode: EPISODES, step: 0 });
      assert.ok(first.challengerWins + first.defenderWins <= EPISODES);
      t.diagnostic(`challenge 1: ${sent} transactions, at most ${Math.max(...progress.map(p => p.inFlight))} in flight after a receipt, score ${first.challengerWins}:${first.defenderWins}, status ${first.status}`);
      assert.ok(sent >= 1, `the challenge took ${sent} transactions`);
      assert.ok(Math.max(...progress.map(p => p.inFlight)) >= Math.min(2, sent - 1), 'the pipeline had transactions in flight');
      assert.ok(progress.every(p => p.id === 1 || p.id === null) && progress.at(-1).id === 1);
      assert.equal(progress.at(-1).status, first.status);
      assert.equal(progress.at(-1).inFlight, 0, 'nothing in flight when the client returns');
      assert.equal(progress.at(-1).confirmed, sent, 'every sent transaction was confirmed');
      const steps = progress.map(p => p.episode * 1000 + p.step);
      assert.ok(steps.every((s, k) => k === 0 || s >= steps[k - 1]), 'the progress never goes back');
      // the ranks: the winner is rank 1, the loser rank 2; wins and losses count
      const rows = await reader.ladder();
      const [winner, loser] = first.status === STATUS.CHALLENGER_WON ? [modules.b, modules.a] : [modules.a, modules.b];
      assert.deepEqual(rows.map(r => [r.rank, r.module, r.wins, r.losses, r.activeChallenge]), [[1, winner, 1, 0, 0], [2, loser, 0, 1, 0]]);
      assert.deepEqual(await asBob.resume(1), first, 'resume of a settled challenge returns it');
      assert.deepEqual(await reader.challengeInfo(1), first);
    });

    await t.test('targets shows the cooldown of the pair, then it lifts', async () => {
      const [{ rank: loserRank, module: loser }] = (await reader.ladder()).filter(r => r.rank === 2);
      const [top] = await reader.ladder({ fromRank: 1, count: 1 });
      const [target] = await clientOf(loser === modules.b ? bob : alice).targets(loser);
      const until = Number(await chain.ladderContract.cooldownUntil(loser, top.module));
      assert.equal(target.cooldownUntil, until);
      const block = await provider.getBlockNumber();
      assert.equal(target.reason, block < until ? 'Cooldown' : null, `cooldown until ${until}, now ${block}, loser rank ${loserRank}`);
      await mine(12);
      assert.equal((await clientOf(loser === modules.b ? bob : alice).targets(loser))[0].reason, null);
    });

    let second = null;
    await t.test('resume continues a challenge that was interrupted with transactions in flight', async () => {
      const [top, low] = await reader.ladder();
      const signer = low.owner.toLowerCase() === (await bob.getAddress()).toLowerCase() ? bob : alice;
      const client = clientOf(signer);
      const stop = await mining(150);
      try {
        const seen = [];
        const settledEarly = await client.challenge(low.module, top.module, { onProgress: p => { seen.push(p); if (p.confirmed === 2) throw new Error('page closed'); } })
          .then(info => info, e => { if (!/page closed/.test(e.message)) throw e; return null; });
        const id = seen.at(-1).id;
        assert.equal(id, 2);
        if (settledEarly) { second = settledEarly; t.diagnostic('the start transaction settled challenge 2: nothing to resume'); return; }
        assert.equal((await reader.challengeInfo(id)).status, STATUS.PLAYING);
        assert.equal(await reader.activeChallengeOf(low.module), id);
        const progress = [];
        second = await client.resume(id, { onProgress: p => { progress.push(p); assert.ok(p.inFlight <= MAX_IN_FLIGHT); } });
        assert.ok([STATUS.CHALLENGER_WON, STATUS.DEFENSE].includes(second.status));
        assert.equal(second.episode, EPISODES);
        assert.equal(progress.at(-1).status, second.status);
        assert.equal(progress.at(-1).inFlight, 0);
      } finally { await stop(); }
      assert.equal(await reader.activeChallengeOf(low.module), null);
      await assert.rejects(client.resume(3), /does not exist/);
    });

    await t.test('replay rebuilds every episode from the events, and the JS scene with the JS networks plays the same', async () => {
      for (const info of [first, second]) {
        const r = await reader.replay(info.id);
        assert.deepEqual({ id: r.id, seed: r.seed, challenger: r.challenger, defender: r.defender, status: r.status }, { id: info.id, seed: info.seed, challenger: info.challenger, defender: info.defender, status: info.status });
        assert.equal(r.episodes.length, EPISODES);
        const modelOf = m => (m === modules.a ? models.a : models.b);
        let [cw, dw] = [0, 0];
        for (const ep of r.episodes) {
          const swapped = ep.episode % 2 === 1;
          assert.deepEqual([ep.side0, ep.side1], swapped ? [info.defender, info.challenger] : [info.challenger, info.defender]);
          assert.equal(ep.seed, episodeSeed(info.seed, Math.floor(ep.episode / 2)));
          assert.equal(ep.seed, Number(BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [info.seed, Math.floor(ep.episode / 2)]))) & 0xffffffffn));
          if (ep.episode > 0 && ep.episode % 2 === 0) assert.notEqual(ep.seed, r.episodes[ep.episode - 1].seed);
          if (swapped) assert.equal(ep.seed, r.episodes[ep.episode - 1].seed, 'the mirror episode plays the same seed');
          const [red, blue] = [policy(modelOf(ep.side0)), policy(modelOf(ep.side1))];
          let s = call('battle', { seed: ep.seed });
          for (const [a0, a1] of ep.actions) {
            assert.ok(s.end < 0, 'no action after the end');
            assert.deepEqual([a0, a1], [red(call('view', s, 0)), blue(call('view', s, 1))], `episode ${ep.episode} step ${s.t}: the networks chose the actions of the event`);
            s = call('play', s, a0, a1);
          }
          assert.equal(s.end, ep.end, `episode ${ep.episode} ends as the event says`);
          assert.equal(s.t, ep.steps);
          assert.equal(ep.actions.length, ep.steps);
          if (ep.end === 0 || ep.end === 1) { if ((ep.end === 0) !== swapped) cw++; else dw++; }
        }
        assert.deepEqual([cw, dw], [info.challengerWins, info.defenderWins], 'the episode ends give the score of the challenge');
      }
      await assert.rejects(reader.replay(9), /does not exist/);
    });

    await t.test('recentChallenges lists the challenges newest first with the gas of their transactions', async () => {
      const recent = await reader.recentChallenges({ count: 5 });
      assert.deepEqual(recent.map(c => [c.id, c.challenger, c.defender, c.status, c.challengerWins, c.defenderWins, c.startBlock]),
        [second, first].map(i => [i.id, i.challenger, i.defender, i.status, i.challengerWins, i.defenderWins, i.startBlock]));
      for (const c of recent) { assert.ok(c.gasUsed > 1_000_000 && c.transactions >= 1, `challenge ${c.id}: ${c.transactions} transactions, ${c.gasUsed} gas`); }
      assert.deepEqual((await reader.recentChallenges({ count: 1 })).map(c => c.id), [2]);
    });

    await t.test('with the read provider of the page, a key signer registers right after the deployment receipt', async () => {
      // The dev signer of the page signs locally, so the read provider gives its nonces. Automine gives the receipt of
      // the deployment at once, so the register transaction follows it within the 250 ms request cache of ethers.
      const page = readProvider(chain.url, chainId);
      const key = ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase('test test test test test test test test test test test junk'), "m/44'/60'/0'/0/4").connect(page);
      const asKey = createLadderClient({ provider: page, signer: key, ladder, factory, chainId, pollMs: 20 });
      try {
        for (const seed of [17, 19, 23]) {
          const r = await asKey.register(await artifactOf(fixedModel(INPUTS, [32, 32], ACTIONS, seed)));
          assert.equal(r.owner, key.address);
        }
      } finally { page.destroy(); }
    });
  } finally { chain.stop(); }
});

test('decodeLadderError names the custom error from the shapes ethers and wallets give, null otherwise', () => {
  const data = iface.encodeErrorResult('Cooldown', [77]);
  assert.equal(decodeLadderError({ data }), 'Cooldown');
  assert.equal(decodeLadderError({ info: { error: { data } } }), 'Cooldown');
  assert.equal(decodeLadderError({ error: { data: { data } } }), 'Cooldown');
  assert.equal(decodeLadderError(new Error('x', { cause: { data } })), 'Cooldown');
  assert.equal(decodeLadderError({ revert: { name: 'LowGas', args: [1n, 2n] } }), 'LowGas');
  assert.equal(decodeLadderError({ ladderError: 'NotEoa' }), 'NotEoa');
  for (const name of ['NotOfficialModule', 'HasTools', 'NotEoa', 'Busy', 'SeasonOver', 'NotOwner', 'NotExpired', 'Expired', 'NotPlaying', 'OutOfRange']) assert.equal(decodeLadderError({ data: iface.encodeErrorResult(name, []) }), name);
  assert.equal(decodeLadderError({ data: iface.encodeErrorResult('WrongShape', [12, 4]) }), 'WrongShape');
  assert.equal(decodeLadderError({ data: iface.encodeErrorResult('TooLarge', [1, 2]) }), 'TooLarge');
  assert.equal(decodeLadderError({ data: iface.encodeErrorResult('DuplicateWeights', [ethers.ZeroAddress]) }), 'DuplicateWeights');
  assert.equal(decodeLadderError({ data: '0x08c379a0' + ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['plain revert']).slice(2) }), null);
  assert.equal(decodeLadderError({ data: '0x12345678' }), null);
  assert.equal(decodeLadderError(new Error('network')), null);
  assert.equal(decodeLadderError(null), null);
  assert.equal(decodeLadderError({ revert: { name: 'Error' } }), null);
});

test('unpackActions and episodeSeed follow the contract', () => {
  assert.deepEqual(unpackActions('0x' + [0, 8, 9 * 4 + 7, 80].map(b => b.toString(16).padStart(2, '0')).join('')), [[0, 0], [0, 8], [4, 7], [8, 8]]);
  assert.deepEqual(unpackActions('0x'), []);
  const seed = ethers.id('seed');
  assert.equal(episodeSeed(seed, 0), Number(BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [seed, 0]))) & 0xffffffffn));
  assert.ok(Number.isInteger(episodeSeed(seed, 2)) && episodeSeed(seed, 2) >= 0 && episodeSeed(seed, 2) < 2 ** 32);
});
