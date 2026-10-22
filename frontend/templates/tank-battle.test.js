// templates/tank-battle.test.js — the tank battle template: a Battle City level. It instantiates with only the problems
// of candidates that accepted nothing yet. It has four training modules, each with one trainer and its loop (ADR 0020).
// In stage 1, 中 and 大 learn the teacher of one shared scene. In stage 2, each structure continues from its stage 1
// candidates by REINFORCE on the battle reward of the scene, behind a gate on its stage 1 report. Its script module
// 坦克对战 plays the two stage 2 networks against each other on the battle of the same scene.
//
// The rules of the level run through the runner on fixed seeds. A test that needs a given position resets the runner,
// then puts the tanks and bullets in place on the runner's state. The teacher runs as the trainers call it. The rules of
// the battle run through the calls of the script module, as the script calls them.
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
/** The same structures in stage 2 (the battle map against the bot). */
const STAGE2 = ['s2_a', 's2_b'];
/** The metrics of each stage 1 evaluator, by the titles that its report shows. */
const METRICS = ['过关率', '平均击毁数', '基地保住的比例', '和教师一致的比例'];
/** The metrics of each stage 2 evaluator. */
const DUEL_METRICS = ['胜率', '击毁对方坦克的比例', '我方坦克被击中的比例', '超时的比例'];

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
  const metrics = [...graph.nodes.values()].filter(n => [...METRICS, ...DUEL_METRICS].includes(n.title));
  assert.equal(metrics.length, METRICS.length + DUEL_METRICS.length);
  for (const n of metrics) assert.equal(graph.parentOf(n.id).id, group.id, `${n.title} sits outside the training modules`);
});

test('in stage 1, 中 and 大 learn the teacher of one shared scene', () => {
  const { graph, ids, group } = instance();
  assert.deepEqual(STRUCTURES.map(m => graph.node(ids[`${m}_net`]).config.layers.map(L => L.hidden)), [[32, 32], [128, 128, 128]]);
  assert.equal(graph.parentOf(ids.scene).id, group.id, 'the scene sits outside the training module');
  assert.deepEqual(graph.consumers(ids.scene, 'module').map(c => c.node).sort(), [...STRUCTURES, ...STAGE2].map(m => ids[`${m}_loop`]).sort(), 'one scene for all loops');
  for (const m of STRUCTURES) {
    const trainer = graph.node(ids[`${m}_trainer`]);
    assert.equal(trainer.config.method, 'cross-entropy', m);
    assert.deepEqual([graph.producers(trainer.id, 'init'), graph.producers(trainer.id, 'gate')], [[], []], `${m}: stage 1 starts from random weights`);
    assert.deepEqual(graph.producers(trainer.id, 'objective').map(p => [p.node, p.port]), [[ids.scene, 'teacher']], m);
    assert.deepEqual(graph.producers(ids[`${m}_evaluator`], 'metrics').map(p => graph.node(p.node).title).sort(), [...METRICS].sort(), `${m}: evaluator`);
    const env = createEnv(buildBundle(graph, trainer.id).env);
    env.reset({ seed: 1 });
    assert.equal(env.input().length, graph.node(ids[`${m}_net`]).config.inputs, `${m}: the network reads all input bits of the scene`);
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

test('stage 2 continues each structure from its stage 1 candidates on the battle map, gated on its stage 1 report', () => {
  const { graph, ids } = instance();
  for (const [m, from, hidden] of [['s2_a', 's1_a', [32, 32]], ['s2_b', 's1_b', [128, 128, 128]]]) {
    const trainer = graph.node(ids[`${m}_trainer`]), wired = port => graph.producers(trainer.id, port).map(p => [p.node, p.port]);
    assert.equal(trainer.config.method, 'reinforce', m);
    assert.deepEqual(graph.node(ids[`${m}_net`]).config.layers.map(L => L.hidden), hidden, `${m}: the structure of ${from}`);
    assert.deepEqual(wired('objective'), [[ids.scene, 'duelReward']], `${m}: the battle reward of the scene`);
    assert.deepEqual(wired('init'), [[ids[`${from}_cands`], 'weights']], `${m}: init`);
    assert.deepEqual(wired('gate'), [[ids[`${from}_evaluator`], 'report']], `${m}: gate`);
    assert.deepEqual(graph.producers(ids[`${m}_evaluator`], 'metrics').map(p => graph.node(p.node).title).sort(), [...DUEL_METRICS].sort(), `${m}: evaluator`);

    // the condition: 和教师一致的比例 of the stage 1 report is at least 0.9
    const evaluation = mean => ({ stale: false, report: { metrics: { 和教师一致的比例: { mean } } } });
    assert.ok(METRICS.includes(trainer.config.gate.metric), `${m}: the gate reads a metric of the stage 1 evaluator`);
    assert.deepEqual([0.89, 0.9, 0.95].map(v => gateStatus(trainer.config.gate, evaluation(v), 'e').passed), [false, true, true], m);
    assert.equal(gateStatus(trainer.config.gate, null, 'e').passed, false, `${m}: no report, no start`);
    assert.equal(gateStatus(trainer.config.gate, { ...evaluation(0.95), stale: true }, 'e').passed, false, `${m}: a stale report, no start`);

    // the run starts from the accepted stage 1 weights, and the loop runs the battle: the network is side 0 and sees view(state, 0)
    const id = '0x' + '4'.repeat(64), model = fixedModel(492, hidden, 6, 3), artifact = shapedArtifact(graph, ids[`${from}_net`], model);
    graph.patchConfig(ids[`${from}_cands`], { accepted: id });
    const bundle = buildBundle(graph, trainer.id, { artifacts: a => (a === id ? artifact : null) });
    assert.deepEqual(bundle.init, { artifactId: id, model }, m);
    const env = createEnv(bundle.env), page = scriptCalls(graph, graph.resolved(), ids.vs_battle, { artifacts: () => null });
    const start = env.reset({ seed: 7 }), battle = page.call('battle', [{ seed: 7 }]);
    assert.deepEqual({ ...start, seed: undefined }, { ...battle, seed: undefined }, `${m}: the start of the battle`);
    assert.deepEqual(env.input(), page.call('view', [start, 0]), `${m}: the input is the view of side 0`);
  }
});

test('the parameters of stage 2 do not change the environment of stage 1, so its artifacts stay compatible', () => {
  const envOf = values => {
    const { graph, ids } = instance();
    graph.patchConfig(ids.duel, { values });
    return JSON.stringify(buildBundle(graph, ids.s1_a_trainer).env);
  };
  assert.equal(envOf({}), envOf({ botRandom: 0.9, stepCost: 0.1 }));
});

// ---------------------------------------------------------------------------------------------- the level
const [UP, RIGHT, DOWN, LEFT, FIRE, WAIT] = [0, 1, 2, 3, 4, 5];
/** Map codes of the scene: 0 empty, 1 brick, 2 steel, 3 base. */
const [BRICK, STEEL, BASE] = [1, 2, 3];
const IDLE = { on: false, x: 0, y: 0, d: 0 };
/** A tank or a bullet record from [x, y, d], or IDLE for null. */
const thing = v => (v ? { on: true, x: v[0], y: v[1], d: v[2] } : IDLE);
const cellOf = (s, x, y) => s.cells[y * 9 + x];

/** The scene of the template with `values` in the parameters: the runner, the teacher and the bundle of 中. */
function level(values = {}) {
  const { graph, ids } = instance();
  graph.patchConfig(ids.params, { values });
  const bundle = buildBundle(graph, ids.s1_a_trainer);
  return { graph, ids, bundle, env: createEnv(bundle.env), teacher: compileEntry(bundle.objective, [bundle.env.types.State], 'teacher') };
}
/**
 * Resets `env` on seed 1, then puts the given things on its state. `me` is [x, y, d]. `foes` and `shots` list [x, y, d]
 * or null for each slot: shots[0] is our bullet, shots[1 + i] the bullet of enemy i. All enemies have appeared, so no
 * new enemy comes.
 */
function place(env, { me = [2, 8, UP], foes = [null, null, null], shots = [null, null, null, null], ...more } = {}) {
  env.reset({ seed: 1 });
  env.state = { ...env.state, me: { x: me[0], y: me[1], d: me[2] }, foes: foes.map(thing), shots: shots.map(thing), spawned: 6, ...more };
  return env.state;
}

test('a bullet removes the brick that it hits, and our own bullet on the base loses the level', () => {
  const { env } = level({ fireProb: 0 });
  const start = place(env);
  assert.equal(cellOf(start, 3, 8), BRICK, 'the brick ring of the base');
  const turn = env.step(RIGHT);
  assert.deepEqual(turn.next.me, { x: 2, y: 8, d: RIGHT }, 'a move into a brick only turns the tank');
  const first = env.step(FIRE);
  assert.equal(cellOf(first.next, 3, 8), 0, 'the brick is gone');
  assert.deepEqual([first.next.shots[0].on, first.next.end, first.done], [false, -1, false], 'the bullet is gone too');
  const second = env.step(FIRE);
  assert.deepEqual([second.next.end, second.done, second.success], [2, true, false], 'the next bullet hits the base');
});

test('steel stops a bullet and stays', () => {
  const { env } = level({ fireProb: 0 });
  place(env, { me: [4, 5, UP] });
  const fired = env.step(FIRE);
  assert.deepEqual([fired.next.shots[0].on, fired.next.shots[0].x, fired.next.shots[0].y], [true, 4, 3], 'a bullet flies 2 cells per step');
  const stopped = env.step(WAIT);
  assert.equal(stopped.next.shots[0].on, false);
  assert.equal(cellOf(stopped.next, 4, 2), STEEL);
});

test('our bullet and an enemy bullet that meet both disappear', () => {
  const { env } = level({ fireProb: 0 });
  // the two bullets fly into the same cell (4,0)
  place(env, { me: [2, 0, RIGHT], shots: [null, [6, 0, LEFT], null, null] });
  const meet = env.step(FIRE);
  assert.deepEqual(meet.next.shots.map(b => b.on), [false, false, false, false]);
  assert.equal(meet.next.end, -1);
  // the two bullets pass each other between (2,0) and (3,0). Without the clash, the enemy bullet hits our tank.
  place(env, { me: [2, 0, RIGHT], shots: [null, [3, 0, LEFT], null, null] });
  const cross = env.step(FIRE);
  assert.deepEqual([cross.next.shots[0].on, cross.next.shots[1].on, cross.next.end], [false, false, -1]);
  place(env, { me: [2, 0, UP], shots: [null, [3, 0, LEFT], null, null] });
  assert.deepEqual([env.step(WAIT).next.end], [1], 'with no bullet of ours, the enemy bullet hits');
});

test('an enemy bullet flies through enemies, and our bullet destroys an enemy', () => {
  const { env } = level({ fireProb: 0 });
  // enemy 0 at (1,0) faces the brick (1,1), enemy 1 at (2,0) faces the map edge, so both only turn
  const foes = [[1, 0, DOWN], [2, 0, UP], null];
  place(env, { foes, shots: [null, null, null, [0, 0, RIGHT]] });
  const through = env.step(WAIT).next;
  assert.deepEqual(through.foes.map(f => f.on), [true, true, false]);
  assert.deepEqual([through.shots[3].on, through.shots[3].x, through.kills], [true, 2, 0]);
  place(env, { me: [4, 0, LEFT], foes });
  const hit = env.step(FIRE).next;
  assert.deepEqual(hit.foes.map(f => f.on), [true, false, false]);
  assert.deepEqual([hit.kills, hit.killed, hit.end], [1, 1, -1]);
});

// ---------------------------------------------------------------------------------------------- the trails of the bullets
/** The end reasons of a trail: still in flight, a brick (gone), steel or the map edge, a base, a tank, a clash. */
const [FLYING, HIT_BRICK, HIT_STEEL, HIT_BASE, HIT_TANK, MEET, CROSS] = [0, 1, 2, 3, 4, 5, 6];
/** The trail of a bullet that starts at [x, y] in direction d, flies n cells, ends at [ex, ey] for the reason `why`. */
const trail = ([x, y, d], n, [ex, ey], why) => ({ on: true, x, y, d, n, ex, ey, why });
/** The trail of an idle bullet: it did not fly in this step. */
const IDLE_TRAIL = { on: false, x: 0, y: 0, d: 0, n: 0, ex: 0, ey: 0, why: 0 };

test('each step records the trail of each bullet: its start, the cells it flies, its end and why it stops', () => {
  const { env } = level({ fireProb: 0 });
  const flown = action => env.step(action).next.trails;
  place(env, { me: [2, 8, RIGHT] });
  const brick = env.step(FIRE).next;
  assert.deepEqual(brick.trails, [trail([2, 8, RIGHT], 1, [3, 8], HIT_BRICK), IDLE_TRAIL, IDLE_TRAIL, IDLE_TRAIL],
    'a bullet fired into the brick next to the tank ends in the same step');
  assert.equal(cellOf(brick, 3, 8), 0, 'the brick is gone');
  assert.deepEqual(flown(FIRE)[0], trail([2, 8, RIGHT], 2, [4, 8], HIT_BASE), 'the next bullet passes the empty cell to the base');
  place(env, { me: [4, 5, UP] });
  assert.deepEqual(flown(FIRE)[0], trail([4, 5, UP], 2, [4, 3], FLYING), 'a bullet flies 2 cells');
  assert.deepEqual(flown(WAIT)[0], trail([4, 3, UP], 1, [4, 2], HIT_STEEL), 'then it stops at the steel');
  place(env, { me: [1, 7, RIGHT] });
  const far = env.step(FIRE).next;
  assert.deepEqual([far.trails[0], cellOf(far, 3, 7)], [trail([1, 7, RIGHT], 2, [3, 7], HIT_BRICK), 0], 'a brick 2 cells away');
  place(env, { me: [0, 0, LEFT] });
  assert.deepEqual(flown(FIRE)[0], trail([0, 0, LEFT], 1, [-1, 0], HIT_STEEL), 'the map edge stops a bullet as steel does');
  place(env, { me: [4, 0, LEFT], foes: [[1, 0, DOWN], [2, 0, UP], null] });
  assert.deepEqual(flown(FIRE)[0], trail([4, 0, LEFT], 2, [2, 0], HIT_TANK), 'our bullet destroys the enemy at (2,0)');
  place(env, { me: [2, 0, UP], shots: [null, [3, 0, LEFT], null, null] });
  assert.deepEqual(flown(WAIT)[1], trail([3, 0, LEFT], 1, [2, 0], HIT_TANK), 'an enemy bullet hits our tank');
  place(env, { me: [2, 8, UP], shots: [null, [2, 7, RIGHT], null, null] });
  assert.deepEqual(flown(UP)[1], trail([2, 7, RIGHT], 0, [2, 7], HIT_TANK), 'our tank drives into an enemy bullet before it flies');
  place(env, { me: [2, 0, RIGHT], shots: [null, [6, 0, LEFT], null, null] });
  assert.deepEqual(flown(FIRE).slice(0, 2), [trail([2, 0, RIGHT], 2, [4, 0], MEET), trail([6, 0, LEFT], 2, [4, 0], MEET)],
    'two bullets that fly into one cell');
  place(env, { me: [2, 0, RIGHT], shots: [null, [3, 0, LEFT], null, null] });
  assert.deepEqual(flown(FIRE).slice(0, 2), [trail([2, 0, RIGHT], 1, [3, 0], CROSS), trail([3, 0, LEFT], 1, [2, 0], CROSS)],
    'two bullets that pass through each other: each ends in the start cell of the other');
});

test('enemies appear one by one, at most 3 at a time, and running out of steps is not a win', () => {
  const { env } = level({ fireProb: 0 });
  let s = env.reset({ seed: 1 }), tr;
  const onField = st => st.foes.filter(f => f.on).length;
  assert.equal(onField(s), 1, 'the first enemy is there at the start');
  const counts = [1];
  do {
    tr = env.step(WAIT);
    const before = onField(tr.prev), after = onField(tr.next);
    assert.ok(after <= before + 1, `step ${tr.next.t}: one enemy appears at a time`);
    if (after > before) assert.equal(tr.next.t % 8, 0, `step ${tr.next.t}: enemies appear every 8 steps`);
    counts.push(after);
    s = tr.next;
  } while (!tr.done);
  assert.equal(Math.max(...counts), 3);
  assert.deepEqual([s.spawned, s.kills], [3, 0], 'no enemy is destroyed, so no fourth enemy appears');
  assert.deepEqual([tr.done, tr.success, s.end, s.t], [true, false, 3, 200]);
});

test('an enemy bullet on our tank loses the level, and destroying the sixth enemy wins it', () => {
  const { env } = level({ fireProb: 0, turnProb: 0 });
  place(env, { shots: [null, [2, 6, DOWN], null, null] });
  const lost = env.step(WAIT);
  assert.deepEqual([lost.next.end, lost.done, lost.success], [1, true, false]);
  place(env, { me: [2, 4, UP], foes: [[2, 2, DOWN], null, null], kills: 5 });
  const won = env.step(FIRE);
  assert.deepEqual([won.next.kills, won.next.end, won.done, won.success], [6, 0, true, true]);
});

test('in a full level, 6 enemies appear over time and the teacher can destroy all of them', () => {
  const { env, teacher } = level();
  let s = env.reset({ seed: 2 }), tr, most = 0;
  do { tr = env.step(teacher(s).indexOf(1)); s = tr.next; most = Math.max(most, s.foes.filter(f => f.on).length); } while (!tr.done);
  assert.deepEqual([s.end, tr.success, s.kills, s.spawned], [0, true, 6, 6]);
  assert.ok(most <= 3);
});

test('the input has 492 bits: six maps of 81 cells, then the facing, our bullet in flight and the bias', () => {
  const { env } = level();
  place(env, { me: [2, 8, LEFT], foes: [[0, 0, DOWN], null, null], shots: [[2, 7, UP], [0, 1, DOWN], null, null] });
  const bits = env.input();
  assert.equal(bits.length, 492);
  const map = k => bits.slice(k * 81, (k + 1) * 81);
  const at = (x, y) => y * 9 + x;
  const ones = v => v.flatMap((b, c) => (b ? [c] : []));
  assert.ok(map(0)[at(3, 8)] === 1 && map(0)[at(4, 8)] === 0, 'bricks');
  assert.deepEqual(ones(map(1)), [at(4, 2), at(0, 4), at(8, 4)], 'steel');
  assert.deepEqual(ones(map(2)), [at(4, 8)], 'base');
  assert.deepEqual(ones(map(3)), [at(0, 0)], 'enemy tanks');
  assert.deepEqual(ones(map(4)), [at(0, 1)], 'enemy bullets');
  assert.deepEqual(ones(map(5)), [at(2, 8)], 'our tank');
  assert.deepEqual(bits.slice(486), [0, 0, 0, 1, 1, 1], 'facing left, our bullet in flight, bias');
});

// ---------------------------------------------------------------------------------------------- the teacher
/** The 6 target bits with the slots `on` set. */
const slots = (...on) => [UP, RIGHT, DOWN, LEFT, FIRE, WAIT].map(a => (on.includes(a) ? 1 : 0));

test('the teacher dodges an enemy bullet to a side, or fires at the bullet when it faces it', () => {
  const { env, teacher } = level();
  const foes = [[8, 6, LEFT], null, null];
  // the bullet at (2,2) flies up to our tank at (2,0). Both side cells in row 0 are free.
  assert.deepEqual(teacher(place(env, { me: [2, 0, LEFT], foes, shots: [null, [2, 2, UP], null, null] })), slots(LEFT, RIGHT));
  assert.deepEqual(teacher(place(env, { me: [2, 0, DOWN], foes, shots: [null, [2, 2, UP], null, null] })), slots(LEFT, RIGHT, FIRE));
  // (2,2) has a brick on each side, so only the shot back at the bullet helps
  assert.deepEqual(teacher(place(env, { me: [2, 2, UP], foes, shots: [null, [2, 0, DOWN], null, null] })), slots(FIRE));
  // a side cell that another bullet hits in the next step is not a dodge
  assert.deepEqual(teacher(place(env, { me: [2, 0, LEFT], foes, shots: [null, [2, 2, UP], [1, 0, UP], null] })), slots(RIGHT));
});

test('the teacher fires at an enemy behind a brick, and turns to it first', () => {
  const { env, teacher } = level();
  const foes = [[0, 5, UP], null, null];
  assert.deepEqual(teacher(place(env, { me: [2, 5, LEFT], foes })), slots(FIRE), 'the brick (1,5) is between');
  assert.deepEqual(teacher(place(env, { me: [2, 5, UP], foes })), slots(LEFT));
  assert.deepEqual(teacher(place(env, { me: [2, 5, LEFT], foes, shots: [[1, 5, LEFT], null, null, null] })), slots(WAIT), 'our bullet is in flight');
});

test('the teacher goes to intercept an enemy that faces the base before it goes to a nearer enemy', () => {
  const { env, teacher } = level();
  // the enemy at (7,8) faces left to the base. (7,7) sees it along column 7, 6 steps from (2,6) below our tank.
  // (2,3) sees the enemy at (4,3) along row 3, 1 step from (2,4) above our tank.
  assert.deepEqual(teacher(place(env, { me: [2, 5, UP], foes: [[7, 8, LEFT], [4, 3, LEFT], null] })), slots(DOWN));
  assert.deepEqual(teacher(place(env, { me: [2, 5, UP], foes: [[7, 8, UP], [4, 3, LEFT], null] })), slots(UP), 'no enemy faces the base');
});

test('the teacher does not fire when the bullet would hit its own base first', () => {
  const { env, teacher } = level();
  // the enemy at (7,8) is in row 8 to the right of our tank, but the base (4,8) is between them
  const mask = teacher(place(env, { me: [2, 8, RIGHT], foes: [[7, 8, LEFT], null, null] }));
  assert.equal(mask[FIRE], 0);
  assert.deepEqual(mask, slots(UP), 'it goes to intercept the enemy, which faces the base');
});

test('the teacher marks every shortest way to a cell that sees an enemy', () => {
  const { env, teacher } = level();
  // from (2,0), (6,0) sees the enemy at (6,4) along column 6 and (2,4) sees it along row 4: 4 steps each way
  assert.deepEqual(teacher(place(env, { me: [2, 0, LEFT], foes: [[6, 4, UP], null, null] })), slots(RIGHT, DOWN));
});

test('the metric 和教师一致的比例 is the share of steps where our tank took an action that the teacher marks', () => {
  const { graph, ids, bundle, env, teacher } = level();
  const id = '0x' + '3'.repeat(64), artifact = shapedArtifact(graph, ids.s1_a_net, fixedModel(492, [32, 32], 6, 5));
  graph.patchConfig(ids.s1_a_cands, { accepted: id });
  const entry = buildBundle(graph, ids.s1_a_evaluator, { artifacts: a => (a === id ? artifact : null) }).metrics.find(m => m.name === '和教师一致的比例');
  const agreeRate = compileEntry(entry, [episodeType(bundle.env.types.State)], 'agreeRate');
  /** Plays seed 4 with `choose(mask)` for our tank. Returns agreeRate of the episode and the steps that the teacher marks. */
  const play = choose => {
    let s = env.reset({ seed: 4 }), marked = 0, tr;
    do { const mask = teacher(s), a = choose(mask); marked += mask[a]; tr = env.step(a); s = tr.next; } while (!tr.done);
    return { rate: agreeRate({ initial: tr.prev, final: s, steps: s.t, success: tr.success, return: 0 }), marked, t: s.t };
  };
  assert.equal(play(mask => mask.indexOf(1)).rate, 1, 'our tank follows the teacher');
  const waits = play(() => WAIT);
  assert.ok(waits.marked < waits.t, 'the teacher does not mark wait on each step');
  assert.equal(waits.rate, waits.marked / waits.t);
});

/** A Transition from `prev` to `next`. */
const transition = (prev, next, done = false) => ({ prev, action: WAIT, next, done, truncated: false, success: next.end === 0 })

// ---------------------------------------------------------------------------------------------- the battle
/** Fixed models of 中 and 大, accepted in the stage 2 candidates that the networks of the battle read. */
const BATTLE_MODELS = { mid: fixedModel(492, [32, 32], 6, 11), big: fixedModel(492, [128, 128, 128], 6, 13) };
/**
 * The battle script of the template, with BATTLE_MODELS accepted. `calls()` gives the page side of its inputs over the
 * graph of the moment. `call(name, ...args)` calls one of them.
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
  return { graph, ids, calls, call: (name, ...args) => calls().call(name, args) };
}
/** A tank, bullet or trail record turned 180° on the 9 × 9 map. A trail also turns its end cell. */
const rot = o => ({ ...o, x: 8 - o.x, y: 8 - o.y, d: (o.d + 2) % 4, ...('ex' in o ? { ex: 8 - o.ex, ey: 8 - o.ey } : {}) });
/** The battle state `s` as side 1 has it: the map turned 180°, and the two sides swap places. */
const turn = s => ({
  ...s,
  cells: s.cells.map((_, c) => s.cells[80 - c]),
  tanks: [rot(s.tanks[1]), rot(s.tanks[0])],
  shots: [rot(s.shots[1]), rot(s.shots[0])],
  trails: [rot(s.trails[1]), rot(s.trails[0])],
  bases: [s.bases[1], s.bases[0]],
  acts: [s.acts[1], s.acts[0]].map(a => (a < 4 ? (a + 2) % 4 : a)),
  end: s.end === 0 ? 1 : s.end === 1 ? 0 : s.end,
});
const tank = ([x, y, d]) => ({ on: true, x, y, d });

test('the battle has a base at each end and no bots, and side 1 sees the map turned 180°', () => {
  const { call } = arena();
  const starts = [new Set(), new Set()];
  for (let seed = 1; seed <= 100; seed++) {
    const s = call('battle', { seed });
    assert.deepEqual(s.cells.filter((v, c) => v !== s.cells[80 - c]), [], `seed ${seed}: the map is the same after a turn of 180°`);
    assert.deepEqual([cellOf(s, 4, 8), cellOf(s, 4, 0)], [BASE, BASE], `seed ${seed}: the bases`);
    assert.deepEqual([s.bases, s.end, s.t, s.shots.map(b => b.on)], [[true, true], -1, 0, [false, false]], `seed ${seed}`);
    const [a, b] = s.tanks;
    assert.ok(a.on && a.y >= 7 && a.d === UP && cellOf(s, a.x, a.y) === 0, `seed ${seed}: side 0 starts near its base, facing up`);
    assert.ok(b.on && b.y <= 1 && b.d === DOWN && cellOf(s, b.x, b.y) === 0, `seed ${seed}: side 1 starts near its base, facing down`);
    starts[0].add(`${a.x},${a.y}`); starts[1].add(`${b.x},${b.y}`);
  }
  assert.deepEqual(starts.map(c => c.size), [12, 12], 'neighbouring seeds give each side all 12 start cells');
  const s = { ...call('battle', { seed: 1 }), tanks: [tank([2, 5, RIGHT]), tank([6, 2, DOWN])], shots: [tank([2, 3, UP]), tank([6, 4, LEFT])] };
  const bits = call('view', s, 0), map = k => bits.slice(k * 81, (k + 1) * 81), ones = v => v.flatMap((x, c) => (x ? [c] : []));
  assert.equal(bits.length, 492, 'the same 492 bits as in the level');
  assert.deepEqual(ones(map(2)), [8 * 9 + 4], 'the own base');
  assert.deepEqual(ones(map(3)), [4, 2 * 9 + 6], 'the other base is a target with the other tank');
  assert.deepEqual(ones(map(4)), [4 * 9 + 6], 'the bullet of the other side');
  assert.deepEqual(ones(map(5)), [5 * 9 + 2], 'the own tank');
  assert.deepEqual(bits.slice(486), [0, 1, 0, 0, 1, 1], 'facing right, the own bullet in flight, bias');
  assert.deepEqual(call('view', s, 1), call('view', turn(s), 0), 'side 1 sees what side 0 sees on the turned map');
});

test('the battle rules are the same for both sides: a turned battle plays the turned moves', () => {
  const { call } = arena();
  // fixed moves that walk, turn into walls, fire and wait, as each side sees the map
  const moves = [[UP, UP], [FIRE, FIRE], [RIGHT, LEFT], [FIRE, WAIT], [UP, FIRE], [LEFT, RIGHT], [FIRE, FIRE], [WAIT, UP]];
  for (const seed of [1, 4, 9]) {
    let s = call('battle', { seed }), k = 0;
    while (s.end < 0 && k < 40) {
      const [a, b] = moves[(k * 5 + seed) % moves.length];
      const next = call('play', s, a, b);
      assert.deepEqual(call('play', turn(s), b, a), turn(next), `seed ${seed}, step ${k}`);
      assert.deepEqual(call('view', next, 1), call('view', turn(next), 0), `seed ${seed}, step ${k}`);
      s = next; k++;
    }
  }
});

test('in the battle, a hit on a tank or a base decides it, and both sides losing in one step or the last step is a draw', () => {
  const { call } = arena({ steps: 3 });
  const start = call('battle', { seed: 1 });
  const at = (tanks, shots = [null, null]) => ({ ...start, tanks: tanks.map(tank), shots: shots.map(thing) });
  // column 2 is free from top to bottom
  const shot = call('play', at([[2, 6, UP], [2, 2, DOWN]]), FIRE, WAIT);
  assert.deepEqual([shot.shots[0].y, shot.end], [4, -1], 'a bullet flies 2 cells per step');
  const hit = call('play', shot, WAIT, WAIT);
  assert.deepEqual([hit.tanks[1].on, hit.end], [false, 0], 'side 0 hits the tank of side 1');
  // side 1 at (4,6) faces down to the base of side 0 behind the brick (4,7). Down for side 1 is up on its own map.
  const brick = call('play', at([[0, 8, UP], [4, 6, DOWN]]), WAIT, FIRE);
  assert.deepEqual([cellOf(brick, 4, 7), brick.end], [0, -1], 'the bullet removes the brick');
  const base = call('play', brick, WAIT, FIRE);
  assert.deepEqual([base.bases, base.end], [[false, true], 1], 'the next bullet hits the base: side 1 wins');
  const both = call('play', at([[2, 6, RIGHT], [6, 2, LEFT]], [[6, 4, UP], [2, 4, DOWN]]), WAIT, WAIT);
  assert.deepEqual([both.tanks.map(t => t.on), both.end], [[false, false], 2], 'both tanks hit in one step');
  const meet = call('play', at([[3, 6, RIGHT], [5, 6, LEFT]]), RIGHT, RIGHT);
  assert.deepEqual(meet.tanks, [tank([3, 6, RIGHT]), tank([5, 6, LEFT])], 'two tanks that go into one cell only turn');
  const clash = call('play', at([[2, 7, UP], [2, 1, DOWN]], [[2, 5, UP], [2, 3, DOWN]]), WAIT, WAIT);
  assert.deepEqual([clash.shots.map(b => b.on), clash.end], [[false, false], -1], 'two bullets that meet disappear');
  let s = start;
  for (let k = 0; k < 3; k++) s = call('play', s, WAIT, WAIT);
  assert.deepEqual([s.t, s.end], [3, 2], 'out of steps');
});

test('the battle records the trails of both bullets with the code of the level', () => {
  const { call } = arena();
  const start = call('battle', { seed: 1 });
  const at = (tanks, shots = [null, null]) => ({ ...start, tanks: tanks.map(tank), shots: shots.map(thing) });
  assert.deepEqual(start.trails, [IDLE_TRAIL, IDLE_TRAIL], 'no bullet flies before the first step');
  const shot = call('play', at([[2, 6, UP], [2, 2, DOWN]]), FIRE, WAIT);
  assert.deepEqual(shot.trails, [trail([2, 6, UP], 2, [2, 4], FLYING), IDLE_TRAIL]);
  assert.deepEqual(call('play', shot, WAIT, WAIT).trails[0], trail([2, 4, UP], 2, [2, 2], HIT_TANK), 'side 0 hits the tank of side 1');
  const brick = call('play', at([[0, 8, UP], [4, 6, DOWN]]), WAIT, FIRE);
  assert.deepEqual(brick.trails[1], trail([4, 6, DOWN], 1, [4, 7], HIT_BRICK), 'side 1 fires into the brick next to its tank');
  assert.deepEqual(call('play', brick, WAIT, FIRE).trails[1], trail([4, 6, DOWN], 2, [4, 8], HIT_BASE), 'then into the base of side 0');
  const clash = call('play', at([[2, 7, UP], [2, 1, DOWN]], [[2, 5, UP], [2, 3, DOWN]]), WAIT, WAIT);
  assert.deepEqual(clash.trails, [trail([2, 5, UP], 1, [2, 4], MEET), trail([2, 3, DOWN], 1, [2, 4], MEET)]);
});

// ---------------------------------------------------------------------------------------------- stage 2: the battle map against the bot
/**
 * The loop of stage 2 for 中 with `values` in the parameters of stage 2 and `level` in the shared parameters: its runner
 * and its reward. The network is side 0, the bot side 1. `at(tanks, shots, cells)` resets on seed 1 and puts the given
 * things on the state: tanks and shots are [x, y, d], or null for a tank that is not on the map or a bullet that does not
 * fly. `cells` changes cells of the map: { [x + ',' + y]: code }.
 */
function duel(values = {}, level = {}) {
  const { graph, ids } = instance();
  graph.patchConfig(ids.duel, { values });
  graph.patchConfig(ids.params, { values: level });
  const id = '0x' + '8'.repeat(64), artifact = shapedArtifact(graph, ids.s1_a_net, fixedModel(492, [32, 32], 6, 5));
  graph.patchConfig(ids.s1_a_cands, { accepted: id });
  const bundle = buildBundle(graph, ids.s2_a_trainer, { artifacts: a => (a === id ? artifact : null) });
  const env = createEnv(bundle.env);
  const at = (tanks, shots = [null, null], cells = {}) => {
    env.reset({ seed: 1 });
    const map = [...env.state.cells];
    for (const [xy, v] of Object.entries(cells)) { const [x, y] = xy.split(',').map(Number); map[y * 9 + x] = v; }
    env.state = { ...env.state, cells: map, tanks: tanks.map(thing), shots: shots.map(thing) };
    return env.state;
  };
  return { env, at, reward: compileEntry(bundle.objective, [bundle.env.types.Transition], 'reward') };
}
/** The action of the bot in the step after `state` when our tank waits, in the directions of the map. */
const botMove = (env, state) => { env.state = state; return env.step(WAIT).next.acts[1]; };

test('the bot of stage 2 fires at a tank that it sees, and turns to it first', () => {
  const { env, at } = duel({ botRandom: 0 });
  // column 2 is free from top to bottom: the bot at (2, 2) sees our tank at (2, 6)
  assert.equal(botMove(env, at([[2, 6, UP], [2, 2, DOWN]])), FIRE, 'facing the tank');
  assert.equal(botMove(env, at([[2, 6, UP], [2, 2, LEFT]])), DOWN, 'it turns to the tank');
  assert.equal(botMove(env, at([[2, 6, UP], [2, 2, DOWN]], [null, [2, 4, DOWN]])), WAIT, 'its own bullet still flies');
});

test('the bot of stage 2 dodges a bullet to the side, and does not fire along the line to its own base', () => {
  const { env, at } = duel({ botRandom: 0 });
  // our bullet at (2, 4) flies up into the bot at (2, 2). Left of the bot is a brick, right is free.
  assert.equal(botMove(env, at([[6, 8, UP], [2, 2, LEFT]], [[2, 4, UP], null])), RIGHT);
  // the bot at (4, 3) faces up: our tank at (4, 2) is in front of it, but the base of the bot is behind (4, 2)
  assert.notEqual(botMove(env, at([[4, 2, DOWN], [4, 3, UP]])), FIRE);
});

test('in stage 2, only the destroyed base of the bot wins: a hit bot tank leaves the map, and the episode goes on', () => {
  const { env, at } = duel({ botRandom: 0 });
  // the bot at (0, 2) has the map edge on its left and a brick on its right, so it cannot dodge our bullet from (0, 3)
  at([[6, 8, UP], [0, 2, LEFT]], [[0, 3, UP], null]);
  const kill = env.step(WAIT);
  assert.deepEqual([kill.next.tanks[1].on, kill.next.end, kill.done], [false, -1, false], 'the bot tank is hit and leaves the map');
  const after = env.step(WAIT);
  assert.deepEqual([after.next.tanks[1].on, after.next.acts[1], after.next.shots[1].on], [false, WAIT, false], 'a tank off the map does not act');
  // our tank at (4, 2) faces the base of the bot at (4, 0). The brick at (4, 1) is gone.
  at([[4, 2, UP], null], [null, null], { '4,1': 0 });
  const win = env.step(FIRE);
  assert.deepEqual([win.next.bases, win.next.end, win.success], [[true, false], 0, true], 'the base of the bot is destroyed: a win');
});

test('in stage 2, our tank hit or the end of the steps is a loss, and there is no draw', () => {
  const { env, at } = duel({ botRandom: 0 }, { steps: 3 });
  // column 2 is free: the bullet of the bot at (2, 4) flies down into our tank at (2, 6)
  at([[2, 6, UP], [2, 2, DOWN]], [null, [2, 4, DOWN]]);
  const hit = env.step(WAIT);
  assert.deepEqual([hit.next.tanks[0].on, hit.next.end, hit.success], [false, 1, false], 'our tank is hit: a loss');
  at([[2, 6, UP], null]);
  let tr;
  do tr = env.step(WAIT); while (!tr.done);
  assert.deepEqual([tr.next.t, tr.next.end, tr.truncated, tr.next.tanks[0].on, tr.next.bases], [3, 1, false, true, [true, true]], 'out of steps: a loss');
});

test('the bot of stage 2 beats a tank that only waits, and its random actions repeat on the seed', () => {
  const { env } = duel({ botRandom: 0 });
  for (let seed = 1; seed <= 20; seed++) {
    let tr;
    env.reset({ seed });
    do tr = env.step(WAIT); while (!tr.done);
    assert.equal(tr.next.end, 1, `seed ${seed}: our side loses`);
  }
  const noisy = duel({ botRandom: 1 }).env, moves = () => { noisy.reset({ seed: 3 }); return Array.from({ length: 10 }, () => noisy.step(WAIT).next.acts[1]); };
  const once = moves();
  assert.deepEqual(moves(), once, 'the same seed gives the same random actions');
  assert.ok(new Set(once).size > 2, 'botRandom 1: the actions are random');
});

test('the reward of stage 2 gives 1 for the base of the bot, killReward for its tank, −1 for a loss, and each step costs stepCost', () => {
  const { at, reward } = duel({ stepCost: 0.01, killReward: 0.3 });
  const s = at([[2, 6, UP], [2, 2, DOWN]]);
  const close = (got, want, why) => assert.ok(Math.abs(got - want) < 1e-12, `${why}: ${got}`);
  const off = { ...s.tanks[1], on: false };
  close(reward(transition(s, { ...s, end: -1 })), -0.01, 'a step');
  close(reward(transition(s, { ...s, tanks: [s.tanks[0], off], end: -1 })), 0.3 - 0.01, 'the bot tank is hit');
  close(reward(transition({ ...s, tanks: [s.tanks[0], off] }, { ...s, tanks: [s.tanks[0], off], end: -1 })), -0.01, 'a tank that is already off gives nothing');
  close(reward(transition(s, { ...s, bases: [true, false], end: 0 }, true)), 1 - 0.01, 'a win');
  close(reward(transition(s, { ...s, end: 1 }, true)), -1 - 0.01, 'a loss');
});

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
    const { state, log } = await fight(ctxCall(calls()), { seed, random: 0, show: (s, entry) => shown.push(entry) });
    const direct = directBattle(call, mid, big, seed);
    assert.deepEqual(state, direct.state, `seed ${seed}`);
    assert.deepEqual(log.map(e => e.moves), direct.moves, `seed ${seed}: the moves`);
    assert.ok(log.every(e => !e.wild.some(Boolean)), `seed ${seed}: no random action`);
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
  const { state } = await fight(ctxCall(calls()), { seed: 1, random: 0 });
  assert.deepEqual(state, directBattle(call, big, mid, 1).state, 'a whole battle with 大 as 红方');
});

test('a battle repeats on its seed: with no random action, and with the random actions of the script', async () => {
  const { graph, ids, calls } = arena();
  const { fight, RANDOM } = await scriptFile(graph, ids, 'game.js');
  assert.equal(RANDOM, 0.1, 'the default random-action probability');
  const play = async (seed, random) => (await fight(ctxCall(calls()), { seed, random })).log;
  const still = await play(5, 0);
  assert.deepEqual(await play(5, 0), still);
  const once = await play(5, RANDOM), again = await play(5, RANDOM);
  assert.deepEqual(once, again);
  assert.ok(once.some(e => e.wild.some(Boolean)), 'some actions are random');
  assert.notDeepEqual(once.map(e => e.moves), still.map(e => e.moves), 'the random actions change the battle');
});

test('the battle calls the networks on the stage 2 candidates and the scene that the loops run, and 整理 puts it after stage 2', () => {
  const { graph, ids, groupIds, group, nodes } = instance();
  const from = port => graph.producers(ids.vs_battle, port).map(p => [p.node, p.port]);
  assert.deepEqual(['battle', 'view', 'play'].map(from), [[[ids.scene, 'battle']], [[ids.scene, 'view']], [[ids.scene, 'play']]]);
  assert.deepEqual([from('红方'), from('蓝方')], [[[ids.vs_mid_readout, 'run']], [[ids.vs_big_readout, 'run']]]);
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
