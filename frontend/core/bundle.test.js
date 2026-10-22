import { test } from 'node:test';
import assert from 'node:assert/strict';
import './kinds/index.js';
import { buildBundle, bundleHash, envHash, BundleError, staticValue } from './bundle.js';
import { canonicalJSON } from './canonical.js';
import { makeArtifact } from './store.js';
import { counterModel } from './sessions/fixtures.js';
import { counterGraph } from './fixtures/counter.js';

const code = (graph, source, inputs = []) => graph.addNode({ kind: 'code', config: { inputs, source } });

test('trainer bundle: env programs, values, types, the loop section, partitions and recipe from the graph', () => {
  const { graph, ids } = counterGraph();
  const b = buildBundle(graph, ids.trainer);
  assert.equal(b.format, 'neurom-bundle');
  assert.deepEqual(Object.keys(b.env.programs).sort(), ['init', 'input', 'step']);
  assert.equal(b.env.programs.init.program.format, 'neurom-program');
  assert.equal('params' in b.env, false, 'scenario parameters travel as the programs’ bound values, not as env params');
  assert.deepEqual(b.env.programs.step.program.params, ['state', 'action', 'params']);
  assert.deepEqual(b.env.programs.step.bound, { params: { budget: 5, target: 3 } });
  assert.equal(b.env.budget, 5);
  assert.deepEqual(b.env.actions, ['stay', 'up']);
  assert.equal(b.env.start, 'seed');
  assert.equal(b.env.types.I, 3);
  assert.deepEqual(b.env.types.Start, { type: 'record', fields: { seed: { type: 'number' } } });
  assert.deepEqual(b.env.types.State, { type: 'record', fields: { count: { type: 'number' }, seed: { type: 'number' } } });
  assert.deepEqual(Object.keys(b.env.types.Transition.fields), ['action', 'done', 'next', 'prev', 'success', 'truncated']);
  assert.equal(b.objective.kind, 'reward');
  assert.deepEqual(b.loop, {
    I: 3, action: { node: ids.readout, port: 'action' }, trained: ids.net,
    nodes: {
      [ids.net]: { kind: 'network', structure: { engine: 'dense-policy', kind: 'lif', inputs: 3, outputs: 2, weightBits: 8, layers: [{ hidden: 8 }], ticks: 2, leak_shift: 2, reset: 0 }, in: { node: '$input', port: 'bits' }, model: null, artifactId: null },
      [ids.readout]: { kind: 'readout', readout: { mode: 'argmax', map: [0, 1], width: 2 }, scores: { node: ids.net, port: 'scores' } },
    },
  });
  assert.deepEqual(b.partitions, { training: { kind: 'seed', seed: 1, count: 64 }, validation: { kind: 'seed', seed: 100000, count: 32 } });
  assert.equal(b.recipe.method, 'reinforce'); assert.equal(b.recipe.epochs, 10);
  assert.equal(canonicalJSON(b), JSON.stringify(b), 'bundles come out in canonical key order');
});

test('frozen networks: evaluator and execution bundles need every network’s accepted weights', async () => {
  const { graph, ids } = counterGraph();
  assert.throws(() => buildBundle(graph, ids.evaluator), error => error instanceof BundleError && /没有已接受的权重/.test(error.message));
  const artifact = await makeArtifact({ bundle: buildBundle(graph, ids.trainer), model: counterModel(1) });
  graph.patchConfig(ids.cands, { accepted: artifact.id });
  const artifacts = id => (id === artifact.id ? artifact : null);
  const evaluator = buildBundle(graph, ids.evaluator, { artifacts });
  assert.deepEqual(evaluator.loop.nodes[ids.net].model, artifact.model);
  assert.equal(evaluator.loop.nodes[ids.net].artifactId, artifact.id);
  assert.equal(evaluator.loop.trained, null);
  assert.deepEqual(buildBundle(graph, ids.execution, { artifacts }).partitions, { test: { kind: 'seed', seed: 200000, count: 100 } });
});

test('a network’s own `artifact` is its model; with a weights wire or a trainer it is a problem; it must fit the network', async () => {
  const { graph, ids } = counterGraph();
  const artifact = await makeArtifact({ bundle: buildBundle(graph, ids.trainer), model: counterModel(1) });
  const narrowGraph = counterGraph();
  narrowGraph.graph.patchConfig(narrowGraph.ids.net, { layers: [{ hidden: 4 }] });
  const narrow = await makeArtifact({ bundle: buildBundle(narrowGraph.graph, narrowGraph.ids.trainer), model: counterModel(1, { hidden: 4 }) });
  const artifacts = id => [artifact, narrow].find(a => a.id === id) ?? null;
  const netProblems = () => graph.problems().filter(p => p.node === ids.net).map(p => p.port);
  graph.patchConfig(ids.net, { artifact: artifact.id });
  assert.deepEqual(netProblems().sort(), ['structure', 'weights'], 'artifact + weights wire, artifact + trainer');
  graph.disconnect(graph.producers(ids.net, 'weights')[0].wire.id);
  assert.deepEqual(netProblems(), ['structure']);
  graph.disconnect(graph.consumers(ids.net, 'structure')[0].wire.id);
  assert.deepEqual(netProblems(), []);
  const evaluator = buildBundle(graph, ids.evaluator, { artifacts });
  assert.deepEqual(evaluator.loop.nodes[ids.net].model, artifact.model);
  assert.equal(evaluator.loop.nodes[ids.net].artifactId, artifact.id);
  graph.patchConfig(ids.net, { artifact: narrow.id });
  assert.throws(() => buildBundle(graph, ids.evaluator, { artifacts }), /产物不兼容：网络结构不同/);
  graph.patchConfig(ids.net, { layers: [{ hidden: 4 }] });
  assert.equal(buildBundle(graph, ids.evaluator, { artifacts }).loop.nodes[ids.net].artifactId, narrow.id, 'fits once the network has its structure');
  graph.patchConfig(ids.net, { artifact: null });
  assert.throws(() => buildBundle(graph, ids.evaluator, { artifacts }), /没有已接受的权重/);
});

test('a trainer `init` carries the accepted artifact of its candidates; none accepted or a misfit is a problem', async () => {
  const { graph, ids } = counterGraph();
  assert.equal('init' in buildBundle(graph, ids.trainer), false, 'without the wire the bundle has no init');
  const artifact = await makeArtifact({ bundle: buildBundle(graph, ids.trainer), model: counterModel(1) });
  const narrowGraph = counterGraph();
  narrowGraph.graph.patchConfig(narrowGraph.ids.net, { layers: [{ hidden: 4 }] });
  const narrow = await makeArtifact({ bundle: buildBundle(narrowGraph.graph, narrowGraph.ids.trainer), model: counterModel(1, { hidden: 4 }) });
  const artifacts = id => [artifact, narrow].find(a => a.id === id) ?? null;
  graph.connect({ kind: 'value', from: { node: ids.cands, port: 'weights' }, to: { node: ids.trainer, port: 'init' } });
  const initProblems = () => graph.problems().filter(p => p.node === ids.trainer && p.port === 'init');
  assert.equal(initProblems().length, 1, 'no accepted artifact yet');
  assert.equal(initProblems()[0].incomplete, true);
  assert.throws(() => buildBundle(graph, ids.trainer, { artifacts }), error => error instanceof BundleError && /init/.test(error.message));
  graph.patchConfig(ids.cands, { accepted: artifact.id });
  assert.deepEqual(initProblems(), []);
  const b = buildBundle(graph, ids.trainer, { artifacts });
  assert.deepEqual(b.init, { artifactId: artifact.id, model: artifact.model });
  assert.equal(b.loop.nodes[ids.net].model, null, 'the trained network itself stays without a model');
  graph.patchConfig(ids.cands, { accepted: narrow.id });
  assert.throws(() => buildBundle(graph, ids.trainer, { artifacts }), /产物不兼容：网络结构不同/);
});

test('a trainer `gate` takes an evaluator report only; a missing condition or a metric the evaluator does not have is a problem', () => {
  const { graph, ids } = counterGraph();
  const before = buildBundle(graph, ids.trainer);
  assert.throws(() => graph.connect({ kind: 'value', from: { node: ids.cands, port: 'weights' }, to: { node: ids.trainer, port: 'gate' } }), /report/);
  graph.connect({ kind: 'value', from: { node: ids.evaluator, port: 'report' }, to: { node: ids.trainer, port: 'gate' } });
  const gateProblems = () => graph.problems().filter(p => p.node === ids.trainer && p.port === 'gate');
  assert.equal(gateProblems().length, 1, 'no condition yet');
  assert.equal(gateProblems()[0].incomplete, true);
  graph.patchConfig(ids.trainer, { gate: { metric: 'speed', min: 1 } });
  assert.match(gateProblems()[0].message, /speed/);
  assert.ok(!gateProblems()[0].incomplete);
  assert.throws(() => buildBundle(graph, ids.trainer), /speed/);
  graph.patchConfig(ids.trainer, { gate: { metric: graph.node(ids.steps).title, max: 4 } });
  assert.deepEqual(gateProblems(), []);
  assert.deepEqual(buildBundle(graph, ids.trainer), before, 'the gate and its condition do not change the bundle');
  assert.throws(() => graph.patchConfig(ids.trainer, { gate: { metric: 'steps', min: 'high' } }), /gate\.min/);
});

test('hash stability: key order does not matter; env hash is shared across consumers and instances of one loop', async () => {
  const one = counterGraph(), two = counterGraph();
  const b1 = buildBundle(one.graph, one.ids.trainer), b2 = buildBundle(two.graph, two.ids.trainer);
  assert.equal(await envHash(b1), await envHash(b2), 'the env holds no node ids');
  const reordered = JSON.parse(JSON.stringify(b1, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)));
  assert.equal(await bundleHash(reordered), await bundleHash(b1));
  const artifact = await makeArtifact({ bundle: b1, model: counterModel(1) });
  one.graph.patchConfig(one.ids.cands, { accepted: artifact.id });
  const evaluator = buildBundle(one.graph, one.ids.evaluator, { artifacts: () => artifact });
  assert.equal(await envHash(evaluator), await envHash(b1), 'trainer and evaluator share the environment');
  assert.notEqual(await bundleHash(evaluator), await bundleHash(b1));
  assert.deepEqual(evaluator.metrics.map(m => m.name), ['steps']);
  assert.deepEqual(evaluator.partitions, { test: { kind: 'seed', seed: 200000, count: 100 } });
});

test('a different objective keeps the env hash; a different scenario program changes it', async () => {
  const { graph, ids } = counterGraph();
  const base = await envHash(buildBundle(graph, ids.trainer));
  graph.disconnect(graph.producers(ids.trainer, 'objective')[0].wire.id);
  const other = code(graph, 'export function reward(transition) { return transition.next.count; }');
  graph.connect({ kind: 'call', from: { node: other.id, port: 'reward' }, to: { node: ids.trainer, port: 'objective' } });
  assert.equal(await envHash(buildBundle(graph, ids.trainer)), base);
  graph.patchConfig(ids.params, { values: { target: 4 } });
  assert.notEqual(await envHash(buildBundle(graph, ids.trainer)), base, 'params values are part of the environment');
});

test('bound values travel with the program', () => {
  const { graph, ids } = counterGraph();
  graph.disconnect(graph.producers(ids.trainer, 'objective')[0].wire.id);
  const scaled = code(graph, 'export function reward(transition) { return transition.action > 0 ? k : 0; }', ['k']);
  graph.connect({ kind: 'value', from: { node: ids.params, port: 'params.target' }, to: { node: scaled.id, port: 'k' } });
  graph.connect({ kind: 'call', from: { node: scaled.id, port: 'reward' }, to: { node: ids.trainer, port: 'objective' } });
  const b = buildBundle(graph, ids.trainer);
  assert.deepEqual(b.objective.bound, { k: 3 });
  assert.deepEqual(b.objective.boundTypes, { k: { type: 'number' } });
  assert.deepEqual(b.objective.program.params, ['transition', 'k']);
  assert.deepEqual(staticValue(graph, graph.resolved(), ids.scene, 'actions'), ['stay', 'up'], 'the scenario’s export const actions is its actions output');
  const nested = code(graph, 'export const nest = { cfg: { bonus: 2 } };');
  assert.equal(staticValue(graph, graph.resolved(), nested.id, 'nest.cfg.bonus'), 2, 'field paths walk nested records');
  assert.throws(() => staticValue(graph, graph.resolved(), nested.id, 'nest.cfg.nope'), /没有字段/);
});

test('file-level names a scenario function reads travel as its bound values: consts (evaluated once) and inputs', () => {
  const { graph, ids } = counterGraph();
  const source = graph.node(ids.scene).config.source
    .replace('export const actions', 'const goal = params.target * 2;\nconst marks = range(3).map(i => i + goal);\nexport const actions')
    .replace('return thermometer(state.count, [1, 2, 3]);', 'return thermometer(state.count + marks[0] - cap, [1, 2, 3]);');
  graph.patchConfig(ids.scene, { source, inputs: ['params', 'cap'] });
  graph.connect({ kind: 'value', from: { node: ids.params, port: 'params.budget' }, to: { node: ids.scene, port: 'cap' } });
  const { programs } = buildBundle(graph, ids.trainer).env;
  assert.deepEqual(programs.input.program.params, ['state', 'marks', 'cap'], 'the runner’s arguments first, then the file-level names read, in order of first use');
  assert.deepEqual(programs.input.bound, { marks: [6, 7, 8], cap: 5 }, 'a const reading params and an earlier const is computed once and bound by value');
  assert.deepEqual(programs.input.boundTypes, { marks: { type: 'array', of: { type: 'number' }, length: 3 }, cap: { type: 'number' } });
  assert.deepEqual(programs.init.bound, {}, 'init reads nothing but its start');
});

test('an unfinished graph cannot be bundled and says why', () => {
  const { graph, ids } = counterGraph();
  graph.patchConfig(ids.scene, { source: graph.node(ids.scene).config.source.replace(/export function input[^}]*}/, '') });
  assert.throws(() => buildBundle(graph, ids.trainer), error => error instanceof BundleError && /input/.test(error.message));
  assert.throws(() => buildBundle(graph, ids.params), BundleError);
  // the step limit is the scenario's own export: without it there is no bundle
  const { graph: noBudget, ids: nb } = counterGraph();
  noBudget.patchConfig(nb.scene, { source: noBudget.node(nb.scene).config.source.replace('export const budget = params.budget;', '') });
  assert.ok(noBudget.problems().some(p => p.node === nb.loop && p.port === 'scenario' && p.incomplete && /budget/.test(p.message)));
  assert.throws(() => buildBundle(noBudget, nb.trainer), error => error instanceof BundleError && /budget/.test(error.message));
});

test('a constraint expression bounds a field by another one: out of range is a problem and blocks the bundle', () => {
  const { graph, ids } = counterGraph();
  const fields = graph.node(ids.params).config.fields;
  graph.patchConfig(ids.params, { fields: { ...fields, target: { ...fields.target, max: 'budget - 1' } } });
  assert.equal(buildBundle(graph, ids.trainer).env.programs.step.bound.params.target, 3, 'target 3 ≤ budget 5 − 1');
  graph.patchConfig(ids.params, { values: { budget: 3 } });
  assert.ok(graph.problems().some(p => p.node === ids.params && /target/.test(p.message) && /1\.\.2/.test(p.message)), 'the bound follows budget');
  assert.throws(() => buildBundle(graph, ids.trainer), error => error instanceof BundleError && /target/.test(error.message));
  graph.patchConfig(ids.params, { fields: { ...fields, target: { ...fields.target, max: 'budgte - 1' } } });
  assert.ok(graph.problems().some(p => p.node === ids.params && /budgte/.test(p.message)), 'an expression naming no field is a problem, not a silent no-op');
});
