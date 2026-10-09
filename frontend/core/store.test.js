import { test } from 'node:test';
import assert from 'node:assert/strict';
import './kinds/index.js';
import { Workspace, makeArtifact, validateArtifact, artifactSpec, StoreError, RestoreError, WORKSPACE_FORMAT } from './store.js';
import { buildBundle, bundleHash } from './bundle.js';
import { COUNTER_YAML, counterGraph } from './fixtures/counter.js';
import { counterModel } from './sessions/fixtures.js';

const model = counterModel(1);

test('artifact: canonical id, tamper detection, derived spec', async () => {
  const { graph, ids } = counterGraph();
  const bundle = buildBundle(graph, ids.trainer);
  const a = await makeArtifact({ bundle, model, provenance: { run: 'r1' }, evaluation: { score: 1 } });
  assert.match(a.id, /^0x[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(a.bundle.env));
  const b = await makeArtifact({ model, bundle, evaluation: { score: 1 }, provenance: { run: 'r1' } });
  assert.equal(a.id, b.id, 'key order does not change the id');
  assert.deepEqual(await validateArtifact(JSON.parse(JSON.stringify(a))), a);
  const tampered = JSON.parse(JSON.stringify(a)); tampered.model.layers[0].W[0][0] = 9;
  await assert.rejects(validateArtifact(tampered), error => error instanceof StoreError && /摘要不匹配/.test(error.message));
  await assert.rejects(validateArtifact({ ...a, format: 'nope' }), StoreError);
  assert.deepEqual(artifactSpec(a), { engine: 'dense-policy', kind: 'lif', inputs: 3, outputs: 2, weightBits: 8, layers: [{ hidden: 8 }], ticks: 2, leak_shift: 2, reset: 0, readout: { mode: 'argmax', map: [0, 1], width: 2 } });
  graph.patchConfig(ids.cands, { accepted: a.id });
  await assert.rejects(makeArtifact({ bundle: buildBundle(graph, ids.evaluator, { artifacts: () => a }), model }), /网络结构/, 'an artifact is the model of a trained network');
});

test('workspace: templates, runs, artifacts, datasets and settings round-trip through JSON with validation', async () => {
  const ws = new Workspace();
  const events = [];
  ws.subscribe(what => events.push(what));
  const template = ws.addTemplate(COUNTER_YAML);
  assert.throws(() => ws.addTemplate(COUNTER_YAML), /已存在/);
  assert.equal(ws.template('counter-task').revision, 1);
  const { graph, ids } = counterGraph();
  const bundle = buildBundle(graph, ids.trainer);
  const artifact = await makeArtifact({ bundle, model });
  await ws.addArtifact(artifact);
  ws.addRun({ id: 'run-1', trainer: ids.trainer, bundleHash: await bundleHash(bundle), status: 'running', startedAt: 1 });
  ws.updateRun('run-1', { status: 'done', candidates: [artifact.id] });
  assert.throws(() => ws.updateRun('run-1', { status: 'exploded' }), StoreError);
  assert.throws(() => ws.addRun({ id: 'run-2', trainer: 'x', bundleHash: 'nope', status: 'queued' }), StoreError);
  ws.addDataset({ id: 'ds1', name: 'prices', hash: artifact.id, columns: ['open', 'close'], rows: 100 });
  ws.updateSettings({ chainId: 31337 });
  ws.graph.addNode({ kind: 'text', config: { text: 'hello' } });
  assert.deepEqual(new Set(events), new Set(['templates', 'artifacts', 'runs', 'datasets', 'settings', 'graph']));

  const json = JSON.parse(JSON.stringify(ws.toJSON()));
  assert.equal(json.format, WORKSPACE_FORMAT);
  const back = await Workspace.restore(json);
  assert.deepEqual(back.toJSON(), ws.toJSON());
  assert.deepEqual(back.template('counter-task'), template);
  assert.equal(back.artifact(artifact.id).id, artifact.id);
  assert.equal(back.runs.get('run-1').status, 'done');

  const broken = structuredClone(json); broken.runs[0].candidates = ['0x' + 'ab'.repeat(32)];
  await assert.rejects(Workspace.restore(broken), /不存在的产物/);
  const tampered = structuredClone(json); tampered.artifacts[0].evaluation = { score: 2 };
  await assert.rejects(Workspace.restore(tampered), /摘要不匹配/);
  await assert.rejects(Workspace.restore({ format: 'neurom-workbench' }), /templates：工作区缺少数组 templates/);
});

test('restore: a save that cannot be restored says which format it has and where it failed', async () => {
  const ws = new Workspace();
  const text = ws.graph.addNode({ kind: 'text', config: { text: 'hello' } });
  ws.addRun({ id: 'run-1', trainer: text.id, bundleHash: '0x' + 'ab'.repeat(32), status: 'done' });
  const json = JSON.parse(JSON.stringify(ws.toJSON()));
  const reason = async save => { try { await Workspace.restore(save); } catch (error) { assert.ok(error instanceof RestoreError && error instanceof StoreError); return error.reason; } assert.fail('restored'); };

  assert.deepEqual(await reason({ ...json, format: 'neurom-graph' }),
    { format: 'neurom-graph', path: 'format', message: '需要 neurom-workbench 工作区' });
  assert.deepEqual(await reason(null),
    { format: null, path: 'format', message: '需要 neurom-workbench 工作区' });
  const noFormat = structuredClone(json); delete noFormat.format;
  assert.deepEqual(await reason(noFormat),
    { format: null, path: 'format', message: '需要 neurom-workbench 工作区' });

  const unknownField = structuredClone(json); unknownField.graph.nodes[0].config.threshold = 1;
  assert.deepEqual(await reason(unknownField),
    { format: 'neurom-workbench', path: 'graph.nodes[0].config', message: '未知配置项 threshold' });
  const wrongType = structuredClone(json); wrongType.graph.nodes[0].config.text = 5;
  assert.deepEqual(await reason(wrongType),
    { format: 'neurom-workbench', path: 'graph.nodes[0].config.text', message: '配置 text：必须是字符串' });
  const badRun = structuredClone(json); badRun.runs[0].status = 'exploded';
  assert.deepEqual(await reason(badRun),
    { format: 'neurom-workbench', path: 'runs[0]', message: '运行记录 run-1 的状态 exploded 未知' });
  const noArray = structuredClone(json); delete noArray.datasets;
  assert.equal((await reason(noArray)).path, 'datasets');
  await assert.rejects(Workspace.restore(unknownField), error => error.message.includes('graph.nodes[0].config') && error.message.includes('未知配置项 threshold'), 'the message carries the path and the reason');

  const notJson = await Workspace.parse('{"format": "neurom-workbench",').then(() => null, error => error.reason);
  assert.deepEqual({ ...notJson, message: undefined }, { format: null, path: '', message: undefined });
  assert.match(notJson.message, /^不是 JSON/, 'a file that is not JSON fails the same way');
  assert.deepEqual((await Workspace.restore(json)).toJSON(), ws.toJSON(), 'a valid save restores unchanged');
});
