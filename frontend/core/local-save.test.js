import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workspace, RestoreError } from './store.js';
import { createMemoryArtifactStore, localText, openLocal, savedIds } from './local-save.js';
import { acceptedCounter } from './sessions/fixtures.js';

test('the local save names a stored artifact by its id, and opens to the same workspace', async () => {
  const { ws, artifact, ids } = await acceptedCounter();
  const store = createMemoryArtifactStore(), json = ws.toJSON();
  await store.put(artifact);
  const text = localText(json, new Set([artifact.id]));
  assert.ok(!text.includes('"model"'), 'no model in the text');
  assert.deepEqual(savedIds(text), [artifact.id]);
  const back = await Workspace.parse(await openLocal(text, store));
  assert.deepEqual(back.toJSON(), json);
  assert.equal(back.graph.node(ids.cands).config.accepted, artifact.id);
});

test('an artifact that is not stored yet, or a browser without IndexedDB, keeps the artifact in the text', async () => {
  const { ws } = await acceptedCounter();
  const json = ws.toJSON(), text = localText(json, new Set());
  assert.ok(text.includes('"model"'));
  assert.deepEqual(savedIds(text), []);
  assert.deepEqual((await Workspace.parse(await openLocal(text, null))).toJSON(), json);
});

test('a local save from before the store opens as it is, and a missing artifact refuses the save with its place', async () => {
  const { ws, artifact } = await acceptedCounter();
  const store = createMemoryArtifactStore();
  const old = JSON.stringify(ws.toJSON());
  assert.equal(await openLocal(old, store), old);
  assert.equal(await openLocal('not json', store), 'not json', 'Workspace.parse words the error');
  const text = localText(ws.toJSON(), new Set([artifact.id]));
  for (const s of [store, null]) await assert.rejects(openLocal(text, s), e => e instanceof RestoreError && /artifactIds\[0\]/.test(e.message) && /产物库/.test(e.message));
});
