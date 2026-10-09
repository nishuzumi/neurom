import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBundle } from '../bundle.js';
import { makeArtifact } from '../store.js';
import { importDataset } from './dataset.js';
import { bundlePins } from './pinned.js';
import { acceptedCounter, counterModel, datasetWorkspace } from './fixtures.js';

test('pin: the current bundle with the rows of every table it names, checked against the hash it pins', async () => {
  const { ws, store, meta, ids } = await datasetWorkspace();
  const pins = bundlePins(ws, ids.trainer, { datasets: store });
  const pin = await pins.pin();
  assert.equal(pin.bundle, pins.current().bundle);
  assert.deepEqual(Object.keys(pin.tables), [meta.id]);
  assert.deepEqual(Array.from(pin.tables[meta.id].close).slice(0, 3), [0, 10, 20]);
  assert.equal(await pins.pin(), pin, 'an unchanged graph pins the same bundle and rows');

  await assert.rejects(bundlePins(ws, ids.trainer).pin(), /缺少数据集/, 'no dataset store');
  await store.put(meta.id, await importDataset('open,close\n1,1'));
  ws.graph.moveNode(ids.ds, 5, 5);                                      // a new cache entry: the rows are read again
  await assert.rejects(pins.pin(), /哈希不符/);
  ws.graph.disconnect(ws.graph.producers(ids.trainer, 'objective')[0].wire.id);
  await assert.rejects(pins.pin(), /objective/, 'a graph problem cannot be pinned');
});

test('stale: a pin is stale while the graph describes another bundle (or none), not after unrelated edits', async () => {
  const { graph, ids, ws, artifact } = await acceptedCounter();
  const pins = bundlePins(ws, ids.evaluator);
  const pin = await pins.pin();
  assert.equal(pins.stale(pin), false);
  graph.moveNode(ids.net, 300, 300);
  assert.notEqual(pins.current().bundle, pin.bundle, 'a fresh bundle object …');
  assert.equal(pins.stale(pin), false, '… with the same content');
  const other = await makeArtifact({ bundle: buildBundle(graph, ids.trainer), model: counterModel(0) });
  await ws.addArtifact(other);
  graph.patchConfig(ids.cands, { accepted: other.id });
  assert.equal(pins.stale(pin), true);
  graph.patchConfig(ids.cands, { accepted: null });
  assert.ok(pins.current().problem);
  assert.equal(pins.stale(pin), true, 'no current bundle: every pin is stale');
  graph.patchConfig(ids.cands, { accepted: artifact.id });
  assert.equal(pins.stale(pin), false);
});

test('run: a result is published only when no later run started and the pins were not disposed', async () => {
  const { ids, ws } = await acceptedCounter();
  const pins = bundlePins(ws, ids.evaluator);
  let release;
  const slow = pins.run(async pin => { await new Promise(r => { release = r; }); return pin.bundle.loop.trained; });
  await new Promise(r => setTimeout(r, 0));
  const fast = await pins.run(async () => 'fast');
  assert.equal(fast.value, 'fast');
  assert.equal(fast.pin.bundle, pins.current().bundle, 'the result carries the pin it was made from');
  release();
  assert.equal(await slow, null, 'superseded by the later run');
  await assert.rejects(pins.run(() => { throw new Error('boom'); }), /boom/, 'a failing job rejects');
  const late = pins.run(async () => { await new Promise(r => setTimeout(r, 0)); return 1; });
  pins.dispose();
  assert.equal(await late, null);
  assert.equal(await pins.run(async () => 1), null, 'nothing is published after dispose');
});
