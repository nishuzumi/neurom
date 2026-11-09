// chain/client.test.js — the ladder client over a fresh anvil with the protocol and a TankLadder on it
// (frontend/ladder.fixture.js). Two fixed 中 networks of the template (572 → 32 → 32 → 9, int16, different seeds) are
// the entries: built as artifacts from the stage 1 trainer of the template and deployed through the chain bridge of
// the workbench (module-chain.js deployModule, each under an English id of its deployer), the way the workbench
// deploys; the client registers the addresses.
// The challenges run under manual mining (one block every 150 ms, one 30M transaction per block), so the pipeline
// really has transactions in flight. Skips with NO_FOUNDRY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { NO_FOUNDRY, deployOut } from '../../../frontend/anvil.fixture.js';
import { localLadder, LADDER_DEFAULTS } from '../../../frontend/ladder.fixture.js';
import { ModuleGraph } from '../../../frontend/core/graph.js';
import { instantiateInto } from '../../../frontend/core/template.js';
import { buildBundle } from '../../../frontend/core/bundle.js';
import { builtinTemplate } from '../../../frontend/templates/index.js';
import { makeArtifact } from '../../../frontend/core/store.js';
import { scriptCalls } from '../../../frontend/core/script-calls.js';
import { createExecutor } from '../../../frontend/core/sessions/executor.js';
import { DENSE_FORMAT } from '../../../frontend/runtime/dense-policy.js';
import { deployModule } from '../../../frontend/module-chain.js';
import stepGas from '../../data/step-gas.json' with { type: 'json' };
import TankLadderABI from '../../../frontend/abi/TankLadder.json' with { type: 'json' };
import { createLadderClient, decodeLadderError, episodeSeed, unpackActions, PLAY_GAS, MAX_IN_FLIGHT, STATUS, EPISODES } from './client.js';
import { readProvider } from '../../../frontend/chain.js';

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
  const clientOf = signer => createLadderClient({ provider, signer, ladder, pollMs: 20 });
  const [reader, asAlice, asBob] = [createLadderClient({ provider, ladder }), clientOf(alice), clientOf(bob)];
  /** Manual mining: a block every `ms` → stop(). */
  const mining = async ms => {
    await provider.send('evm_setAutomine', [false]);
    const timer = setInterval(() => provider.send('evm_mine', []).catch(() => {}), ms);
    return async () => { clearInterval(timer); await provider.send('evm_setAutomine', [true]); };
  };
  const mine = n => provider.send('anvil_mine', [ethers.toQuantity(n)]);
  const sent = async signer => Number(await provider.send('eth_getTransactionCount', [await signer.getAddress(), 'latest']));
  const modules = {};
  try {
    await t.test('config reads the deployed configuration as numbers', async () => {
      const c = await reader.config();
      assert.deepEqual({ ...c, endBlock: undefined, factory: undefined }, { ...LADDER_DEFAULTS, ...OVERRIDES, endBlock: undefined, factory: undefined });
      assert.equal(c.factory, factory);
      assert.equal(typeof c.endBlock, 'number');
      assert.deepEqual(await reader.board(), []);
      assert.deepEqual(await reader.entries(), []);
    });

    await t.test('register enters a module the Factory deployed and sends only the register transaction; the board, entries and entry read it back', async () => {
      const deployed = await deployModule(alice, factory, await artifactOf(models.a), { moduleId: 'alice-mid' });
      const before = await sent(alice);
      const status = [];
      const a = await asAlice.register(deployed.address.toLowerCase(), { onStatus: s => status.push(s) });
      assert.equal(a.module, ethers.getAddress(deployed.address), 'the address comes back checksummed');
      assert.deepEqual({ rank: a.rank, owner: a.owner, weightBytes: a.weightBytes }, { rank: 1, owner: await alice.getAddress(), weightBytes: 39840 });
      assert.deepEqual(status.map(s => s.stage), ['registering', 'registered']);
      assert.equal(await sent(alice), before + 1, 'registration is one transaction');
      const tx = await provider.getTransaction(a.txHash);
      assert.equal(tx.to, ladder, 'the one transaction goes to the ladder');
      assert.equal(tx.data, iface.encodeFunctionData('register', [a.module]), 'and only registers: no chunks, no module');
      const b = await asBob.register((await deployModule(bob, factory, await artifactOf(models.b), { moduleId: 'bob-mid' })).address);
      assert.deepEqual({ rank: b.rank, owner: b.owner }, { rank: 2, owner: await bob.getAddress() });
      modules.a = a.module; modules.b = b.module; modules.aArtifact = deployed.artifactId.toLowerCase();
      const rows = await reader.board();
      assert.deepEqual(rows, [
        { rank: 1, module: a.module, owner: a.owner, weightBytes: 39840, wins: 0, losses: 0, activeChallenge: 0 },
        { rank: 2, module: b.module, owner: b.owner, weightBytes: 39840, wins: 0, losses: 0, activeChallenge: 0 },
      ]);
      assert.deepEqual(await reader.entries(), rows, 'in the order of registration');
      assert.deepEqual(await reader.entry(b.module), rows[1]);
      assert.equal(await reader.entry(ladder), null);
    });

    await t.test('register refuses before sending: a duplicate of registered weights (DuplicateWeights), an address the official Factory did not deploy (NotOfficialModule), a non-address', async () => {
      const twin = await deployModule(bob, factory, await artifactOf(models.a), { moduleId: 'bob-twin-of-alice' });
      modules.twin = twin.address;
      const before = await sent(bob);
      await assert.rejects(asBob.register(twin.address), e => decodeLadderError(e) === 'DuplicateWeights' && e.ladderError === 'DuplicateWeights' && e.module === twin.address);
      for (const notOfficial of [factory, ladder, await alice.getAddress()]) {
        await assert.rejects(asBob.register(notOfficial), e => e.ladderError === 'NotOfficialModule', `${notOfficial} is not a module of the Factory`);
      }
      await assert.rejects(asBob.register(modules.a), e => e.ladderError === 'AlreadyEntered');
      await assert.rejects(asBob.register('0x1234'), /not a module address/);
      await assert.rejects(asBob.register(''), /not a module address/);
      assert.equal(await sent(bob), before, 'a refusal sends nothing');
      await assert.rejects(reader.register(twin.address), /needs a signer/);
    });

    await t.test('deploymentsOf lists the modules of one account from the archive of the Factory: English ids, descriptors, in deployment order, registered or not', async () => {
      const [aliceAddress, bobAddress] = [await alice.getAddress(), await bob.getAddress()];
      assert.deepEqual([await reader.deploymentCount(aliceAddress), await reader.deploymentCount(bobAddress), await reader.deploymentCount(ladder)], [1, 2, 0]);
      const ofAlice = await reader.deploymentsOf(aliceAddress);
      assert.deepEqual(ofAlice, [{ module: modules.a, moduleId: 'alice-mid', deployer: aliceAddress, engineId: ofAlice[0].engineId, engine: ofAlice[0].engine, artifactId: modules.aArtifact, taskId: ofAlice[0].taskId,
        kind: 0, kindName: 'feedforward', inputs: INPUTS, outputs: ACTIONS, stateWidth: 0 }]);
      assert.match(ofAlice[0].engine, /^0x[0-9a-fA-F]{40}$/);
      const ofBob = await reader.deploymentsOf(bobAddress);
      assert.deepEqual(ofBob.map(d => [d.module, d.moduleId, d.deployer]), [[modules.b, 'bob-mid', bobAddress], [modules.twin, 'bob-twin-of-alice', bobAddress]], 'in deployment order, the unregistered twin included');
      assert.deepEqual({ ...ofBob[1], module: null, moduleId: null, deployer: null }, { ...ofAlice[0], module: null, moduleId: null, deployer: null }, 'the twin of alice carries her descriptor');
      assert.notEqual(ofBob[0].artifactId, ofBob[1].artifactId);
      // the registered state comes from the ladder, not from the archive
      assert.equal((await reader.entry(ofBob[0].module)).rank, 2);
      assert.equal(await reader.entry(ofBob[1].module), null);
      assert.deepEqual((await reader.deploymentsOf(bobAddress, { offset: 1, limit: 5 })).map(d => d.moduleId), ['bob-twin-of-alice']);
      assert.deepEqual(await reader.deploymentsOf(bobAddress, { offset: 2 }), []);
      assert.deepEqual(await reader.deploymentsOf(ladder), []);
      await assert.rejects(reader.deploymentsOf('0x1234'), /not an address/);
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

    await t.test('an entry off a full board targets the last ranks within range; register, entry and entries say rank 0', async () => {
      // a second ladder on the same chain with a board of 1: a fills it, b stays off it
      const cfg = await reader.config();
      const small = await (await deployOut(chain.signer, 'TankLadder', { ...cfg, boardSize: 1 })).getAddress();
      const on = signer => createLadderClient({ provider, signer, ladder: small, pollMs: 20 });
      assert.equal((await on(alice).register(modules.a)).rank, 1);
      const status = [];
      const off = await on(bob).register(modules.b, { onStatus: s => status.push(s) });
      assert.equal(off.rank, 0);
      assert.match(status.at(-1).message, /off the board/);
      const reads = on(undefined);
      assert.deepEqual((await reads.board()).map(e => e.module), [modules.a]);
      assert.deepEqual((await reads.entries()).map(e => [e.module, e.rank]), [[modules.a, 1], [modules.b, 0]]);
      assert.equal((await reads.entry(modules.b)).rank, 0, 'off the board is still an entry');
      const targets = await on(bob).targets(modules.b);
      assert.deepEqual(targets.map(d => [d.module, d.rank, d.reason]), [[modules.a, 1, null]], 'rank 1 is one rank above the rank below the last');
      assert.deepEqual(await on(alice).targets(modules.a), [], 'nobody above rank 1');
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
      const rows = await reader.board();
      const [winner, loser] = first.status === STATUS.CHALLENGER_WON ? [modules.b, modules.a] : [modules.a, modules.b];
      assert.deepEqual(rows.map(r => [r.rank, r.module, r.wins, r.losses, r.activeChallenge]), [[1, winner, 1, 0, 0], [2, loser, 0, 1, 0]]);
      assert.deepEqual(await asBob.resume(1), first, 'resume of a settled challenge returns it');
      assert.deepEqual(await reader.challengeInfo(1), first);
    });

    await t.test('targets shows the cooldown of the pair, then it lifts', async () => {
      const [{ rank: loserRank, module: loser }] = (await reader.board()).filter(r => r.rank === 2);
      const [top] = await reader.board();
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
      const [top, low] = await reader.board();
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
        assert.equal((await reader.entry(low.module)).activeChallenge, id);
        const progress = [];
        second = await client.resume(id, { onProgress: p => { progress.push(p); assert.ok(p.inFlight <= MAX_IN_FLIGHT); } });
        assert.ok([STATUS.CHALLENGER_WON, STATUS.DEFENSE].includes(second.status));
        assert.equal(second.episode, EPISODES);
        assert.equal(progress.at(-1).status, second.status);
        assert.equal(progress.at(-1).inFlight, 0);
      } finally { await stop(); }
      assert.equal((await reader.entry(low.module)).activeChallenge, 0);
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
      for (const c of recent) { assert.ok(c.gasUsed > 1_000_000, `challenge ${c.id}: ${c.gasUsed} gas`); }
      assert.deepEqual((await reader.recentChallenges({ count: 1 })).map(c => c.id), [2]);
    });

    await t.test('old challenges keep their replay and gas totals through an RPC with a 100-block log limit', async () => {
      const expectedRecent = await reader.recentChallenges();
      const expectedReplays = await Promise.all([reader.replay(first.id), reader.replay(second.id)]);
      await mine(500);
      const limited = readProvider(chain.url, chainId);
      const send = limited.send.bind(limited);
      limited.send = (method, params) => {
        if (method === 'eth_getLogs') {
          const [{ fromBlock, toBlock }] = params;
          if (toBlock === 'latest' || BigInt(toBlock) - BigInt(fromBlock) >= 100n) {
            throw new Error('Block range is too large');
          }
        }
        return send(method, params);
      };
      const client = createLadderClient({ provider: limited, ladder });
      try {
        assert.deepEqual(await client.recentChallenges(), expectedRecent);
        assert.deepEqual(await Promise.all([client.replay(first.id), client.replay(second.id)]), expectedReplays);
      } finally { limited.destroy(); }
    });
    await t.test('resume settles an expired challenge without advance, and repeated settlement sends nothing', async subtest => {
      const [top, low] = await reader.board();
      const page = readProvider(chain.url, chainId);
      subtest.after(() => page.destroy());
      const signer = await page.getSigner(low.owner);
      const client = createLadderClient({ provider: page, signer, ladder, pollMs: 20 });
      let id;
      await assert.rejects(client.challenge(low.module, top.module, { onProgress: p => {
        if (p.id !== null) { id = p.id; throw new Error('interrupted after start'); }
      } }), /interrupted after start/);
      const before = await client.challengeInfo(id);
      assert.equal(before.status, STATUS.PLAYING);
      await assert.rejects(client.expire(id), e => decodeLadderError(e) === 'NotExpired');
      const partial = await client.replay(id);
      const block = Number(await provider.send('eth_blockNumber', []));
      await mine(before.deadline - block + 1);
      const nonce = await sent(signer);
      const progress = [];
      const result = await client.resume(id, { onProgress: p => progress.push(p) });
      assert.equal(result.status, STATUS.EXPIRED);
      assert.equal(await sent(signer), nonce + 1, 'only the settlement transaction is sent');
      const tx = await page.getTransaction((await page.getBlock('latest')).transactions[0]);
      assert.equal(iface.parseTransaction({ data: tx.data }).name, 'expire');
      assert.ok(tx.gasLimit < BigInt(PLAY_GAS), 'settlement does not pay for a play transaction');
      assert.equal(progress.at(-1).status, STATUS.EXPIRED);
      assert.equal(progress.at(-1).inFlight, 0);
      assert.equal((await reader.entry(low.module)).activeChallenge, 0);
      assert.equal((await reader.entry(top.module)).activeChallenge, 0);
      assert.deepEqual(await client.expire(id), result);
      assert.equal(await sent(signer), nonce + 1);
      const finalReplay = await client.replay(id);
      assert.equal(finalReplay.status, STATUS.EXPIRED);
      assert.deepEqual(finalReplay.episodes, partial.episodes);
    });


    await t.test('with the read provider of the page, a key signer registers right after the deployment receipt; the registrar owns the entry', async () => {
      // The dev signer of the page signs locally, so the read provider gives its nonces. Automine gives the receipt of
      // the deployment at once, so the register transaction follows it within the 250 ms request cache of ethers.
      const page = readProvider(chain.url, chainId);
      const key = ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase('test test test test test test test test test test test junk'), "m/44'/60'/0'/0/4").connect(page);
      const asKey = createLadderClient({ provider: page, signer: key, ladder, pollMs: 20 });
      try {
        for (const seed of [17, 19, 23]) {
          const { address } = await deployModule(key, factory, await artifactOf(fixedModel(INPUTS, [32, 32], ACTIONS, seed)), { moduleId: `key-seed-${seed}` });
          const r = await asKey.register(address);
          assert.equal(r.owner, key.address);
        }
        // the contract gives the entry to msg.sender, whoever deployed the module
        const byBob = await deployModule(bob, factory, await artifactOf(fixedModel(INPUTS, [32, 32], ACTIONS, 29)), { moduleId: 'bob-for-key' });
        const r = await asKey.register(byBob.address);
        assert.equal(r.owner, key.address);
        assert.equal((await reader.entry(byBob.address)).owner, key.address);
        // the archive of the Factory keeps the deployer, whoever registered the module
        assert.deepEqual((await reader.deploymentsOf(key.address)).map(d => d.moduleId), ['key-seed-17', 'key-seed-19', 'key-seed-23']);
        const bobsLast = (await reader.deploymentsOf(await bob.getAddress())).at(-1);
        assert.deepEqual({ module: bobsLast.module, moduleId: bobsLast.moduleId, deployer: bobsLast.deployer }, { module: byBob.address, moduleId: 'bob-for-key', deployer: await bob.getAddress() });
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
