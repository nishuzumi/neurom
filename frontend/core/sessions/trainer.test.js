import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workspace } from '../store.js';
import { bundleHash, buildBundle } from '../bundle.js';
import { createTrainerSession } from './trainer.js';
import { WorkspaceClient } from './workspace-client.js';
import { counterArtifact, counterModel, datasetWorkspace } from './fixtures.js';

const result = () => ({ model: counterModel(1), evaluation: { metricName: 'return', metric: 3, selectedEpoch: 1, curves: { loss: [1] }, validation: {} }, provenance: { method: 'reinforce', backend: 'browser', seed: 1, epochs: 10, bundleHash: '0x' + '0'.repeat(64), recipe: {} } });

/** A worker stand-in: the test settles it by hand. */
function fakeBrowser() {
  const calls = [];
  const browser = (bundle, { onProgress }) => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const call = { bundle, onProgress, resolve, reject, cancelled: false, cancel: () => { call.cancelled = true; reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); } };
    calls.push(call);
    return { promise, cancel: call.cancel, runId: 'w' };
  };
  return { browser, calls };
}
const tick = () => new Promise(r => setTimeout(r, 0));
/** Resolves once `cond()` holds. Finishing a run hashes its artifact (crypto.subtle settles off the event loop). A
 *  Python run is followed by polling. So no fixed number of ticks or milliseconds is guaranteed to cover it. */
async function until(cond, timeoutMs = 5000) {
  for (const end = Date.now() + timeoutMs; !cond();) {
    if (Date.now() > end) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise(r => setTimeout(r, 5));
  }
}

test('browser run: bundle → run record → artifact linked on completion; progress flows through the snapshot', async () => {
  const { graph, ids, bundle } = await counterArtifact();
  const ws = new Workspace(graph);
  const { browser, calls } = fakeBrowser();
  let clock = 1000;
  const changes = [];
  ws.subscribe(what => changes.push(what));                           // the app persists on every Workspace change
  const s = createTrainerSession({ workspace: ws, nodeId: ids.trainer, browser, now: () => clock });
  assert.equal(s.snapshot().problem, null);
  assert.deepEqual(s.snapshot().can, { start: true, cancel: false });
  const id = await s.start();
  assert.deepEqual(calls[0].bundle, bundle, 'the worker receives the node bundle');
  const run = ws.runs.get(id);
  assert.equal(run.status, 'running');
  assert.equal(run.bundleHash, await bundleHash(bundle));
  assert.deepEqual(run.bundle, bundle, 'active runs keep their bundle');
  assert.deepEqual(s.snapshot().can, { start: false, cancel: true });
  await assert.rejects(s.start(), /运行中/);
  calls[0].onProgress({ epoch: 1, epochs: 10, loss: 0.5 });
  assert.deepEqual(s.snapshot().active.progress, { epoch: 1, epochs: 10, loss: 0.5 });
  assert.deepEqual(ws.runs.get(id).progress, { epoch: 1, epochs: 10, loss: 0.5 }, 'first progress is persisted');
  clock += 10; calls[0].onProgress({ epoch: 2, epochs: 10, loss: 0.4 });
  assert.equal(ws.runs.get(id).progress.epoch, 1, 'persisted progress is throttled');
  calls[0].resolve(result());
  await until(() => ws.runs.get(id).status !== 'running');
  const done = ws.runs.get(id);
  assert.equal(done.status, 'done');
  assert.equal(done.candidates.length, 1);
  assert.equal(done.bundle, undefined, 'the artifact carries the bundle from now on');
  assert.equal(done.metric, 3);
  const artifact = ws.artifact(done.candidates[0]);
  assert.deepEqual(artifact.bundle, bundle);
  assert.deepEqual(artifact.model, counterModel(1));
  assert.ok(changes.includes('runs'));
  assert.deepEqual(s.snapshot().can, { start: true, cancel: false });
  assert.equal(s.snapshot().runs[0].id, id);
  s.dispose();
});

test('browser run: cancel → cancelled, failure → failed with the message; a graph problem blocks start', async () => {
  const { graph, ids } = await counterArtifact();
  const ws = new Workspace(graph);
  const { browser, calls } = fakeBrowser();
  const s = createTrainerSession({ workspace: ws, nodeId: ids.trainer, browser });
  const a = await s.start();
  await s.cancel();
  await tick();
  assert.equal(ws.runs.get(a).status, 'cancelled');
  assert.equal(ws.runs.get(a).error, null);
  const b = await s.start();
  calls[1].reject(new Error('boom'));
  await tick();
  assert.equal(ws.runs.get(b).status, 'failed');
  assert.equal(ws.runs.get(b).error, 'boom');
  await assert.rejects(s.cancel(), /没有可取消/);
  graph.disconnect(graph.producers(ids.trainer, 'objective')[0].wire.id);
  assert.match(s.snapshot().problem, /objective/);
  await assert.rejects(s.start(), /objective/);
  s.remove(a);
  assert.equal(ws.runs.has(a), false);
});

/** Fake fetch for the Python protocol: an in-memory run table the test advances. */
function fakeServer() {
  const runs = new Map(), submitted = [];
  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
  const fetch = async (url, { method = 'GET', body } = {}) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/session') return json(200, { token: 'tok', capabilities: { methods: ['reinforce'] } });
    if (path === '/api/runs' && method === 'POST') {
      const { run } = JSON.parse(body);
      submitted.push(run);
      if (runs.has(run.id) && runs.get(run.id).bundleHash !== run.bundleHash) return json(409, { error: 'conflict' });
      runs.set(run.id, { id: run.id, status: 'queued', progress: null, bundleHash: run.bundleHash });
      return json(200, { run: runs.get(run.id) });
    }
    const m = path.match(/^\/api\/runs\/([^/?]+)$/);
    if (m && method === 'GET') return runs.has(m[1]) ? json(200, runs.get(m[1])) : json(404, { error: 'no such run' });
    if (m && method === 'DELETE') { const r = runs.get(m[1]); if (r) r.status = 'cancelled'; return json(200, { run: r }); }
    return json(404, { error: 'nope' });
  };
  return { fetch, runs, submitted };
}

test('python run: submit, follow by polling, artifact on completion; recover re-attaches after a reload', async () => {
  const { graph, ids } = await counterArtifact();
  const ws = new Workspace(graph);
  graph.patchConfig(ids.trainer, { backend: 'python' });
  const bundle = buildBundle(graph, ids.trainer);
  const server = fakeServer();
  const client = new WorkspaceClient('', { fetch: server.fetch, EventSource: undefined });
  const s = createTrainerSession({ workspace: ws, nodeId: ids.trainer, client });
  const id = await s.start();
  assert.equal(server.runs.get(id).bundleHash, await bundleHash(bundle));
  assert.equal(ws.runs.get(id).status, 'queued');
  server.runs.get(id).status = 'completed'; server.runs.get(id).result = result();
  await until(() => !['queued', 'running'].includes(ws.runs.get(id).status));
  assert.equal(ws.runs.get(id).status, 'done');
  s.dispose();

  // simulate a reload while the run was still in flight: the record is active and still holds its bundle
  const json = JSON.parse(JSON.stringify(ws.toJSON()));
  json.runs = json.runs.map(r => ({ ...r, status: 'running', candidates: [], bundle }));
  json.artifacts = [];
  const back = await Workspace.restore(json);
  const client2 = new WorkspaceClient('', { fetch: server.fetch, EventSource: undefined });
  const s2 = createTrainerSession({ workspace: back, nodeId: ids.trainer, client: client2 });
  await s2.recover();
  await until(() => back.runs.get(id).status !== 'running');
  const run = back.runs.get(id);
  assert.equal(run.status, 'done');
  assert.equal(back.artifacts.size, 1);
  assert.deepEqual(back.artifact(run.candidates[0]).bundle, bundle);
  s2.dispose();

  // a browser run cannot be recovered
  const json2 = JSON.parse(JSON.stringify(ws.toJSON()));
  json2.runs = json2.runs.map(r => ({ ...r, status: 'running', backend: 'browser', candidates: [] })); json2.artifacts = [];
  const back2 = await Workspace.restore(json2);
  const s3 = createTrainerSession({ workspace: back2, nodeId: ids.trainer });
  await s3.recover();
  assert.equal(back2.runs.get(id).status, 'failed');
  assert.match(back2.runs.get(id).error, /重新加载/);
});

test('python run: a dataset-backed bundle travels with its pinned table rows; recovery still finishes the run', async () => {
  const { ws, store, meta, ids } = await datasetWorkspace();
  ws.graph.patchConfig(ids.trainer, { backend: 'python' });
  const server = fakeServer();
  const s = createTrainerSession({ workspace: ws, nodeId: ids.trainer, datasets: store, client: new WorkspaceClient('', { fetch: server.fetch, EventSource: undefined }) });
  const id = await s.start();
  const sent = server.submitted.at(-1);
  assert.equal(sent.id, id);
  assert.deepEqual(sent.bundle.env.tables.map(tb => tb.id), [meta.id]);
  assert.deepEqual(Object.keys(sent.tables), [meta.id], 'the table the bundle names is submitted with it');
  assert.deepEqual(sent.tables[meta.id].close, Array.from({ length: 20 }, (_, i) => i * 10), 'as plain JSON numbers');
  assert.deepEqual(sent.tables[meta.id].open, Array.from({ length: 20 }, (_, i) => i));
  s.dispose();

  // after a reload the run is re-attached from its record, and the Python side holds the rows it was given
  const back = await Workspace.restore(JSON.parse(JSON.stringify(ws.toJSON())));
  assert.deepEqual(back.runs.get(id).bundle, sent.bundle, 'the record keeps the bundle for recovery');
  server.runs.get(id).status = 'running';
  const s2 = createTrainerSession({ workspace: back, nodeId: ids.trainer, datasets: store, client: new WorkspaceClient('', { fetch: server.fetch, EventSource: undefined }) });
  await s2.recover();
  assert.equal(s2.snapshot().active?.id, id, 'followed again');
  server.runs.get(id).status = 'failed'; server.runs.get(id).error = 'stopped';
  await until(() => back.runs.get(id).status === 'failed');
  assert.equal(back.runs.get(id).error, 'stopped');
  assert.equal(server.submitted.length, 1, 'recovery follows the submitted run; nothing is resubmitted');
  s2.dispose();
});

test('python run: a failed submission is recorded; a python backend without a client is a problem', async () => {
  const { graph, ids } = await counterArtifact();
  const ws = new Workspace(graph);
  graph.patchConfig(ids.trainer, { backend: 'python' });
  assert.match(createTrainerSession({ workspace: ws, nodeId: ids.trainer }).snapshot().problem, /Workspace/);
  const fetch = async url => (url.endsWith('/api/session') ? { ok: true, status: 200, json: async () => ({}) } : { ok: false, status: 500, text: async () => JSON.stringify({ error: 'invalid bundle' }) });
  const s = createTrainerSession({ workspace: ws, nodeId: ids.trainer, client: new WorkspaceClient('', { fetch, EventSource: undefined }) });
  await assert.rejects(s.start(), /invalid bundle/);
  const run = [...ws.runs.values()][0];
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'invalid bundle');
});
