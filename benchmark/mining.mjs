// mining.mjs — the trained mining network (FF 185→32→7, int8) on `anvil --network monad` and on
// `anvil --network ethereum`, through the production bridge (frontend/module-chain.js): deploy, then the 63 step
// transactions of test episode 0. It checks every on-chain step against the local scores, and reads the real charge of
// one step from the sender's balance.
// Run from the repository root: node benchmark/mining.mjs
import { localChain } from '../frontend/anvil.fixture.js';
import { deployModule, stepModule, sessionId } from '../frontend/module-chain.js';
import { trainMining, testEpisode } from './mining-network.mjs';

const artifact = await trainMining();
const episode = testEpisode(artifact);
console.error(`local episode 0: ${episode.length} steps, success ${episode.at(-1).success}`);

async function measure(network) {
  const chain = await localChain({ network });
  try {
    const d = await deployModule(chain.signer, chain.factory, artifact);
    const session = sessionId(`benchmark-${network}`), gas = [];
    let charged = null;
    for (const [k, s] of episode.entries()) {
      const before = await chain.provider.getBlockNumber();
      const r = await stepModule(chain.signer, d.address, s.input, session);
      if (JSON.stringify(r.scores) !== JSON.stringify(s.scores)) throw new Error(`${network}: step ${k} differs from the local scores`);
      gas.push(Number(r.gasUsed));
      if (k === 1) {
        const rc = await chain.provider.getTransactionReceipt(r.txHash), tx = await chain.provider.getTransaction(r.txHash);
        const paid = (await chain.provider.getBalance(chain.signer.address, before)) - (await chain.provider.getBalance(chain.signer.address, rc.blockNumber));
        charged = { gas: Number(paid / rc.gasPrice), gasUsed: Number(rc.gasUsed), gasLimit: Number(tx.gasLimit) };
      }
    }
    const sorted = [...gas].sort((a, b) => a - b);
    return { deploy: Number(d.gasUsed), chunkBytes: d.chunks.map(c => c.bytes), step: sorted[sorted.length >> 1], total: gas.reduce((a, b) => a + b, 0), charged };
  } finally { chain.stop(); }
}

const [monad, eth] = [await measure('monad'), await measure('ethereum')];
console.error(JSON.stringify({ monad, ethereum: eth }));
const n = x => x.toLocaleString('en-US'), diff = (m, e) => `${m > e ? '+' : ''}${(((m - e) / e) * 100).toFixed(1)}%`;
const by = c => (c.gas === c.gasLimit ? 'gasLimit' : c.gas === c.gasUsed ? 'gasUsed' : '?');
console.log(`\nFF 185→32→7 int8, weight chunks ${monad.chunkBytes.join(', ')} bytes, ${episode.length} steps, every on-chain step equal to the local scores\n`);
console.log('| Gas (receipt gasUsed) | Ethereum | Monad | Difference |\n|---|---|---|---|');
console.log(`| Deploy (chunk + module) | ${n(eth.deploy)} | ${n(monad.deploy)} | ${diff(monad.deploy, eth.deploy)} |`);
console.log(`| One step transaction (median) | ${n(eth.step)} | ${n(monad.step)} | ${diff(monad.step, eth.step)} |`);
console.log(`| ${episode.length} step transactions | ${n(eth.total)} | ${n(monad.total)} | ${diff(monad.total, eth.total)} |`);
console.log(`| Charged for one step transaction | ${n(eth.charged.gas)} (${by(eth.charged)}) | ${n(monad.charged.gas)} (${by(monad.charged)}) | ${diff(monad.charged.gas, eth.charged.gas)} |`);
