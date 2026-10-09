// The browser runner, loop executor and lockstep runner still produce every committed case of the parity corpus
// (bundle-env.json, replays.json) — the JS side of the seam test_bundle_env.py / test_bundle_train.py check in Python.
// A failure means the JS semantics changed: regenerate with `node training/fixtures/bundle-env.mjs` (and replays.mjs)
// only together with the matching change to the Python twins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../../frontend/core/kinds/index.js';
import { episodesOf } from '../../frontend/core/sessions/common.js';
import { envTrace, loopTrace, interceptTrace, validation, replay, quantization } from './parity.mjs';

const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const FIXTURES = read('./bundle-env.json'), REPLAYS = read('./replays.json');
const json = value => JSON.parse(JSON.stringify(value));

test('runner: every scripted episode reproduces', () => {
  for (const sc of FIXTURES.envs) assert.deepEqual(json(envTrace({ ...sc, starts: sc.lanes.map(l => l.start) })), sc.lanes, sc.name);
});

test('loop executor: every greedy episode reproduces step by step, and the lockstep runner\'s summaries', () => {
  for (const sc of FIXTURES.loops) assert.deepEqual(json(loopTrace({ bundle: sc.bundle, starts: sc.lanes.map(l => l.start) })), { lanes: sc.lanes, summaries: sc.summaries }, sc.name);
});

test('lockstep runner: every intercepted case reproduces; every refused case is refused', () => {
  assert.ok(FIXTURES.intercepted.length >= 6);
  for (const sc of FIXTURES.intercepted) {
    const lanes = interceptTrace({ bundle: sc.bundle, tables: sc.tables, starts: sc.lanes.map(l => l.start) }, (b, k) => sc.lanes[b].steps[k].result);
    assert.deepEqual(json(lanes), sc.lanes, sc.name);
  }
  for (const sc of FIXTURES.errors) assert.throws(() => interceptTrace(sc, (b, k) => sc.results[b][k]), Error, sc.name);
});

test('validation: both accuracy rules reproduce', () => {
  assert.deepEqual(new Set(FIXTURES.validations.map(v => v.labelled)), new Set(['all', 'any']));
  for (const v of FIXTURES.validations) assert.deepEqual(json(validation(v)), v.summary, v.name);
});

test('partitions list the same episodes', () => {
  for (const fx of FIXTURES.partitions) assert.deepEqual(json(episodesOf(fx.entry)), fx.episodes);
});

test('Python-trained models replay in the browser executor with the recorded decisions', () => {
  assert.ok(REPLAYS.replays.length >= 4);
  for (const fx of REPLAYS.replays) assert.deepEqual(json(replay(fx.bundle, fx.model)), { summary: fx.summary, decisions: fx.decisions }, JSON.stringify(fx.source));
});

test('the per-layer quantiser reproduces every recorded case', () => {
  assert.ok(FIXTURES.quantizations.length >= 48);
  for (const [i, fx] of FIXTURES.quantizations.entries()) assert.deepEqual(json(quantization(fx)), fx.expect, `case ${i} int${fx.bits} ${fx.role}`);
});
