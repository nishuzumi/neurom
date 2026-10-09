import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBundle, envHash } from '../bundle.js';
import { makeArtifact } from '../store.js';
import { evaluate, createEvaluatorSession } from './evaluator.js';
import { acceptedCounter, counterModel } from './fixtures.js';

test('evaluate: greedy episodes over the test partition, return from the objective, metrics per episode, env hash', async () => {
  const { graph, ids, artifact, artifacts } = await acceptedCounter();
  const bundle = buildBundle(graph, ids.evaluator, { artifacts });
  const trainer = buildBundle(graph, ids.trainer, { artifacts });
  const evalBundle = { ...bundle, objective: trainer.objective };                   // reward objective → return
  const up = await evaluate(evalBundle, 'test');
  assert.equal(up.role, 'test');
  assert.equal(up.n, 100);
  assert.equal(up.successRate, 1, 'always up reaches target 3 within budget 5');
  assert.equal(up.meanSteps, 3);
  assert.equal(up.meanReturn, 3, 'reward 1 per upward move');
  assert.deepEqual(up.metrics, { steps: { mean: 3, n: 100 } });
  assert.equal(up.episodes.length, 100);
  assert.deepEqual(up.episodes[0].episode, { seed: 200000 });
  assert.equal(up.episodes[0].metrics.steps, 3);
  assert.equal(up.envHash, await envHash(bundle));
  assert.deepEqual(up.artifacts, { [ids.net]: artifact.id });

  const stay = await evaluate(evalBundle, 'test', { models: { [ids.net]: counterModel(0) } });
  assert.equal(stay.successRate, 0);
  assert.equal(stay.meanSteps, 5, 'truncated at the budget');
  assert.equal(stay.meanReturn, 0);

  assert.equal((await evaluate(bundle)).meanReturn, null, 'no reward objective → no return, rather than a 0 that reads as one');
  assert.equal((await evaluate(bundle, 'test', { keep: 4 })).episodes.length, 4);
  await assert.rejects(evaluate(bundle, 'validation'), /validation/);
});

test('evaluator session: the report keeps describing the bundle it ran on and reads stale once the graph moves on', async () => {
  const { graph, ids, ws, artifact } = await acceptedCounter();
  const session = createEvaluatorSession({ workspace: ws, nodeId: ids.evaluator });
  assert.equal(session.snapshot().problem, null);
  const report = await session.run();
  assert.equal(report.successRate, 1);
  assert.equal(session.snapshot().report, report);
  assert.equal(session.snapshot().stale, false);
  graph.patchConfig(ids.cands, { accepted: null });
  assert.match(session.snapshot().problem, /没有已接受的权重/);
  assert.equal(session.snapshot().report, report, 'an edit does not discard the report');
  assert.equal(session.snapshot().stale, true);
  graph.patchConfig(ids.cands, { accepted: artifact.id });
  assert.equal(session.snapshot().stale, false, 'back to the bundle it ran on');
  graph.patchConfig(ids.cands, { accepted: null });
  assert.equal(await session.run(), null);
  assert.match(session.snapshot().error, /没有已接受的权重/);
  assert.equal(session.snapshot().report, null);
  session.dispose();
  assert.ok(session.snapshot().dead);
});

test('evaluator session: a graph edit during an evaluation publishes the report as stale, naming the weights it ran', async () => {
  const { graph, ids, ws, artifact } = await acceptedCounter();
  const other = await makeArtifact({ bundle: buildBundle(graph, ids.trainer), model: counterModel(0) });
  await ws.addArtifact(other);
  const session = createEvaluatorSession({ workspace: ws, nodeId: ids.evaluator });
  let edited = false;
  session.subscribe(kind => { if (kind === 'progress' && !edited) { edited = true; graph.patchConfig(ids.cands, { accepted: other.id }); } });
  const report = await session.run();
  assert.ok(edited, 'the graph changed while the evaluation ran');
  assert.equal(report.successRate, 1, 'the evaluation finished on the weights it started with');
  assert.deepEqual(report.artifacts, { [ids.net]: artifact.id });
  assert.equal(session.snapshot().report, report);
  assert.equal(session.snapshot().stale, true, 'the report describes the bundle before the edit');
  assert.equal((await session.run()).successRate, 0);
  assert.equal(session.snapshot().stale, false);
  session.dispose();
});

test('evaluator session: a report finishing after dispose is not published', async () => {
  const { ids, ws } = await acceptedCounter();
  const session = createEvaluatorSession({ workspace: ws, nodeId: ids.evaluator });
  const seen = [];
  session.subscribe(kind => { seen.push(kind); if (kind === 'progress' && !seen.includes('disposed-here')) { seen.push('disposed-here'); session.dispose(); } });
  assert.equal(await session.run(), null);
  assert.equal(session.snapshot().report, null);
});
