import { test } from 'node:test';
import assert from 'node:assert/strict';
import './kinds/index.js';
import { buildBundle } from './bundle.js';
import { createEnv, RunnerError } from './runner.js';
import { counterGraph } from './fixtures/counter.js';

const counterEnv = () => { const { graph, ids } = counterGraph(); return { env: createEnv(buildBundle(graph, ids.trainer).env), graph, ids }; };
/** Rewrite the counter scenario's source (`from` → `to`). */
const patchSource = (graph, id, from, to) => graph.patchConfig(id, { source: graph.node(id).config.source.replace(from, to) });

test('reset → input → step: state, input bits and the transition follow the contract', () => {
  const { env } = counterEnv();
  assert.throws(() => env.input(), RunnerError);
  assert.deepEqual(env.reset({ seed: 7 }), { count: 0, seed: 7 });
  assert.deepEqual(env.input(), [0, 0, 0]);
  const tr = env.step(1);
  assert.deepEqual(tr, { prev: { count: 0, seed: 7 }, action: 1, next: { count: 1, seed: 7 }, done: false, truncated: false, success: false });
  assert.equal(env.t, 1); assert.equal(env.done, false);
  assert.deepEqual(env.input(), [1, 0, 0], 'thermometer of the new count');
  env.step(0);
  assert.deepEqual(env.state, { count: 1, seed: 7 });
});

test('done from step ends the episode (not truncated); stepping after done is an error', () => {
  const { env } = counterEnv();
  env.reset({ seed: 1 });
  env.step(1); env.step(1);
  const tr = env.step(1);
  assert.deepEqual([tr.done, tr.truncated, tr.success], [true, false, true]);
  assert.equal(env.done, true); assert.equal(env.t, 3);
  assert.throws(() => env.step(0), error => error instanceof RunnerError && /回合已结束/.test(error.message));
  env.reset({ seed: 2 });
  assert.equal(env.done, false); assert.equal(env.t, 0);
});

test('truncation: t+1 ≥ budget without done ends the episode truncated; a done step at the budget is not truncated', () => {
  const { env } = counterEnv();
  env.reset({ seed: 1 });
  for (let i = 0; i < 4; i++) assert.equal(env.step(0).done, false);
  const tr = env.step(0);
  assert.deepEqual([tr.done, tr.truncated, tr.success], [true, true, false]);
  assert.throws(() => env.step(1), RunnerError);
  env.reset({ seed: 1 });
  env.step(0); env.step(0); env.step(1); env.step(1);
  const last = env.step(1);                    // t=4 hits the budget, and step itself says done with success
  assert.deepEqual([last.done, last.truncated, last.success], [true, false, true]);
});

test('runtime type errors surface as RunnerError; Start records are checked against the partition type', () => {
  const { env } = counterEnv();
  assert.throws(() => env.reset({ nope: 1 }), RunnerError);
  env.reset({ seed: 1 });
  assert.throws(() => env.step('up'), RunnerError);
});

test('input must return 0/1 bits of width I', () => {
  const { graph, ids } = counterGraph();
  patchSource(graph, ids.scene, /return thermometer[^;]*;/, 'return [state.count, 0, 0];');
  const env = createEnv(buildBundle(graph, ids.trainer).env);
  env.reset({ seed: 1 });
  assert.deepEqual(env.input(), [0, 0, 0]);
  env.step(1); env.step(1);
  assert.throws(() => env.input(), error => error instanceof RunnerError && /0\/1/.test(error.message));
});
