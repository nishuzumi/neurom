#!/usr/bin/env node
// scripts/dev-chain.mjs — the local development stack of the ladder page in one command:
//   1. a fresh `anvil --network monad` with the protocol and a TankLadder on it (frontend/ladder.fixture.js),
//   2. a few entries from model artifacts, registered by anvil accounts 0 and 2,
//   3. a few challenges, played to the end from the contract,
//   4. a name service on PGlite, mounted at /api/names of the Vite dev server,
//   5. the Vite dev server of the page, pointed at the anvil through VITE_LADDER_RPC and the addresses.
// The page then logs in with anvil account 1 (VITE_DEV_ACCOUNT), which owns nothing at the start, so the whole flow
// (register, challenge, name) can be walked in the browser. Local development only: the accounts are public.
//
//   node ladder/scripts/dev-chain.mjs [--port 5174] [--no-play] [--artifacts a.json,b.json]
//   ANVIL=… FORGE=… select the Foundry binaries (contracts/scripts/foundry.mjs).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { localLadder, PLAY_GAS } from '../../frontend/ladder.fixture.js';
import { ensureSchema, openTestDatabase } from '../server/db.js';
import { createNameHandler } from '../server/names-http.js';
import { createNameService, ladderOwnerOf, nameMessage } from '../server/names.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('../..', import.meta.url));
const { values: args } = parseArgs({ options: { port: { type: 'string', default: '5174' }, play: { type: 'boolean', default: true }, artifacts: { type: 'string' } }, allowNegative: true });

/** The default entries: name → artifact file (relative to the repo). The two trained networks of
 *  ladder/data/artifacts (template revision 15) are always there. Other local artifacts in .scratch fill the rest of
 *  the ladder when they exist. Missing files are skipped. */
const DEFAULT_ARTIFACTS = [
  ['Mid', 'ladder/data/artifacts/mid.json'],
  ['Big', 'ladder/data/artifacts/big.json'],
  ['Mid S1', '.scratch/jolt/s1-a-r15.json'],
  ['Big S1', '.scratch/jolt/s1-b-r15.json'],
  ['Mid Jolt', '.scratch/jolt/s2-a-jolt.json'],
  ['Big Jolt', '.scratch/jolt/s2-b-jolt.json'],
];
const files = args.artifacts ? args.artifacts.split(',').map((f, i) => [`Entry ${i + 1}`, f]) : DEFAULT_ARTIFACTS;

const log = (...a) => console.log('[dev-chain]', ...a);

log('building contracts and starting anvil…');
const chain = await localLadder();
const { provider, ladderContract, ladder, factory, enter } = chain;
log(`anvil ${chain.url}`);
log(`factory ${factory}`);
log(`ladder  ${ladder} (season ends at block ${chain.config.endBlock})`);

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
  log(`entry #${e.rank} ${e.module} (${e.weightBytes} B) ← ${file} by ${await owner.getAddress()}`);
}

// --- the name service on PGlite, with names for the entries
const db = await openTestDatabase();
await ensureSchema(db);
const banned = JSON.parse(readFileSync(`${here}../data/banned-words.json`, 'utf8')).words;
const service = createNameService({ db, chainId: 31337, ownerOf: ladderOwnerOf({ rpc: provider, ladder }), banned });
for (const e of entries) {
  const signature = await e.signer.signMessage(nameMessage({ chainId: 31337, module: e.module, name: e.name }));
  await service.set({ module: e.module, name: e.name, signature });
}
log(`names set for ${entries.length} entries`);

// From here anvil mines a block every second, as a real chain does. With automine only, the chain stops at the last
// transaction, and ethers' receipt polling (which runs on new blocks) can wait forever on the page and here.
await provider.send('evm_setIntervalMining', [1]);
log('anvil now mines one block per second');

// --- a few challenges, played from the contract until settled
async function play(challenger, defender) {
  const c = ladderContract.connect(challenger.signer);
  const started = await c.challenge(challenger.module, defender.module, { gasLimit: PLAY_GAS });
  log(`challenge ${challenger.name} → ${defender.name}: start tx ${started.hash}`);
  const rc = await started.wait();
  const ev = rc.logs.map(l => { try { return ladderContract.interface.parseLog(l); } catch { return null; } }).find(e => e && e.name === 'ChallengeStarted');
  const id = ev.args.id;
  let info = await ladderContract.challengeInfo(id), txs = 1;
  while (Number(info.status) === 1) {
    const tx = await c.advance(id, { gasLimit: PLAY_GAS });
    log(`  #${id} advance ${tx.hash} (episode ${info.episode}, step ${info.step})`);
    await tx.wait();
    txs++;
    info = await ladderContract.challengeInfo(id);
  }
  log(`challenge #${id} ${challenger.name} → ${defender.name}: status ${info.status}, ${info.challengerWins} : ${info.defenderWins}, ${txs} transactions`);
}
if (args.play && entries.length >= 2) {
  const last = entries.length - 1;
  await play(entries[last], entries[last - 1]);
  if (entries.length >= 3) await play(entries[last - 1], entries[last - 2]);
  await play(entries[1], entries[0]);
}

// --- the Vite dev server with /api/names
process.env.VITE_LADDER_CHAIN_ID = '31337';
process.env.VITE_LADDER_RPC = chain.url;
process.env.VITE_LADDER_ADDRESS = ladder;
process.env.VITE_LADDER_FACTORY = factory;
const handler = createNameHandler({ service, adminToken: process.env.ADMIN_TOKEN ?? '' });
const server = await createServer({
  configFile: `${here}../vite.config.js`,
  server: { port: Number(args.port) },
  plugins: [{ name: 'ladder-dev-names', configureServer(s) { s.middlewares.use('/api/names', (req, res) => handler(req, res)); } }],
});
await server.listen();
const url = server.resolvedUrls.local[0];
log(`page ${url}`);
log('login in the page uses anvil account 1 (VITE_DEV_ACCOUNT). Ctrl-C stops everything.');

const stop = async () => { await server.close(); await db.close(); chain.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
