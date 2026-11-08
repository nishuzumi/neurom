// chain/practice.test.js — the practice challenge of the tank battle template (ADR 0028) over a fresh anvil with the
// protocol and a TankLadder on it (frontend/ladder.fixture.js). The script files practice.js and data.js of the
// script module 坦克对战 run in Node as the sandbox runs them: `viem` is a global, and the client is the one that the
// chain node gives a script (C4: a test client over a custom transport, with the public and wallet actions, and the
// network facts on `network`). The transport sends each request to anvil the way the page does, with the revert data
// on the error (core/script-calls.js chainError). A change of the contract, of its storage layout or of the scene
// fails this test. Skips with NO_FOUNDRY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as viem from 'viem';
import { ethers } from 'ethers';
import { NO_FOUNDRY } from '../../../frontend/anvil.fixture.js';
import { localLadder } from '../../../frontend/ladder.fixture.js';
import { ModuleGraph } from '../../../frontend/core/graph.js';
import { instantiateInto } from '../../../frontend/core/template.js';
import { buildBundle } from '../../../frontend/core/bundle.js';
import { builtinTemplate } from '../../../frontend/templates/index.js';
import { makeArtifact } from '../../../frontend/core/store.js';
import { scriptCalls, chainError } from '../../../frontend/core/script-calls.js';
import { deployModule } from '../../../frontend/module-chain.js';
import { DENSE_FORMAT } from '../../../frontend/runtime/dense-policy.js';
import { episodeSeed, unpackActions } from './client.js';
import TankLadderABI from '../../../frontend/abi/TankLadder.json' with { type: 'json' };

globalThis.viem = viem;

const [INPUTS, ACTIONS] = [572, 9];
const lower = a => String(a).toLowerCase();

/** A fixed dense FF model at int16 (as templates/tank-battle.test.js fixedModel). */
function fixedModel(inputs, hidden, outputs, seed) {
  let k = seed;
  const w = () => ((((k++) * 29 + 13) % 7) - 3) * 1000, b = () => ((((k++) * 17 + 5) % 5) - 1) * 1000;
  const region = (rows, cols) => ({ W: Array.from({ length: rows }, () => Array.from({ length: cols }, w)), b: Array.from({ length: rows }, b) });
  return { format: DENSE_FORMAT, kind: 'feedforward', inputs, outputs, weightBits: 16, ticks: 1, leak_shift: 0, reset: 0,
    layers: hidden.map((h, i) => ({ hidden: h, ...region(h, i ? hidden[i - 1] : inputs), scale: 1000, k: 0 })),
    output: { ...region(outputs, hidden.at(-1)), scale: 1000, k: 0 } };
}

/** The template instance: artifacts of the 中 structure of stage 1, the scene calls of the battle script as the
 *  sandbox gives them (`call.<name>(…args)`), and the files of the script loaded as modules. */
function template() {
  const graph = new ModuleGraph();
  const { ids } = instantiateInto(graph, builtinTemplate('tank-battle'));
  const page = scriptCalls(graph, graph.resolved(), ids.vs_battle, { artifacts: () => null });
  const call = Object.fromEntries(page.functions.map(name => [name, async (...args) => page.call(name, args)]));
  const file = name => import(`data:text/javascript,${encodeURIComponent(graph.node(ids.vs_battle).config.files.find(f => f.name === name).source)}`);
  return { artifactOf: model => makeArtifact({ bundle: buildBundle(graph, ids.s1_a_trainer), model }), call, file };
}

/** The client of a chain node with `write` (C4) over the JSON-RPC `url`: each request goes to the node, a failed one
 *  rejects with the error of the page bridge. `network` holds the facts of the node's chain. */
function chainNodeClient(url, network) {
  let id = 0;
  const request = async ({ method, params }) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }) });
    const body = await res.json();
    if (body.error) throw chainError(body.error);
    return body.result;
  };
  const client = viem.createTestClient({ mode: 'anvil', transport: viem.custom({ request }) }).extend(viem.publicActions).extend(viem.walletActions);
  client.network = network;
  return client;
}

test('the practice challenge of the template plays on anvil and leaves the ladder as it was', { skip: NO_FOUNDRY }, async t => {
  const chain = await localLadder();
  const { provider, factory, ladder, ladderContract } = chain;
  const chainId = Number((await provider.getNetwork()).chainId);
  const { artifactOf, call, file } = template();
  const [data, practice] = await Promise.all([file('data.js'), file('practice.js')]);
  const client = chainNodeClient(chain.url, { chainId, name: 'anvil', local: true, write: true, factory, ladder });
  const alice = await provider.getSigner(1);
  const owner = await provider.getSigner(0);
  /** The board as module addresses in rank order. */
  const board = async () => (await ladderContract.board()).map(e => lower(e.module));
  /** What a practice must not change. */
  const snapshot = async () => ({ board: await board(), challengeCount: Number(await ladderContract.challengeCount()), entryCount: Number(await ladderContract.entryCount()) });
  try {
    // three entries of alice at ranks 1 to 3, and a challenger that account 0 deployed and did not register
    const entries = [];
    for (const seed of [13, 17, 19]) entries.push(await chain.enter(await artifactOf(fixedModel(INPUTS, [32, 32], ACTIONS, seed)), alice));
    const challenger = (await deployModule(owner, factory, await artifactOf(fixedModel(INPUTS, [32, 32], ACTIONS, 11)), { moduleId: 'practice-mid' })).address;
    const before = await snapshot();
    assert.deepEqual(before, { board: entries.map(e => lower(e.module)), challengeCount: 0, entryCount: 3 });

    await t.test('listChallengers lists the tank networks of the archive of the unlocked accounts, and listBoard the board', async () => {
      const challengers = await practice.listChallengers(client, data);
      assert.deepEqual(challengers.map(c => [lower(c.module), c.moduleId, lower(c.deployer), c.entered]).sort(),
        [[lower(challenger), 'practice-mid', lower(await owner.getAddress()), false], ...entries.map(e => [lower(e.module), e.moduleId, lower(e.owner), true])].sort());
      const bytesOf = Object.fromEntries(challengers.map(c => [lower(c.module), c.weightBytes]));
      for (const e of entries) assert.equal(bytesOf[lower(e.module)], e.weightBytes, `${e.moduleId}: the weight bytes as the ladder counts them`);
      const rows = await practice.listBoard(client, data);
      assert.deepEqual(rows.map(r => [r.rank, lower(r.module), r.moduleId, r.weightBytes, r.wins, r.losses]), entries.map((e, k) => [k + 1, lower(e.module), e.moduleId, e.weightBytes, 0, 0]));
    });

    await t.test('one result per seed with 6 settled episodes, replayable on the scene; the ladder is unchanged after', async () => {
      const shown = [];
      const results = await practice.practice(client, data, { challenger, defender: entries[2].module, seeds: 2, onResult: r => shown.push(r.seed) });
      assert.deepEqual(shown, [1, 2]);
      assert.equal(results.length, 2);
      for (const r of results) {
        assert.equal(r.error, null, `seed ${r.seed}: ${r.error}`);
        assert.ok([data.STATUS.CHALLENGER_WON, data.STATUS.DEFENSE].includes(r.status), `seed ${r.seed}: settled, status ${r.status}`);
        assert.equal(r.statusText, data.STATUS_TEXT[r.status]);
        assert.deepEqual([r.rank, r.defenderRank], [4, 3], 'the challenger sits one rank below the defender');
        assert.ok(r.blocks >= 1 && r.blocks <= data.MAX_BLOCKS);
        assert.equal(r.id, 1, 'each seed starts the first challenge of the fork again');
        assert.equal(r.episodes.length, data.EPISODES);
        assert.equal(r.challengerWins + r.defenderWins, r.episodes.filter(ep => ep.result !== 'draw').length);
        assert.equal(r.challengerWins, r.episodes.filter(ep => ep.result === 'win').length);
        assert.ok(r.gasUsed > 0 && r.transactions >= 1);
        for (const ep of r.episodes) {
          assert.equal(ep.challengerSide, ep.episode % 2);
          assert.equal(ep.seed, episodeSeed(r.challengeSeed, Math.floor(ep.episode / 2)));
          assert.ok(ep.actions.length > 0 && ep.actions.every(([a0, a1]) => a0 >= 0 && a0 < 9 && a1 >= 0 && a1 < 9));
          assert.equal(ep.steps, ep.actions.length);
          assert.ok([0, 1, 2].includes(ep.end), `episode ${ep.episode} ended`);
          assert.equal(ep.result, ep.end === 2 ? 'draw' : ep.end === ep.challengerSide ? 'win' : 'loss');
        }
      }
      // the scene of the template plays the actions of the events to the same end
      const seen = [];
      const last = await practice.replayEpisode(call, results[0].episodes[0], { show: (s, entry) => seen.push(entry) });
      assert.deepEqual([last.end, last.t], [results[0].episodes[0].end, results[0].episodes[0].steps]);
      assert.equal(seen.length, results[0].episodes[0].actions.length + 1, 'the start and each step');
      assert.deepEqual(seen.slice(1).map(e => e.moves), results[0].episodes[0].actions);
      assert.deepEqual(await snapshot(), before, 'the revert undid the registration, the board and the challenge');
      assert.equal(await ladderContract.entryOwner(challenger), ethers.ZeroAddress);
    });

    await t.test('a defender several ranks above works: the board is rewritten under the snapshot', async () => {
      const [r] = await practice.practice(client, data, { challenger, defender: entries[0].module, seeds: 1 });
      assert.equal(r.error, null, r.error);
      assert.deepEqual([r.rank, r.defenderRank], [2, 1]);
      assert.equal(r.episodes.length, data.EPISODES);
      assert.deepEqual(await snapshot(), before);
    });

    await t.test('an owner with EIP-7702 code, as the public anvil accounts on Monad testnet, still challenges; the revert gives the code back', async () => {
      const address = await owner.getAddress(), delegated = '0xef0100' + '11'.repeat(20);
      await provider.send('anvil_setCode', [address, delegated]);
      try {
        const [r] = await practice.practice(client, data, { challenger, defender: entries[2].module, seeds: 1 });
        assert.equal(r.error, null, r.error);
        assert.equal(r.episodes.length, data.EPISODES);
        assert.equal(await provider.getCode(address), delegated, 'the fork has the delegation again after the practice');
        assert.deepEqual(await snapshot(), before);
      } finally { await provider.send('anvil_setCode', [address, '0x']); }
    });

    await t.test('a challenger that is on the board moves to the rank below the defender, from its own owner', async () => {
      const [r] = await practice.practice(client, data, { challenger: entries[2].module, defender: entries[0].module, seeds: 1 });
      assert.equal(r.error, null, r.error);
      assert.deepEqual([r.rank, r.defenderRank], [2, 1]);
      assert.ok(r.episodes.every(ep => [0, 1, 2].includes(ep.end)));
      assert.deepEqual(await snapshot(), before);
    });

    await t.test('an error of the contract reads as its text, and stop ends the run after the seed', async () => {
      // a twin of entry 1 cannot register: DuplicateWeights(entry)
      const twin = (await deployModule(owner, factory, await artifactOf(fixedModel(INPUTS, [32, 32], ACTIONS, 13)), { moduleId: 'practice-twin' })).address;
      let done = 0;
      const results = await practice.practice(client, data, { challenger: twin, defender: entries[2].module, seeds: 3, onResult: () => done++, stopped: () => done >= 1 });
      assert.equal(results.length, 1);
      assert.equal(results[0].error, `权重和已登记的条目 ${viem.getAddress(entries[0].module)} 相同`);
      assert.deepEqual(results[0].episodes, []);
      // the practice decides before the chain: the same module on both sides, and a module the Factory did not deploy
      assert.equal((await practice.practice(client, data, { challenger: entries[0].module, defender: entries[0].module, seeds: 1 }))[0].error, '挑战者和擂主是同一个模块');
      assert.equal((await practice.practice(client, data, { challenger: ladder, defender: entries[0].module, seeds: 1 }))[0].error, '挑战者不是官方 Factory 部署的模块');
      assert.deepEqual(await snapshot(), before);
    });
  } finally { chain.stop(); }
});

test('the helpers of practice.js follow the contract', async () => {
  const { file } = template();
  const [data, practice] = await Promise.all([file('data.js'), file('practice.js')]);
  const bytes = '0x' + [0, 8, 9 * 4 + 7, 80].map(b => b.toString(16).padStart(2, '0')).join('');
  assert.deepEqual(practice.unpackActions(bytes), [[0, 0], [0, 8], [4, 7], [8, 8]]);
  assert.deepEqual(practice.unpackActions(bytes), unpackActions(bytes));
  const seed = ethers.id('seed');
  for (const pair of [0, 1, 2]) assert.equal(practice.episodeSeed(seed, pair), episodeSeed(seed, pair));
  const iface = new ethers.Interface(TankLadderABI);
  const hex = iface.encodeErrorResult('LowGas', [5, 7]);
  assert.equal(practice.describeError({ data: hex }, data), 'gas 不够：剩 5，至少要 7');
  assert.equal(practice.describeError(new Error(`execution reverted data=${hex}`), data), 'gas 不够：剩 5，至少要 7');
  assert.equal(practice.describeError(new Error('x', { cause: { details: `reverted ${hex}` } }), data), 'gas 不够：剩 5，至少要 7');
  assert.equal(practice.describeError({ data: iface.encodeErrorResult('NotEntered', []) }, data), data.ERROR_TEXT.NotEntered);
  assert.equal(practice.describeError(new Error('network down'), data), 'network down');
  assert.equal(practice.revertData(new Error(`sent 0x${'ab'.repeat(32)} to 0x${'cd'.repeat(20)}`)), null, 'a hash or an address is not revert data');
  for (const name of Object.keys(data.ERROR_TEXT)) assert.ok(iface.getError(name), `${name} is an error of the contract`);
});
