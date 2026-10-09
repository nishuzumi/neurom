#!/usr/bin/env node
// list-roles.mjs — which accounts hold each protocol role (ADR 0016) of an official factory on a network. Read-only.
//
//   node contracts/scripts/list-roles.mjs --rpc-url <url> --factory <ModuleFactory proxy> [--from-block <n>] [--block-range <n>]
//
// Roles keeps no list of holders, so the accounts come from its RoleGranted events. Every holder was granted once (the
// deployer in the constructor). The command reads the events with eth_getLogs from --from-block to the latest block,
// in windows of --block-range blocks. --from-block defaults to 0. On a public network, give the block that Roles was
// deployed in. --block-range defaults to 1000, a usual RPC limit. hasRole at that latest block confirms each account.
// Exit code 0 = listed, 2 = the listing could not run.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ethers } from 'ethers';
import FactoryABI from '../../frontend/abi/ModuleFactory.json' with { type: 'json' };
import RolesABI from '../../frontend/abi/Roles.json' with { type: 'json' };

const ROLE_NAMES = ['ADMIN', 'UPGRADER'];

/**
 * → `{ factory, roles, block, holders: { ADMIN: [address], UPGRADER: [address] } }`: the holders of each role at the
 * latest block, in the order they were first granted.
 */
export async function listRoles({ rpcUrl, factory, fromBlock = 0, blockRange = 1000 }) {
  if (!ethers.isAddress(factory)) throw new Error(`--factory is not an address: ${factory}`);
  if (!(Number.isSafeInteger(fromBlock) && fromBlock >= 0)) throw new Error(`--from-block is not a block number: ${fromBlock}`);
  if (!(Number.isSafeInteger(blockRange) && blockRange >= 1)) throw new Error(`--block-range is not a positive number: ${blockRange}`);
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  try {
    const block = await provider.getBlockNumber();
    if ((await provider.getCode(factory, block)) === '0x') throw new Error(`no contract at ${factory}`);
    const roles = await new ethers.Contract(factory, FactoryABI, provider).roles({ blockTag: block });
    const r = new ethers.Contract(roles, RolesABI, provider), topic = r.interface.getEvent('RoleGranted').topicHash;
    const ids = Object.fromEntries(await Promise.all(ROLE_NAMES.map(async name => [name, await r[name]({ blockTag: block })])));
    const granted = Object.fromEntries(ROLE_NAMES.map(name => [name, []]));
    for (let from = fromBlock; from <= block; from += blockRange) {
      for (const log of await provider.getLogs({ address: roles, topics: [topic], fromBlock: from, toBlock: Math.min(block, from + blockRange - 1) })) {
        const { role, account } = r.interface.parseLog(log).args, name = ROLE_NAMES.find(n => ids[n] === role);
        if (name && !granted[name].includes(account)) granted[name].push(account);
      }
    }
    const holders = {};
    for (const name of ROLE_NAMES) {
      const held = await Promise.all(granted[name].map(account => r.hasRole(ids[name], account, { blockTag: block })));
      holders[name] = granted[name].filter((_, k) => held[k]);
    }
    return { factory, roles, block, holders };
  } finally { provider.destroy(); }
}

/** The listing as the command prints it: one line per holder, `(none)` for a role nobody holds. */
function report(r) {
  const width = Math.max(...ROLE_NAMES.map(n => n.length)) + 2;
  return [`Roles ${r.roles} of factory ${r.factory}, block ${r.block}:`,
    ...ROLE_NAMES.flatMap(name => (r.holders[name].length ? r.holders[name] : ['(none)']).map(a => name.padEnd(width) + a))].join('\n');
}

/** The command line → `listRoles`'s arguments. Throws on an unknown, incomplete or missing flag. */
function argsOf(argv) {
  const { values } = parseArgs({ args: argv, options: Object.fromEntries(['rpc-url', 'factory', 'from-block', 'block-range'].map(f => [f, { type: 'string' }])) });
  for (const f of ['rpc-url', 'factory']) if (!values[f]) throw new Error(`missing --${f}`);
  const number = f => values[f] === undefined ? undefined : Number(values[f]);
  return { rpcUrl: values['rpc-url'], factory: values.factory, fromBlock: number('from-block'), blockRange: number('block-range') };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let args;
  try { args = argsOf(process.argv.slice(2)); }
  catch (e) {
    console.error(`${e.message}\nusage: node contracts/scripts/list-roles.mjs --rpc-url <url> --factory <ModuleFactory proxy> [--from-block <block Roles was deployed in>] [--block-range <blocks per eth_getLogs, default 1000>]`);
    process.exit(2);
  }
  try { console.log(report(await listRoles(args))); }
  catch (e) { console.error(`listing failed: ${e.message}`); process.exit(2); }
}
