import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../kinds/index.js';
import { Workspace } from '../store.js';
import { createEnv } from '../runner.js';
import { importDataset, parseCSV, parseJSON, datasetHash, createMemoryDatasetStore, importInto, reclaimDatasets, RECLAIM_AFTER_MS, createDatasetSession, DatasetError, LIMITS } from './dataset.js';
import { bundlePins } from './pinned.js';
import { datasetWorkspace } from './fixtures.js';

const CSV = 'open,close\n1,2\n3,4.5\n"5",6\n';

test('hash: the same data hashes the same across formats and column order; different data differs', async () => {
  const csv = await importDataset(CSV);
  const json = await importDataset(JSON.stringify([{ open: 1, close: 2 }, { open: 3, close: 4.5 }, { open: 5, close: 6 }]));
  const swapped = await importDataset('close,open\n2,1\n4.5,3\n6,5');
  assert.deepEqual(csv.columns, ['open', 'close']);
  assert.deepEqual(csv.rows, [[1, 2], [3, 4.5], [5, 6]]);
  assert.equal(csv.hash, json.hash);
  assert.equal(csv.hash, swapped.hash, 'column order is not identity');
  assert.notEqual(csv.hash, (await importDataset('open,close\n1,2\n3,4.5\n5,7')).hash);
  assert.equal(await datasetHash(parseJSON({ columns: ['open', 'close'], rows: [[1, 2], [3, 4.5], [5, 6]] })), csv.hash);
  assert.deepEqual(Array.from(csv.table.close), [2, 4.5, 6]);
});

test('bounds and shape errors', async () => {
  assert.throws(() => parseCSV('a,b\n1'), /1 个值/);
  assert.throws(() => parseCSV('a,b\n1,x'), /不是有限数/);
  assert.throws(() => parseCSV('a\n'), /表头/);
  assert.throws(() => parseCSV('a,b\n"1,2'), /引号/);
  assert.throws(() => parseJSON([{ a: 1 }, { b: 2 }]), /字段/);
  assert.throws(() => parseJSON({ a: [1, 2], b: [1] }), /长度/);
  await assert.rejects(importDataset('a,a\n1,2'), /重复/);
  await assert.rejects(importDataset('1x,b\n1,2'), /不合法/);
  await assert.rejects(importDataset(Array.from({ length: LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(',') + '\n' + Array(LIMITS.maxColumns + 1).fill('0').join(',')), /最多 256 列/);
  await assert.rejects(importDataset('a;b\n1;true'), DatasetError, 'booleans are accepted only in JSON');
  assert.deepEqual((await importDataset('a;b\n1;2')).rows, [[1, 2]], 'semicolon separator');
});

test('importInto: node config, workspace metadata and runner tables; re-import pins new rows under a new id', async () => {
  const ws = new Workspace(), store = createMemoryDatasetStore();
  const ds = ws.graph.addNode({ kind: 'dataset', title: 'prices' });
  const meta = await importInto({ workspace: ws, store, nodeId: ds.id, text: CSV });
  assert.deepEqual(ws.graph.node(ds.id).config, { datasetId: meta.id, name: 'prices', columns: ['open', 'close'], rows: 3, hash: meta.hash });
  assert.equal(ws.datasets.get(meta.id).rows, 3);
  const again = await importInto({ workspace: ws, store, nodeId: ds.id, text: 'open,close\n9,9' });
  assert.notEqual(again.id, meta.id, 'the rows of an id never change: other content is another id');
  assert.equal(ws.graph.node(ds.id).config.datasetId, again.id);
  assert.equal(ws.graph.node(ds.id).config.rows, 1);
  assert.deepEqual([...ws.datasets.keys()], [again.id], 'the workspace lists the datasets its modules declare');
  assert.equal((await store.get(again.id)).columns.open[0], 9);
  assert.equal((await store.get(meta.id)).hash, meta.hash, 'the rows a bundle pinned stay as they were');
});

test('re-import: a copied dataset module and a refused import leave every declared table resolvable', async () => {
  const ws = new Workspace(), store = createMemoryDatasetStore();
  const a = ws.graph.addNode({ kind: 'dataset', title: 'prices' });
  const first = await importInto({ workspace: ws, store, nodeId: a.id, text: CSV });
  const b = ws.graph.addNode({ kind: 'dataset', title: 'copy', config: structuredClone(ws.graph.node(a.id).config) });
  await importInto({ workspace: ws, store, nodeId: b.id, text: 'open,close\n9,9' });
  const declared = async id => { const c = ws.graph.node(id).config; return { config: c.hash, stored: (await store.get(c.datasetId))?.hash, meta: ws.datasets.get(c.datasetId)?.hash }; };
  assert.deepEqual(await declared(a.id), { config: first.hash, stored: first.hash, meta: first.hash }, 'importing into the copy leaves the original’s rows');
  await assert.rejects(importInto({ workspace: ws, store, nodeId: a.id, text: 'open,close\n5,5', name: 'x'.repeat(201) }), /200/);
  assert.deepEqual(await declared(a.id), { config: first.hash, stored: first.hash, meta: first.hash }, 'a refused import changes nothing a module declares');
  const c = ws.graph.node(b.id).config;
  assert.deepEqual(await declared(b.id), { config: c.hash, stored: c.hash, meta: c.hash });
  assert.equal(ws.datasets.size, 2);
});

test('a window-partitioned scenario reads the pinned table through the bundle', async () => {
  const { ws, store, meta, ids } = await datasetWorkspace();
  const pins = bundlePins(ws, ids.trainer, { datasets: store });
  const { bundle, tables } = await pins.pin();
  assert.equal(bundle.env.tables[0].id, meta.id);
  assert.equal(bundle.env.tables[0].hash, ws.graph.node(ids.ds).config.hash);
  const runner = createEnv(bundle.env, { tables });
  runner.reset({ start: 4, length: 4 });
  assert.deepEqual(runner.input(), [0, 0], 'close at row 4 = 40 → below both edges');
  const tr = runner.step(1);
  assert.equal(tr.next.price, 50);
  assert.deepEqual(runner.input(), [1, 0]);
});

test('reclaim: old rows nothing in an adopted workspace references are deleted; declared, listed and pinned ones stay', async () => {
  let clock = 1_000_000;
  const now = () => clock;
  const { ws, store, meta, ids } = await datasetWorkspace(undefined, { now });
  const pinned = (await importInto({ workspace: ws, store, nodeId: ids.ds, text: 'open,close\n1,1\n2,2' })).id;
  ws.addRun({ id: 'run-1', trainer: ids.trainer, bundleHash: meta.hash, status: 'running', bundle: { env: { tables: [{ id: pinned, hash: meta.hash }] } } });
  const current = (await importInto({ workspace: ws, store, nodeId: ids.ds, text: 'open,close\n3,3' })).id;
  const listed = 'ds-listed';
  await store.put(listed, await importDataset('a\n1')); ws.addDataset({ id: listed, name: 'listed', hash: meta.hash, columns: ['a'], rows: 1 });
  assert.deepEqual((await store.ids()).sort(), [current, listed, meta.id, pinned].sort(), 'nothing is reclaimed during the session');
  clock += RECLAIM_AFTER_MS + 1;
  assert.deepEqual(await reclaimDatasets(ws, store, { now }), [meta.id], 'the first import: no module, run, artifact or metadata names it');
  assert.deepEqual((await store.ids()).sort(), [current, listed, pinned].sort());
  assert.deepEqual(await reclaimDatasets(ws, store, { now }), []);
});

test('reclaim: unreferenced rows written recently survive (another tab may not have saved them yet)', async () => {
  let clock = 5_000_000;
  const now = () => clock;
  const ws = new Workspace(), store = createMemoryDatasetStore({ now });
  await store.put('ds-fresh', await importDataset('a\n1'));
  clock += RECLAIM_AFTER_MS;
  assert.deepEqual(await reclaimDatasets(ws, store, { now }), [], 'written exactly RECLAIM_AFTER_MS ago: still kept');
  clock += 1;
  assert.deepEqual(await reclaimDatasets(ws, store, { now }), ['ds-fresh']);
});

test('dataset session: import reports metadata and preview rows; errors are kept', async () => {
  const ws = new Workspace(), store = createMemoryDatasetStore();
  const ds = ws.graph.addNode({ kind: 'dataset', title: 'prices' });
  const s = createDatasetSession({ workspace: ws, store, nodeId: ds.id });
  assert.equal(s.snapshot().meta, null);
  const meta = await s.import(CSV);
  assert.equal(s.snapshot().meta.hash, meta.hash);
  assert.deepEqual(await s.preview(2), { columns: ['open', 'close'], rows: [[1, 2], [3, 4.5]] });
  await assert.rejects(s.import('a,b\n1'), DatasetError);
  assert.match(s.snapshot().error, /1 个值/);
  assert.equal(s.snapshot().meta.hash, meta.hash, 'a failed import keeps the previous data');
  s.dispose();
});
