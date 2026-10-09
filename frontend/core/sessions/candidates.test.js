import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workspace, makeArtifact } from '../store.js';
import { buildBundle, bundleHash } from '../bundle.js';
import { createCandidatesSession, compatibility } from './candidates.js';
import { counterArtifact, counterModel } from './fixtures.js';

async function setup() {
  const { graph, ids, bundle, artifact } = await counterArtifact();
  const ws = new Workspace(graph);
  await ws.addArtifact(artifact);
  ws.addRun({ id: 'r1', trainer: ids.trainer, bundleHash: await bundleHash(bundle), status: 'done', candidates: [artifact.id], startedAt: 1, finishedAt: 2, method: 'reinforce', backend: 'browser' });
  return { graph, ids, bundle, artifact, ws };
}

test('candidates: lists artifacts of wired runs, accept feeds the node config, preview is session-local', async () => {
  const { graph, ids, artifact, ws } = await setup();
  const s = createCandidatesSession({ workspace: ws, nodeId: ids.cands });
  const snap = s.snapshot();
  assert.equal(snap.candidates.length, 1);
  assert.equal(snap.candidates[0].id, artifact.id);
  assert.equal(snap.candidates[0].metric, 3);
  assert.deepEqual(snap.candidates[0].compatible, { ok: true, reason: '' });
  assert.equal(snap.reference.trainer, ids.trainer);
  s.preview(artifact.id);
  assert.equal(s.snapshot().candidates[0].previewed, true);
  s.accept(artifact.id);
  assert.equal(graph.node(ids.cands).config.accepted, artifact.id);
  assert.equal(s.snapshot().candidates[0].accepted, true);
  assert.equal(graph.problems().some(p => p.node === ids.evaluator && /接受/.test(p.message)), false, 'the evaluator now has weights');
  assert.throws(() => s.remove(artifact.id), /取消接受/);
  s.clearAccepted();
  assert.equal(graph.node(ids.cands).config.accepted, null);
  assert.throws(() => s.accept('0x' + 'a'.repeat(64)), /不属于/);
  s.remove(artifact.id);
  assert.equal(s.snapshot().candidates.length, 0);
  assert.equal(ws.artifacts.has(artifact.id), false, 'unreferenced artifact is dropped');
  s.dispose();
});

test('compatibility: another loop, structure or readout is refused with a reason; import / export round-trip', async () => {
  const { graph, ids, artifact, ws, bundle } = await setup();
  const s = createCandidatesSession({ workspace: ws, nodeId: ids.cands });
  // an artifact trained with a different network structure
  const { graph: g2, ids: ids2 } = await counterArtifact();
  g2.patchConfig(ids2.net, { layers: [{ hidden: 4 }] });
  const narrow = await makeArtifact({ bundle: buildBundle(g2, ids2.trainer), model: counterModel(0, { hidden: 4 }) });
  assert.equal(compatibility(narrow, bundle).ok, false);
  assert.match(compatibility(narrow, bundle).reason, /网络结构/);
  const imported = await s.importArtifact(JSON.stringify(narrow));
  assert.equal(imported.id, narrow.id);
  const c = s.snapshot().candidates.find(x => x.id === narrow.id);
  assert.equal(c.imported, true);
  assert.equal(c.compatible.ok, false);
  assert.throws(() => s.accept(narrow.id), /不兼容/);
  assert.equal(JSON.parse(s.exportArtifact(artifact.id)).id, artifact.id);
  await assert.rejects(s.importArtifact('{'), /JSON/);
  await assert.rejects(s.importArtifact({ format: 'nope' }), /neurom-module/);
  const tampered = JSON.parse(JSON.stringify(narrow)); tampered.model.output.b = [5, 5];
  await assert.rejects(s.importArtifact(tampered), /摘要/);
  // the same loop with a different params value is another environment
  graph.patchConfig(ids.params, { values: { target: 4 } });
  assert.match(s.snapshot().candidates.find(x => x.id === artifact.id).compatible.reason, /环境/);
  // an unwired candidates node has no reference
  const lone = graph.addNode({ kind: 'candidates' });
  const s2 = createCandidatesSession({ workspace: ws, nodeId: lone.id });
  await s2.importArtifact(narrow);
  assert.equal(s2.snapshot().candidates[0].compatible.ok, null);
  assert.equal(s2.snapshot().reference, null);
  s2.accept(narrow.id);
  assert.equal(graph.node(lone.id).config.accepted, narrow.id);
});
