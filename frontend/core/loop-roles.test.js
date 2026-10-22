// core/loop-roles.test.js — a loop's `roles` config names the exports of its scenario that fill init / input / step
// (ADR 0022). The bundle keys the programs by role, so the runner, the trainer and Python see no mapping. One scene
// serves several loops: an export a sibling loop uses as a role is not an unused export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './kinds/index.js';
import { buildBundle, bundleHash, envHash } from './bundle.js';
import { createEnv } from './runner.js';
import { exampleOf } from './sample.js';
import { rolesOf } from './roles.js';
import { ModuleGraph } from './graph.js';
import { instantiateInto } from './template.js';
import { counterGraph } from './fixtures/counter.js';
import { builtinTemplate } from '../templates/index.js';
import { builtinArtifacts } from '../templates/artifacts/index.js';

/** The counter scene's second mode: the count starts at the target and action 1 counts down. Every export keeps its own name. */
const DUEL = `
export function duelInit(start) {
  return { count: params.target, seed: start.seed };
}
export function duelInput(state) {
  return thermometer(state.count, [1, 2, 3]);
}
export function duelStep(state, action) {
  const next = state.count - action;
  return { state: { count: next, seed: state.seed }, done: next <= 0, success: next <= 0 };
}
`;
const DUEL_ROLES = { init: 'duelInit', input: 'duelInput', step: 'duelStep' };
const scenarioProblems = (graph, loop) => graph.problems().filter(p => p.node === loop && p.port === 'scenario');

test('a loop with roles runs the mapped exports: the bundle keys them by role and a runner episode uses them', () => {
  const { graph, ids } = counterGraph();
  const source = graph.node(ids.scene).config.source.replace(/export function init[\s\S]*/, DUEL);
  graph.patchConfig(ids.scene, { source });
  assert.ok(scenarioProblems(graph, ids.loop).some(p => p.incomplete && /没有导出函数 input/.test(p.message)), 'without the mapping the scene lacks input');
  graph.patchConfig(ids.loop, { roles: DUEL_ROLES });
  assert.deepEqual(scenarioProblems(graph, ids.loop), [], 'the mapped exports fill the roles, and duelInit / duelInput / duelStep are not unused');
  const b = buildBundle(graph, ids.trainer);
  assert.deepEqual(Object.keys(b.env.programs).sort(), ['init', 'input', 'step'], 'programs are keyed by role, whatever export fills it');
  assert.deepEqual(b.env.programs.init.program.params, ['start', 'params'], 'init is duelInit: it reads params.target');
  assert.deepEqual(b.env.types.State, { type: 'record', fields: { count: { type: 'number' }, seed: { type: 'number' } } });
  const env = createEnv(b.env);
  assert.deepEqual(env.reset({ seed: 7 }), { count: 3, seed: 7 }, 'duelInit starts at the target');
  assert.deepEqual(env.input(), [1, 1, 1]);
  const tr = env.step(1);
  assert.deepEqual([tr.next.count, tr.done, tr.success], [2, false, false], 'duelStep counts down');
  const example = exampleOf(graph, graph.resolved(), ids.scene, 'duelStep'), [, action] = example.args;
  assert.deepEqual(example.result, { state: { count: 3 - action, seed: 1 }, done: false, success: false }, 'the help window runs duelStep in its role');
  const step = rolesOf(graph, graph.resolved(), ids.scene).role('duelStep');
  assert.deepEqual([step.required, step.callers[0].role, step.params.map(p => p.label)], [true, 'step', ['State', 'number']], 'duelStep is the loop’s step role');
  assert.equal(rolesOf(graph, graph.resolved(), ids.scene).role('step'), null, 'nothing calls an export named step');
});

test('a missing mapped export is a problem naming it, and the roles config takes identifiers only', () => {
  const { graph, ids } = counterGraph();
  graph.patchConfig(ids.loop, { roles: { step: 'duelStep' } });
  const problems = scenarioProblems(graph, ids.loop);
  assert.ok(problems.some(p => p.incomplete && p.message === '场景 counter scene 没有导出函数 duelStep'), problems.map(p => p.message).join('\n'));
  assert.ok(problems.some(p => p.incomplete && /导出了 step/.test(p.message) && /duelStep/.test(p.message)), 'step is unused now, and the message lists the loop’s role exports');
  assert.throws(() => buildBundle(graph, ids.trainer), /duelStep/);
  graph.patchConfig(ids.loop, { roles: { init: 'duelInit' } });
  assert.ok(scenarioProblems(graph, ids.loop).some(p => p.incomplete && p.message === '场景 counter scene 没有导出函数 duelInit'), 'a mapped init is not optional');
  assert.throws(() => buildBundle(graph, ids.trainer), /duelInit/);
  assert.throws(() => graph.patchConfig(ids.loop, { roles: { step: 'duel step' } }), /roles\.step/);
  assert.throws(() => graph.patchConfig(ids.loop, { roles: { budget: 'limit' } }), /budget/, 'const roles are not mapped');
});

test('an export a sibling loop on the same scene uses as a role is not unused, a truly unused one still is', () => {
  const { graph, ids } = counterGraph();
  graph.patchConfig(ids.scene, { source: graph.node(ids.scene).config.source + DUEL });
  const sibling = graph.addNode({ kind: 'loop', config: { roles: DUEL_ROLES } });
  graph.connect({ kind: 'call', from: { node: ids.scene, port: 'module' }, to: { node: sibling.id, port: 'scenario' } });
  const unused = loop => scenarioProblems(graph, loop).filter(p => /导出了/.test(p.message)).map(p => p.message);
  assert.deepEqual(unused(ids.loop), [], 'the first loop does not report the duel exports');
  assert.deepEqual(unused(sibling.id), [], 'the sibling does not report init / input / step');
  assert.deepEqual(buildBundle(graph, ids.trainer).env.programs.init.program.params, ['start'], 'the first loop still bundles init');
  graph.patchConfig(ids.scene, { source: graph.node(ids.scene).config.source + 'export function spare(state) {\n  return state;\n}\n' });
  assert.deepEqual(unused(ids.loop), ['场景导出了 spare，但运行器不调用它，也没有接到别处（运行器调用：init、input、step）']);
  assert.deepEqual(unused(sibling.id), ['场景导出了 spare，但运行器不调用它，也没有接到别处（运行器调用：duelInit、duelInput、duelStep）']);
});

test('a loop without roles yields the bundle it did before: the counter hash does not move, a builtin artifact still matches its template', async () => {
  const { graph, ids } = counterGraph();
  const before = await bundleHash(buildBundle(graph, ids.trainer));
  graph.patchConfig(ids.loop, { roles: {} });
  assert.equal(await bundleHash(buildBundle(graph, ids.trainer)), before);
  graph.patchConfig(ids.loop, { roles: { init: 'init', input: 'input', step: 'step' } });
  assert.equal(await bundleHash(buildBundle(graph, ids.trainer)), before, 'a role mapped to its own name is the default');
  // arithmetic-add4's artifact was trained before loops had a roles config: its trainer bundle hash is in its provenance
  const { artifact } = (await builtinArtifacts()).find(e => e.name === 'arithmetic-add4');
  const scratch = new ModuleGraph(), { ids: fresh } = instantiateInto(scratch, builtinTemplate('arithmetic-add4'), { x: 0, y: 0 });
  let text = JSON.stringify(scratch.toJSON());
  for (const [local, id] of Object.entries(fresh)) text = text.replaceAll(JSON.stringify(id), JSON.stringify(local));
  const bundle = buildBundle(ModuleGraph.fromJSON(JSON.parse(text)), 'trainer');
  assert.equal(await envHash(bundle), await envHash(artifact.bundle));
  assert.equal(await bundleHash(bundle), artifact.provenance.bundleHash);
});
