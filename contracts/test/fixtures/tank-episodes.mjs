// contracts/test/fixtures/tank-episodes.mjs — writes tank-episodes.json, the parity corpus of the on-chain referee
// (contracts/src/ladder/TankScene.sol, TankLadder.sol) against the scene of frontend/templates/tank-battle.yaml.
// The browser code alone plays every episode: the template scene (`battle`, `view`, `play` through the script calls
// of 坦克对战) and the integer executor of two trained artifacts (中, 大). The forge test test/ladder/TankParity.t.sol
// replays the corpus step by step on the deployed modules and compares every action and every state word.
//   modules         the ModuleSpec and chunk contents of each artifact (`data`, ABI MODULE), so forge deploys the
//                   same modules
//   episodes        the index of the episodes: the pair, the seed, the steps, the end, the lives and `covers`, what
//                   the episode shows. The seeds of each pair are the first SEEDS seeds plus the first seed that
//                   shows each of: a mutual shot, a respawn, a base kill, the step limit.
//   episodesData    the episodes (ABI EPISODE[]): the actions and the state after every step
//   challenges      the index of whole challenges as the ladder plays them: a prevrandao, id 1, the derived seed,
//                   per episode the end and the steps, and the score
//   challengesData  the challenges (ABI CHALLENGE[]) with the action bytes of the `Steps` events
// One ABI blob per list keeps the cheatcode calls of the forge test few (each call copies the whole file).
//   node contracts/test/fixtures/tank-episodes.mjs [中.json] [大.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AbiCoder, keccak256 } from 'ethers';
import '../../../frontend/core/kinds/index.js';
import { ModuleGraph } from '../../../frontend/core/graph.js';
import { instantiateInto } from '../../../frontend/core/template.js';
import { builtinTemplate } from '../../../frontend/templates/index.js';
import { scriptCalls } from '../../../frontend/core/script-calls.js';
import { createExecutor } from '../../../frontend/core/sessions/executor.js';
import { validateArtifact } from '../../../frontend/core/store.js';
import { deploymentOf, weightChunks, taskIdOf } from '../../../frontend/module-chain.js';
import { DENSE_KINDS } from '../../../frontend/runtime/dense-policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const SEEDS = 6;
const STEPS = 100;
const EPISODES = 6;
const PAIRS = [['mid', 'mid'], ['big', 'big'], ['mid', 'big'], ['big', 'mid']];
/** The encoding of one episode: the seed, then per step the cells word (3 bits per cell, cell c at bits 3c..3c+2) and
 *  a meta word: a0 | a1 << 4 (the chosen actions, own maps) | act0 << 8 | act1 << 12 (the actions made, world)
 *  | tank0 << 16 | tank1 << 38 (a tank: on | x << 1 | y << 5 | d << 9 | lives << 11 | fired << 13 | sx << 14 | sy << 18)
 *  | bases << 60 (b0 | b1 << 1) | jolt << 62 (the step was a mutual shot) | (end + 1) << 63. */
const EPISODE = 'tuple(string tag0, string tag1, uint32 seed, uint256[] cells, uint256[] meta)';
/** The encoding of one challenge: the tags, prevrandao, the id, the seed, per episode the action bytes of the `Steps`
 *  events (a0 · 9 + a1 per step), the end and the steps, then the score. */
const CHALLENGE = 'tuple(string challenger, string defender, bytes32 prevrandao, uint256 id, bytes32 seed, bytes[] actions, int8[] ends, uint8[] steps, uint8 challengerWins, uint8 defenderWins)';
/** The encoding of one module's deployment: the ModuleSpec fields and the chunk contents. */
const MODULE = 'tuple(bytes32 engineId, uint8 kind, uint16 inputs, uint16 outputs, uint256[] shape, bytes[] chunks, bytes32 artifactId, bytes32 taskId)';
const coder = AbiCoder.defaultAbiCoder();

const [midPath = join(ROOT, 'ladder', 'data', 'artifacts', 'mid.json'), bigPath = join(ROOT, 'ladder', 'data', 'artifacts', 'big.json')] = process.argv.slice(2);
const artifacts = { mid: JSON.parse(readFileSync(midPath, 'utf8')), big: JSON.parse(readFileSync(bigPath, 'utf8')) };

/** The scene calls of the template's script module 坦克对战: call(name, ...args). */
function sceneCalls() {
  const graph = new ModuleGraph();
  const { ids } = instantiateInto(graph, builtinTemplate('tank-battle'));
  const page = scriptCalls(graph, graph.resolved(), ids.vs_battle, { artifacts: () => null });
  return { call: (name, ...args) => page.call(name, args), revision: builtinTemplate('tank-battle').revision };
}

const argmax = o => { let b = 0; for (let k = 1; k < o.length; k++) if (o[k] > o[b]) b = k; return b; };
const packTank = t => BigInt(t.on ? 1 : 0) | (BigInt(t.x) << 1n) | (BigInt(t.y) << 5n) | (BigInt(t.d) << 9n) | (BigInt(t.lives) << 11n) | (BigInt(t.fired ? 1 : 0) << 13n) | (BigInt(t.sx) << 14n) | (BigInt(t.sy) << 18n);
const packCells = cells => cells.reduce((w, v, c) => w | (BigInt(v) << BigInt(3 * c)), 0n);
const hex = v => '0x' + v.toString(16);

/** One episode of `seed` between the networks of `tag0` (side 0) and `tag1` (side 1) → the record and what it covers. */
function episode(call, nets, [tag0, tag1], seed) {
  const r = { tag0, tag1, seed, cells: [], meta: [] };
  const actions = [];
  const covers = new Set();
  let s = call('battle', { seed });
  while (s.end < 0) {
    const a0 = argmax(nets[tag0].step(call('view', s, 0)).scores);
    const a1 = argmax(nets[tag1].step(call('view', s, 1)).scores);
    const was = s;
    s = call('play', s, a0, a1);
    const jolt = s.trails[0].why === 5;
    r.cells.push(hex(packCells(s.cells)));
    r.meta.push(hex(BigInt(a0) | (BigInt(a1) << 4n) | (BigInt(s.acts[0]) << 8n) | (BigInt(s.acts[1]) << 12n) | (packTank(s.tanks[0]) << 16n) | (packTank(s.tanks[1]) << 38n)
      | (BigInt((s.bases[0] ? 1 : 0) | (s.bases[1] ? 2 : 0)) << 60n) | (BigInt(jolt ? 1 : 0) << 62n) | (BigInt(s.end + 1) << 63n)));
    actions.push(a0 * 9 + a1);
    if (jolt) covers.add('mutual');
    if (s.hits.some((h, k) => h && s.tanks[k].lives > 0)) covers.add('respawn');
    if (s.bases.some((b, k) => !b && was.bases[k])) covers.add('base');
    if (s.t >= STEPS && s.end >= 0 && s.tanks.every(t => t.lives > 0) && s.bases.every(b => b)) covers.add('limit');
  }
  return { record: r, actions, covers: [...covers], steps: s.t, end: s.end, lives: s.tanks.map(t => t.lives) };
}

/** The seed of mirror pair `pair` of a challenge with `seed`: uint32(keccak256(abi.encode(seed, pair))). */
function pairSeed(seed, pair) {
  return Number(BigInt(keccak256(coder.encode(['bytes32', 'uint256'], [seed, pair]))) & 0xffffffffn);
}

/** A whole challenge of `challengerTag` against `defenderTag` from `prevrandao` with id 1, as the ladder plays it. */
function challenge(call, nets, [challengerTag, defenderTag], prevrandao, id = 1) {
  const seed = keccak256(coder.encode(['bytes32', 'uint256'], [prevrandao, id]));
  const r = { challenger: challengerTag, defender: defenderTag, prevrandao, id, seed, actions: [], ends: [], steps: [], challengerWins: 0, defenderWins: 0 };
  for (let e = 0; e < EPISODES; e++) {
    const swapped = e % 2 === 1;
    const pair = swapped ? [defenderTag, challengerTag] : [challengerTag, defenderTag];
    const { actions, steps, end } = episode(call, nets, pair, pairSeed(seed, Math.floor(e / 2)));
    if (end === 0 || end === 1) { if ((end === 0) !== swapped) r.challengerWins++; else r.defenderWins++; }
    r.actions.push('0x' + actions.map(a => a.toString(16).padStart(2, '0')).join('')); r.ends.push(end); r.steps.push(steps);
  }
  return r;
}

const { call, revision } = sceneCalls();
const nets = Object.fromEntries(Object.entries(artifacts).map(([k, a]) => [k, createExecutor(a.model)]));
const modules = {};
for (const [tag, a] of Object.entries(artifacts)) {
  const valid = await validateArtifact(a);
  const d = deploymentOf(valid);
  const chunks = weightChunks(d.weights);
  const spec = { engineId: keccak256(Buffer.from(d.engine)), kind: DENSE_KINDS.indexOf(d.kind), inputs: d.inputs, outputs: d.outputs, shape: d.shape, chunks: chunks.map(c => c.data), artifactId: valid.id, taskId: await taskIdOf(valid) };
  modules[tag] = { artifactId: valid.id, engine: d.engine, inputs: d.inputs, outputs: d.outputs, chunks: chunks.length, weightBytes: (d.weights.length - 2) / 2, data: coder.encode([MODULE], [spec]) };
}

const episodes = [];
const records = [];
for (const pair of PAIRS) {
  const want = new Set(['mutual', 'respawn', 'base', 'limit']);
  for (let seed = 1; seed <= 400 && (seed <= SEEDS || want.size); seed++) {
    const e = episode(call, nets, pair, seed);
    const fresh = e.covers.filter(c => want.has(c));
    if (seed > SEEDS && !fresh.length) continue;
    for (const c of fresh) want.delete(c);
    episodes.push({ pair, seed, steps: e.steps, end: e.end, lives: e.lives, covers: e.covers });
    records.push(e.record);
  }
  if (want.size) throw new Error(`${pair.join('-')}: no seed up to 400 shows ${[...want].join(', ')}`);
}

const challenges = [
  challenge(call, nets, ['mid', 'mid'], keccak256(Buffer.from('ladder-mid-mid'))),
  challenge(call, nets, ['mid', 'big'], keccak256(Buffer.from('ladder-mid-big'))),
  challenge(call, nets, ['big', 'mid'], keccak256(Buffer.from('ladder-big-mid'))),
];

const out = {
  template: { id: 'tank-battle', revision }, abi: { module: MODULE, episode: EPISODE, challenge: CHALLENGE }, modules,
  episodes, episodesData: coder.encode([`${EPISODE}[]`], [records]),
  challenges: challenges.map(({ actions, ends, steps, ...c }) => ({ ...c, episodes: ends.map((end, e) => ({ end, steps: steps[e] })) })),
  challengesData: coder.encode([`${CHALLENGE}[]`], [challenges]),
};
writeFileSync(join(HERE, 'tank-episodes.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`episodes ${episodes.length} (${episodes.reduce((n, e) => n + e.steps, 0)} steps), challenges ${challenges.length}`);
for (const e of episodes) console.log(`${e.pair.join('-')} seed ${e.seed}: ${e.steps} steps, end ${e.end}, lives ${e.lives.join('/')}${e.covers.length ? ', ' + e.covers.join(' ') : ''}`);
for (const c of challenges) console.log(`${c.challenger} vs ${c.defender}: ${c.steps.map((n, e) => `${n}:${c.ends[e]}`).join(' ')} → ${c.challengerWins}-${c.defenderWins}`);
