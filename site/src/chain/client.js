// chain/client.js — the ladder client (ticket 06, contract-interface.md "Ladder client API"). Plain JS over ethers 6,
// no React: the page reaches the chain only through this module.
//   - Reads: the configuration, the board (the ranked entries), every entry on and off the board, the targets of an
//     entry with the refusal the contract would give, a challenge, the recent challenges and the replay of a
//     challenge from its events.
//   - Registration: `register(module)` enters a module that the workbench already deployed through the official
//     Factory. The client sends only the register transaction: it never deploys weights or modules.
//   - The archive: `deploymentCount(deployer)` and `deploymentsOf(deployer)` read the modules an account deployed
//     through the official Factory, with their English ids and descriptors. The page chooses the module to register
//     from this list (on-chain state, not events, not local storage).
//   - A challenge: the start transaction with the gas limit PLAY_GAS (Monad's transaction limit, above the contract's
//     minStartGas), then `advance` transactions with explicit nonces, at most MAX_IN_FLIGHT in flight. The receipts
//     come by polling the hash: ethers' `wait()` misses the receipts of large transactions on anvil --network monad
//     (ethers 6.13, measured for 30M-gas transactions). Every receipt reports the progress read from the events. Monad charges the gas
//     limit of a transaction, so the client keeps no more transactions in flight than the typical remaining steps
//     need (step-gas.json): a transaction that lands after the settlement reverts and pays its whole limit.
//   - A refusal is a custom error of the contract: `decodeLadderError` gives its name from any error ethers throws,
//     and the errors this module throws carry the revert data too.
import { AbiCoder, Contract, Interface, keccak256, getAddress, isAddress, ZeroAddress } from 'ethers';
import TankLadderABI from '../../../frontend/abi/TankLadder.json' with { type: 'json' };
import ModuleFactoryABI from '../../../frontend/abi/ModuleFactory.json' with { type: 'json' };
import NeuromModuleABI from '../../../frontend/abi/NeuromModule.json' with { type: 'json' };
import stepGas from '../../data/step-gas.json' with { type: 'json' };
import { DENSE_KINDS } from '../../../frontend/runtime/dense-policy.js';

/** The gas limit of a transaction that starts or advances a challenge: Monad's transaction limit. */
export const PLAY_GAS = 30_000_000;
/** The most transactions of one account in flight during a challenge. */
export const MAX_IN_FLIGHT = 3;
/** Episodes of a challenge (TankLadder.EPISODES) and steps of an episode (TankScene.STEPS). */
export const EPISODES = 6;
const STEPS = 100;
/** The status codes of ChallengeInfo.status. */
export const STATUS = Object.freeze({ NONE: 0, PLAYING: 1, CHALLENGER_WON: 2, DEFENSE: 3, EXPIRED: 4 });
/** The modules one `modulesByDeployer` request reads from the archive of the Factory. */
const ARCHIVE_PAGE = 50;
/** Public RPC endpoints accept log queries of at most 100 blocks. */
const LOG_BLOCKS = 100;
/** The entries one `entries` request reads. */
const ENTRY_PAGE = 100;

const iface = new Interface(TankLadderABI);
const coder = AbiCoder.defaultAbiCoder();
const num = v => Number(v);
/** The custom errors of the contract. */
const ERROR_NAMES = new Set(TankLadderABI.filter(f => f.type === 'error').map(f => f.name));
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** The topics of the events a replay reads. */
const REPLAY_TOPICS = [iface.getEvent('Steps').topicHash, iface.getEvent('EpisodeEnded').topicHash];

// ------------------------------------------------------------------------------------------------ errors

/** The revert data (hex) inside `error`, wherever ethers or a wallet put it, or null. */
function revertDataOf(error, depth = 0) {
  if (!error || typeof error !== 'object' || depth > 6) return null;
  for (const v of [error.data, error.info?.error?.data, error.error?.data, error.info?.data]) {
    if (typeof v === 'string' && v.startsWith('0x') && v.length >= 10) return v;
    if (v && typeof v === 'object' && typeof v.data === 'string' && v.data.startsWith('0x')) return v.data;
  }
  return revertDataOf(error.cause, depth + 1) ?? revertDataOf(error.error, depth + 1) ?? revertDataOf(error.info?.error, depth + 1);
}

/** The name of the TankLadder custom error that `error` carries (an error of ethers, a wallet or this module), or null. */
export function decodeLadderError(error) {
  if (!error || typeof error !== 'object') return null;
  if (typeof error.ladderError === 'string') return error.ladderError;
  if (error.revert && typeof error.revert.name === 'string' && ERROR_NAMES.has(error.revert.name)) return error.revert.name;
  const data = revertDataOf(error);
  if (!data) return null;
  try { const name = iface.parseError(data)?.name; return name && ERROR_NAMES.has(name) ? name : null; } catch { return null; }
}

/** An error of this module for revert data `data` (null when unknown): `.ladderError` names the custom error. */
function ladderError(message, data, extra = {}) {
  let name = null, args = null;
  if (data) { try { const e = iface.parseError(data); if (e && ERROR_NAMES.has(e.name)) { name = e.name; args = e.args; } } catch { /* not ours */ } }
  const cause = extra.cause?.shortMessage ?? extra.cause?.message;
  const e = new Error(name ? `${message}: ${name}` : cause ? `${message}: ${cause}` : message);
  return Object.assign(e, { data: data ?? undefined, ladderError: name, ladderArgs: args, ...extra });
}

// ------------------------------------------------------------------------------------------------ pure helpers

/** The seed of mirror pair `pair` (0..2) of a challenge with `seed`, as the contract derives it (_episodeSeed). */
export function episodeSeed(seed, pair) {
  return Number(BigInt(keccak256(coder.encode(['bytes32', 'uint256'], [seed, pair]))) & 0xffffffffn);
}

/** One byte of a Steps event → the two actions `[a0, a1]`. */
const unpackAction = b => [Math.floor(b / 9), b % 9];

/** The bytes of a Steps event (hex) → `[[a0, a1], ...]`. */
export function unpackActions(hex) {
  const out = [];
  for (let k = 2; k < hex.length; k += 2) out.push(unpackAction(parseInt(hex.slice(k, k + 2), 16)));
  return out;
}

const entryOf = e => ({ rank: num(e.rank), module: e.module, owner: e.owner, weightBytes: num(e.weightBytes), wins: num(e.wins), losses: num(e.losses), activeChallenge: num(e.activeChallenge) });

const infoOf = (id, i) => ({ id: num(id), challenger: i.challenger, defender: i.defender, seed: i.seed, startBlock: num(i.startBlock), deadline: num(i.deadline), status: num(i.status), episode: num(i.episode), step: num(i.step), challengerWins: num(i.challengerWins), defenderWins: num(i.defenderWins) });

/** The gas of one `forward` of a network of `weightBytes` (step-gas.json: linear in the bytes). */
const forwardGas = weightBytes => Math.round(stepGas.forward.intercept + stepGas.forward.perByte * weightBytes);

/** The steps one play transaction with the reserve `reserveGas` holds for two networks of `cBytes` and `dBytes`, and the
 *  gas of one step. */
function stepPlan(cBytes, dBytes, reserveGas) {
  const step = forwardGas(cBytes) + forwardGas(dBytes) + stepGas.scenePerStep;
  const stepsPerTransaction = Math.max(1, Math.floor((PLAY_GAS - reserveGas - stepGas.perTransaction) / step));
  return { step, stepsPerTransaction };
}

/** The events of TankLadder in receipt `rc`, in log order. */
function ladderLogs(rc, ladder) {
  const at = ladder.toLowerCase(), out = [];
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== at) continue;
    try { const e = iface.parseLog({ topics: [...l.topics], data: l.data }); if (e) out.push({ ...e, log: l }); } catch { /* not ours */ }
  }
  return out;
}

/** `state` (a progress record) after the events of one play receipt. */
function applyLogs(state, logs) {
  for (const e of logs) {
    switch (e.name) {
      case 'ChallengeStarted': state.id = num(e.args.id); break;
      case 'Steps': state.episode = num(e.args.episode); state.step = num(e.args.fromStep) + (e.args.actions.length - 2) / 2; break;
      case 'EpisodeEnded': {
        const end = num(e.args.end), episode = num(e.args.episode);
        if (end === 0 || end === 1) { if ((end === 0) !== (episode % 2 === 1)) state.challengerWins++; else state.defenderWins++; }
        state.episode = episode + 1; state.step = 0;
        break;
      }
      case 'ChallengeSettled': state.status = num(e.args.status); state.challengerWins = num(e.args.challengerWins); state.defenderWins = num(e.args.defenderWins); state.newRank = num(e.args.newRank); break;
      default: break;
    }
  }
  return state;
}

// ------------------------------------------------------------------------------------------------ the client

/**
 * The ladder client → see contract-interface.md. `provider` reads; `signer` (optional) sends. `ladder` is the address
 * of the TankLadder (the Factory comes from its configuration). `pollMs`: the interval of the receipt polling
 * (default 250 ms). `receiptTimeoutMs`: how long a sent transaction may stay unmined before the client gives up
 * (default 10 minutes). `maxInFlight` caps the pipeline (default MAX_IN_FLIGHT, 3).
 */
export function createLadderClient({ provider, signer = undefined, ladder, pollMs = 250, receiptTimeoutMs = 600_000, maxInFlight = MAX_IN_FLIGHT }) {
  if (!provider) throw new Error('createLadderClient: provider is required');
  if (!ladder) throw new Error('createLadderClient: ladder address is required');
  const reader = new Contract(ladder, TankLadderABI, provider);
  const writer = signer ? new Contract(ladder, TankLadderABI, signer) : null;
  const requireSigner = () => { if (!signer) throw new Error('this operation needs a signer'); return signer; };
  let fixedFlight = null;
  const eventCache = new Map();
  const gasReceipts = new Map();

  /** The receipt of `hash`, polled by the hash. Throws after `receiptTimeoutMs`. */
  async function receiptOf(hash) {
    const until = Date.now() + receiptTimeoutMs;
    for (;;) {
      const rc = await provider.getTransactionReceipt(hash);
      if (rc) return rc;
      if (Date.now() > until) throw Object.assign(new Error(`no receipt for ${hash} after ${receiptTimeoutMs} ms`), { code: 'RECEIPT_TIMEOUT', hash });
      await sleep(pollMs);
    }
  }

  /** The error of a transaction `tx` that reverted in receipt `rc`: replays it as a call on the state before its
   *  block to read the revert data. Without data (the state moved on), a plain error with the hash. */
  async function revertError(tx, rc, what) {
    let data = null;
    try {
      await provider.call({ from: tx.from, to: tx.to, data: tx.data, gasLimit: tx.gasLimit, blockTag: Math.max(0, num(rc.blockNumber) - 1) });
    } catch (e) { data = revertDataOf(e); }
    return ladderError(`${what} reverted (${rc.hash})`, data, { hash: rc.hash, receipt: rc });
  }

  /** A dry run of `method(...args)` as the signer with the play gas: throws the decoded refusal (with `extra` on the
   *  error), ignores other failures (a node that caps eth_call below PLAY_GAS cannot tell). */
  async function precheck(method, args, from, extra = {}) {
    try { await writer[method].staticCall(...args, { gasLimit: PLAY_GAS, from }); } catch (e) {
      const name = decodeLadderError(e);
      if (name) throw ladderError(`${method} refused`, revertDataOf(e), { ladderError: name, cause: e, ...extra });
    }
  }

  /** The steps one play transaction of the pair of `state` holds, or null when the read failed. The weight bytes
   *  of the two entries do not change during a challenge, so `play` reads the plan once. */
  async function stepsPerTransactionOf(state) {
    try {
      const [c, d, cfg] = await Promise.all([reader.entry(state.challenger), reader.entry(state.defender), fixedConfig()]);
      return stepPlan(num(c.weightBytes), num(d.weightBytes), cfg.reserveGas).stepsPerTransaction;
    } catch { return null; }
  }

  /** The number of transactions worth keeping in flight for the typical remaining steps of `state`. Without a step
   *  plan (`perTransaction` null), the pipeline is full. */
  function depthFor(state, perTransaction) {
    if (!perTransaction) return maxInFlight;
    const remaining = Math.max(1, (EPISODES - state.episode) * stepGas.stepsPerEpisode.mean - state.step);
    return Math.min(maxInFlight, Math.max(1, Math.ceil(remaining / perTransaction)));
  }

  /**
   * Plays challenge `state.id` on with `advance` transactions until it settles. `state` is the progress record of the
   * last confirmed receipt; `nonce` the next nonce of the signer; `deadline` the deadline block of the challenge.
   * Reports every receipt through `onProgress`.
   */
  async function play(state, nonce, deadline, onProgress) {
    const s = requireSigner();
    const data = iface.encodeFunctionData('advance', [state.id]);
    const pending = [];
    const report = () => onProgress({ ...state, inFlight: pending.length });
    const settleExpired = async () => {
      for (const tx of pending.splice(0)) {
        await receiptOf(tx.hash);
        state.confirmed++;
        report();
      }
      const confirmed = state.confirmed;
      return expire(state.id, { onProgress: p => onProgress({ ...p, confirmed: confirmed + p.confirmed }) });
    };
    let perTransaction = await stepsPerTransactionOf(state);
    let depth = depthFor(state, perTransaction);
    while (state.status === STATUS.PLAYING) {
      if (await blockNumber() > deadline) return settleExpired();
      while (pending.length < depth) pending.push(await s.sendTransaction({ to: ladder, data, gasLimit: PLAY_GAS, nonce: nonce++ }));
      const tx = pending.shift();
      const rc = await receiptOf(tx.hash);
      state.confirmed++;
      if (num(rc.status) !== 1) {
        const now = await challengeInfo(state.id);
        if (!now || (now.status === STATUS.PLAYING && await blockNumber() <= deadline)) throw await revertError(tx, rc, 'advance');
        Object.assign(state, { status: now.status, episode: now.episode, step: now.step, challengerWins: now.challengerWins, defenderWins: now.defenderWins });
      } else applyLogs(state, ladderLogs(rc, ladder));
      report();
      if (state.status === STATUS.PLAYING && pending.length < depth) {
        perTransaction ??= await stepsPerTransactionOf(state);
        depth = Math.min(depth, depthFor(state, perTransaction));
      }
    }
    for (const tx of pending.splice(0)) { await receiptOf(tx.hash); state.confirmed++; report(); }
    return challengeInfo(state.id);
  }

  /** The fields of the configuration that never change, read once. A failed read is tried again on the next call. */
  function fixedConfig() {
    fixedFlight ??= reader.config().then(
      c => ({ factory: c.factory, maxWeightBytes: num(c.maxWeightBytes), deltaBps: num(c.deltaBps), range: num(c.range), boardSize: num(c.boardSize), timeoutBlocks: num(c.timeoutBlocks), cooldownBlocks: num(c.cooldownBlocks), minStartGas: num(c.minStartGas), reserveGas: num(c.reserveGas) }),
      e => { fixedFlight = null; throw e; });
    return fixedFlight;
  }

  /** The configuration of the ladder. `endBlock` is read on every call, because the admin can move it. */
  async function config() {
    const [fixed, endBlock] = await Promise.all([fixedConfig(), reader.endBlock()]);
    return { ...fixed, endBlock: num(endBlock) };
  }

  /** The current block, fresh (JsonRpcProvider caches getBlockNumber for a moment). */
  async function blockNumber() {
    return Number(await provider.send('eth_blockNumber', []));
  }

  /** The entries on the board in rank order (rank 1 first). */
  async function board() {
    return (await reader.board()).map(entryOf);
  }

  /** Every entry in the order of registration: rank ≥ 1 on the board, rank 0 off it. */
  async function entries() {
    const total = num(await reader.entryCount());
    const pages = [];
    for (let from = 0; from < total; from += ENTRY_PAGE) pages.push(reader.entries(from, ENTRY_PAGE));
    return (await Promise.all(pages)).flat().map(entryOf);
  }

  /** Entry `module` (rank 0 = off the board), null when it is not entered. */
  async function entry(module) {
    const e = entryOf(await reader.entry(module));
    return e.owner === ZeroAddress ? null : e;
  }

  async function challengeInfo(id) {
    const i = infoOf(id, await reader.challengeInfo(id));
    return i.status === STATUS.NONE ? null : i;
  }

  async function targets(module) {
    const [me, cfg, block, from, ranked] = await Promise.all([entry(module), config(), blockNumber(), signer ? signer.getAddress() : null, board()]);
    if (!me) return [];
    // off the board, the board is full: the entry challenges as the rank below the last
    const myRank = me.rank || ranked.length + 1;
    const above = ranked.filter(d => d.rank < myRank && myRank - d.rank <= cfg.range);
    return Promise.all(above.map(async d => {
      const cooldownUntil = num(await reader.cooldownUntil(module, d.module));
      let reason = null;
      if (block >= cfg.endBlock) reason = 'SeasonOver';
      else if (from && me.owner.toLowerCase() !== from.toLowerCase()) reason = 'NotOwner';
      else if (me.activeChallenge !== 0) reason = 'Busy';
      else if (block < cooldownUntil) reason = 'Cooldown';
      return { ...d, cooldownUntil, reason };
    }));
  }

  async function estimate(challenger, defender) {
    const [c, d, fee] = await Promise.all([reader.entry(challenger), reader.entry(defender), provider.getFeeData()]);
    const { step, stepsPerTransaction } = stepPlan(num(c.weightBytes), num(d.weightBytes), (await fixedConfig()).reserveGas);
    const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    const of = steps => {
      const transactions = Math.max(1, Math.ceil(steps / stepsPerTransaction));
      const gas = steps * step + transactions * stepGas.perTransaction;
      // Monad charges the gas limit of a transaction, not the gas it uses
      return { steps, transactions, gas, cost: BigInt(transactions) * BigInt(PLAY_GAS) * price };
    };
    const typical = of(EPISODES * stepGas.stepsPerEpisode.mean), worst = of(EPISODES * STEPS);
    return { gasWorst: worst.gas, gasTypical: typical.gas, txWorst: worst.transactions, txTypical: typical.transactions, costWorstWei: worst.cost, costTypicalWei: typical.cost, stepsPerTransaction };
  }

  /** Enters `module` (the address of a module the official Factory deployed) under the signer: one register
   *  transaction, after a dry run that throws the refusal the contract would give. The signer becomes the owner. */
  async function register(module, { onStatus = () => {} } = {}) {
    const s = requireSigner();
    if (!isAddress(module)) throw new Error(`register: ${String(module)} is not a module address`);
    const address = getAddress(module);
    const from = await s.getAddress();
    onStatus({ stage: 'registering', message: `registering ${address}`, module: address });
    await precheck('register', [address], from, { module: address });
    let tx;
    try { tx = await writer.register(address); } catch (e) { throw ladderError('register refused', revertDataOf(e), { ladderError: decodeLadderError(e), cause: e, module: address }); }
    const rc = await receiptOf(tx.hash);
    if (num(rc.status) !== 1) throw await revertError(tx, rc, 'register');
    const ev = ladderLogs(rc, ladder).find(e => e.name === 'EntryRegistered');
    if (!ev) throw new Error(`register: no EntryRegistered event in ${rc.hash}`);
    const result = { module: address, rank: num(ev.args.rank), owner: ev.args.owner, weightBytes: num(ev.args.weightBytes), txHash: rc.hash };
    onStatus({ stage: 'registered', message: result.rank ? `registered at rank ${result.rank}` : 'registered off the board (the board is full)', ...result });
    return result;
  }

  async function challenge(challenger, defender, { onProgress = () => {} } = {}) {
    const s = requireSigner();
    const from = await s.getAddress();
    await precheck('challenge', [challenger, defender], from);
    const data = iface.encodeFunctionData('challenge', [challenger, defender]);
    let nonce = await provider.getTransactionCount(from, 'pending');
    const state = { id: null, challenger: getAddress(challenger), defender: getAddress(defender), episode: 0, step: 0, status: STATUS.PLAYING, challengerWins: 0, defenderWins: 0, newRank: null, confirmed: 0 };
    onProgress({ ...state, inFlight: 1 });
    const tx = await s.sendTransaction({ to: ladder, data, gasLimit: PLAY_GAS, nonce: nonce++ });
    const rc = await receiptOf(tx.hash);
    state.confirmed++;
    if (num(rc.status) !== 1) throw await revertError(tx, rc, 'challenge');
    applyLogs(state, ladderLogs(rc, ladder));
    if (state.id === null) throw new Error(`challenge: no ChallengeStarted event in ${rc.hash}`);
    onProgress({ ...state, inFlight: 0 });
    if (state.status !== STATUS.PLAYING) return challengeInfo(state.id);
    return play(state, nonce, (await challengeInfo(state.id)).deadline, onProgress);
  }

  async function resume(id, { onProgress = () => {} } = {}) {
    const s = requireSigner();
    const info = await challengeInfo(id);
    if (!info) throw new Error(`challenge ${id} does not exist`);
    if (info.status !== STATUS.PLAYING) return info;
    const from = await s.getAddress();
    if (await blockNumber() > info.deadline) return expire(id, { onProgress });
    try { await precheck('advance', [id], from); } catch (error) {
      if (decodeLadderError(error) === 'Expired') return expire(id, { onProgress });
      throw error;
    }
    const state = { id: info.id, challenger: info.challenger, defender: info.defender, episode: info.episode, step: info.step, status: info.status, challengerWins: info.challengerWins, defenderWins: info.defenderWins, newRank: null, confirmed: 0 };
    onProgress({ ...state, inFlight: 0 });
    return play(state, await provider.getTransactionCount(from, 'pending'), info.deadline, onProgress);
  }

  /** Settles a timeout with estimated gas. A settled challenge needs no transaction. */
  async function expire(id, { onProgress = () => {} } = {}) {
    requireSigner();
    const info = await challengeInfo(id);
    if (!info) throw new Error(`challenge ${id} does not exist`);
    if (info.status !== STATUS.PLAYING) return info;
    onProgress({ ...info, phase: 'settling', confirmed: 0, inFlight: 1 });
    let tx;
    try { tx = await writer.expire(id); } catch (error) {
      if (decodeLadderError(error) === 'NotPlaying') {
        const now = await challengeInfo(id);
        if (now && now.status !== STATUS.PLAYING) return now;
      }
      throw ladderError('expire refused', revertDataOf(error), { cause: error });
    }
    const rc = await receiptOf(tx.hash);
    const result = await challengeInfo(id);
    if (num(rc.status) !== 1 && result?.status === STATUS.PLAYING) throw await revertError(tx, rc, 'expire');
    if (!result || result.status === STATUS.PLAYING) throw new Error(`expire ${id}: settlement is not confirmed`);
    onProgress({ ...result, phase: 'settling', confirmed: 1, inFlight: 0 });
    return result;
  }

  /** Reads both replay event types together. Historical blocks are shared with gas totals. */
  async function challengeEvents(info, latest) {
    const end = Math.min(latest, info.deadline);
    if (end < info.startBlock) return [];
    let cached = eventCache.get(info.id);
    if (!cached) {
      cached = { through: info.startBlock - 1, events: [], flight: null };
      eventCache.set(info.id, cached);
    }
    const filter = [REPLAY_TOPICS, coder.encode(['uint256'], [info.id])];
    // Do not cache the current block. Concurrent reads share each historical range.
    const through = Math.min(end, latest - 1);
    while (cached.through < through) {
      if (!cached.flight) cached.flight = (async () => {
        for (let from = cached.through + 1; from <= through; from += LOG_BLOCKS) {
          const to = Math.min(through, from + LOG_BLOCKS - 1);
          cached.events.push(...await reader.queryFilter(filter, from, to));
          cached.through = to;
        }
      })().finally(() => { cached.flight = null; });
      await cached.flight;
    }
    const events = cached.events.filter(e => e.blockNumber <= end);
    if (end === latest) events.push(...await reader.queryFilter(filter, end, end));
    return events;
  }

  /** The last `count` challenges, newest first, with the gas their transactions used (from the receipts of the
   *  Steps events). */
  async function recentChallenges({ count = 20 } = {}) {
    const total = num(await reader.challengeCount());
    if (total === 0) return [];
    const ids = [];
    for (let id = total; id > Math.max(0, total - count); id--) ids.push(id);
    const infos = await Promise.all(ids.map(challengeInfo));
    const latest = await blockNumber();
    const steps = (await Promise.all(infos.map(i => challengeEvents(i, latest)))).flat().filter(e => e.fragment.name === 'Steps');
    const hashes = new Map();   // id → the transaction hashes
    for (const e of steps) {
      const id = num(e.args.id);
      if (!hashes.has(id)) hashes.set(id, new Set());
      hashes.get(id).add(e.transactionHash);
    }
    const receipts = new Map();
    await Promise.all([...new Set([...hashes.values()].flatMap(s => [...s]))].map(async h => {
      let rc = gasReceipts.get(h);
      if (!rc) { rc = await provider.getTransactionReceipt(h); if (rc) gasReceipts.set(h, rc); }
      receipts.set(h, rc);
    }));
    return infos.map(i => ({ id: i.id, challenger: i.challenger, defender: i.defender, status: i.status, challengerWins: i.challengerWins, defenderWins: i.defenderWins, startBlock: i.startBlock,
      gasUsed: [...(hashes.get(i.id) ?? [])].reduce((sum, h) => sum + num(receipts.get(h)?.gasUsed ?? 0), 0) }));
  }

  /** The replay of challenge `id` from its events: the seed and, per episode played so far, the seed of the scene,
   *  the modules on each side, the action pairs and the end (−1 while the episode is still playing). */
  async function replay(id) {
    const info = await challengeInfo(id);
    if (!info) throw new Error(`challenge ${id} does not exist`);
    const latest = await blockNumber();
    const events = await challengeEvents(info, latest);
    const steps = events.filter(e => e.fragment.name === 'Steps');
    const ends = events.filter(e => e.fragment.name === 'EpisodeEnded');
    const byEpisode = new Map();
    for (const e of steps) {
      const ep = num(e.args.episode);
      if (!byEpisode.has(ep)) byEpisode.set(ep, []);
      byEpisode.get(ep).push({ from: num(e.args.fromStep), actions: unpackActions(e.args.actions) });
    }
    const endOf = new Map(ends.map(e => [num(e.args.episode), { end: num(e.args.end), steps: num(e.args.steps) }]));
    const played = Math.max(byEpisode.size ? Math.max(...byEpisode.keys()) + 1 : 0, ends.length ? Math.max(...endOf.keys()) + 1 : 0);
    const episodes = [];
    for (let ep = 0; ep < Math.min(played, EPISODES); ep++) {
      const segments = (byEpisode.get(ep) ?? []).sort((a, b) => a.from - b.from);
      const actions = [];
      for (const seg of segments) { if (seg.from !== actions.length) throw new Error(`replay ${id}: episode ${ep} has a gap at step ${actions.length}`); actions.push(...seg.actions); }
      const swapped = ep % 2 === 1;
      episodes.push({ episode: ep, seed: episodeSeed(info.seed, Math.floor(ep / 2)), side0: swapped ? info.defender : info.challenger, side1: swapped ? info.challenger : info.defender, actions, end: endOf.get(ep)?.end ?? -1, steps: endOf.get(ep)?.steps ?? actions.length });
    }
    return { id: info.id, seed: info.seed, challenger: info.challenger, defender: info.defender, status: info.status, episodes };
  }

  /** The archive contract of the official Factory recorded by the ladder. */
  async function archive() {
    return new Contract((await fixedConfig()).factory, ModuleFactoryABI, provider);
  }

  /** How many modules `deployer` deployed through the official Factory (ModuleFactory.deploymentCount). */
  async function deploymentCount(deployer) {
    if (!isAddress(deployer)) throw new Error(`deploymentCount: ${String(deployer)} is not an address`);
    return num(await (await archive()).deploymentCount(deployer));
  }

  /**
   * The modules `deployer` deployed through the official Factory, in deployment order, from the archive of the Factory
   * (ModuleFactory.modulesByDeployer, ARCHIVE_PAGE addresses a request). Each: `{ module, moduleId, deployer, engineId,
   * engine, artifactId, taskId, kind, kindName, inputs, outputs, stateWidth }` from `moduleIdOf` and the descriptor of
   * the module. `offset` and `limit` select a window of the archive (default: all of it).
   */
  async function deploymentsOf(deployer, { offset = 0, limit } = {}) {
    if (!isAddress(deployer)) throw new Error(`deploymentsOf: ${String(deployer)} is not an address`);
    const from = getAddress(deployer);
    const a = await archive();
    const total = num(await a.deploymentCount(from));
    const end = limit === undefined ? total : Math.min(total, offset + limit);
    const modules = [];
    for (let at = offset; at < end; at += ARCHIVE_PAGE) modules.push(...await a.modulesByDeployer(from, at, Math.min(ARCHIVE_PAGE, end - at)));
    return Promise.all(modules.map(async module => {
      const [moduleId, d] = await Promise.all([a.moduleIdOf(module), new Contract(module, NeuromModuleABI, provider).descriptor()]);
      return { module: getAddress(module), moduleId, deployer: from, engineId: d.engineId, engine: d.engine, artifactId: d.artifactId, taskId: d.taskId,
        kind: num(d.kind), kindName: DENSE_KINDS[num(d.kind)] ?? String(num(d.kind)), inputs: num(d.inputs), outputs: num(d.outputs), stateWidth: num(d.stateWidth) };
    }));
  }

  return {
    contract: reader,
    config, board, entries, entry,
    targets, estimate, register, challenge, resume, expire, challengeInfo, recentChallenges, replay,
    deploymentCount, deploymentsOf,
  };
}
