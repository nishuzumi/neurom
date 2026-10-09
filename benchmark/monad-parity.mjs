// monad-parity.mjs — does `anvil --network monad` charge the same gas as the Monad testnet?
// It runs benchmark/MonadParity.sol (constructor only, through eth_call, no transaction and no funds) on the Monad
// testnet RPC, on `anvil --network monad` and on `anvil --network ethereum`. The probe measures cold and warm account
// access, storage pages (MIP-8), memory expansion, and the deploy, forward and step of the trained mining network.
// Exit code 1 when anvil --network monad and the testnet disagree on any number.
// Run from the repository root: node benchmark/monad-parity.mjs [testnet RPC URL]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { ethers } from 'ethers';
import { foundryBinary, startAnvil } from '../contracts/scripts/foundry.mjs';
import { deploymentOf, weightChunks, taskIdOf } from '../frontend/module-chain.js';
import { trainMining, testEpisode } from './mining-network.mjs';

const TESTNET = process.argv[2] || 'https://testnet-rpc.monad.xyz';
const CONTRACTS = new URL('../contracts/', import.meta.url).pathname;
const LABELS = [
  'EXTCODESIZE, cold account', 'EXTCODESIZE, warm account', 'SLOAD, first slot of a page', 'SLOAD, same page',
  'SLOAD, another page', 'SSTORE 0 → 1, new page', 'SSTORE 0 → 1, same page', 'Memory expansion by 1 MiB',
  'Protocol deploy', 'createChunk (weights)', 'deploy (module)', 'forward', 'step', 'forward × 63',
];

const forge = foundryBinary('forge');
if (!forge || !foundryBinary('anvil')) throw new Error('needs Foundry (forge, anvil) on PATH');
execFileSync(forge, ['build', '../benchmark/MonadParity.sol'], { cwd: CONTRACTS, stdio: 'ignore' });
const out = JSON.parse(fs.readFileSync(`${CONTRACTS}out/MonadParity.sol/MonadParity.json`, 'utf8'));

const artifact = await trainMining();
const d = deploymentOf(artifact), observations = testEpisode(artifact).map(s => Uint8Array.from(s.input));
const args = new ethers.Interface(out.abi).encodeDeploy([
  d.kind === 'lif' ? 1 : 0, d.inputs, d.outputs, d.shape, weightChunks(d.weights).map(c => c.data), artifact.id, await taskIdOf(artifact), observations,
]);
const data = out.bytecode.object + args.slice(2);

async function probe(url) {
  const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
  try {
    const [chainId, ret] = [await provider.send('eth_chainId', []), await provider.send('eth_call', [{ data, gas: '0x1c9c380' }, 'latest'])];
    return { chainId: Number(chainId), m: ethers.AbiCoder.defaultAbiCoder().decode(['uint256[]'], ret)[0].map(Number) };
  } finally { provider.destroy(); }
}
async function onAnvil(network, args = []) {
  const node = await startAnvil(args, { network });
  try { return await probe(node.url); } finally { node.stop(); }
}

const testnet = await probe(TESTNET);
const monad = await onAnvil('monad');
const eth = await onAnvil('ethereum', ['--disable-code-size-limit']);   // the probe's initcode exceeds EIP-3860
const n = x => x.toLocaleString('en-US');
console.log(`\nMonad testnet (chain ${testnet.chainId}) against anvil 1.8 --network monad and --network ethereum\n`);
console.log('| Measurement | Monad testnet | anvil --network monad | anvil --network ethereum |\n|---|---|---|---|');
LABELS.forEach((label, i) => console.log(`| ${label} | ${n(testnet.m[i])} | ${n(monad.m[i])}${monad.m[i] === testnet.m[i] ? '' : ' ≠'} | ${n(eth.m[i])} |`));
const equal = testnet.m.every((x, i) => x === monad.m[i]);
console.log(`\n${equal ? 'anvil --network monad charges the same gas as the Monad testnet for every measurement.' : 'MISMATCH: anvil --network monad differs from the Monad testnet.'}`);
process.exitCode = equal ? 0 : 1;
