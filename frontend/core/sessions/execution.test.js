import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeArtifact } from '../store.js';
import { buildBundle } from '../bundle.js';
import { integerStep } from '../../runtime/dense-policy.js';
import { createExecutionSession } from './execution.js';
import { acceptedCounter, counterModel } from './fixtures.js';

/** Manual timers so run() is deterministic. */
function fakeTimers() {
  const queue = [];
  return { setTimeout(fn) { const id = queue.length + 1; queue.push({ id, fn }); return id; }, clearTimeout(id) { const i = queue.findIndex(q => q.id === id); if (i >= 0) queue.splice(i, 1); }, async flush() { while (queue.length) { const { fn } = queue.shift(); await fn(); } }, pending: () => queue.length };
}

test('stepping records the loop’s per-step values and the transition; done halts; reset starts a fresh episode', async () => {
  const { graph, ids, artifact, ws } = await acceptedCounter();
  const s = createExecutionSession({ workspace: ws, nodeId: ids.execution });
  let snap = s.snapshot();
  assert.equal(snap.problem, null);
  assert.deepEqual(snap.episodes, { test: 100 });
  assert.deepEqual(snap.actions, ['stay', 'up']);
  assert.deepEqual(snap.body.map(b => b.id), [ids.net, ids.readout]);
  snap = await s.step();
  assert.deepEqual(snap.episode, { seed: 200000 }, 'default: first episode of the wired partition');
  assert.deepEqual(snap.state, { count: 1, seed: 200000 });
  assert.equal(snap.t, 1);
  const h = snap.history[0];
  assert.deepEqual(h.input, [0, 0, 0]);
  assert.equal(h.action, 1); assert.equal(h.actionName, 'up'); assert.equal(h.manual, false);
  assert.deepEqual([h.done, h.truncated, h.success], [false, false, false]);
  assert.deepEqual(h.ran, [ids.net, ids.readout]);
  assert.deepEqual(h.values[`${ids.net}.scores`], integerStep(artifact.model, [0, 0, 0], new Array(8).fill(0)).scores);
  assert.deepEqual(h.values[`${ids.readout}.bits`], [0, 1]);
  assert.equal(snap.voltages[ids.net].length, 8, 'LIF potentials live on the instance');
  snap = await s.step(0);                                                    // manual "stay"
  assert.equal(snap.last.manual, true); assert.equal(snap.last.action, 0); assert.equal(snap.last.policyAction, 1);
  assert.deepEqual(snap.state, { count: 1, seed: 200000 });
  await s.step(); snap = await s.step();
  assert.equal(snap.done, true); assert.equal(snap.success, true); assert.equal(snap.history.length, 4);
  await assert.rejects(s.step(), /回合已结束/);
  assert.match(s.snapshot().error, /回合已结束/);
  snap = await s.reset();
  assert.equal(snap.t, 0); assert.deepEqual(snap.history, []); assert.equal(snap.error, null); assert.equal(snap.done, false);
  assert.deepEqual(snap.voltages[ids.net], new Array(8).fill(0));

  // explicit episodes: by index into the wired partition or a raw Start record
  s.setEpisode({ role: 'test', index: 3 });
  assert.deepEqual((await s.step()).episode, { seed: 200003 });
  assert.equal(s.setEpisode({ seed: 77 }).problem, null);
  assert.deepEqual((await s.step()).state, { count: 1, seed: 77 });
  assert.match(s.setEpisode({ role: 'training' }).problem, /training/);
  await assert.rejects(s.step(), /training/);
  s.setEpisode(null);

  // other accepted weights make the running loop stale, and reset runs them
  await s.step();
  const other = await makeArtifact({ bundle: buildBundle(graph, ids.trainer), model: counterModel(0) });
  await ws.addArtifact(other);
  graph.patchConfig(ids.cands, { accepted: other.id });
  assert.equal(s.snapshot().stale, true);
  await s.reset();
  snap = await s.step();
  assert.equal(snap.stale, false);
  assert.equal(snap.last.action, 0, 'the other weights always stay');
  graph.patchConfig(ids.cands, { accepted: null });
  assert.match(s.snapshot().problem, /没有已接受的权重/);
  s.dispose();
  assert.ok(s.snapshot().dead);
});

test('run() steps on the clock until done; pause stops it', async () => {
  const { ids, ws } = await acceptedCounter();
  const timers = fakeTimers();
  const s = createExecutionSession({ workspace: ws, nodeId: ids.execution, timers });
  s.run(50);
  assert.equal(s.snapshot().running, true);
  await timers.flush();
  const snap = s.snapshot();
  assert.equal(snap.done, true); assert.equal(snap.running, false); assert.equal(snap.history.length, 3);
  await s.reset(); s.run();
  s.pause();
  assert.equal(s.snapshot().running, false);
  assert.equal(timers.pending(), 0, 'pause cancels the pending tick');
});
