// templates/tank-battle.test.js — the tank battle template: a Botzone Tank2 battle (1 tank per side, 2 lives) on a
// fixed 9 × 9 map with a base at each end. It instantiates with only the problems of candidates that accepted nothing
// yet. It has four training modules, each with one trainer and its loop (ADR 0020). Both stages play the battle against
// the bot of one shared scene. In stage 1, 中 and 大 learn the teacher of the scene. In stage 2, each structure
// continues from its stage 1 candidates by REINFORCE on the reward of the scene, behind a gate on its stage 1 report.
// Its script module 坦克对战 plays the stage 2 中 against a bot of the scene (the hard bot by default) or against the
// stage 2 大, on the battle of the same scene.
//
// The rules of the battle without a bot run through the calls of the script module, as the script calls them. A test
// that needs a given position puts the tanks in place on a start state and changes cells of the map. The rules of the
// training step run through the runner on fixed seeds: a test resets the runner, then puts the position on its state.
// The teacher runs as the trainers call it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModuleGraph } from '../core/graph.js';
import { instantiateInto } from '../core/template.js';
import { buildBundle } from '../core/bundle.js';
import { createEnv } from '../core/runner.js';
import { builtinTemplate } from './index.js';
import { compileEntry } from '../core/sessions/common.js';
import { episodeType } from '../core/kinds/scenario.js';
import { sectionColumns, trainingModule } from '../editor/training-module.js';
import { canvasGeometry } from '../editor/canvas-geometry.ts';
import { shapedArtifact } from '../core/sessions/fixtures.js';
import { gateStatus } from '../core/sessions/trainer.js';
import { DENSE_FORMAT } from '../runtime/dense-policy.js';
import { scriptCalls } from '../core/script-calls.js';
import { createExecutor } from '../core/sessions/executor.js';

const instance = () => { const graph = new ModuleGraph(); return { graph, ...instantiateInto(graph, builtinTemplate('tank-battle')) }; };
/** The two structures of stage 1: 中 (2 × 32) and 大 (3 × 128). */
const STRUCTURES = ['s1_a', 's1_b'];
/** The same structures in stage 2. */
const STAGE2 = ['s2_a', 's2_b'];
/** The metrics of each stage 2 evaluator, by the titles that its report shows. */
const DUEL_METRICS = ['胜率', '击毁对方坦克的比例', '我方坦克被击中的比例', '平局的比例'];
/** The metrics of each stage 1 evaluator: the agreement with the teacher, then the metrics of stage 2. */
const METRICS = ['和教师一致的比例', ...DUEL_METRICS];
/** The levels of the bot: 1 easy, 2 medium, 3 hard. */
const LEVELS = [1, 2, 3];
/** The bits that each side sees, and the actions. */
const [INPUTS, ACTIONS] = [572, 9];

test('the tank battle template instantiates with no problem but candidates that accepted nothing yet and the starts that wait for them', () => {
  const { graph, ids } = instance();
  const byNode = (a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0);
  const unaccepted = [...STRUCTURES, ...STAGE2].map(m => ({ node: ids[`${m}_cands`], port: 'artifact', incomplete: true, message: '尚未接受任何候选' }));
  const noStart = [['s2_a', '候选（中）'], ['s2_b', '候选（大）']]
    .map(([m, cands]) => ({ node: ids[`${m}_trainer`], port: 'init', incomplete: true, message: `init 的候选 ${cands} 尚未接受任何产物` }));
  assert.deepEqual(graph.problems().sort(byNode), [...unaccepted, ...noStart].sort(byNode));
});

test('each training module trains one network: each stage has one for 中 and one for 大, and the metrics are shared', () => {
  const { graph, ids, group, groupIds } = instance();
  const modules = [...STRUCTURES, ...STAGE2];
  assert.deepEqual([...graph.groups.values()].filter(g => g.prefab).map(g => g.id), modules.map(m => groupIds[m]), 'four training modules');
  for (const m of modules) {
    graph.setGroupLayout(groupIds[m], { collapsed: false });
    const frame = trainingModule(graph, groupIds[m]);
    assert.deepEqual(frame.trainers, [ids[`${m}_trainer`]], `${m}: one trainer`);
    assert.deepEqual(frame.canvas, [groupIds[`${m}_box`]], `${m}: its loop box is in the well`);
  }
  const metrics = [...graph.nodes.values()].filter(n => METRICS.includes(n.title));
  assert.equal(metrics.length, METRICS.length, 'one module for each metric');
  for (const n of metrics) assert.equal(graph.parentOf(n.id).id, group.id, `${n.title} sits outside the training modules`);
});

test('in stage 1, 中 and 大 learn the teacher of one shared scene, and the evaluators count the agreement as the reward', () => {
  const { graph, ids, group } = instance();
  assert.deepEqual(STRUCTURES.map(m => graph.node(ids[`${m}_net`]).config.layers.map(L => L.hidden)), [[32, 32], [128, 128, 128]]);
  assert.equal(graph.parentOf(ids.scene).id, group.id, 'the scene sits outside the training module');
  assert.deepEqual(graph.consumers(ids.scene, 'module').map(c => c.node).sort(), [...STRUCTURES, ...STAGE2].map(m => ids[`${m}_loop`]).sort(), 'one scene for all loops');
  for (const m of STRUCTURES) {
    const trainer = graph.node(ids[`${m}_trainer`]);
    assert.equal(trainer.config.method, 'cross-entropy', m);
    assert.deepEqual([graph.producers(trainer.id, 'init'), graph.producers(trainer.id, 'gate')], [[], []], `${m}: stage 1 starts from random weights`);
    assert.deepEqual(graph.producers(trainer.id, 'objective').map(p => [p.node, p.port]), [[ids.scene, 'teacher']], m);
    assert.deepEqual(graph.producers(ids[`${m}_evaluator`], 'objective').map(p => [p.node, p.port]), [[ids.scene, 'agreement']], `${m}: evaluator reward`);
    assert.deepEqual(graph.producers(ids[`${m}_evaluator`], 'metrics').map(p => graph.node(p.node).title).sort(), [...METRICS].sort(), `${m}: evaluator`);
    const env = createEnv(buildBundle(graph, trainer.id).env);
    env.reset({ seed: 1 });
    assert.equal(env.input().length, graph.node(ids[`${m}_net`]).config.inputs, `${m}: the network reads all input bits of the scene`);
    assert.deepEqual(graph.node(ids[`${m}_readout`]).config.map, [0, 1, 2, 3, 4, 5, 6, 7, 8], `${m}: the readout maps the 9 actions`);
  }
  // both trainers train on the same scene: their bundles agree on the environment
  const envs = STRUCTURES.map(m => JSON.stringify(buildBundle(graph, ids[`${m}_trainer`]).env));
  assert.equal(new Set(envs).size, 1);
});

/** A fixed dense FF model at int16, because an evaluator runs accepted weights only. */
function fixedModel(inputs, hidden, outputs, seed) {
  let k = seed;
  const w = () => ((((k++) * 29 + 13) % 7) - 3) * 1000, b = () => ((((k++) * 17 + 5) % 5) - 1) * 1000;
  const region = (rows, cols) => ({ W: Array.from({ length: rows }, () => Array.from({ length: cols }, w)), b: Array.from({ length: rows }, b) });
  return { format: DENSE_FORMAT, kind: 'feedforward', inputs, outputs, weightBits: 16, ticks: 1, leak_shift: 0, reset: 0,
    layers: hidden.map((h, i) => ({ hidden: h, ...region(h, i ? hidden[i - 1] : inputs), scale: 1000, k: 0 })),
    output: { ...region(outputs, hidden.at(-1)), scale: 1000, k: 0 } };
}

test('stage 2 continues each structure from its stage 1 candidates on the same battle, gated on its stage 1 report', () => {
  const { graph, ids } = instance();
  for (const [m, from, hidden] of [['s2_a', 's1_a', [32, 32]], ['s2_b', 's1_b', [128, 128, 128]]]) {
    const trainer = graph.node(ids[`${m}_trainer`]), wired = port => graph.producers(trainer.id, port).map(p => [p.node, p.port]);
    assert.equal(trainer.config.method, 'reinforce', m);
    assert.deepEqual(graph.node(ids[`${m}_net`]).config.layers.map(L => L.hidden), hidden, `${m}: the structure of ${from}`);
    assert.deepEqual(wired('objective'), [[ids.scene, 'reward']], `${m}: the reward of the scene`);
    assert.deepEqual(wired('init'), [[ids[`${from}_cands`], 'weights']], `${m}: init`);
    assert.deepEqual(wired('gate'), [[ids[`${from}_evaluator`], 'report']], `${m}: gate`);
    assert.deepEqual(graph.producers(ids[`${m}_evaluator`], 'metrics').map(p => graph.node(p.node).title).sort(), [...DUEL_METRICS].sort(), `${m}: evaluator`);

    // the condition: 和教师一致的比例 of the stage 1 report is at least 0.7
    const evaluation = mean => ({ stale: false, report: { metrics: { 和教师一致的比例: { mean } } } });
    assert.ok(METRICS.includes(trainer.config.gate.metric), `${m}: the gate reads a metric of the stage 1 evaluator`);
    assert.deepEqual([0.69, 0.7, 0.95].map(v => gateStatus(trainer.config.gate, evaluation(v), 'e').passed), [false, true, true], m);
    assert.equal(gateStatus(trainer.config.gate, null, 'e').passed, false, `${m}: no report, no start`);
    assert.equal(gateStatus(trainer.config.gate, { ...evaluation(0.95), stale: true }, 'e').passed, false, `${m}: a stale report, no start`);

    // the run starts from the accepted stage 1 weights. Its loop plays the battle of stage 1: the network is side 0 and
    // sees view(state, 0).
    const id = '0x' + '4'.repeat(64), model = fixedModel(INPUTS, hidden, ACTIONS, 3), artifact = shapedArtifact(graph, ids[`${from}_net`], model);
    graph.patchConfig(ids[`${from}_cands`], { accepted: id });
    const bundle = buildBundle(graph, trainer.id, { artifacts: a => (a === id ? artifact : null) });
    assert.deepEqual(bundle.init, { artifactId: id, model }, m);
    assert.equal(JSON.stringify(bundle.env), JSON.stringify(buildBundle(graph, ids[`${from}_trainer`]).env), `${m}: the environment of ${from}`);
    const env = createEnv(bundle.env), page = scriptCalls(graph, graph.resolved(), ids.vs_battle, { artifacts: () => null });
    const start = env.reset({ seed: 7 }), battle = page.call('battle', [{ seed: 7 }]);
    assert.deepEqual(start, battle, `${m}: the start of the battle`);
    assert.deepEqual(env.input(), page.call('view', [start, 0]), `${m}: the input is the view of side 0`);
  }
});

test('the rewards of stage 2 do not change the environment of stage 1, so its artifacts stay compatible', () => {
  const envOf = values => {
    const { graph, ids } = instance();
    graph.patchConfig(ids.rewards, { values });
    return JSON.stringify(buildBundle(graph, ids.s1_a_trainer).env);
  };
  assert.equal(envOf({}), envOf({ win: 2, kill: 0.9, hurt: -0.5, step: 0.1 }));
});

// ---------------------------------------------------------------------------------------------- the battle
/** The 9 actions: move up, right, down, left; fire up, right, down, left; wait. */
const [UP, RIGHT, DOWN, LEFT, FIRE_UP, FIRE_RIGHT, FIRE_DOWN, FIRE_LEFT, WAIT] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
/** Map codes of the scene: 0 empty, 1 brick, 2 steel, 3 base, 4 water. */
const [BRICK, STEEL, BASE, WATER] = [1, 2, 3, 4];
/** The end reasons of a trail: a brick (gone), steel or the map edge, a base, a tank, mutual fire (both shells cancel). */
const [HIT_BRICK, HIT_STEEL, HIT_BASE, HIT_TANK, MUTUAL] = [1, 2, 3, 4, 5];
/** A tank on the map at [x, y] with 2 lives, not fired, with its start cell there; `more` overrides fields. */
const tank = ([x, y], more = {}) => ({ on: true, x, y, d: 0, lives: 2, fired: false, sx: x, sy: y, ...more });
/** The trail of a shell fired from [x, y] in direction d: it hits the n-th cell for the reason `why`. */
const trail = ([x, y], d, n, why) => ({ on: true, x, y, d, n, why });
const cellOf = (s, x, y) => s.cells[y * 9 + x];
/** The action `a` turned 180°: a move or a fire direction turns, wait stays. */
const turnAct = a => (a < 8 ? a - (a % 4) + ((a % 4) + 2) % 4 : a);
/** A fixed map for the position tests: the fixed part of the scene, and the random part as in revision 13. */
const LAYOUT = [
  0, 0, 0, 1, 3, 1, 0, 0, 0,
  0, 2, 0, 1, 1, 1, 0, 2, 0,
  0, 1, 0, 0, 1, 0, 0, 1, 0,
  4, 1, 0, 0, 1, 0, 0, 1, 4,
  4, 4, 2, 1, 2, 1, 2, 4, 4,
  4, 1, 0, 0, 1, 0, 0, 1, 4,
  0, 1, 0, 0, 1, 0, 0, 1, 0,
  0, 2, 0, 1, 1, 1, 0, 2, 0,
  0, 0, 0, 1, 3, 1, 0, 0, 0,
];
/** The cells of the random part of the map, by the cell of the top-left quarter that decides them. */
const QUARTER = [[0, 2], [1, 2], [2, 2], [3, 2], [1, 3], [2, 3], [3, 3]].map(([x, y]) => [[x, y], [8 - x, y], [8 - x, 8 - y], [x, 8 - y]].map(([a, b]) => b * 9 + a));
/** The state `s` on LAYOUT with `tanks` in place and the cells { 'x,y': code } changed. */
const place = (s, tanks, cells = {}) => {
  const map = [...LAYOUT];
  for (const [xy, v] of Object.entries(cells)) { const [x, y] = xy.split(',').map(Number); map[y * 9 + x] = v; }
  return { ...s, cells: map, tanks };
};
/** Whether every cell that a tank can enter (empty, or a brick that it can shoot away) is reachable from every other one. */
const connected = cells => {
  const free = c => cells[c] === 0 || cells[c] === BRICK, all = cells.map((_, c) => c).filter(free), seen = new Set([all[0]]), todo = [all[0]];
  while (todo.length) {
    const c = todo.pop(), x = c % 9, y = Math.floor(c / 9);
    for (const [a, b] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) if (a >= 0 && b >= 0 && a < 9 && b < 9 && free(b * 9 + a) && !seen.has(b * 9 + a)) { seen.add(b * 9 + a); todo.push(b * 9 + a); }
  }
  return seen.size === all.length;
};

/** Fixed models of 中 and 大, accepted in the stage 2 candidates that the networks of the battle read. */
const BATTLE_MODELS = { mid: fixedModel(INPUTS, [32, 32], ACTIONS, 11), big: fixedModel(INPUTS, [128, 128, 128], ACTIONS, 13) };
/**
 * The battle script of the template, with BATTLE_MODELS accepted. `calls()` gives the page side of its inputs over the
 * graph of the moment. `call(name, ...args)` calls one of them. `at(tanks, cells)` is the start of seed 1 with the
 * position in place (see `place`), and `step(s, a0, a1)` plays one step with both actions in the directions of the map.
 */
function arena(values = {}) {
  const { graph, ids } = instance();
  graph.patchConfig(ids.params, { values });
  const store = new Map();
  for (const [m, model, digit] of [['s2_a', BATTLE_MODELS.mid, '6'], ['s2_b', BATTLE_MODELS.big, '7']]) {
    const id = '0x' + digit.repeat(64);
    store.set(id, shapedArtifact(graph, ids[`${m}_net`], model));
    graph.patchConfig(ids[`${m}_cands`], { accepted: id });
  }
  const calls = () => scriptCalls(graph, graph.resolved(), ids.vs_battle, { artifacts: a => store.get(a) ?? null });
  const call = (name, ...args) => calls().call(name, args);
  const start = call('battle', { seed: 1 });
  return { graph, ids, calls, call, at: (tanks, cells) => place(start, tanks, cells), step: (s, a0, a1 = WAIT) => call('play', s, a0, turnAct(a1)) };
}
/** A tank or trail record turned 180° on the 9 × 9 map. A tank also turns its start cell. */
const rot = o => ({ ...o, x: 8 - o.x, y: 8 - o.y, d: (o.d + 2) % 4, ...('sx' in o ? { sx: 8 - o.sx, sy: 8 - o.sy } : {}) });
/** The battle state `s` as side 1 has it: the map turned 180°, and the two sides swap places. */
const turn = s => ({
  ...s,
  cells: s.cells.map((_, c) => s.cells[80 - c]),
  tanks: [rot(s.tanks[1]), rot(s.tanks[0])],
  trails: [rot(s.trails[1]), rot(s.trails[0])],
  bases: [s.bases[1], s.bases[0]],
  acts: [turnAct(s.acts[1]), turnAct(s.acts[0])],
  hits: [s.hits[1], s.hits[0]],
  end: s.end === 0 ? 1 : s.end === 1 ? 0 : s.end,
});
/** The state `s` with only `on` of a trail of a side that did not fire: the scene leaves its other fields unspecified. */
const quiet = s => ({ ...s, trails: s.trails.map(b => (b.on ? b : { on: false })) });

test('each battle starts on the map of its seed: the fixed part stays, the random part is symmetric, has at most 2 steel or water cells in its quarter and leaves every free cell reachable; each tank starts on its start cell of the seed', () => {
  const { call } = arena();
  const first = call('battle', { seed: 1 }), starts = [new Set(), new Set()], maps = new Set(), blocks = new Set();
  const random = new Set(QUARTER.flat());
  for (let seed = 1; seed <= 200; seed++) {
    const s = call('battle', { seed });
    assert.deepEqual(s, call('battle', { seed }), `seed ${seed}: the start repeats on the seed`);
    assert.deepEqual([s.bases, s.end, s.t, s.hits, s.acts, s.trails.map(b => b.on)], [[true, true], -1, 0, [false, false], [WAIT, WAIT], [false, false]], `seed ${seed}`);
    assert.deepEqual(s.cells.flatMap((v, c) => (random.has(c) || v === LAYOUT[c] ? [] : [c])), [], `seed ${seed}: the fixed part of the map`);
    assert.ok(s.cells.every((v, c) => v === s.cells[80 - c] && v === s.cells[Math.floor(c / 9) * 9 + 8 - (c % 9)]), `seed ${seed}: the map is the same after a turn of 180° and in a mirror`);
    const quarter = QUARTER.map(([c]) => s.cells[c]), hard = quarter.flatMap((v, k) => (v === STEEL || v === WATER ? [k] : []));
    assert.ok(quarter.every(v => [0, BRICK, STEEL, WATER].includes(v)) && hard.length <= 2 && !hard.includes(6), `seed ${seed}: at most 2 steel or water cells in the quarter, never in front of the passage (${quarter})`);
    assert.ok(connected(s.cells), `seed ${seed}: every free cell is reachable`);
    hard.forEach(k => blocks.add(`${k}:${quarter[k]}`)); maps.add(s.cells.join());
    const [a, b] = s.tanks;
    assert.deepEqual([a, b], [tank([a.x, a.y]), tank([b.x, b.y], { d: DOWN })], `seed ${seed}: 2 lives, not fired, the start cell under the tank`);
    assert.ok(a.y >= 7 && cellOf(s, a.x, a.y) === 0, `seed ${seed}: side 0 starts on a free cell of its two bottom rows`);
    assert.ok(b.y <= 1 && cellOf(s, b.x, b.y) === 0, `seed ${seed}: side 1 starts on a free cell of its two top rows`);
    starts[0].add(`${a.x},${a.y}`); starts[1].add(`${b.x},${b.y}`);
  }
  assert.ok(maps.size > 150, `the seeds give many maps (${maps.size} of 200)`);
  assert.equal(blocks.size, 12, 'steel and water both appear on each of the 6 cells that can hold them');
  assert.deepEqual(starts.map(c => c.size), [10, 10], 'the seeds give each side all 10 start cells');
  assert.deepEqual([...starts[1]].map(c => c.split(',').map(Number)).map(([x, y]) => `${8 - x},${8 - y}`).sort(), [...starts[0]].sort(), 'the start cells of side 1 are those of side 0 turned');
  const s = place(first, [tank([2, 5], { fired: true }), tank([6, 2], { lives: 1 })]);
  const bits = call('view', s, 0), map = k => bits.slice(k * 81, (k + 1) * 81), ones = v => v.flatMap((x, c) => (x ? [c] : []));
  assert.equal(bits.length, INPUTS, 'seven maps of 81 cells, then the five flags');
  assert.deepEqual(ones(map(0)), s.cells.flatMap((v, c) => (v === BRICK ? [c] : [])), 'bricks');
  assert.deepEqual(ones(map(1)), [10, 16, 38, 40, 42, 64, 70], 'steel');
  assert.deepEqual(ones(map(2)), [27, 35, 36, 37, 43, 44, 45, 53], 'water');
  assert.deepEqual(ones(map(3)), [8 * 9 + 4], 'the own base');
  assert.deepEqual(ones(map(4)), [4], 'the other base');
  assert.deepEqual(ones(map(5)), [5 * 9 + 2], 'the own tank');
  assert.deepEqual(ones(map(6)), [2 * 9 + 6], 'the other tank');
  assert.deepEqual(bits.slice(7 * 81), [1, 0, 1, 0, 1], 'own fired, other not; own lives 2, other 1; bias');
  const gone = call('view', { ...s, bases: [true, false], tanks: [s.tanks[0], { ...s.tanks[1], on: false, lives: 0 }] }, 0);
  assert.deepEqual([ones(gone.slice(4 * 81, 5 * 81)), ones(gone.slice(6 * 81, 7 * 81))], [[], []], 'a destroyed base and a tank off the map are not shown');
  assert.deepEqual(call('view', s, 1), call('view', turn(s), 0), 'side 1 sees what side 0 sees on the turned map');
  assert.deepEqual(call('view', s, 1).slice(7 * 81), [0, 1, 0, 1, 1], 'side 1: the flags of its own tank first');
});

test('the battle rules are the same for both sides: a turned battle plays the turned moves', () => {
  const { call } = arena();
  // fixed moves that walk, move into walls, fire and wait, as each side sees the map
  const moves = [[UP, UP], [FIRE_UP, FIRE_UP], [RIGHT, LEFT], [FIRE_LEFT, WAIT], [UP, FIRE_RIGHT], [LEFT, RIGHT], [FIRE_UP, FIRE_DOWN], [WAIT, UP], [DOWN, FIRE_LEFT]];
  for (const seed of [1, 4, 9]) {
    let s = call('battle', { seed }), k = 0;
    while (s.end < 0 && k < 40) {
      const [a, b] = moves[(k * 5 + seed) % moves.length];
      const next = call('play', s, a, b);
      assert.deepEqual(quiet(call('play', turn(s), b, a)), quiet(turn(next)), `seed ${seed}, step ${k}`);
      assert.deepEqual(call('view', next, 1), call('view', turn(next), 0), `seed ${seed}, step ${k}`);
      s = next; k++;
    }
  }
});

test('a move into a brick, steel, water, the edge or a tank is a wait, and two tanks can enter one empty cell and overlap', () => {
  const { at, step } = arena();
  const foe = tank([6, 1], { d: DOWN });
  const moved = (s, a) => { const n = step(s, a); return [n.acts[0], n.tanks[0].x, n.tanks[0].y]; };
  assert.deepEqual(moved(at([tank([2, 2]), foe]), LEFT), [WAIT, 2, 2], 'a brick at (1,2)');
  assert.deepEqual(moved(at([tank([0, 1]), foe]), RIGHT), [WAIT, 0, 1], 'steel at (1,1)');
  assert.deepEqual(moved(at([tank([0, 2]), foe]), DOWN), [WAIT, 0, 2], 'water at (0,3)');
  assert.deepEqual(moved(at([tank([0, 2]), foe]), LEFT), [WAIT, 0, 2], 'the map edge');
  assert.deepEqual(moved(at([tank([2, 2]), tank([2, 3])]), DOWN), [WAIT, 2, 2], 'the other tank at (2,3)');
  assert.deepEqual(moved(at([tank([2, 2]), foe]), RIGHT), [RIGHT, 3, 2], 'a free cell');
  const both = step(at([tank([2, 2]), tank([3, 3])]), RIGHT, UP);
  assert.deepEqual([both.acts, both.tanks.map(t => [t.x, t.y, t.d])], [[RIGHT, UP], [[3, 2, RIGHT], [3, 2, UP]]], 'both tanks go into (3,2)');
  for (const a of [FIRE_UP, FIRE_RIGHT, FIRE_DOWN, FIRE_LEFT]) {
    const fired = step(both, a, turnAct(a));
    assert.deepEqual([fired.hits, fired.tanks.map(t => t.lives), fired.trails.map(b => b.why === HIT_TANK)], [[false, false], [2, 2], [false, false]], `overlapping tanks cannot hit each other: ${a}`);
  }
  const apart = step(both, LEFT, RIGHT);
  assert.deepEqual([apart.acts, apart.tanks.map(t => [t.x, t.y])], [[LEFT, WAIT], [[2, 2], [3, 2]]], 'from the shared cell, side 0 leaves and the move of side 1 into the brick (4,2) is a wait');
});

test('a shell is an instant ray: it hits the first cell that is not empty or water, destroys a brick or a base, and moves resolve before fires', () => {
  const { at, step } = arena();
  const foe = tank([6, 1], { d: DOWN });
  const steel = step(at([tank([2, 2]), foe]), FIRE_DOWN);
  assert.deepEqual([cellOf(steel, 2, 4), steel.trails[0], steel.tanks[0].fired], [STEEL, trail([2, 2], DOWN, 2, HIT_STEEL), true], 'steel at (2,4) stays');
  const edge = step(at([tank([0, 2]), foe]), FIRE_LEFT);
  assert.deepEqual(edge.trails[0], trail([0, 2], LEFT, 1, HIT_STEEL), 'the map edge stops the shell as steel does');
  const water = step(at([tank([0, 2]), tank([0, 6])]), FIRE_DOWN);
  assert.deepEqual([water.trails[0], water.hits, [3, 4, 5].map(y => cellOf(water, 0, y))], [trail([0, 2], DOWN, 4, HIT_TANK), [false, true], [WATER, WATER, WATER]], 'the shell passes over the water to the tank');
  const brick = step(at([tank([2, 2]), foe]), FIRE_LEFT);
  assert.deepEqual([cellOf(brick, 1, 2), brick.trails[0]], [0, trail([2, 2], LEFT, 1, HIT_BRICK)], 'the brick at (1,2) is destroyed');
  // from (2,0), the brick (3,0) hides the base of side 1 at (4,0)
  const dig = step(at([tank([2, 0]), foe]), FIRE_RIGHT);
  assert.deepEqual([cellOf(dig, 3, 0), dig.bases, dig.tanks[0].fired], [0, [true, true], true]);
  const cool = step(dig, FIRE_RIGHT);
  assert.deepEqual([cool.acts[0], cool.trails[0].on, cool.tanks[0].fired, cool.bases], [WAIT, false, false, [true, true]], 'fire right after fire is a wait, and the cooldown ends');
  const base = step(cool, FIRE_RIGHT);
  assert.deepEqual([cellOf(base, 4, 0), base.bases, base.end, base.trails[0]], [0, [true, false], 0, trail([2, 0], RIGHT, 2, HIT_BASE)], 'the next shell destroys the base: side 0 wins');
  assert.equal(step(dig, RIGHT).acts[0], RIGHT, 'a move right after fire is no wait');
  // the ray of side 0 from (2,2) goes right along row 2 to the brick (4,2)
  const out = step(at([tank([2, 2]), tank([3, 2])]), FIRE_RIGHT, DOWN);
  assert.deepEqual([out.hits, out.tanks[1].y, out.trails[0]], [[false, false], 3, trail([2, 2], RIGHT, 2, HIT_BRICK)], 'the tank steps out of the ray before the shell flies');
  const into = step(at([tank([2, 2]), tank([3, 3])]), FIRE_RIGHT, UP);
  assert.deepEqual([into.hits, into.trails[0]], [[false, true], trail([2, 2], RIGHT, 1, HIT_TANK)], 'the tank steps into the ray before the shell flies');
});

test('mutual fire cancels both shells and neither side counts as fired, the next step each side makes a random move or wait of its seed, and a one-sided hit lands', () => {
  const { at, step } = arena();
  const face = at([tank([2, 2]), tank([3, 2])]);
  const mutual = step(face, FIRE_RIGHT, FIRE_LEFT);
  assert.deepEqual([mutual.hits, mutual.tanks.map(t => [t.lives, t.fired]), mutual.acts], [[false, false], [[2, false], [2, false]], [FIRE_RIGHT, FIRE_LEFT]], 'both shells cancel, and the acts still show the fires');
  assert.deepEqual(mutual.trails, [trail([2, 2], RIGHT, 1, MUTUAL), trail([3, 2], LEFT, 1, MUTUAL)], 'the trails show the mutual fire');
  const jolts = Array.from({ length: 20 }, (_, k) => step({ ...mutual, seed: k + 1 }, FIRE_RIGHT, FIRE_LEFT));
  for (const j of jolts) {
    assert.ok(j.acts.every(a => a < 4 || a === WAIT) && j.trails.every(b => !b.on), `seed ${j.seed}: no fire, each side moves or waits (${j.acts})`);
    assert.deepEqual(step({ ...mutual, seed: j.seed }, WAIT, WAIT), j, `seed ${j.seed}: the random step ignores the actions and repeats on its seed`);
  }
  assert.ok(new Set(jolts.map(j => j.acts.join())).size > 3, 'the random step differs between seeds');
  assert.deepEqual(step(jolts[0], WAIT, WAIT).acts, [WAIT, WAIT], 'after the random step, each side takes its own action again');
  const one = step(face, FIRE_RIGHT, WAIT);
  assert.deepEqual([one.hits, one.tanks.map(t => [t.lives, t.fired])], [[false, true], [[2, true], [1, false]]], 'one side fires: the other is hit');
  // side 1 fires up into the brick (3,1), so its ray does not reach side 0: no mutual fire
  const miss = step(face, FIRE_RIGHT, FIRE_UP);
  assert.deepEqual([miss.hits, miss.tanks[0].fired, cellOf(miss, 3, 1), miss.trails[1]], [[false, true], true, 0, trail([3, 2], UP, 1, HIT_BRICK)], 'both fire, but only one ray hits a tank: both shells fly');
});

test('a hit costs a life and respawns the tank at its start cell; the second hit, a destroyed base or the steps end the battle', () => {
  const { at, step } = arena({ steps: 3 });
  const hit = step(at([tank([2, 2]), tank([3, 2], { sx: 6, sy: 1 })]), FIRE_RIGHT);
  assert.deepEqual([hit.hits, hit.tanks[1], hit.end], [[false, true], tank([6, 1], { d: DOWN, lives: 1, sx: 6, sy: 1 }), -1], 'the tank is back at its start cell with 1 life');
  assert.equal(step(hit, WAIT, FIRE_DOWN).acts[1], FIRE_DOWN, 'the respawned tank acts in the next step');
  const dead = step(at([tank([2, 2]), tank([3, 2], { sx: 6, sy: 1, lives: 1 })]), FIRE_RIGHT);
  assert.deepEqual([dead.hits, dead.tanks[1].on, dead.tanks[1].lives, dead.end], [[false, true], false, 0, 0], 'the second hit: side 0 wins');
  // side 0 at (2,8) with the brick (3,8) gone sees its own base at (4,8)
  const own = step(at([tank([2, 8]), tank([6, 1])], { '3,8': 0 }), FIRE_RIGHT);
  assert.deepEqual([own.bases, own.end], [[false, true], 1], 'a shell into the own base loses');
  // side 1 at (2,8) destroys the base of side 0 while side 0 from (2,6) hits its last life
  const both = step(at([tank([2, 6]), tank([2, 8], { lives: 1 })], { '3,8': 0 }), FIRE_DOWN, FIRE_RIGHT);
  assert.deepEqual([both.bases, both.hits, both.tanks[1].on, both.end], [[false, true], [false, true], false, 2], 'both sides lose in one step: a draw');
  let s = at([tank([2, 2]), tank([6, 6])]);
  for (let k = 0; k < 3; k++) { assert.equal(s.end, -1, `step ${k}: running`); s = step(s, WAIT, WAIT); }
  assert.deepEqual([s.t, s.end], [3, 2], 'out of steps: a draw');
});

// ---------------------------------------------------------------------------------------------- the training step and the bot
/**
 * The loop of stage 1 for 中 with `values` in the parameters: its runner, its teacher and its bundle. The network is
 * side 0, the bot side 1. `at(tanks, cells)` resets on seed 1 and puts the position on the state (see `place`).
 */
function scene(values = {}) {
  const { graph, ids } = instance();
  graph.patchConfig(ids.params, { values });
  const bundle = buildBundle(graph, ids.s1_a_trainer);
  const env = createEnv(bundle.env);
  const at = (tanks, cells = {}) => { env.reset({ seed: 1 }); env.state = place(env.state, tanks, cells); return env.state; };
  return { graph, ids, bundle, env, at, teacher: compileEntry(bundle.objective, [bundle.env.types.State], 'teacher') };
}
/** The teacher at each level: `masks(tanks, cells)` gives its 9 target bits for levels 1, 2 and 3. */
const teachers = () => {
  const levels = LEVELS.map(teacherLevel => scene({ teacherLevel }));
  return (tanks, cells) => levels.map(({ at, teacher }) => teacher(at(tanks, cells)));
};
/** The 9 target bits with the slots `on` set. */
const slots = (...on) => Array.from({ length: ACTIONS }, (_, a) => (on.includes(a) ? 1 : 0));
/** The same bits for each of the 3 levels. */
const all = bits => LEVELS.map(() => bits);
/** A tank of side 1 far from the action, on its own start row. */
const FAR = tank([8, 0], { d: DOWN });

test('at each level, the teacher fires at the base of the bot on a clear ray, and digs toward it from the lane of the base', () => {
  const masks = teachers();
  // from (2,0), the brick (3,0) hides the base at (4,0)
  assert.deepEqual(masks([tank([2, 0]), FAR], { '3,0': 0 }), all(slots(FIRE_RIGHT)), 'the base on a clear ray');
  assert.deepEqual(masks([tank([2, 0]), FAR]), all(slots(FIRE_RIGHT)), 'the brick before the base');
  assert.deepEqual(masks([tank([0, 0]), FAR]), all(slots(FIRE_RIGHT)), 'from the end of the row too');
  assert.deepEqual(masks([tank([2, 0], { fired: true }), FAR], { '3,0': 0 }).map(m => m[FIRE_RIGHT]), [0, 0, 0], 'not during the cooldown');
});

test('at each level, the teacher never fires along the lane of its own base', () => {
  const masks = teachers();
  // the tank of the bot at (2,8) is a direct hit from (1,8), but our base (4,8) is behind it on row 8
  assert.deepEqual(masks([tank([1, 8]), tank([2, 8])]).map(m => m[FIRE_RIGHT]), [0, 0, 0]);
  assert.deepEqual(masks([tank([2, 8]), tank([3, 8])], { '3,8': 0 }).map(m => m[FIRE_RIGHT]), [0, 0, 0], 'with the brick (3,8) gone too');
  assert.deepEqual(masks([tank([2, 2]), tank([3, 2])]).map(m => m[FIRE_RIGHT]), [1, 1, 1], 'away from the lane, the tank is a target');
});

test('the medium and hard teachers do not step into the clear ray of an armed bot, and dodge or counter-fire when in it; the easy teacher steps in', () => {
  const masks = teachers();
  // the bot at (3,2) fires left along row 2 and down along column 3. Our tank at (2,3) has (2,2) above and (3,3) to the
  // right in its rays, a brick to the left and steel below.
  const [easy, medium, hard] = masks([tank([2, 3]), tank([3, 2])]);
  assert.deepEqual(easy, slots(UP, RIGHT), 'the easy teacher walks into the rays');
  assert.deepEqual([medium, hard].map(m => [m[UP], m[RIGHT]]), [[0, 0], [0, 0]]);
  assert.deepEqual(masks([tank([2, 3]), tank([3, 2], { fired: true })]).map(m => m[UP] || m[RIGHT]), [1, 1, 1], 'a bot that cannot fire has no ray');
  // our tank at (3,3) is in the ray of the bot at (3,2): (2,3) to the left is safe
  assert.deepEqual(masks([tank([3, 3]), tank([3, 2])]), [slots(FIRE_UP), slots(LEFT, FIRE_UP), slots(LEFT, FIRE_UP)], 'dodge or counter-fire');
  assert.deepEqual(masks([tank([3, 3], { fired: true }), tank([3, 2])]).slice(1), [slots(LEFT), slots(LEFT)], 'only the dodge during the cooldown');
});

test('the easy teacher hunts the tank, the medium and hard teachers attack the base and hunt a bot that is nearer to our base', () => {
  const masks = teachers();
  // the bot at (6,8) stands on the lane of our base (row 8). From (2,2), the way to its base is 2 steps.
  assert.deepEqual(masks([tank([2, 2]), tank([6, 8])]), all(slots(RIGHT, DOWN)));
  // the bot at (6,6) needs as many steps to our lane as we do, so the medium and hard teachers attack. The easy teacher
  // still hunts the tank. The medium teacher counts the brick lane cell (4,2) as 1 step, so up to (2,0) and right to
  // (4,2) are equally near. The hard teacher counts the time to dig: (2,0) has 1 brick before the base, and (4,2) is a
  // brick with 1 brick before the base, so it only goes up.
  assert.deepEqual(masks([tank([2, 2]), tank([6, 6])]), [slots(RIGHT, DOWN), slots(UP, RIGHT), slots(UP)]);
});

test('the hard teacher blocks a direct shot at its base and holds there, while the medium teacher does not', () => {
  const masks = teachers();
  // with the brick (3,8) gone, the bot at (1,8) sees our base (4,8). From (2,7), down to (2,8) is between them.
  const [easy, medium, hard] = masks([tank([2, 7]), tank([1, 8])], { '3,8': 0 });
  assert.deepEqual(hard, slots(DOWN), 'the hard teacher steps between');
  assert.equal(medium[DOWN], 0, 'the medium teacher does not step into the ray');
  assert.equal(easy[DOWN], 1);
  assert.deepEqual(masks([tank([2, 7]), tank([1, 8], { fired: true })], { '3,8': 0 }).map(m => m[DOWN]), [1, 1, 1], 'nothing to block from a bot that cannot fire');
  // between the bot at (0,8) and our base, the hard teacher counter-fires or waits; the medium teacher dodges up
  assert.deepEqual(masks([tank([2, 8]), tank([0, 8])], { '3,8': 0 }), [slots(FIRE_LEFT), slots(UP, FIRE_LEFT), slots(FIRE_LEFT)]);
  assert.deepEqual(masks([tank([2, 8], { fired: true }), tank([0, 8])], { '3,8': 0 }).slice(1), [slots(UP), slots(WAIT)], 'during the cooldown');
});

/** The action of the bot in the step after `state` when our tank waits, in the directions of the map. It steps `env` once. */
const botMove = (env, state) => { env.reset({ seed: state.seed }); env.state = state; return env.step(WAIT).next.acts[1]; };

test('at each level, the bot of side 1 plays the rules of the teacher on the turned map', () => {
  for (const level of LEVELS) {
    const { bundle, env, teacher } = scene({ teacherLevel: level, botLevel: level, botRandom: 0 });
    const probe = createEnv(bundle.env);
    for (let seed = 1; seed <= 12; seed++) {
      let s = env.reset({ seed }), tr;
      do {
        const bot = botMove(probe, s), mask = teacher(turn(s));
        if (s.trails[0].why === MUTUAL) { tr = env.step(WAIT); s = tr.next; continue; }   // the random step after a mutual fire
        assert.equal(mask[turnAct(bot)], 1, `level ${level}, seed ${seed}, step ${s.t}: the bot takes an action that the teacher marks`);
        tr = env.step(teacher(s).indexOf(1)); s = tr.next;
      } while (!tr.done && s.t < 40);
    }
  }
});

test('in the training step, the bot of side 1 plays at params.botLevel', () => {
  // the position of the ray test, turned: the bot at (6,5) has the cells (6,6) and (5,5) in the rays of our tank at (5,6).
  // The medium and hard bots fire at the brick (7,5) to go around instead.
  const moves = LEVELS.map(level => { const { env, at } = scene({ botLevel: level, botRandom: 0 }); at([tank([5, 6]), tank([6, 5], { d: DOWN })]); return env.step(WAIT).next.acts[1]; });
  assert.ok([DOWN, LEFT].includes(moves[0]), `the easy bot steps into a ray: ${moves[0]}`);
  assert.deepEqual(moves.slice(1), [FIRE_RIGHT, FIRE_RIGHT], 'the medium and hard bots do not');
});

test('in the training step, success is the base or the last life of the bot, a loss or a draw is not, and the bot beats a tank that only waits', () => {
  const { env, at } = scene({ botRandom: 0, steps: 2 });
  at([tank([2, 0]), tank([6, 6])], { '3,0': 0 });
  const win = env.step(FIRE_RIGHT);
  assert.deepEqual([win.next.bases, win.next.end, win.done, win.success], [[true, false], 0, true, true], 'the base of the bot');
  // the bot at (0,6) cannot fire back, and its only free neighbour (0,7) is in our ray down column 0
  at([tank([0, 2]), tank([0, 6], { d: DOWN, lives: 1, fired: true })]);
  const kill = env.step(FIRE_DOWN);
  assert.deepEqual([kill.next.tanks[1].on, kill.next.end, kill.done, kill.success], [false, 0, true, true], 'the last life of the bot');
  at([tank([2, 8]), tank([6, 6])], { '3,8': 0 });
  const lose = env.step(FIRE_RIGHT);
  assert.deepEqual([lose.next.bases, lose.next.end, lose.done, lose.success], [[false, true], 1, true, false], 'our base');
  at([tank([2, 2]), tank([6, 6])]);
  env.step(WAIT);
  const draw = env.step(WAIT);
  assert.deepEqual([draw.next.t, draw.next.end, draw.done, draw.truncated, draw.success], [2, 2, true, false, false], 'out of steps: a draw, not a truncation');
  for (const level of LEVELS) {
    const { env } = scene({ botLevel: level, botRandom: 0 });
    for (let seed = 1; seed <= 10; seed++) {
      let tr;
      env.reset({ seed });
      do tr = env.step(WAIT); while (!tr.done);
      assert.equal(tr.next.end, 1, `level ${level}, seed ${seed}: our side loses`);
    }
  }
});

test('the random actions of the bot repeat on the seed', () => {
  const noisy = scene({ botRandom: 1 }).env, moves = seed => { noisy.reset({ seed }); return Array.from({ length: 10 }, () => noisy.step(WAIT).next.acts[1]); };
  const once = moves(3);
  assert.deepEqual(moves(3), once, 'the same seed gives the same random actions');
  assert.ok(new Set(once).size > 2, 'botRandom 1: the actions are random');
  assert.notDeepEqual(moves(4), once, 'another seed gives other actions');
});

/** A Transition from `prev` to `next` with the action `action`. */
const transition = (prev, next, action = WAIT) => ({ prev, action, next, done: next.end >= 0, truncated: false, success: next.end === 0 });

test('the reward of stage 2 gives win, lose or nothing for the end, kill and hurt for the hits, and each step costs step', () => {
  const { graph, ids } = instance();
  graph.patchConfig(ids.rewards, { values: { win: 2, lose: -1.5, kill: 0.3, hurt: -0.4, step: 0.01 } });
  const id = '0x' + '8'.repeat(64), artifact = shapedArtifact(graph, ids.s1_a_net, fixedModel(INPUTS, [32, 32], ACTIONS, 5));
  graph.patchConfig(ids.s1_a_cands, { accepted: id });
  const bundle = buildBundle(graph, ids.s2_a_trainer, { artifacts: a => (a === id ? artifact : null) });
  const reward = compileEntry(bundle.objective, [bundle.env.types.Transition], 'reward');
  const env = createEnv(bundle.env), s = env.reset({ seed: 1 });
  const close = (got, want, why) => assert.ok(Math.abs(got - want) < 1e-12, `${why}: ${got}`);
  const next = (end, hits = [false, false]) => ({ ...s, end, hits });
  close(reward(transition(s, next(-1))), -0.01, 'a step');
  close(reward(transition(s, next(-1, [false, true]))), 0.3 - 0.01, 'the bot tank is hit');
  close(reward(transition(s, next(-1, [true, false]))), -0.4 - 0.01, 'our tank is hit');
  close(reward(transition(s, next(-1, [true, true]))), 0.3 - 0.4 - 0.01, 'both are hit');
  close(reward(transition(s, next(0))), 2 - 0.01, 'a win');
  close(reward(transition(s, next(0, [false, true]))), 2 + 0.3 - 0.01, 'a win by the last life of the bot');
  close(reward(transition(s, next(1))), -1.5 - 0.01, 'a loss');
  close(reward(transition(s, next(2))), -0.01, 'a draw');
});

test('the metrics: 和教师一致的比例 is the share of steps where our tank took an action that the teacher marks, and the duel metrics read the final state', () => {
  const { graph, ids, bundle, env, teacher } = scene();
  const id = '0x' + '3'.repeat(64), artifact = shapedArtifact(graph, ids.s1_a_net, fixedModel(INPUTS, [32, 32], ACTIONS, 5));
  graph.patchConfig(ids.s1_a_cands, { accepted: id });
  const evaluator = buildBundle(graph, ids.s1_a_evaluator, { artifacts: a => (a === id ? artifact : null) });
  const agreement = compileEntry(evaluator.objective, [bundle.env.types.Transition], 'agreement');
  const metric = (title, name) => compileEntry(evaluator.metrics.find(m => m.name === title), [episodeType(bundle.env.types.State)], name);
  const agreeRate = metric('和教师一致的比例', 'agreeRate');
  /** Plays seed 4 with `choose(mask)` for our tank. Returns agreeRate of the episode, with the evaluator's return, and the steps that the teacher marks. */
  const play = choose => {
    let s = env.reset({ seed: 4 }), marked = 0, ret = 0, tr;
    do { const mask = teacher(s), a = choose(mask); marked += mask[a]; tr = env.step(a); ret += agreement(tr); s = tr.next; } while (!tr.done);
    return { rate: agreeRate({ initial: tr.prev, final: s, steps: s.t, success: tr.success, return: ret }), marked, t: s.t };
  };
  assert.equal(play(mask => mask.indexOf(1)).rate, 1, 'our tank follows the teacher');
  const waits = play(() => WAIT);
  assert.ok(waits.marked < waits.t, 'the teacher does not mark wait on each step');
  assert.equal(waits.rate, waits.marked / waits.t);
  const [winRate, killRate, hitRate, drawRate] = [['胜率', 'winRate'], ['击毁对方坦克的比例', 'killRate'], ['我方坦克被击中的比例', 'hitRate'], ['平局的比例', 'drawRate']].map(m => metric(...m));
  const start = env.reset({ seed: 1 });
  const episode = (end, lives) => ({ initial: start, final: { ...start, end, tanks: start.tanks.map((t, k) => ({ ...t, lives: lives[k], on: lives[k] > 0 })) }, steps: 5, success: end === 0, return: 0 });
  const rates = (end, lives) => [winRate, killRate, hitRate, drawRate].map(f => f(episode(end, lives)));
  assert.deepEqual(rates(0, [2, 0]), [1, 1, 0, 0], 'a win on the last life of the bot');
  assert.deepEqual(rates(0, [1, 2]), [1, 0, 1, 0], 'a win on its base, after one hit on our tank');
  assert.deepEqual(rates(1, [2, 1]), [0, 1, 0, 0], 'a loss, after one hit on the bot');
  assert.deepEqual(rates(2, [1, 1]), [0, 1, 1, 1], 'a draw');
  assert.deepEqual(rates(2, [2, 2]), [0, 0, 0, 1], 'a draw with no hit');
});

// ---------------------------------------------------------------------------------------------- the battle script
/** The file `name` of the battle script, loaded as a module (game.js imports nothing). */
const scriptFile = (graph, ids, name) => import(`data:text/javascript,${encodeURIComponent(graph.node(ids.vs_battle).config.files.find(f => f.name === name).source)}`);
/** The function inputs of the battle script as the sandbox gives them to the script: `call.<name>(…args)` → a promise. */
const ctxCall = page => Object.fromEntries(page.functions.map(name => [name, async (...args) => page.call(name, args)]));
/** A network that runs `model` directly: input bits → the action of the first maximum score. */
const policy = model => {
  const ex = createExecutor(model);
  return bits => { const o = ex.step(bits).scores; return o.indexOf(Math.max(...o)); };
};
/** A battle on `seed` with the scene functions called one by one and the policies `red` and `blue` run directly. */
function directBattle(call, red, blue, seed) {
  let s = call('battle', { seed });
  const moves = [];
  while (s.end < 0) {
    moves.push([red(call('view', s, 0)), blue(call('view', s, 1))]);
    s = call('play', s, ...moves.at(-1));
  }
  return { state: s, moves };
}

test('a battle through the script equals the scene functions and the networks called directly', async () => {
  const { graph, ids, calls, call } = arena();
  const { fight } = await scriptFile(graph, ids, 'game.js');
  const [mid, big] = [policy(BATTLE_MODELS.mid), policy(BATTLE_MODELS.big)];
  for (const seed of [1, 2]) {
    const shown = [];
    const { state, log } = await fight(ctxCall(calls()), { seed, show: (s, entry) => shown.push(entry) });
    const direct = directBattle(call, mid, big, seed);
    assert.deepEqual(state, direct.state, `seed ${seed}`);
    assert.deepEqual(log.map(e => e.moves), direct.moves, `seed ${seed}: the moves`);
    assert.deepEqual(shown, [null, ...log], `seed ${seed}: the script shows the start and each step`);
  }
});

test('swapping the wires of 红方 and 蓝方 swaps the seats of the networks', async () => {
  const { graph, ids, calls, call } = arena();
  const { fight } = await scriptFile(graph, ids, 'game.js');
  const [mid, big] = [policy(BATTLE_MODELS.mid), policy(BATTLE_MODELS.big)];
  const bits = call('view', call('battle', { seed: 3 }), 0);
  const seat = name => calls().call(name, [bits]).indexOf(1);
  assert.notEqual(mid(bits), big(bits), 'the two models choose differently here, so a swap shows');
  assert.deepEqual([seat('红方'), seat('蓝方')], [mid(bits), big(bits)]);
  const wires = [...graph.wires.values()].filter(w => w.to.node === ids.vs_battle && ['红方', '蓝方'].includes(w.to.port));
  for (const w of wires) graph.disconnect(w.id);
  for (const w of wires) graph.connect({ kind: 'call', from: w.from, to: { node: w.to.node, port: w.to.port === '红方' ? '蓝方' : '红方' } });
  assert.deepEqual([seat('红方'), seat('蓝方')], [big(bits), mid(bits)]);
  const { state } = await fight(ctxCall(calls()), { seed: 1 });
  assert.deepEqual(state, directBattle(call, big, mid, 1).state, 'a whole battle with 大 as 红方');
});

test('a battle repeats on its seed', async () => {
  const { graph, ids, calls } = arena();
  const { fight } = await scriptFile(graph, ids, 'game.js');
  const play = async seed => (await fight(ctxCall(calls()), { seed })).log;
  assert.deepEqual(await play(5), await play(5));
});

test('蓝方 can be the bot of each level: through the script, it takes an action that the teacher of that level marks', async () => {
  const { graph, ids, calls } = arena();
  const { fight, names } = await scriptFile(graph, ids, 'game.js');
  for (const level of LEVELS) {
    const { teacher } = scene({ teacherLevel: level });
    assert.deepEqual(names(level), ['红方', `蓝方（${['简单', '中等', '困难'][level - 1]}机器人）`]);
    for (const seed of [1, 2, 3]) {
      const states = [];
      const { log } = await fight(ctxCall(calls()), { seed, opponent: level, show: s => states.push(s) });
      // the move of 蓝方 is on its own map, that is, the map of side 0 in the turned battle
      log.forEach((e, i) => assert.equal(teacher(turn(states[i]))[e.moves[1]], 1, `level ${level}, seed ${seed}, step ${e.t}`));
    }
  }
});

test('the battle calls the networks on the stage 2 candidates and the scene that the loops run, and 整理 puts it after stage 2', () => {
  const { graph, ids, groupIds, group, nodes } = instance();
  const from = port => graph.producers(ids.vs_battle, port).map(p => [p.node, p.port]);
  assert.deepEqual(['battle', 'view', 'play', '机器人'].map(from), [[[ids.scene, 'battle']], [[ids.scene, 'view']], [[ids.scene, 'play']], [[ids.scene, 'botMove']]]);
  assert.deepEqual([from('红方'), from('蓝方')], [[[ids.vs_mid_readout, 'run']], [[ids.vs_big_readout, 'run']]]);
  assert.deepEqual(from('设置'), [[ids.vs_settings, 'params']], 'the settings choose 蓝方');
  for (const [net, cands, of] of [['vs_mid_net', 's2_a_cands', 's2_a_net'], ['vs_big_net', 's2_b_cands', 's2_b_net']]) {
    assert.deepEqual(graph.producers(ids[net], 'weights').map(p => [p.node, p.port]), [[ids[cands], 'weights']], net);
    assert.deepEqual(graph.node(ids[net]).config, graph.node(ids[of]).config, `${net}: the structure of ${of}`);
  }
  for (const id of [group.id, ...Object.values(groupIds)]) graph.setGroupLayout(id, { collapsed: false });
  for (const aspect of [16 / 9, 4 / 3, 21 / 9]) {
    const geo = canvasGeometry({ graph: () => graph, measured: () => undefined, aspect: () => aspect, columns: sectionColumns() });
    for (const m of geo.arrange(nodes.map(n => n.id))?.moves ?? []) {
      if (graph.groups.has(m.id)) graph.setGroupLayout(m.id, { x: m.x, y: m.y }); else graph.moveNode(m.id, m.x, m.y);
    }
    const battle = geo.rect(ids.vs_battle);
    for (const m of STAGE2) {
      const s2 = geo.rect(groupIds[m]);
      assert.ok(battle.x >= s2.x + s2.w || battle.y >= s2.y + s2.h, `${aspect}: the battle comes after ${m}`);
    }
  }
});
