// network-size.mjs — gas of FF networks of increasing size, with Monad rules and with Ethereum rules.
// For each network and each rule set: a fresh anvil, then benchmark/NetworkSize.s.sol broadcasts the protocol, the
// module, 8 step transactions and one 63-forward game transaction. The numbers are receipt gasUsed.
// Run from the repository root: node benchmark/network-size.mjs [hidden@bits ...]   (default: the README networks)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { ethers } from 'ethers';
import { foundryBinary, run, startAnvil } from '../contracts/scripts/foundry.mjs';
import FactoryABI from '../frontend/abi/ModuleFactory.json' with { type: 'json' };

const CONTRACTS = new URL('../contracts/', import.meta.url).pathname;
const BROADCAST = `${CONTRACTS}broadcast/NetworkSize.s.sol/31337/run-latest.json`;
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';   // anvil account 0
/** Monad: 112 KiB chunks (ModuleFactory.MAX_CHUNK_BYTES). Ethereum: chunks under the EIP-170 limit (1 + data ≤ 24,576). */
const RULES = [
  { name: 'Monad', network: 'monad', chunk: 114_688 },
  { name: 'Ethereum', network: 'ethereum', chunk: 24_575 },
];
const NETWORKS = process.argv.slice(2).length ? process.argv.slice(2) : ['32@8', '128,128@8', '256,256@8', '256,256@16', '256,256,256,256@8'];

const forge = foundryBinary('forge');
if (!forge || !foundryBinary('anvil')) throw new Error('needs Foundry (forge, anvil) on PATH');
execFileSync(forge, ['build', '../benchmark/NetworkSize.s.sol'], { cwd: CONTRACTS, stdio: 'ignore' });
const factory = new ethers.Interface(FactoryABI);
const selector = name => factory.getFunction(name).selector;

async function measure(spec, rules) {
  const [hidden, bits] = spec.split('@');
  const node = await startAnvil(['--gas-limit', '1000000000'], { network: rules.network });
  try {
    const r = await run(forge, ['script', '../benchmark/NetworkSize.s.sol:NetworkSize', '--rpc-url', node.url, '--private-key', KEY,
      '--broadcast', '--slow', '--gas-limit', '1000000000', '--memory-limit', '4294967296', '--network', rules.network],
    { cwd: CONTRACTS, env: { HIDDEN: hidden, BITS: bits, CHUNK: String(rules.chunk) } });
    if (r.code !== 0) throw new Error(`${spec} ${rules.name}: forge script failed\n${(r.stderr || r.stdout).slice(-2000)}`);
    const j = JSON.parse(fs.readFileSync(BROADCAST, 'utf8'));
    const txs = j.transactions.map((t, i) => ({ fn: t.function ?? '', input: t.transaction.input ?? t.transaction.data ?? '0x', gas: Number(BigInt(j.receipts[i].gasUsed)), ok: j.receipts[i].status === '0x1' }));
    if (!txs.every(t => t.ok)) throw new Error(`${spec} ${rules.name}: a transaction reverted`);
    const chunks = txs.filter(t => t.input.startsWith(selector('createChunk')));
    const steps = txs.filter(t => t.fn.startsWith('step(')).map(t => t.gas).sort((a, b) => a - b);
    return { chunks: chunks.length, step: steps[steps.length >> 1], game: txs.find(t => t.fn.startsWith('play(')).gas };
  } finally { node.stop(); }
}

const label = spec => { const [hidden, bits] = spec.split('@'); return `185→${hidden.split(',').join('→')}→7 int${bits}`; };
const k = n => `${Math.round(n / 1000).toLocaleString('en-US')}k`, M = n => `${(n / 1e6).toFixed(2)}M`;
const diff = (m, e) => `${m > e ? '+' : ''}${(((m - e) / e) * 100).toFixed(1)}%`;
const rows = [];
for (const spec of NETWORKS) {
  const [monad, eth] = [await measure(spec, RULES[0]), await measure(spec, RULES[1])];
  rows.push({ spec, monad, eth });
  console.error(JSON.stringify({ network: label(spec), monad, ethereum: eth }));
}
console.log('\nOne step (median gasUsed of 8 step transactions)\n');
console.log('| Network | Weight chunks Monad / Ethereum | Monad | Ethereum | Monad vs Ethereum |\n|---|---|---|---|---|');
for (const { spec, monad, eth } of rows) console.log(`| ${label(spec)} | ${monad.chunks} / ${eth.chunks} | ${k(monad.step)} | ${k(eth.step)} | ${diff(monad.step, eth.step)} |`);
console.log('\n63 forwards in one transaction (gasUsed)\n');
console.log('| Network | Monad | Ethereum | Monad vs Ethereum |\n|---|---|---|---|');
for (const { spec, monad, eth } of rows) console.log(`| ${label(spec)} | ${M(monad.game)} | ${M(eth.game)} | ${diff(monad.game, eth.game)} |`);
