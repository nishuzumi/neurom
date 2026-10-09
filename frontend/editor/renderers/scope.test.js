import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePath, resolveMark, gridModel, seriesModel, tableModel, kvModel, executionScope, reportScope, scriptContext, trainingModuleValues } from './scope.js';
import { counterGraph } from '../../core/fixtures/counter.js';

const miningState = { map: [0, 1, 2, 3, 0, 0, 0, 0, 3], x: 1, y: 2, bagValue: 3, baseX: 0, baseY: 0, radius: 1 };
const execSnap = {
  state: miningState, t: 2, done: false, actions: ['N', 'E'],
  history: [
    { t: 0, prev: { ...miningState, x: 0, y: 0 }, next: { ...miningState, x: 1, y: 0 }, action: 1, actionName: 'E', event: { reward: -1 }, input: [1, 0], scores: [3, 5] },
    { t: 1, prev: { ...miningState, x: 1, y: 0 }, next: miningState, action: 2, actionName: 'S', event: { reward: 2 }, input: [0, 1], scores: [7, 1] },
  ],
  last: null,
};
execSnap.last = execSnap.history[1];

test('paths walk records, map over arrays and index numerically', () => {
  const scope = executionScope(execSnap);
  assert.equal(resolvePath(scope, 'state.x'), 1);
  assert.deepEqual(resolvePath(scope, 'history.event.reward'), [-1, 2]);
  assert.equal(resolvePath(scope, 'history.1.action'), 2);
  assert.equal(resolvePath(scope, 'state.missing.deeper'), undefined);
});

test('marks resolve pairs, literals and numbers', () => {
  const scope = executionScope(execSnap);
  assert.deepEqual(resolveMark(scope, 'state.x,state.y'), [1, 2]);
  assert.equal(resolveMark(scope, '4'), 4);
  assert.equal(resolveMark(scope, '#c9a97a'), '#c9a97a');
  assert.deepEqual(resolveMark(scope, 'var(--bg),#fff'), ['var(--bg)', '#fff']);
});

test('grid model reproduces the mining map: tiles, agent, base, radius and the trail from history', () => {
  const g = gridModel(executionScope(execSnap), 'state.map', { x: 'state.x', y: 'state.y', baseX: 'state.baseX', baseY: 'state.baseY', radius: 'state.radius' });
  assert.equal(g.problem, null);
  assert.deepEqual([g.width, g.height], [3, 3]);
  assert.equal(g.tiles[g.index(1, 0)], 3);                 // mining order: index = x·N + y
  assert.deepEqual(g.agent, [1, 2]); assert.deepEqual(g.base, [0, 0]); assert.equal(g.radius, 1);
  assert.deepEqual(g.trail, [[0, 0], [1, 0], [1, 2]]);
});

test('grid model draws an empty memory-map grid from width/height marks with agent and target', () => {
  const scope = executionScope({ state: { x: 2, y: 2, tx: 5, ty: 0, grid: 6 }, history: [], t: 0 });
  const g = gridModel(scope, 'state', { width: 'state.grid', height: 'state.grid', agent: 'state.x,state.y', target: 'state.tx,state.ty' });
  assert.equal(g.tiles, null); assert.deepEqual([g.width, g.height], [6, 6]);
  assert.deepEqual(g.agent, [2, 2]); assert.deepEqual(g.target, [5, 0]); assert.deepEqual(g.trail, []);
  assert.equal(gridModel(scope, 'state', {}).problem, 'size');
});

test('grid model at a past step uses that step state and truncates the trail', () => {
  const g = gridModel(executionScope(execSnap, 0), 'state.map', { agent: 'state.x,state.y' });
  assert.deepEqual(g.agent, [1, 0]); assert.deepEqual(g.trail, [[0, 0], [1, 0]]);
});

test('series model: one line, a record of lines, extra mark lines and x labels', () => {
  const report = { role: 'test', metrics: { successRate: { mean: 0.5, n: 4 } }, groups: { axis: 'delay', rows: [{ key: '0', successRate: 1, meanReturn: 2 }, { key: '4', successRate: 0.5, meanReturn: 1 }] }, episodes: [] };
  const s = seriesModel(reportScope(report), 'report.groups.rows.successRate', { x: 'report.groups.rows.key', return: 'report.groups.rows.meanReturn' });
  assert.deepEqual(s.series.map(x => x.name), ['successRate', 'return']);
  assert.deepEqual(s.labels, ['0', '4']); assert.deepEqual([s.min, s.max], [0.5, 2]);
  const curves = seriesModel({ curves: { loss: [1, 0.5], metric: [0, 1] } }, 'curves', {});
  assert.deepEqual(curves.series.map(x => x.name), ['loss', 'metric']);
  assert.deepEqual(seriesModel({ a: 'nope' }, 'a', {}).series, []);
});

test('table model: auto columns flatten one level; named marks pick columns', () => {
  const report = { episodes: [{ episode: { seed: 1 }, steps: 3, success: true, return: 2, metrics: { ret: 2 } }, { episode: { seed: 2 }, steps: 4, success: false, return: 0, metrics: { ret: 0 } }] };
  const auto = tableModel(reportScope(report), 'report.episodes', {});
  assert.deepEqual(auto.columns.map(c => c.key), ['episode.seed', 'steps', 'success', 'return', 'metrics.ret']);
  assert.deepEqual(auto.rows[1], [2, 4, false, 0, 0]);
  const named = tableModel(reportScope(report), 'report.episodes', { seed: 'episode.seed', ok: 'success', limit: '1' });
  assert.deepEqual(named.columns.map(c => c.key), ['seed', 'ok']); assert.equal(named.rows.length, 1); assert.equal(named.total, 2);
});

test('kv model flattens report metrics to depth 2', () => {
  const kv = kvModel(reportScope({ metrics: { settled: { mean: 1.5, n: 8 }, successRate: { mean: 0.25, n: 8 } } }), 'report.metrics', {});
  assert.deepEqual(kv.map(x => x.key), ['settled.mean', 'settled.n', 'successRate.mean', 'successRate.n']);
  assert.deepEqual(kvModel({ v: 3 }, 'v', {}), [{ key: 'v', value: 3 }]);
});

test('a view script reads its training module by title: static values per port, the failures listed, nothing outside one', () => {
  const { graph, group, ids } = counterGraph();
  const view = graph.addNode({ kind: 'view', title: 'map', config: { renderer: 'script' } });
  graph.addToGroup(group.id, view.id);
  assert.deepEqual(trainingModuleValues(graph, graph.resolved(), view.id), { modules: {}, errors: [] }, 'a group without a prefab record is no training module');
  graph.setPrefab(group.id, { slots: [], expect: [] });
  let values = trainingModuleValues(graph, graph.resolved(), view.id);
  assert.deepEqual(values.modules.params, { params: { target: 3, budget: 5 } });
  assert.deepEqual(values.modules.map, {}, 'a member without static outputs is still listed');
  assert.ok(Object.hasOwn(values.modules, 'loop'), 'members of nested groups (the loop box) too');
  graph.patchConfig(ids.params, { fields: { target: { type: 'int', min: 1, max: 10, default: 50 }, budget: { type: 'int', min: 1, max: 100, default: 5 } } });
  values = trainingModuleValues(graph, graph.resolved(), view.id);
  assert.deepEqual(values.modules.params, {}, 'a value breaking its declaration is not handed over');
  // the scene's const `budget` reads those params, so it fails too. The other members keep their values
  assert.deepEqual(values.errors.map(e => [e.module, e.port]).sort(), [['counter scene', 'budget'], ['params', 'params']]);
});

test('a view script ctx: the run data at the scrubbed step, flagged live only when following the run', () => {
  const values = { modules: { params: { params: { grid: 12 } } }, errors: [] };
  const at0 = scriptContext(executionScope(execSnap, 0), 'execution', false, values);
  assert.deepEqual(at0.state, execSnap.history[0].next);
  assert.equal(at0.history.length, 1);
  assert.equal(at0.live, false);
  assert.equal(at0.modules.params.params.grid, 12);
  assert.ok(!('execution' in at0), 'not the whole snapshot again');
  assert.equal(scriptContext(executionScope(execSnap), 'execution', true, values).live, true);
  const report = scriptContext(reportScope({ metrics: { win: 1 }, role: 'test' }), 'evaluator', true, values);
  assert.deepEqual([report.source, report.metrics, report.live, 'state' in report], ['report', { win: 1 }, false, false]);
});
