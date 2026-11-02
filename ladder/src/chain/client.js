// chain/client.js — the ladder client (ticket 06, contract-interface.md "Ladder client API"). Plain JS over ethers 6,
// no React: the page reaches the chain only through this module.
//   - Reads: the configuration, the ladder, the entries, the targets of an entry with the refusal the contract would
//     give, a challenge, the recent challenges and the replay of a challenge from its events.
//   - Registration: the artifact goes through the chain bridge of the workbench (frontend/module-chain.js
//     deployModule), then `register`.
//   - A challenge: the start transaction with the gas limit PLAY_GAS (Monad's transaction limit, above the contract's
//     minStartGas), then `advance` transactions with explicit nonces, at most MAX_IN_FLIGHT in flight. The receipts
//     come by polling the hash: ethers' `wait()` misses the receipts of large transactions on anvil --network monad
//     (ethers 6.13, measured for 30M-gas transactions). Every receipt reports the progress read from the events. Monad charges the gas
//     limit of a transaction, so the client keeps no more transactions in flight than the typical remaining steps
//     need (step-gas.json): a transaction that lands after the settlement reverts and pays its whole limit.
//   - A refusal is a custom error of the contract: `decodeLadderError` gives its name from any error ethers throws,
//     and the errors this module throws carry the revert data too.
import { AbiCoder, Contract, Interface, keccak256, getAddress } from 'ethers';
import TankLadderABI from '../../../frontend/abi/TankLadder.json' with { type: 'json' };
import { deployModule } from '../../../frontend/module-chain.js';
import stepGas from '../../data/step-gas.json' with { type: 'json' };

/** The gas limit of a transaction that starts or advances a challenge: Monad's transaction limit. */
export const PLAY_GAS = 30_000_000;
/** The most transactions of one account in flight during a challenge. */
export const MAX_IN_FLIGHT = 3;
/** Episodes of a challenge (TankLadder.EPISODES) and steps of an episode (TankScene.STEPS). */
export const EPISODES = 6;
export const STEPS = 100;
/** The status codes of ChallengeInfo.status. */
export const STATUS = Object.freeze({ NONE: 0, PLAYING: 1, CHALLENGER_WON: 2, DEFENSE: 3, EXPIRED: 4 });

const iface = new Interface(TankLadderABI);
const coder = AbiCoder.defaultAbiCoder();
const num = v => Number(v);
/** The custom errors of the contract. */
const ERROR_NAMES = new Set(TankLadderABI.filter(f => f.type === 'error').map(f => f.name));
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
 * The ladder client → see contract-interface.md. `provider` reads; `signer` (optional) sends. `ladder` and `factory`
 * are the addresses on `chainId`. `pollMs`: the interval of the receipt polling (default 250 ms). `receiptTimeoutMs`:
 * how long a sent transaction may stay unmined before the client gives up (default 10 minutes). `maxInFlight` caps the
 * pipeline (default MAX_IN_FLIGHT, 3).
 */
export function createLadderClient({ provider, signer = undefined, ladder, factory, chainId, pollMs = 250, receiptTimeoutMs = 600_000, maxInFlight = MAX_IN_FLIGHT }) {
  if (!provider) throw new Error('createLadderClient: provider is required');
  if (!ladder) throw new Error('createLadderClient: ladder address is required');
  const reader = new Contract(ladder, TankLadderABI, provider);
  const writer = signer ? new Contract(ladder, TankLadderABI, signer) : null;
  const requireSigner = () => { if (!signer) throw new Error('this operation needs a signer'); return signer; };
  let configCache = null;

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

  /** A dry run of `method(...args)` as the signer with the play gas: throws the decoded refusal, ignores other failures
   *  (a node that caps eth_call below PLAY_GAS cannot tell). */
  async function precheck(method, args, from) {
    try { await writer[method].staticCall(...args, { gasLimit: PLAY_GAS, from }); } catch (e) {
      const name = decodeLadderError(e);
      if (name) throw ladderError(`${method} refused`, revertDataOf(e), { ladderError: name, cause: e });
    }
  }

  /** The number of transactions worth keeping in flight for the typical remaining steps of `state`. */
  async function depthFor(state) {
    try {
      const [c, d] = await Promise.all([reader.entry(state.challenger), reader.entry(state.defender)]);
      const { stepsPerTransaction } = stepPlan(num(c.weightBytes), num(d.weightBytes), (await config()).reserveGas);
      const remaining = Math.max(1, (EPISODES - state.episode) * stepGas.stepsPerEpisode.mean - state.step);
      return Math.min(maxInFlight, Math.max(1, Math.ceil(remaining / stepsPerTransaction)));
    } catch { return maxInFlight; }
  }

  /**
   * Plays challenge `state.id` on with `advance` transactions until it settles. `state` is the progress record of the
   * last confirmed receipt; `nonce` the next nonce of the signer. Reports every receipt through `onProgress`.
   */
  async function play(state, nonce, onProgress) {
    const s = requireSigner();
    const data = iface.encodeFunctionData('advance', [state.id]);
    const pending = [];
    const report = () => onProgress({ ...state, inFlight: pending.length });
    let depth = await depthFor(state);
    while (state.status === STATUS.PLAYING) {
      while (pending.length < depth) pending.push(await s.sendTransaction({ to: ladder, data, gasLimit: PLAY_GAS, nonce: nonce++ }));
      const tx = pending.shift();
      const rc = await receiptOf(tx.hash);
      state.confirmed++;
      if (num(rc.status) !== 1) {
        // another transaction (one left in flight by an interrupted run, or anyone's advance) may have settled it
        const now = await challengeInfo(state.id);
        if (!now || now.status === STATUS.PLAYING) throw await revertError(tx, rc, 'advance');
        Object.assign(state, { status: now.status, episode: now.episode, step: now.step, challengerWins: now.challengerWins, defenderWins: now.defenderWins });
      } else applyLogs(state, ladderLogs(rc, ladder));
      report();
      if (state.status === STATUS.PLAYING && pending.length < depth) depth = Math.min(depth, await depthFor(state));
    }
    // the transactions sent before the settlement landed revert (NotPlaying): wait for them, so that the account has
    // nothing in flight when the client returns
    for (const tx of pending.splice(0)) { await receiptOf(tx.hash); state.confirmed++; report(); }
    return challengeInfo(state.id);
  }

  async function config() {
    if (configCache) return configCache;
    const c = await reader.config();
    configCache = { factory: c.factory, maxWeightBytes: num(c.maxWeightBytes), deltaBps: num(c.deltaBps), range: num(c.range), timeoutBlocks: num(c.timeoutBlocks), cooldownBlocks: num(c.cooldownBlocks), minStartGas: num(c.minStartGas), reserveGas: num(c.reserveGas), endBlock: num(c.endBlock) };
    return configCache;
  }

  /** The current block, fresh (JsonRpcProvider caches getBlockNumber for a moment). */
  async function blockNumber() {
    if (typeof provider.send === 'function') { try { return Number(await provider.send('eth_blockNumber', [])); } catch { /* fall back */ } }
    return provider.getBlockNumber();
  }

  /** The entries from `fromRank` on (1-based), `count` of them (default: to the end). */
  async function ladderEntries({ fromRank = 1, count } = {}) {
    const total = num(await reader.entryCount());
    if (fromRank < 1 || fromRank > total) return [];
    const n = count === undefined ? total - fromRank + 1 : Math.min(count, total - fromRank + 1);
    if (n <= 0) return [];
    return (await reader.entries(fromRank, n)).map(entryOf);
  }

  async function entry(module) {
    const e = entryOf(await reader.entry(module));
    return e.rank === 0 ? null : e;
  }

  async function challengeInfo(id) {
    const i = infoOf(id, await reader.challengeInfo(id));
    return i.status === STATUS.NONE ? null : i;
  }

  async function targets(module) {
    const [me, cfg, block, from] = await Promise.all([entry(module), config(), blockNumber(), signer ? signer.getAddress() : null]);
    if (!me) return [];
    const fromRank = Math.max(1, me.rank - cfg.range), count = me.rank - fromRank;
    if (count <= 0) return [];
    const above = (await reader.entries(fromRank, count)).map(entryOf);
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
    const { step, stepsPerTransaction } = stepPlan(num(c.weightBytes), num(d.weightBytes), (await config()).reserveGas);
    const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    const of = steps => {
      const transactions = Math.max(1, Math.ceil(steps / stepsPerTransaction));
      const gas = steps * step + transactions * stepGas.perTransaction;
      // Monad charges the gas limit of a transaction, not the gas it uses
      return { steps, transactions, gas, cost: BigInt(transactions) * BigInt(PLAY_GAS) * price };
    };
    const typical = of(EPISODES * stepGas.stepsPerEpisode.mean), worst = of(EPISODES * STEPS);
    return { gasWorst: worst.gas, gasTypical: typical.gas, txWorst: worst.transactions, txTypical: typical.transactions, costWorstWei: worst.cost, costTypicalWei: typical.cost, stepsPerTransaction, gasPriceWei: price, stepsWorst: worst.steps, stepsTypical: typical.steps };
  }

  async function register(artifact, { onStatus = () => {} } = {}) {
    const s = requireSigner();
    const status = m => { try { onStatus(m); } catch { /* the page's problem */ } };
    status({ stage: 'deploying', message: 'deploying the module' });
    const deployed = await deployModule(s, factory, artifact, { onProgress: p => status({ ...p, stage: 'deploy', deployStage: p.stage, message: `${p.kind} ${p.stage}${p.txHash ? ` ${p.txHash}` : ''}` }) });
    const module = deployed.address;
    status({ stage: 'registering', message: `registering ${module}`, module });
    let tx;
    try { tx = await writer.register(module); } catch (e) { throw ladderError('register refused', revertDataOf(e), { ladderError: decodeLadderError(e), cause: e, module }); }
    const rc = await receiptOf(tx.hash);
    if (num(rc.status) !== 1) throw await revertError({ from: tx.from, to: tx.to, data: tx.data, gasLimit: tx.gasLimit }, rc, 'register');
    const ev = ladderLogs(rc, ladder).find(e => e.name === 'EntryRegistered');
    if (!ev) throw new Error(`register: no EntryRegistered event in ${rc.hash}`);
    const result = { module, rank: num(ev.args.rank), owner: ev.args.owner, weightBytes: num(ev.args.weightBytes), txHash: rc.hash, deployment: deployed };
    status({ stage: 'registered', message: `registered at rank ${result.rank}`, ...result });
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
    return play(state, nonce, onProgress);
  }

  async function resume(id, { onProgress = () => {} } = {}) {
    const s = requireSigner();
    const info = await challengeInfo(id);
    if (!info) throw new Error(`challenge ${id} does not exist`);
    if (info.status !== STATUS.PLAYING) return info;
    const from = await s.getAddress();
    await precheck('advance', [id], from);
    const state = { id: info.id, challenger: info.challenger, defender: info.defender, episode: info.episode, step: info.step, status: info.status, challengerWins: info.challengerWins, defenderWins: info.defenderWins, newRank: null, confirmed: 0 };
    onProgress({ ...state, inFlight: 0 });
    return play(state, await provider.getTransactionCount(from, 'pending'), onProgress);
  }

  async function activeChallengeOf(module) {
    const e = await entry(module);
    return e && e.activeChallenge !== 0 ? e.activeChallenge : null;
  }

  /** The last `count` challenges, newest first, with the gas their transactions used (from the receipts of the
   *  Steps events). */
  async function recentChallenges({ count = 20 } = {}) {
    const total = num(await reader.challengeCount());
    if (total === 0) return [];
    const ids = [];
    for (let id = total; id > Math.max(0, total - count); id--) ids.push(id);
    const infos = await Promise.all(ids.map(challengeInfo));
    const fromBlock = Math.min(...infos.map(i => i.startBlock));
    const steps = await reader.queryFilter(reader.filters.Steps(), fromBlock, 'latest');
    const hashes = new Map();   // id → the transaction hashes
    for (const e of steps) {
      const id = num(e.args.id);
      if (!hashes.has(id)) hashes.set(id, new Set());
      hashes.get(id).add(e.transactionHash);
    }
    const receipts = new Map();
    await Promise.all([...new Set([...hashes.values()].flatMap(s => [...s]))].map(async h => receipts.set(h, await provider.getTransactionReceipt(h))));
    return infos.map(i => ({ id: i.id, challenger: i.challenger, defender: i.defender, status: i.status, challengerWins: i.challengerWins, defenderWins: i.defenderWins, startBlock: i.startBlock, seed: i.seed, transactions: hashes.get(i.id)?.size ?? 0,
      gasUsed: [...(hashes.get(i.id) ?? [])].reduce((sum, h) => sum + num(receipts.get(h)?.gasUsed ?? 0), 0) }));
  }

  /** The replay of challenge `id` from its events: the seed and, per episode played so far, the seed of the scene,
   *  the modules on each side, the action pairs and the end (−1 while the episode is still playing). */
  async function replay(id) {
    const info = await challengeInfo(id);
    if (!info) throw new Error(`challenge ${id} does not exist`);
    const [steps, ends] = await Promise.all([
      reader.queryFilter(reader.filters.Steps(id), info.startBlock, 'latest'),
      reader.queryFilter(reader.filters.EpisodeEnded(id), info.startBlock, 'latest'),
    ]);
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

  return {
    provider, signer, address: ladder, factory, chainId, interface: iface, contract: reader,
    config, ladder: ladderEntries, entry,
    entriesOf: async owner => (await ladderEntries()).filter(e => e.owner.toLowerCase() === String(owner).toLowerCase()),
    targets, estimate, register, challenge, resume, challengeInfo, activeChallengeOf, recentChallenges, replay,
  };
}
