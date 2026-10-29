// ladder.fixture.js — test fixture for the tests over the tank ladder (contracts/src/ladder/TankLadder.sol, ADR 0026).
// It starts a fresh anvil --network monad with the protocol (anvil.fixture.js localChain) and deploys a TankLadder
// from account 0 with the configuration of the spec, or the overrides given. `enter` deploys an artifact through the
// official Factory and registers it on the ladder. Tests skip with NO_FOUNDRY.
import { ethers } from 'ethers';
import { deployOut, localChain } from './anvil.fixture.js';
import { deployModule } from './module-chain.js';
import TankLadderABI from './abi/TankLadder.json' with { type: 'json' };

/** The configuration of the spec (TankLadder.Config without `factory` and `endBlock`). */
export const LADDER_DEFAULTS = Object.freeze({
  maxWeightBytes: 216_864,
  deltaBps: 1000,
  range: 10,
  timeoutBlocks: 400,
  cooldownBlocks: 6000,
  minStartGas: 24_000_000,
  reserveGas: 2_000_000,
});

/** The gas limit of a transaction that starts or advances a challenge: Monad's transaction limit. */
export const PLAY_GAS = 30_000_000;

/**
 * A fresh anvil with the protocol and a ladder on it → everything of localChain plus:
 *   - `ladder`: the address of the TankLadder, `ladderContract`: it as an ethers Contract of account 0
 *   - `config`: the Config it was deployed with (`endBlock` = the current block + `blocks`, default 1,000,000)
 *   - `enter(artifact, signer = account 0)`: deploys the artifact's module through the Factory as `signer` and
 *     registers it → `{ module, owner, rank, weightBytes }`
 * `overrides` change any Config field (`endBlock` wins over `blocks`).
 */
export async function localLadder({ blocks = 1_000_000, ...overrides } = {}) {
  const chain = await localChain();
  try {
    const current = await chain.provider.getBlockNumber();
    const config = { factory: chain.factory, ...LADDER_DEFAULTS, endBlock: current + blocks, ...overrides };
    const ladderContract = await deployOut(chain.signer, 'TankLadder', config);
    const ladder = await ladderContract.getAddress();
    const enter = async (artifact, signer = chain.signer) => {
      const { address: module } = await deployModule(signer, chain.factory, artifact);
      const rc = await (await ladderContract.connect(signer).register(module)).wait();
      const ev = rc.logs.map(l => { try { return ladderContract.interface.parseLog(l); } catch { return null; } }).find(e => e && e.name === 'EntryRegistered');
      if (!ev) throw new Error(`no EntryRegistered event: ${rc.hash}`);
      return { module, owner: ev.args.owner, rank: Number(ev.args.rank), weightBytes: Number(ev.args.weightBytes) };
    };
    return { ...chain, ladder, ladderContract, config, enter };
  } catch (e) { chain.stop(); throw e; }
}

/** The TankLadder at `address` as an ethers Contract of `runner` (a provider or a signer). */
export function ladderAt(runner, address) {
  return new ethers.Contract(address, TankLadderABI, runner);
}
