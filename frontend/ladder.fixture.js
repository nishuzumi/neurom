// ladder.fixture.js — test fixture for the tests over the tank ladder (contracts/src/ladder/TankLadder.sol, ADR 0026).
// It starts a fresh anvil --network monad with the protocol (anvil.fixture.js localChain) and deploys a TankLadder
// from account 0 with the configuration of the spec, or the overrides given. `enter` deploys an artifact through the
// official Factory and registers it on the ladder. Tests skip with NO_FOUNDRY.
// `mined` and `playChallenge` are for the scripts that drive a ladder from a signer (site/scripts, contracts/scripts).
import { ethers } from 'ethers';
import { deployOut, localChain } from './anvil.fixture.js';
import { deployModule } from './module-chain.js';
import TankLadderABI from './abi/TankLadder.json' with { type: 'json' };
import { TX_GAS_LIMIT } from './monad.js';
import defaults from '../contracts/ladder-defaults.json' with { type: 'json' };

/** The configuration of the spec (TankLadder.Config without `factory` and `endBlock`), from contracts/ladder-defaults.json. */
export const LADDER_DEFAULTS = Object.freeze({
  maxWeightBytes: defaults.maxWeightBytes,
  deltaBps: defaults.deltaBps,
  range: defaults.range,
  boardSize: defaults.boardSize,
  timeoutBlocks: defaults.timeoutBlocks,
  cooldownBlocks: defaults.cooldownBlocks,
  minStartGas: defaults.minStartGas,
  reserveGas: defaults.reserveGas,
});

/**
 * A fresh anvil with the protocol and a ladder on it → everything of localChain plus:
 *   - `ladder`: the address of the TankLadder, `ladderContract`: it as an ethers Contract of account 0
 *   - `config`: the Config it was deployed with (`endBlock` = the current block + `blocks`, default 1,000,000)
 *   - `enter(artifact, signer = account 0, moduleId = a fresh fixture id)`: deploys the artifact's module through the
 *     Factory as `signer` under `moduleId` and registers it → `{ module, moduleId, owner, rank, weightBytes }`. The
 *     default id is `fixture-<12 hex of the artifact id>-<n>`, distinct per call, so one artifact can enter many times.
 * `overrides` change any Config field (`endBlock` wins over `blocks`).
 */
export async function localLadder({ blocks = 1_000_000, ...overrides } = {}) {
  const chain = await localChain();
  try {
    const current = await chain.provider.getBlockNumber();
    const config = { factory: chain.factory, ...LADDER_DEFAULTS, endBlock: current + blocks, ...overrides };
    const ladderContract = await deployOut(chain.signer, 'TankLadder', config);
    const ladder = await ladderContract.getAddress();
    let entered = 0;
    const enter = async (artifact, signer = chain.signer, moduleId = `fixture-${String(artifact.id).slice(2, 14)}-${++entered}`) => {
      const { address: module } = await deployModule(signer, chain.factory, artifact, { moduleId });
      const rc = await (await ladderContract.connect(signer).register(module)).wait();
      const ev = ladderEvents(ladderContract, rc).find(e => e.name === 'EntryRegistered');
      if (!ev) throw new Error(`no EntryRegistered event: ${rc.hash}`);
      return { module, moduleId, owner: ev.args.owner, rank: Number(ev.args.rank), weightBytes: Number(ev.args.weightBytes) };
    };
    return { ...chain, ladder, ladderContract, config, enter };
  } catch (e) { chain.stop(); throw e; }
}

/** The TankLadder at `address` as an ethers Contract of `runner` (a provider or a signer). */
export function ladderAt(runner, address) {
  return new ethers.Contract(address, TankLadderABI, runner);
}

/** The events of the ladder `contract` in receipt `rc`, parsed. Logs of other contracts are left out. */
export function ladderEvents(contract, rc) {
  return rc.logs.map(l => { try { return contract.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
}

/** Poll the receipt of `hash` (ethers' wait() misses receipts of large transactions on anvil), then wait until the
 *  node reports its block as the latest: anvil hands out the receipt a moment before the state and the block number
 *  move, and the next nonce lookup would be stale. */
export async function mined(provider, hash, { timeoutMs = 180_000 } = {}) {
  const until = Date.now() + timeoutMs;
  let rc = null;
  while (!rc && Date.now() < until) { rc = await provider.getTransactionReceipt(hash); if (!rc) await new Promise(r => setTimeout(r, 100)); }
  if (!rc) throw new Error(`no receipt for ${hash} after ${timeoutMs / 1000}s`);
  while ((await provider.getBlockNumber()) < rc.blockNumber && Date.now() < until) await new Promise(r => setTimeout(r, 50));
  return rc;
}

/**
 * Play a challenge from the contract until it is settled: `challenge(challenger, defender)` as the signer of `ladder`
 * (a TankLadder Contract of a signer), then `advance` while the challenge is active, each with the gas limit TX_GAS_LIMIT.
 * `onReceipt(rc, info)` gets every receipt with the challengeInfo read after it. `maxTransactions` stops the loop
 * early (the challenge then stays active). A reverted transaction throws.
 *  → `{ id, receipts, info }`: the challenge id, the receipts in sending order and the last challengeInfo.
 */
export async function playChallenge(ladder, challenger, defender, { onReceipt = () => {}, maxTransactions = Infinity } = {}) {
  const provider = ladder.runner.provider;
  const receipts = [];
  const send = async (method, args) => {
    const tx = await ladder[method](...args, { gasLimit: TX_GAS_LIMIT });
    const rc = await mined(provider, tx.hash);
    if (rc.status !== 1) throw new Error(`${method} reverted: ${tx.hash}`);
    receipts.push(rc);
    return rc;
  };
  let rc = await send('challenge', [challenger, defender]);
  const started = ladderEvents(ladder, rc).find(e => e.name === 'ChallengeStarted');
  if (!started) throw new Error(`no ChallengeStarted event: ${rc.hash}`);
  const id = started.args.id;
  let info = await ladder.challengeInfo(id);
  await onReceipt(rc, info);
  while (Number(info.status) === 1 && receipts.length < maxTransactions) {
    rc = await send('advance', [id]);
    info = await ladder.challengeInfo(id);
    await onReceipt(rc, info);
  }
  return { id, receipts, info };
}
