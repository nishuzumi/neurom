#!/usr/bin/env node
// scripts/verify-chain.mjs — the checks of ticket 11 on a real network: the facts that the prototype proved only on
// anvil, proved again on the chain the ladder is deployed on.
//   1. An EIP-7702 account carries code: a fresh account delegates to the ladder, and the script prints its code size.
//   2. `challenge` refuses that account with `NotEoa` (the EOA check), while a plain EOA passes that check.
//   3. A challenge between two entries runs to settlement from the contract alone. The script deploys two copies of
//      the 中 fixture network (contracts/test/fixtures/tank-episodes.json, 39,840 weight bytes).
//      A salt changes the last padding byte, so each run creates distinct entries.
//      The script registers both modules, starts a challenge and advances it until settlement.
//      A challenge runs at most 600 steps. Each play transaction has a 30M gas limit.
//   4. The gas per step of that challenge against `data/step-gas.json` (pair mid-mid), the number the page estimates
//      costs from. A deviation over GAS_TOLERANCE fails the check: the page would then quote wrong costs.
// It prints every transaction, the gas, what the deployer paid (Monad charges the gas limit, not the gas used) and
// ends with PASS/FAIL per check; the exit code is 1 when a check failed.
//
//   node site/scripts/verify-chain.mjs --anvil
//       self-test: a fresh `anvil --network monad` with the protocol and a ladder (frontend/ladder.fixture.js), the
//       deployer is anvil account 0. ANVIL=… FORGE=… select the Foundry binaries (contracts/scripts/foundry.mjs).
//   DEPLOYER_PRIVATE_KEY=0x… node site/scripts/verify-chain.mjs --rpc https://testnet-rpc.monad.xyz [--ladder 0x…]
//       a real network. `--ladder` defaults to the entry of data/deployments.json for the chain id of the RPC. The key
//       pays for everything: two module deployments (~9.5M gas each), two registrations, the delegation and five play
//       transactions (each charged at its 30M limit). At a 100 gwei base fee that is about 20 MON; keep 30 on the key.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AbiCoder, Contract, JsonRpcProvider, SigningKey, Wallet, concat, encodeRlp, formatEther, keccak256, toBeHex } from 'ethers';
import TankLadderABI from '../../frontend/abi/TankLadder.json' with { type: 'json' };
import FactoryABI from '../../frontend/abi/ModuleFactory.json' with { type: 'json' };
import { PLAY_GAS, ladderEvents, localLadder, mined, playChallenge } from '../../frontend/ladder.fixture.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('../..', import.meta.url));
const { values: args } = parseArgs({ options: { anvil: { type: 'boolean', default: false }, rpc: { type: 'string' }, ladder: { type: 'string' }, help: { type: 'boolean', default: false } } });
if (args.help || (!args.anvil && !args.rpc)) {
  console.log('usage: verify-chain.mjs --anvil | --rpc <url> [--ladder <address>]   (DEPLOYER_PRIVATE_KEY in the environment for --rpc)');
  process.exit(args.help ? 0 : 2);
}

/** The accepted deviation of the measured gas per step from data/step-gas.json. */
const GAS_TOLERANCE = 0.30;
const ANVIL_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const stepGas = JSON.parse(readFileSync(`${here}../data/step-gas.json`, 'utf8'));
const deployments = JSON.parse(readFileSync(`${here}../data/deployments.json`, 'utf8'));
const fixture = JSON.parse(readFileSync(`${repo}contracts/test/fixtures/tank-episodes.json`, 'utf8'));
const coder = AbiCoder.defaultAbiCoder();
const ladderIface = new Contract('0x0000000000000000000000000000000000000001', TankLadderABI).interface;

const log = (...a) => console.log('[verify]', ...a);
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const mon = wei => `${Number(formatEther(wei)).toFixed(4)} MON`;

/** Send `contract.method(...args)` with a 20% margin over the estimate (or `gasLimit`) and wait → receipt (throws on revert). */
async function send(contract, method, params, { gasLimit } = {}) {
  const limit = gasLimit ?? (await contract[method].estimateGas(...params)) * 12n / 10n;
  const tx = await contract[method](...params, { gasLimit: limit });
  const rc = await mined(contract.runner.provider, tx.hash);
  if (rc.status !== 1) throw new Error(`${method} reverted: ${tx.hash}`);
  return rc;
}
/** The revert data of an ethers call error, or null. */
const revertData = e => { for (const d of [e?.data, e?.info?.error?.data, e?.error?.data, e?.info?.error?.data?.data]) if (typeof d === 'string' && d.startsWith('0x') && d.length >= 10) return d; return null; };
/** The custom error name of the ladder in a call error, or the error message when it is not one. */
function ladderError(e) {
  const data = revertData(e);
  if (data) { try { return ladderIface.parseError(data)?.name ?? data; } catch { return data; } }
  return e?.shortMessage ?? e?.message ?? String(e);
}
/** The most play transactions of the challenge check. The challenge stays active when it needs more. */
const MAX_PLAYS = 40;
/** The intrinsic gas of a transaction with `data`: 21,000 plus the calldata. */
const intrinsic = data => 21_000 + [...Buffer.from(data.slice(2), 'hex')].reduce((g, b) => g + (b ? 16 : 4), 0);
/** An integer as RLP wants it: minimal big-endian bytes, zero = empty. */
const rlpInt = n => (BigInt(n) === 0n ? '0x' : toBeHex(BigInt(n)));

/**
 * A type-4 (EIP-7702) transaction from `sender`: `authority` delegates to `target`. Hand-rolled because ethers 6.13
 * knows no type 4. `to` is the sender itself (type 4 needs a destination), no value, no data.
 *  → the raw transaction and its hash.
 */
async function delegationTx(provider, sender, authority, target) {
  const { chainId } = await provider.getNetwork();
  const nonce = await provider.getTransactionCount(sender.address);
  const authNonce = await provider.getTransactionCount(authority.address);
  const fee = await provider.getFeeData();
  const maxFee = fee.maxFeePerGas ?? fee.gasPrice, tip = fee.maxPriorityFeePerGas ?? 0n;
  const authDigest = keccak256(concat(['0x05', encodeRlp([rlpInt(chainId), target.toLowerCase(), rlpInt(authNonce)])]));
  const a = new SigningKey(authority.privateKey).sign(authDigest);
  const authorization = [rlpInt(chainId), target.toLowerCase(), rlpInt(authNonce), rlpInt(a.yParity), rlpInt(a.r), rlpInt(a.s)];
  const fields = [rlpInt(chainId), rlpInt(nonce), rlpInt(tip), rlpInt(maxFee), rlpInt(120_000), sender.address.toLowerCase(), '0x', '0x', [], [authorization]];
  const s = new SigningKey(sender.privateKey).sign(keccak256(concat(['0x04', encodeRlp(fields)])));
  const raw = concat(['0x04', encodeRlp([...fields, rlpInt(s.yParity), rlpInt(s.r), rlpInt(s.s)])]);
  return { raw, hash: keccak256(raw), gasLimit: 120_000n };
}

/** Deploy a salted twin of fixture module `tag` through the Factory as `signer` → its address. The module id is
 *  unique for the deployer across runs (the tag, the salt and the time in base 36: ModuleFactory refuses an id the
 *  account used before). */
async function deployTwin(signer, factoryAddress, tag, salt) {
  const factory = new Contract(factoryAddress, FactoryABI, signer);
  const [m] = coder.decode([fixture.abi.module], fixture.modules[tag].data);
  const chunks = [...m.chunks];
  const last = Buffer.from(chunks[chunks.length - 1].slice(2), 'hex');
  last[last.length - 1] ^= salt;
  chunks[chunks.length - 1] = '0x' + last.toString('hex');
  const moduleId = `verify-${tag}-${salt}-${Date.now().toString(36)}`;
  const spec = { engineId: m.engineId, version: '0x0000000000000000000000000000000000000000', kind: Number(m.kind), inputs: Number(m.inputs), outputs: Number(m.outputs), shape: [...m.shape], tools: [], chunks: chunks.map(keccak256), artifactId: keccak256(concat([m.artifactId, toBeHex(salt, 1)])), taskId: m.taskId, moduleId };
  let gas = 0n;
  for (const c of chunks) gas += (await send(factory, 'createChunk', [c])).gasUsed;
  const rc = await send(factory, 'deploy', [spec, chunks.map(() => '0x')]);
  gas += rc.gasUsed;
  const ev = rc.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(e => e && e.name === 'ModuleDeployed');
  if (!ev) throw new Error(`no ModuleDeployed event: ${rc.hash}`);
  return { module: ev.args.module, gas, transactions: chunks.length + 1 };
}

// ---------------------------------------------------------------------------------------------------------- setup
// cacheTimeout -1: ethers answers identical requests from a 250 ms cache by default, which hands a stale nonce to the
// transaction that follows a receipt on a fast node.
const connect = (url, pollingInterval) => new JsonRpcProvider(url, undefined, { staticNetwork: true, pollingInterval, cacheTimeout: -1, batchMaxCount: 1 });
let anvil = null, provider, deployer, ladderAddress;
if (args.anvil) {
  log('building the contracts and starting anvil --network monad…');
  anvil = await localLadder();
  provider = connect(anvil.url, 20);
  deployer = new Wallet(ANVIL_KEY_0, provider);
  ladderAddress = anvil.ladder;
} else {
  if (!process.env.DEPLOYER_PRIVATE_KEY) { console.error('DEPLOYER_PRIVATE_KEY is not set'); process.exit(2); }
  provider = connect(args.rpc, 500);
  deployer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
}
try {
  const { chainId } = await provider.getNetwork();
  // a fork entry (forkOf) has the ladder of the chain it forks
  const entry = deployments[String(chainId)], ladderOf = e => e?.ladder ?? (e?.forkOf ? deployments[e.forkOf]?.ladder : undefined);
  ladderAddress ??= args.ladder ?? ladderOf(entry);
  if (!ladderAddress) throw new Error(`no ladder address for chain ${chainId}: pass --ladder or fill data/deployments.json`);
  const ladder = new Contract(ladderAddress, TankLadderABI, deployer);
  const config = await ladder.config();
  const block = await provider.getBlock('latest');
  const fee = await provider.getFeeData();
  const balanceStart = await provider.getBalance(deployer.address);
  log(`chain ${chainId}, block ${block.number} (gas limit ${block.gasLimit.toLocaleString()}), base fee ${fee.gasPrice ? `${Number(fee.gasPrice) / 1e9} gwei` : 'unknown'}`);
  log(`ladder ${ladderAddress}, factory ${config.factory}, season ends at block ${config.endBlock}, ${await ladder.entryCount()} entries`);
  log(`deployer ${deployer.address}, balance ${mon(balanceStart)}`);
  if ((await provider.getCode(ladderAddress)) === '0x') throw new Error(`no code at ${ladderAddress}`);
  if (BigInt(block.number) >= config.endBlock) log('warning: the season is over on this ladder; the challenge check will fail with SeasonOver');

  // ------------------------------------------------------------------------------------- 1. a 7702 account has code
  const delegated = Wallet.createRandom();
  const d = await delegationTx(provider, deployer, delegated, ladderAddress);
  await provider.send('eth_sendRawTransaction', [d.raw]);
  const drc = await mined(provider, d.hash);
  const code = await provider.getCode(delegated.address);
  const codeBytes = (code.length - 2) / 2;
  log(`delegation ${d.hash}: status ${drc.status}, gas used ${drc.gasUsed}, code at ${delegated.address} = ${code} (${codeBytes} bytes)`);
  record('7702 account carries code', drc.status === 1 && code.toLowerCase() === `0xef0100${ladderAddress.slice(2).toLowerCase()}`, `${codeBytes} bytes, 0xef0100 ‖ ladder`);

  // ------------------------------------------------------------------------------------- 2. challenge refuses it
  const probe = ladderIface.encodeFunctionData('challenge', [delegated.address, delegated.address]);
  const callAs = async from => { try { await provider.call({ from, to: ladderAddress, data: probe, gasLimit: PLAY_GAS }); return 'no revert'; } catch (e) { return ladderError(e); } };
  let fromDelegated = await callAs(delegated.address);
  const fromEoa = await callAs(deployer.address);
  log(`eth_call challenge from the 7702 account → ${fromDelegated}; from the deployer EOA → ${fromEoa}`);
  let eoaDetail = `7702 account: ${fromDelegated}, plain EOA: ${fromEoa}`;
  if (fromDelegated !== 'NotEoa' && (fromDelegated === 'LowGas' || !fromDelegated.startsWith('0x') && !/^[A-Z]\w+$/.test(fromDelegated))) {
    // The RPC capped the gas of eth_call below minStartGas (or refused it). The real thing: fund the account and send.
    log('the RPC did not run eth_call with 30M gas; sending a real challenge transaction from the 7702 account instead');
    const price = (fee.maxFeePerGas ?? fee.gasPrice) * 2n;
    const fund = await deployer.sendTransaction({ to: delegated.address, value: price * BigInt(PLAY_GAS) + 10n ** 15n });
    await mined(provider, fund.hash);
    const tx = await new Wallet(delegated.privateKey, provider).sendTransaction({ to: ladderAddress, data: probe, gasLimit: PLAY_GAS, maxFeePerGas: price, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n });
    const rc = await mined(provider, tx.hash);
    fromDelegated = rc.status === 0 ? 'reverted (status 0; reason not readable through this RPC)' : 'did not revert';
    eoaDetail = `real transaction ${tx.hash} from the 7702 account ${fromDelegated}; eth_call from a plain EOA: ${fromEoa}`;
    record('challenge refuses a 7702 account (NotEoa)', rc.status === 0 && fromEoa !== 'NotEoa', eoaDetail);
  } else {
    record('challenge refuses a 7702 account (NotEoa)', fromDelegated === 'NotEoa' && fromEoa !== 'NotEoa', eoaDetail);
  }

  // ------------------------------------------------------------------------------------- 3. two entries, one challenge
  const salts = [1 + Math.floor(Math.random() * 255)];
  salts.push(1 + ((salts[0] + Math.floor(Math.random() * 254)) % 255));
  log(`deploying two twins of the mid fixture network (${fixture.modules.mid.weightBytes} bytes, salts ${salts.join(', ')})…`);
  const modules = [];
  for (const salt of salts) {
    const t = await deployTwin(deployer, config.factory, 'mid', salt);
    log(`module ${t.module}: ${t.transactions} transactions, ${t.gas.toLocaleString()} gas`);
    modules.push(t.module);
  }
  const [defender, challenger] = modules;
  const ranks = [];
  for (const m of [defender, challenger]) {
    const rc = await send(ladder, 'register', [m]);
    const ev = ladderEvents(ladder, rc).find(e => e.name === 'EntryRegistered');
    ranks.push(Number(ev.args.rank));
    log(`registered ${m} ${Number(ev.args.rank) ? `at rank ${ev.args.rank}` : 'off the board'} (${ev.args.weightBytes} bytes), ${rc.gasUsed.toLocaleString()} gas`);
  }
  // the challenger is the rank below the defender, or off the board right below a defender at the last rank
  record('two entries registered', ranks.length === 2 && ranks[0] > 0 && (ranks[1] === ranks[0] + 1 || ranks[1] === 0), `ranks ${ranks.join(' and ')} (0 = off the board)`);
  if (ranks[0] === 0) throw new Error('the board is full: the defender is off the board, so the challenge would revert OutOfRange');

  const balanceBeforePlay = await provider.getBalance(deployer.address);
  const stepsOf = rc => ladderEvents(ladder, rc).filter(e => e.name === 'Steps').reduce((n, e) => n + (e.args.actions.length - 2) / 2, 0);
  const { id, receipts, info } = await playChallenge(ladder, challenger, defender, { maxTransactions: MAX_PLAYS });
  const plays = receipts.map((rc, i) => ({ hash: rc.hash, gasUsed: Number(rc.gasUsed), steps: stepsOf(rc), intrinsic: intrinsic(ladderIface.encodeFunctionData(...(i ? ['advance', [id]] : ['challenge', [challenger, defender]]))) }));
  const balanceAfterPlay = await provider.getBalance(deployer.address);
  const totalSteps = plays.reduce((n, p) => n + p.steps, 0);
  for (const [i, p] of plays.entries()) log(`play ${i + 1} ${p.hash}: ${p.steps} steps, ${p.gasUsed.toLocaleString()} gas used${p.steps ? `, ${Math.round((p.gasUsed - p.intrinsic) / p.steps).toLocaleString()} gas/step` : ''}`);
  const statusName = { 2: 'challenger won', 3: 'defense', 4: 'expired' }[Number(info.status)] ?? `status ${info.status}`;
  log(`challenge #${id}: ${statusName}, ${info.challengerWins} : ${info.defenderWins}, episode ${info.episode}, ${totalSteps} steps in ${plays.length} transactions`);
  log(`the play transactions cost ${mon(balanceBeforePlay - balanceAfterPlay)} (gas used ${plays.reduce((n, p) => n + p.gasUsed, 0).toLocaleString()}; Monad charges the ${PLAY_GAS.toLocaleString()} limit of each)`);
  const settled = Number(info.status) === 2 || Number(info.status) === 3;
  const challengerEntry = await ladder.entry(challenger);
  record('challenge runs to settlement', settled && Number(challengerEntry.activeChallenge) === 0, `${statusName} after ${plays.length} transaction(s), challenger now rank ${challengerEntry.rank}`);

  // ------------------------------------------------------------------------------------- 4. gas per step vs step-gas.json
  const perStep = plays.filter(p => p.steps > 0).map(p => (p.gasUsed - p.intrinsic) / p.steps).sort((a, b) => a - b);
  const measured = perStep.length ? Math.round(perStep[perStep.length >> 1]) : 0;
  const baseline = stepGas.pairs['mid-mid'].loopStep.median;
  const forward = stepGas.forward.intercept + stepGas.forward.perByte * fixture.modules.mid.weightBytes;
  const pageEstimate = Math.round(2 * forward + stepGas.scenePerStep);
  const deviation = measured ? measured / baseline - 1 : NaN;
  log(`gas per step: measured median ${measured.toLocaleString()} (${perStep.length} transaction(s)), step-gas.json mid-mid loopStep median ${baseline.toLocaleString()}, the page's formula ${pageEstimate.toLocaleString()} → ${(deviation * 100).toFixed(1)}% vs the baseline`);
  record(`gas per step within ${GAS_TOLERANCE * 100}% of step-gas.json`, Number.isFinite(deviation) && Math.abs(deviation) <= GAS_TOLERANCE, `${measured.toLocaleString()} vs ${baseline.toLocaleString()} (${deviation >= 0 ? '+' : ''}${(deviation * 100).toFixed(1)}%)`);

  const balanceEnd = await provider.getBalance(deployer.address);
  log(`the whole run cost the deployer ${mon(balanceStart - balanceEnd)}; balance now ${mon(balanceEnd)}`);
  const failed = results.filter(r => !r.ok);
  log(failed.length ? `${failed.length} of ${results.length} checks FAILED` : `all ${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error('[verify] error:', e?.shortMessage ?? e?.message ?? e);
  if (revertData(e)) console.error('[verify] revert:', ladderError(e));
  process.exitCode = 1;
} finally {
  provider.destroy();
  anvil?.stop();
}
