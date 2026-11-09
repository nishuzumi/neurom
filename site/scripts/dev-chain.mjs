#!/usr/bin/env node
// scripts/dev-chain.mjs — the local development stack of the ladder page in one command:
//   1. a fresh `anvil --network monad` with the protocol and a TankLadder on it (frontend/ladder.fixture.js),
//   2. a few entries from model artifacts, registered by anvil accounts 0 and 2,
//   3. a few challenges, played to the end from the contract,
//   4. a name service on PGlite, mounted at /api/names of the Vite dev server,
//   5. the Vite dev server of the site, pointed at the anvil through VITE_LADDER_RPC and the addresses: the home page
//      at /, the ladder at /ladder/ and the workbench at /studio/ (site/vite.config.js), on the same chain and
//      official Factory.
// Each page logs in with one anvil account (VITE_DEV_ACCOUNT). The default is one page for account 1, which owns
// nothing at the start, so the whole flow (register, challenge, name) can be walked in the browser. `--accounts 1,3,4`
// starts one page for each account, on the ports after `--port`, so several local users share one chain and one name
// service. `--no-seed` starts with an empty ladder. `--board-size 3` deploys the ladder with a board of 3 ranks, so a
// few entries already fill the board and the page shows entries off the board. Local development only: the accounts
// are public.
//
// `--fork` starts a local fork of the ladder chain instead (ADR 0028): the fork entry of data/deployments.json, with
// its chain id and port, the same command as `forkCommand` of frontend/chain.js. The fork keeps the board, the Factory
// and the ladder of the real chain, so nothing is deployed, seeded or played. The pages and the workbench use the fork
// entry, and the chain node of a tank battle template reaches the same node.
//
//   node site/scripts/dev-chain.mjs [--port 5174] [--accounts 1] [--board-size 20] [--no-seed] [--no-play] [--artifacts a.json,b.json]
//   node site/scripts/dev-chain.mjs --fork [--port 5174] [--accounts 1]
//   ANVIL=… FORGE=… select the Foundry binaries (contracts/scripts/foundry.mjs).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { startAnvil } from '../../contracts/scripts/foundry.mjs';
import { CHAINS } from '../../frontend/chain.js';
import { ladderAt, localLadder, playChallenge } from '../../frontend/ladder.fixture.js';
import { ensureSchema, openTestDatabase } from '../server/db.js';
import { createNameHandler } from '../server/names-http.js';
import { createNameService, ladderOwnerOf, nameMessage } from '../server/names.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('../..', import.meta.url));
const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '5174' },
    accounts: { type: 'string', default: '1' },
    seed: { type: 'boolean', default: true },
    play: { type: 'boolean', default: true },
    artifacts: { type: 'string' },
    'board-size': { type: 'string' },
    fork: { type: 'boolean', default: false },
  },
  allowNegative: true,
});
const accounts = args.accounts.split(',').map(Number);
if (accounts.some(a => !Number.isInteger(a) || a < 0 || a > 9) || new Set(accounts).size !== accounts.length) {
  throw new Error(`--accounts must list different indices 0 to 9 of the anvil mnemonic, got "${args.accounts}"`);
}

/** The default entries: name → artifact file (relative to the repo). The two trained networks of
 *  site/data/artifacts (the scene of template revision 16) are always there. Other local artifacts in .scratch fill the rest of
 *  the ladder when they exist. Missing files are skipped. */
const DEFAULT_ARTIFACTS = [
  ['Mid', 'site/data/artifacts/mid.json'],
  ['Big', 'site/data/artifacts/big.json'],
  ['Mid S1', '.scratch/jolt/s1-a-r15.json'],
  ['Big S1', '.scratch/jolt/s1-b-r15.json'],
  ['Mid Jolt', '.scratch/jolt/s2-a-jolt.json'],
  ['Big Jolt', '.scratch/jolt/s2-b-jolt.json'],
];
const files = !args.seed || args.fork ? [] : args.artifacts ? args.artifacts.split(',').map((f, i) => [`Entry ${i + 1}`, f]) : DEFAULT_ARTIFACTS;

const log = (...a) => console.log('[dev-chain]', ...a);

/** The first fork entry of the registry, or null. */
const FORK_ID = Object.keys(CHAINS).map(Number).find(id => CHAINS[id].fork) ?? null;

/** A local fork of the chain the fork entry names, on the port and chain id of that entry → the shape of localLadder
 *  without `enter`: the Factory and the ladder are the ones of the forked chain. */
async function forkLadder() {
  if (FORK_ID === null) throw new Error('data/deployments.json has no fork entry (forkOf)');
  const c = CHAINS[FORK_ID], of = CHAINS[c.fork.of];
  if (!c.ladder) throw new Error(`${c.name} forks ${of.name}, which has no ladder address`);
  log(`starting a fork of ${of.name} (${of.rpc})…`);
  const { url, provider, stop } = await startAnvil(['--fork-url', of.rpc, '--chain-id', String(FORK_ID)], { port: c.fork.port });
  // On Monad testnet, the public anvil accounts carry an EIP-7702 delegation, and `challenge` refuses an account with
  // code. Remove that code on the fork (local only), so the pages can challenge from these accounts.
  for (const account of await provider.send('eth_accounts', [])) await provider.send('anvil_setCode', [account, '0x']);
  const ladderContract = ladderAt(await provider.getSigner(0), c.ladder);
  const onChain = await ladderContract.config();
  return { url, provider, stop, ladder: c.ladder, factory: c.factory, ladderContract, config: { endBlock: Number(onChain.endBlock), boardSize: Number(onChain.boardSize) } };
}
async function freshLadder() {
  log('building contracts and starting anvil…');
  return localLadder(args['board-size'] ? { boardSize: Number(args['board-size']) } : {});
}

const chainId = args.fork ? FORK_ID : 31337;
const chain = args.fork ? await forkLadder() : await freshLadder();
const { provider, ladderContract, ladder, factory, enter } = chain;
log(`anvil ${chain.url} (chain ${chainId})`);
log(`factory ${factory}`);
log(`ladder  ${ladder} (season ends at block ${chain.config.endBlock}, a board of ${chain.config.boardSize} ranks)`);

// --- entries: accounts 0 and 2 take turns; account 1 is the page's dev account and owns nothing yet
const owners = [await provider.getSigner(0), await provider.getSigner(2)];
const entries = [];
for (const [i, [name, file]] of files.entries()) {
  const path = `${repo}${file}`;
  if (!existsSync(path)) { log(`skip ${file}: not found`); continue; }
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  const owner = owners[i % owners.length];
  const e = await enter(artifact, owner);
  entries.push({ ...e, name, signer: owner });
  log(`entry ${e.rank ? `#${e.rank}` : 'off the board'} ${e.module} (${e.weightBytes} B) ← ${file} by ${await owner.getAddress()}`);
}

// --- the name service on PGlite, with names for the entries
const db = await openTestDatabase();
await ensureSchema(db);
const banned = JSON.parse(readFileSync(`${here}../data/banned-words.json`, 'utf8')).words;
const service = createNameService({ db, chainId, ownerOf: ladderOwnerOf({ rpc: provider, ladder }), banned });
for (const e of entries) {
  const signature = await e.signer.signMessage(nameMessage({ chainId, module: e.module, name: e.name }));
  await service.set({ module: e.module, name: e.name, signature });
}
log(`names set for ${entries.length} entries`);

// From here anvil mines a block every second, as a real chain does. With automine only, the chain stops at the last
// transaction, and ethers' receipt polling (which runs on new blocks) can wait forever on the page and here.
await provider.send('evm_setIntervalMining', [1]);
log('anvil now mines one block per second');

// --- a few challenges, played from the contract until settled. A pair plays once: the cooldown refuses a second time.
const played = new Set();
async function play(challenger, defender) {
  const pair = `${challenger.module}:${defender.module}`;
  if (played.has(pair)) return;
  played.add(pair);
  log(`challenge ${challenger.name} → ${defender.name}…`);
  const { id, receipts, info } = await playChallenge(ladderContract.connect(challenger.signer), challenger.module, defender.module, {
    onReceipt: (rc, after) => log(`  ${rc.hash} mined (episode ${after.episode}, step ${after.step})`),
  });
  log(`challenge #${id} ${challenger.name} → ${defender.name}: status ${info.status}, ${info.challengerWins} : ${info.defenderWins}, ${receipts.length} transactions`);
}
if (args.play && entries.length >= 2) {
  const byModule = new Map(entries.map(e => [e.module, e]));
  const board = async () => (await ladderContract.board()).map(b => byModule.get(b.module));
  // the last entry challenges the entry right above it: the last rank of the board when it is off the board
  const last = entries.at(-1);
  await play(last, Number((await ladderContract.entry(last.module)).rank) ? entries.at(-2) : (await board()).at(-1));
  let ranked = await board();
  if (ranked.length >= 3) await play(ranked[2], ranked[1]);
  ranked = await board();
  if (ranked.length >= 2) await play(ranked[1], ranked[0]);
}

// --- one Vite dev server with /api/names for each account. Vite reads the VITE_ variables when it creates the server,
// so each server keeps the account that was set before it was created. The workbench at /studio/ of a server deploys
// from the account of that server. The overrides are set for a fork too: else the VITE_LADDER_RPC of the root
// .env.local (a public RPC of the forked chain) applies to the fork's chain id.
process.env.VITE_LADDER_CHAIN_ID = String(chainId);
process.env.VITE_LADDER_RPC = chain.url;
process.env.VITE_LADDER_ADDRESS = ladder;
process.env.VITE_LADDER_FACTORY = factory;
const handler = createNameHandler({ service, adminToken: process.env.ADMIN_TOKEN ?? '' });
const servers = [];
for (const [i, account] of accounts.entries()) {
  process.env.VITE_DEV_ACCOUNT = String(account);
  const server = await createServer({
    configFile: `${here}../vite.config.js`,
    server: { port: Number(args.port) + i, strictPort: true },
    plugins: [{ name: 'ladder-dev-names', configureServer(s) { s.middlewares.use('/api/names', (req, res) => handler(req, res)); } }],
  });
  await server.listen();
  servers.push(server);
  const url = server.resolvedUrls.local[0];
  log(`home ${url}, ladder ${url}ladder/, workbench ${url}studio/ — logs in with anvil account ${account} (${await (await provider.getSigner(account)).getAddress()})`);
}
log('Ctrl-C stops everything.');

const stop = async () => { await Promise.all(servers.map(s => s.close())); await db.close(); chain.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
