#!/usr/bin/env node
// engine-version-check.mjs — the bit-for-bit check before ADMIN adds an engine version (ADR 0017: every version of one
// engine id computes the same, bit for bit).
//
//   node contracts/scripts/engine-version-check.mjs --rpc-url <url> --factory <ModuleFactory> --engine <id> --candidate <address>
//
// Forks the network (local Anvil or any RPC) into a throwaway local `anvil --fork-url` at its latest block. Deploys
// every case of the fixed input set (engine-cases.mjs) whose module computes with the engine (its tools included)
// through the production bridge. Runs the inputs twice from the same state: once with the latest version's code at
// every version of the engine id, once with the candidate's code (anvil_setCode, on the fork only). So the cases'
// tools (modules that the bridge reuses from the network, also on an older version) run on the latest, then on the
// candidate. Reports any difference in scores, action, counts or next state (or a revert on one side only) with the
// first differing input. Only with zero differences does it print the transactions that an ADMIN sends: addVersion,
// then setLatest. It never sends anything to the network. Exit code 0 = no difference, 1 = differences, 2 = the check
// could not run.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ethers } from 'ethers';
import FactoryABI from '../../frontend/abi/ModuleFactory.json' with { type: 'json' };
import ModuleABI from '../../frontend/abi/NeuromModule.json' with { type: 'json' };
import { deployModule } from '../../frontend/module-chain.js';
import { engineCases } from './engine-cases.mjs';
import { startAnvil } from './foundry.mjs';

/** A local `anvil --network monad --fork-url rpcUrl` at block `block` → `{ provider, stop }`. The fork also stops when
 *  this process exits (the command turns SIGINT / SIGTERM into an exit). */
const forkOf = (rpcUrl, block) => startAnvil(['--fork-url', rpcUrl, '--fork-block-number', String(block), '--no-storage-caching']);

/** The revert reason of a failed call, else its message. */
const reasonOf = e => e.revert?.args?.[0] ?? e.reason ?? e.shortMessage ?? e.message ?? String(e);

/** A decision as plain JSON values: `{ scores, action, counts, voltages }`, or `{ error }` for a revert. */
async function decisionOf(call) {
  try {
    const [scores, action, counts, voltages] = await call();
    return { scores: Array.from(scores, String), action: Number(action), counts: Array.from(counts, Number), voltages: Array.from(voltages, Number) };
  } catch (e) { return { error: reasonOf(e) }; }
}

/** Gas limit of a step on the fork: Monad's per-transaction limit, so no estimate is needed. */
const STEP_GAS = 30_000_000n;

/** The fork mines each transaction as it arrives: its receipt is there at once (ethers' wait() polls for blocks). */
async function mined(tx) {
  const rc = (await tx.provider.getTransactionReceipt(tx.hash)) ?? (await tx.wait());
  if (rc.status !== 1) throw new Error(`step transaction ${tx.hash} failed after its call succeeded`);
}

/** Every case's decisions on the fork as it is now: `forward` per input, or one session's `step`s for a stateful case. */
async function runCases(signer, modules, log) {
  const out = [];
  for (const { c, address } of modules) {
    const m = new ethers.Contract(address, ModuleABI, signer), session = ethers.id(`engine-version-check ${c.name}`), got = [];
    for (const bits of c.inputs) {
      const input = Uint8Array.from(bits);
      if (!c.stateful) { got.push(await decisionOf(() => m.forward(input))); continue; }
      const d = await decisionOf(() => m.step.staticCall(session, input));
      got.push(d);
      if (!d.error) await mined(await m.step(session, input, { gasLimit: STEP_GAS }));
    }
    out.push(got);
    log(`  ${c.name}: ${got.length} decisions`);
  }
  return out;
}

const FIELDS = ['error', 'scores', 'action', 'counts', 'voltages'];

/**
 * Run the check → `{ engine, factory, roles, current, candidate, block, cases, decisions, differences, transactions }`.
 * `current` is the engine id's latest version. `differences` is `[{ case, index, input, stateful, fields, current,
 * candidate }]` in case and input order. `transactions` is `[{ to, data }]` (addVersion, setLatest) for an ADMIN of
 * `roles` to send when there is no difference, else null. Throws when the check cannot run: an engine id without a
 * latest version, a candidate without code or already a version, or no case that covers the engine.
 */
export async function checkVersion({ rpcUrl, factory, engine, candidate, log = () => {} }) {
  if (!ethers.isAddress(factory)) throw new Error(`--factory is not an address: ${factory}`);
  if (!ethers.isAddress(candidate)) throw new Error(`--candidate is not an address: ${candidate}`);
  const source = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  let fork = null;
  try {
    const block = await source.getBlockNumber(), id = ethers.id(engine), f = new ethers.Contract(factory, FactoryABI, source);
    const [current, versions, roles, listed] = await Promise.all([f.latestOf(id, { blockTag: block }), f.versionsOf(id, { blockTag: block }), f.roles({ blockTag: block }), f.engineIdOf(candidate, { blockTag: block })]);
    if (current === ethers.ZeroAddress) throw new Error(`engine ${engine} has no latest version on ${factory}`);
    if ((await source.getCode(candidate, block)) === '0x') throw new Error(`the candidate ${candidate} has no code on the network`);
    if (listed !== ethers.ZeroHash) throw new Error(`the candidate ${candidate} already is an engine version on ${factory}`);
    const { cases: all, artifacts } = await engineCases();
    const cases = all.filter(c => c.engines.has(engine));
    if (!cases.length) throw new Error(`no case of the fixed input set computes with ${engine}`);
    log(`engine ${engine}: latest version ${current}`);
    log(`fork of ${rpcUrl} at block ${block}: ${cases.length} cases`);

    fork = await forkOf(rpcUrl, block);
    const signer = await fork.provider.getSigner(0), modules = [];
    for (const c of cases) modules.push({ c, address: (await deployModule(signer, factory, c.artifact, { artifacts })).address });
    const snapshot = await fork.provider.send('evm_snapshot', []);
    /** The cases' decisions with `at`'s code at every version of the engine id. */
    const runWith = async (at, who) => {
      const code = await fork.provider.getCode(at);
      for (const version of versions) await fork.provider.send('anvil_setCode', [version, code]);
      log(`${who}'s code at ${versions.length} version(s), on the fork:`);
      return runCases(signer, modules, log);
    };
    const before = await runWith(current, 'the latest version');
    if (!(await fork.provider.send('evm_revert', [snapshot]))) throw new Error('could not revert the fork');
    const after = await runWith(candidate, 'the candidate');

    const differences = [];
    cases.forEach((c, k) => c.inputs.forEach((bits, index) => {
      const a = before[k][index], b = after[k][index];
      const fields = FIELDS.filter(f => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
      if (fields.length) differences.push({ case: c.name, index, input: bits.join(''), stateful: c.stateful, fields, current: a, candidate: b });
    }));
    const transactions = ['addVersion', 'setLatest'].map(fn => ({ to: factory, data: f.interface.encodeFunctionData(fn, [id, candidate]) }));
    return { engine, factory, roles, current, candidate, block, cases: cases.map(c => c.name), decisions: cases.reduce((n, c) => n + c.inputs.length, 0),
      differences, transactions: differences.length ? null : transactions };
  } finally {
    fork?.stop();
    source.destroy();
  }
}

/** The check's result as the command prints it. */
function report(r, rpcUrl) {
  const lines = [`${r.engine}: ${r.current} → candidate ${r.candidate} (block ${r.block})`,
    `${r.cases.length} cases, ${r.decisions} decisions: ${r.differences.length} differences.`];
  if (r.differences.length) {
    const first = r.differences[0], show = v => JSON.stringify(v);
    lines.push('', `First difference: case "${first.case}", ${first.stateful ? `step ${first.index + 1} of one session` : `input ${first.index + 1}`}, bits ${first.input}`);
    for (const f of first.fields) lines.push(`  ${f}: current ${show(first.current[f])}, candidate ${show(first.candidate[f])}`);
    const perCase = new Map();
    for (const d of r.differences) perCase.set(d.case, (perCase.get(d.case) ?? 0) + 1);
    lines.push('', 'Differing decisions per case:', ...[...perCase].map(([name, n]) => `  ${name}: ${n}`), '', 'No transaction: the candidate changes decisions.');
  } else {
    lines.push('', `Transactions (not sent; an ADMIN of Roles ${r.roles} sends them, in order):`);
    for (const [k, x] of r.transactions.entries()) lines.push(`  ${k + 1}. to    ${x.to}`, `     data  ${x.data}`);
    lines.push('', ...['addVersion', 'setLatest'].map(fn => `  cast send ${r.factory} '${fn}(bytes32,address)' $(cast keccak ${r.engine}) ${r.candidate} --rpc-url ${rpcUrl}`));
  }
  return lines.join('\n');
}

/** The command line → `checkVersion`'s arguments. Throws on an unknown, incomplete or missing flag. */
function argsOf(argv) {
  const flags = ['rpc-url', 'factory', 'engine', 'candidate'];
  const { values } = parseArgs({ args: argv, options: Object.fromEntries(flags.map(f => [f, { type: 'string' }])) });
  for (const f of flags) if (!values[f]) throw new Error(`missing --${f}`);
  return { rpcUrl: values['rpc-url'], factory: values.factory, engine: values.engine, candidate: values.candidate };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => process.exit(2));     // runs the fork's exit hook
  let args;
  try { args = argsOf(process.argv.slice(2)); }
  catch (e) {
    console.error(`${e.message}\nusage: node contracts/scripts/engine-version-check.mjs --rpc-url <url> --factory <ModuleFactory> --engine <engine id, e.g. dense-policy> --candidate <candidate address>`);
    process.exit(2);
  }
  try {
    const r = await checkVersion({ ...args, log: line => console.error(line) });
    console.log(report(r, args.rpcUrl));
    process.exit(r.differences.length ? 1 : 0);
  } catch (e) { console.error(`check failed: ${e.message}`); process.exit(2); }
}
