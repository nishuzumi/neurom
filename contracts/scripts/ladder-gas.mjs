// ladder-gas.mjs — measures the gas of a referee step of the tank ladder on anvil --network monad, for every pair of
// the two trained networks of the parity corpus (中 39,840 bytes, 大 216,864 bytes; test/fixtures/tank-episodes.json).
// Each pair plays on two fresh ladders: one with the configuration of the spec, which plays as many steps per 30M
// transaction as the reserve allows (the gas per step in a loop, and the steps per transaction), and one with a
// reserve of 29.9M, which plays exactly one step per transaction (the gas of one step with the cold accesses, the
// load, the save and the events: what the reserve must hold). 中 against 中 and 大 against 大 play a twin whose last
// weight byte (padding of the output bias column) differs, because the ladder refuses the same weights twice.
//   ANVIL=/tmp/foundry-1.8.0/anvil FORGE=/tmp/foundry-1.8.0/forge node contracts/scripts/ladder-gas.mjs [single steps per pair = 40]
// Prints a JSON report. The README of contracts/ records the numbers.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AbiCoder, Contract, keccak256 } from 'ethers';
import { localLadder, ladderAt, LADDER_DEFAULTS, PLAY_GAS, mined, playChallenge, ladderEvents } from '../../frontend/ladder.fixture.js';
import { deployOut } from '../../frontend/anvil.fixture.js';
import FactoryABI from '../../frontend/abi/ModuleFactory.json' with { type: 'json' };

const SINGLE = Number(process.argv[2] ?? 40);
const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(HERE, '..', 'test', 'fixtures', 'tank-episodes.json'), 'utf8'));
const coder = AbiCoder.defaultAbiCoder();
const stats = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? { n: s.length, min: s[0], median: s[s.length >> 1], max: s[s.length - 1], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) } : null; };
/** The intrinsic gas of a transaction with `data`: 21,000 plus the calldata. */
const intrinsic = data => 21_000 + [...Buffer.from(data.slice(2), 'hex')].reduce((g, b) => g + (b ? 16 : 4), 0);

/** Send the transaction `p` and wait until it is mined. A reverted transaction throws. */
async function sent(provider, p) {
  const tx = await p;
  const rc = await mined(provider, tx.hash);
  if (rc.status !== 1) throw new Error(`reverted ${tx.hash}`);
  return rc;
}
/** Deploys fixture module `tag` through the Factory as `signer`; `twin` changes the last weight byte. The module id is
 *  `tag`, or `tag`-twin (one signer deploys all four). */
async function deployFixture(signer, factoryAddress, tag, twin) {
  const factory = new Contract(factoryAddress, FactoryABI, signer);
  const [m] = coder.decode([fixture.abi.module], fixture.modules[tag].data);
  const chunks = [...m.chunks];
  if (twin) { const last = Buffer.from(chunks[chunks.length - 1].slice(2), 'hex'); last[last.length - 1] ^= 0x5a; chunks[chunks.length - 1] = '0x' + last.toString('hex'); }
  const spec = { engineId: m.engineId, version: '0x0000000000000000000000000000000000000000', kind: Number(m.kind), inputs: Number(m.inputs), outputs: Number(m.outputs), shape: [...m.shape], tools: [], chunks: chunks.map(keccak256), artifactId: twin ? keccak256(m.artifactId) : m.artifactId, taskId: m.taskId, moduleId: twin ? `${tag}-twin` : tag };
  for (const c of chunks) await sent(signer.provider, factory.createChunk(c, { gasLimit: PLAY_GAS }));
  const rc = await sent(signer.provider, factory.deploy(spec, chunks.map(() => '0x'), { gasLimit: PLAY_GAS }));
  return ladderEvents(factory, rc).find(e => e.name === 'ModuleDeployed').args.module;
}

/** Plays a challenge of `challenger` against `defender` on `ladder` → per transaction { gasUsed, steps, intrinsic }. */
async function play(ladder, challenger, defender, limit = Infinity) {
  const { id, receipts, info } = await playChallenge(ladder, challenger, defender, { maxTransactions: limit });
  const transactions = receipts.map((rc, k) => ({
    gasUsed: Number(rc.gasUsed),
    steps: ladderEvents(ladder, rc).filter(e => e.name === 'Steps').reduce((n, e) => n + (e.args.actions.length - 2) / 2, 0),
    intrinsic: intrinsic(k === 0 ? ladder.interface.encodeFunctionData('challenge', [challenger, defender]) : ladder.interface.encodeFunctionData('advance', [id])),
  }));
  return { id, transactions, info };
}

const chain = await localLadder();
try {
  const { provider, signer, factory } = chain;
  const eoa = await provider.getSigner(1);
  /** A fresh ladder with `reserveGas`, the defender at rank 1 and the challenger at rank 2, as an ethers Contract of the EOA. */
  const ladderFor = async (reserveGas, challenger, defender) => {
    const ladder = ladderAt(eoa, await (await deployOut(signer, 'TankLadder', { ...chain.config, reserveGas })).getAddress());
    for (const m of [defender, challenger]) await sent(provider, ladder.register(m, { gasLimit: 2_000_000 }));
    return ladder;
  };
  const modules = {};
  for (const [tag, twin] of [['mid', false], ['mid2', true], ['big', false], ['big2', true]]) modules[tag] = await deployFixture(eoa, factory, tag.replace('2', ''), twin);
  const report = { blockGasLimit: String((await provider.getBlock('latest')).gasLimit), config: { ...LADDER_DEFAULTS }, bytes: { mid: fixture.modules.mid.weightBytes, big: fixture.modules.big.weightBytes }, pairs: {} };
  for (const [name, c, d] of [['mid-mid', 'mid', 'mid2'], ['big-big', 'big', 'big2'], ['mid-big', 'mid', 'big'], ['big-mid', 'big', 'mid']]) {
    const loop = await ladderFor(LADDER_DEFAULTS.reserveGas, modules[c], modules[d]);
    const single = await ladderFor(29_900_000, modules[c], modules[d]);
    const l = await play(loop, modules[c], modules[d]);
    const s = await play(single, modules[c], modules[d], SINGLE);
    const full = l.transactions.filter(t => Number(t.steps) > 0);
    const singles = s.transactions.filter(t => Number(t.steps) === 1);
    report.pairs[name] = {
      challenge: { transactions: l.transactions.length, steps: full.reduce((n, t) => n + t.steps, 0), challengerWins: Number(l.info.challengerWins), defenderWins: Number(l.info.defenderWins), status: Number(l.info.status) },
      loopPerStep: stats(full.map(t => Math.round((t.gasUsed - t.intrinsic) / t.steps))),
      stepsPerTransaction: stats(l.transactions.slice(0, -1).map(t => t.steps)),
      transactionGas: stats(l.transactions.map(t => t.gasUsed)),
      singleStep: stats(singles.map(t => t.gasUsed - t.intrinsic)),
    };
    console.error(name, JSON.stringify(report.pairs[name]));
  }
  console.log(JSON.stringify(report, null, 1));
} finally { chain.stop(); }
