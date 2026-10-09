import test from 'node:test';
import assert from 'node:assert/strict';
import { ModuleGraph } from './graph.js';
import { instantiateInto } from './template.js';
import { builtinTemplate } from '../templates/index.js';
import { exampleOf } from './sample.js';
import { builtinArtifacts } from '../templates/artifacts/index.js';

test('combiner role examples agree: init feeds input and step, reward and the metric follow step', async () => {
  const byId = new Map((await builtinArtifacts()).map(b => [b.artifact.id, b.artifact])), artifacts = id => byId.get(id) ?? null;
  const graph = new ModuleGraph();
  const { ids } = instantiateInto(graph, builtinTemplate('arithmetic-combiner'), { x: 0, y: 0 });
  const stray = graph.addNode({ kind: 'code', config: { inputs: [], source: 'export function reward(transition) { return 1; }' } });
  const res = graph.resolved();
  const ex = (m, fn) => exampleOf(graph, res, m, fn, { artifacts });
  const init = ex(ids.scene, 'init'), input = ex(ids.scene, 'input'), step = ex(ids.scene, 'step');
  const reward = ex(ids.reward, 'reward'), exact = ex(ids.exact, 'exact');
  for (const e of [init, input, step, reward, exact]) assert.equal(e.error, undefined, e.error);

  const [start] = init.args, state = init.result;
  assert.deepEqual(state, { op: start.op, a: start.a, b: start.b, action: -1 }, 'init builds the state from the episode');
  assert.deepEqual(input.args, [state]);
  assert.deepEqual(step.args, [state, 0], 'step gets the initial state and the sample action');
  assert.equal(input.result.length, 11);
  assert.ok(input.result.every(b => b === 0 || b === 1));
  assert.deepEqual(step.result.state, { ...state, action: 0 });
  assert.equal(step.result.done, true);

  const [transition] = reward.args;
  assert.deepEqual(transition.prev, state);
  assert.deepEqual(transition.next, step.result.state);
  assert.equal(transition.success, step.result.success);
  assert.equal(reward.result, step.result.success ? 1 : 0);
  // the tool layer decides as constantly as the loop acts: tool 0 (ADD4) on zero data, and what ADD4 returns for it
  assert.deepEqual(transition.loop, { 策略: { tools: { choice: 0, data: [0, 0, 0, 0, 0, 0, 0, 0], result: [0, 0, 0, 0, 0, 0, 0, 0] } } });
  assert.match(reward.label, /工具 0/);

  const [episode] = exact.args;
  assert.deepEqual(episode, { initial: state, final: step.result.state, steps: 1, success: step.result.success, return: reward.result });
  assert.equal(exact.result, reward.result);

  assert.equal(ex(stray.id, 'reward'), null, 'a function in no role has no example');
  assert.equal(ex(ids.scene, 'want'), null, 'nor does an unexported helper');
  const bare = new ModuleGraph(), fresh = instantiateInto(bare, builtinTemplate('arithmetic-combiner'), { x: 0, y: 0 }).ids;
  assert.match(exampleOf(bare, bare.resolved(), fresh.reward, 'reward').error ?? '', /没有已接受的权重/, 'without the tools\' weights the example says why');
});

test('an artifact arriving or disappearing rebuilds the example without a graph edit', async () => {
  const byId = new Map((await builtinArtifacts()).map(b => [b.artifact.id, b.artifact]));
  const graph = new ModuleGraph(), { ids } = instantiateInto(graph, builtinTemplate('arithmetic-combiner'), { x: 0, y: 0 });
  const res = graph.resolved(), present = new Map();
  const ex = () => exampleOf(graph, res, ids.reward, 'reward', { artifacts: id => present.get(id) ?? null });
  const missing = ex();
  assert.match(missing.error ?? '', /没有已接受的权重/);
  assert.equal(ex(), missing, 'memoised while nothing changes');
  for (const [id, a] of byId) present.set(id, a);
  const imported = ex();
  assert.equal(imported.error, undefined, imported.error);
  assert.equal(graph.resolved(), res, 'the graph did not change');
  present.clear();
  assert.match(ex().error ?? '', /没有已接受的权重/, 'removed again: the example says why again');
});
