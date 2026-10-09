import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterGraph } from '../core/fixtures/counter.js';
import { MAX_COLUMNS } from '../core/graph.js';
import { moveSection, sectionColumns, sectionPorts, trainingModule } from './training-module.js';

/** The counter task as one expanded prefab (an empty prefab record: the frame needs one, not its slots), plus
 *  `weights.params → reward.w`, `steps → trainer.metric` and a view on the evaluator's report. */
function counterModule() {
  const { graph, ids, group, groupIds } = counterGraph();
  graph.setGroupLayout(group.id, { collapsed: false });
  graph.setPrefab(group.id, { slots: [], expect: [] });
  const weights = graph.addNode({ kind: 'params', config: { fields: { bonus: { type: 'number', default: 1 } } } });
  const report = graph.addNode({ kind: 'view' });
  graph.patchConfig(ids.reward, { inputs: ['w'], source: 'export function reward(transition) { return transition.action > 0 ? w.bonus : 0; }' });
  graph.connect({ kind: 'value', from: { node: weights.id, port: 'params' }, to: { node: ids.reward, port: 'w' } });
  graph.connect({ kind: 'call', from: { node: ids.steps, port: 'steps' }, to: { node: ids.trainer, port: 'metric' } });
  graph.connect({ kind: 'value', from: { node: ids.evaluator, port: 'report' }, to: { node: report.id, port: 'report' } });
  graph.addToGroup(group.id, report.id); graph.addToGroup(group.id, weights.id);
  return { graph, group, ids: { ...ids, weights: weights.id, report: report.id }, box: groupIds.box };
}
const keys = list => list.map(e => `${e.node}/${e.port}`);

test('sections: drivers, the scenario module, plus satellites wired only to sections (to a fixed point), in column order', () => {
  const { graph, group, ids, box } = counterModule();
  // a random module feeding only the scenario module follows it into the column, placed just before it
  const rng = graph.addNode({ kind: 'random', config: { multiplier: 1664525, increment: 1013904223, draws: 4 } });
  graph.addToGroup(group.id, rng.id);
  graph.patchConfig(ids.scene, { inputs: ['params', 'rng'] });
  graph.connect({ kind: 'value', from: { node: rng.id, port: graph.resolved().portsOf(rng.id).outputs[0].id }, to: { node: ids.scene, port: 'rng' } });
  const tm = trainingModule(graph, group.id);
  assert.ok(tm);
  // the scene is wired into the loop's scenario: a section, although that wire reaches the well. params and rng
  // feed only it, weights feeds only reward, reward feeds only the trainer: all sections
  assert.deepEqual(tm.sections, [ids.seeds, ids.params, rng.id, ids.scene, ids.weights, ids.reward, ids.steps, ids.trainer, ids.cands, ids.evaluator, ids.report, ids.execution]);
  assert.deepEqual(tm.canvas, [box]);
});

test('section ports: canvas-wired and facing ends are feeds, outside or unwired ends are slots, the rest hidden', () => {
  const { graph, group, ids } = counterModule();
  const outside = graph.addNode({ kind: 'view' });
  graph.connect({ kind: 'value', from: { node: ids.execution, port: 'execution' }, to: { node: outside.id, port: 'execution' } });
  graph.disconnect(graph.producers(ids.execution, 'loop')[0].wire.id);
  const tm = trainingModule(graph, group.id);
  const { feeds, inputs, outputs } = sectionPorts(graph, graph.resolved(), tm);
  // execution.loop lost its wire but faces the box: still a feed
  // the scenario module's wires into the loop box are feeds too
  assert.deepEqual(keys(feeds), [`${ids.scene}/module`, `${ids.scene}/actions`, `${ids.trainer}/loop`, `${ids.trainer}/structure`, `${ids.cands}/weights`, `${ids.evaluator}/loop`, `${ids.execution}/loop`]);
  assert.deepEqual(feeds.map(f => f.dir), ['out', 'out', 'in', 'in', 'out', 'in', 'in']);
  // unwired non-facing ports and a port wired outside the frame stay reachable on the outer edges
  assert.ok(keys(inputs).includes(`${ids.evaluator}/objective`));
  assert.ok(keys(outputs).includes(`${ids.cands}/artifact`));
  assert.ok(keys(outputs).includes(`${ids.execution}/execution`));
  assert.ok(keys(inputs).indexOf(`${ids.evaluator}/objective`) < keys(inputs).indexOf(`${ids.report}/execution`), 'section order');
  // an input taking many wires stays reachable for the next one
  assert.ok(keys(inputs).includes(`${ids.cands}/run`));
  // joined only to other sections: not drawn anywhere
  const shown = new Set([...keys(feeds), ...keys(inputs), ...keys(outputs)]);
  for (const hidden of [`${ids.trainer}/objective`, `${ids.trainer}/metric`, `${ids.trainer}/training`, `${ids.trainer}/run`, `${ids.weights}/params`, `${ids.reward}/w`, `${ids.evaluator}/report`]) assert.ok(!shown.has(hidden), hidden);
  // the picked section's outputs are slots, so one can take a second wire to another section. Its inputs stay hidden.
  const picked = (/** @type {string} */ id) => sectionPorts(graph, graph.resolved(), tm, id);
  assert.ok(keys(picked(ids.weights).outputs).includes(`${ids.weights}/params`) && !keys(picked(ids.weights).outputs).includes(`${ids.trainer}/run`));
  assert.ok(keys(picked(ids.trainer).outputs).includes(`${ids.trainer}/run`) && !keys(picked(ids.trainer).inputs).includes(`${ids.trainer}/objective`));
  // picking a code module picks the 「代码」 section: the outputs of every code module are slots
  assert.ok(keys(picked(ids.steps).outputs).includes(`${ids.reward}/reward`) && !keys(sectionPorts(graph, graph.resolved(), tm).outputs).includes(`${ids.reward}/reward`));
});

test('a code module also wired to a canvas member stays on the canvas', () => {
  const { graph, group, ids } = counterModule();
  const net = graph.producers(ids.trainer, 'structure')[0].node;
  const probe = graph.addNode({ kind: 'code', config: { inputs: ['a', 'b'], source: 'export const k = 1;' } });
  graph.addToGroup(group.id, probe.id);
  graph.connect({ kind: 'value', from: { node: ids.trainer, port: 'run' }, to: { node: probe.id, port: 'a' } });
  assert.ok(trainingModule(graph, group.id).sections.includes(probe.id), 'wired only to the trainer');
  graph.connect({ kind: 'value', from: { node: net, port: 'structure' }, to: { node: probe.id, port: 'b' } });
  const tm = trainingModule(graph, group.id);
  assert.ok(!tm.sections.includes(probe.id) && tm.canvas.includes(probe.id));
  // the trainer's run now reaches a canvas member: a feed
  assert.ok(keys(sectionPorts(graph, graph.resolved(), tm).feeds).includes(`${ids.trainer}/run`));
});

test('a frame is an expanded prefab, whatever its trainers', () => {
  const { graph, group, box, ids } = counterModule();
  assert.equal(trainingModule(graph, box), null, 'a group without a prefab record');
  const second = graph.addNode({ kind: 'trainer' });
  graph.addToGroup(group.id, second.id);
  assert.deepEqual(trainingModule(graph, group.id)?.trainers, [ids.trainer, second.id], 'two trainers: still the frame');
  graph.removeNode(ids.trainer); graph.removeNode(second.id);
  assert.deepEqual(trainingModule(graph, group.id)?.trainers, [], 'no trainer: still the frame');
  graph.setGroupLayout(group.id, { collapsed: true });
  assert.equal(trainingModule(graph, group.id), null, 'collapsed');
});

test('a stored split: drawn as placed; stale entries skipped, new sections below their rule predecessor, ports follow', () => {
  const { graph, group, ids } = counterModule();
  const rest = [ids.seeds, ids.params, ids.scene, ids.weights, ids.reward, ids.steps];
  graph.setGroupLayout(group.id, { columns: [[ids.execution, ids.evaluator, 'gone', ids.report], [ids.trainer, ids.cands], rest] });
  assert.deepEqual(trainingModule(graph, group.id)?.split, [[ids.execution, ids.evaluator, ids.report], [ids.trainer, ids.cands], rest]);
  // the sections' ports are listed in the split's order: the execution's feed before the trainer's
  const feeds = keys(sectionPorts(graph, graph.resolved(), /** @type {any} */ (trainingModule(graph, group.id))).feeds);
  assert.ok(feeds.indexOf(`${ids.execution}/loop`) < feeds.indexOf(`${ids.trainer}/loop`));
  // a second evaluator follows the first one's view (its predecessor in ADR 0011 §2's order). Removing a section moves nothing else.
  const ev2 = graph.addNode({ kind: 'evaluator' });
  graph.addToGroup(group.id, ev2.id);
  graph.removeNode(ids.cands);
  assert.deepEqual(trainingModule(graph, group.id)?.split, [[ids.execution, ids.evaluator, ids.report, ev2.id], [ids.trainer], rest]);
  // sections without a placed predecessor start the first column, in rule order. The others follow their predecessor
  // wherever it is (the evaluator the trainer, ev2 the report). A column left with nothing is dropped.
  graph.setGroupLayout(group.id, { columns: [['gone'], [ids.report], [ids.trainer]] });
  assert.deepEqual(trainingModule(graph, group.id)?.split, [[...rest, ids.report, ev2.id, ids.execution], [ids.trainer, ids.evaluator]]);
  graph.setGroupLayout(group.id, { columns: null });
  assert.equal(trainingModule(graph, group.id)?.split, null);
  // a new code module joins the others (they are drawn as one 「代码」 section), not its rule predecessor (the execution)
  const drivers = [ids.trainer, ids.evaluator, ids.report, ev2.id, ids.execution];
  graph.setGroupLayout(group.id, { columns: [drivers, rest] });
  const probe = graph.addNode({ kind: 'code', config: { inputs: ['a'], source: 'export const k = 1;' } });
  graph.addToGroup(group.id, probe.id);
  graph.connect({ kind: 'value', from: { node: ids.trainer, port: 'run' }, to: { node: probe.id, port: 'a' } });
  assert.deepEqual(trainingModule(graph, group.id)?.split, [drivers, [...rest, probe.id]]);
});

test('moving a section: within and across columns, into a new column; empty columns go; at most 16', () => {
  assert.deepEqual(moveSection([['a', 'b'], ['c']], 'c', { column: 0, index: 1 }), [['a', 'c', 'b']]);
  assert.deepEqual(moveSection([['a', 'b'], ['c']], 'b', { column: 1, index: 1 }), [['a'], ['c', 'b']]);
  assert.deepEqual(moveSection([['a', 'b'], ['c']], 'a', { before: 0 }), [['a'], ['b'], ['c']]);
  assert.deepEqual(moveSection([['a', 'b'], ['c']], 'a', { before: 2 }), [['b'], ['c'], ['a']]);
  assert.equal(moveSection([['a', 'b'], ['c']], 'b', { column: 0, index: 1 }), null, 'dropped where it was');
  assert.equal(moveSection([['a'], ['c']], 'a', { before: 1 }), null, 'its own column again');
  const sixteen = Array.from({ length: 16 }, (_, i) => [`s${i}`]);
  assert.equal(moveSection([['x', ...sixteen[0]], ...sixteen.slice(1)], 'x', { before: 0 }), null, 'a 17th column');
  assert.deepEqual(moveSection(sixteen, 's3', { before: 0 })?.[0], ['s3'], 'a lone section opens a new column: still 16');
});

/** a frame alone on its level, its well at the origin (no canvas members), not measured yet */
const room = (neighbours = []) => ({ content: null, corner: { x: 0, y: 0 }, height: undefined, neighbours: () => neighbours });

test('the frame draws its code modules as one 「代码」 section; the split it stores lists them all, adjacent, and draws back the same', () => {
  const { graph, group, ids } = counterModule();
  const columns = sectionColumns(), tm = /** @type {any} */ (trainingModule(graph, group.id));
  const frame = columns.frame(graph, tm, room());
  assert.deepEqual(frame.codes, [ids.scene, ids.reward, ids.steps]);
  assert.deepEqual(frame.sections, [ids.seeds, ids.params, ids.scene, ids.weights, ids.trainer, ids.cands, ids.evaluator, ids.report, ids.execution]);
  assert.deepEqual(frame.columns.flat(), frame.sections, 'an automatic split keeps the drawn order, column by column');
  // a section dropped at the top of a new first column: the split to store spells the 「代码」 section out
  const stored = columns.move(graph, tm, ids.trainer, { before: 0 });
  assert.ok(stored);
  const at = stored.flat().indexOf(ids.scene);
  assert.deepEqual(stored.flat().slice(at, at + 3), [ids.scene, ids.reward, ids.steps]);
  graph.setGroupLayout(group.id, { columns: stored });
  const placed = columns.frame(graph, /** @type {any} */ (trainingModule(graph, group.id)), room());
  assert.deepEqual(placed.columns, moveSection(frame.columns, ids.trainer, { before: 0 }), 'drawn as it was dropped');
  assert.equal(columns.move(graph, /** @type {any} */ (trainingModule(graph, group.id)), ids.trainer, { column: 0, index: 0 }), null, 'dropped where it is');
});

test('automatic split: the count whose frame is nearest the aspect, stopping before a neighbour; kept while sections grow, redone once measured, on rebalance and on folding', () => {
  const { graph, group, ids } = counterModule();
  const tm = /** @type {any} */ (trainingModule(graph, group.id));
  const alone = sectionColumns().frame(graph, tm, room());
  assert.ok(alone.columns.length > 1, 'nine sections in one column would make a tall thin frame');
  const one = sectionColumns().frame(graph, tm, room([{ x: alone.well.x - 600, y: alone.rect.y, w: 50, h: 50 }]));
  assert.equal(one.columns.length, 1, 'a second column would reach the neighbour');
  assert.equal(one.rect.x + one.rect.w, alone.rect.x + alone.rect.w, 'columns widen the frame to the left: the well stays');

  const columns = sectionColumns(), first = columns.frame(graph, tm, room()).columns;
  const all = Object.fromEntries(first.flat().map(id => [id, 100]));
  columns.measure(group.id, 0, { [ids.trainer]: 100 });
  assert.deepEqual(columns.frame(graph, tm, room()).columns, first, 'a partial measurement keeps the estimated split');
  columns.measure(group.id, 0, all);
  const settled = columns.frame(graph, tm, room()).columns;
  assert.notDeepEqual(settled, first, 'equal measured heights split differently from the estimates');
  columns.measure(group.id, 0, { ...all, [ids.execution]: 4000 });
  assert.deepEqual(columns.frame(graph, tm, room()).columns, settled, 'a growing section lengthens its column, nothing moves');
  columns.rebalance();
  const rebalanced = columns.frame(graph, tm, room()).columns;
  assert.deepEqual(rebalanced[rebalanced.length - 1], [ids.execution], '整理 splits again around the tall section');
  columns.measure(group.id, 0, all);
  graph.setUi(ids.cands, { uiCollapsed: true });
  assert.notDeepEqual(columns.frame(graph, tm, room()).columns, rebalanced, 'folding a section re-splits');
});

test('each drawn section has its rect in the frame: column by column below the slot rows, stacked without overlap, at its measured height', () => {
  const { graph, group, ids } = counterModule();
  const columns = sectionColumns(), tm = /** @type {any} */ (trainingModule(graph, group.id));
  /** the frame as the browser draws it: tall enough for its column */
  const drawn = () => columns.frame(graph, tm, { ...room(), height: 5000 });
  const check = (/** @type {any} */ f, /** @type {number} */ ins) => {
    assert.deepEqual(f.placed.map((/** @type {any} */ r) => r.id), f.columns.flat(), 'one rect per drawn section (the 「代码」 section once), in column order');
    for (const [c, col] of f.columns.entries()) {
      const rs = f.placed.filter((/** @type {any} */ r) => col.includes(r.id));
      assert.equal(rs[0].y, 44 + 20 + ins, 'a column starts below the header, the padding and the slot rows');
      for (const [i, r] of rs.entries()) {
        assert.equal(r.x, 20 + c * (440 + 24));
        assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= f.rect.w && r.y + r.h <= f.rect.h, 'inside the frame');
        if (i) assert.equal(r.y, rs[i - 1].y + rs[i - 1].h, 'right below the one above');
      }
    }
  };
  check(drawn(), 0);
  const sizes = Object.fromEntries(drawn().sections.map((/** @type {string} */ id, /** @type {number} */ i) => [id, 100 + 10 * i]));
  columns.measure(group.id, 60, sizes);
  const f = drawn();
  check(f, 60);
  for (const r of f.placed) assert.equal(r.h, sizes[r.id], 'measured heights');
  // a section that has another below it grows: the split stays, the one below moves down
  const [top, next] = /** @type {string[]} */ (f.columns.find((/** @type {string[]} */ col) => col.length > 1));
  columns.measure(group.id, 60, { ...sizes, [top]: 700 });
  const grown = drawn(), at = (/** @type {string} */ id) => grown.placed.find((/** @type {any} */ r) => r.id === id);
  assert.deepEqual(grown.columns, f.columns);
  assert.equal(at(next).y, at(top).y + 700, 'a grown section pushes the ones below it down');
  check(grown, 60);
});

test('corner drag: horizontal steps by column widths, vertical picks the fewest columns whose tallest fits; release stores the re-split, a click nothing', () => {
  const { graph, group, ids } = counterModule();
  const columns = sectionColumns(), tm = /** @type {any} */ (trainingModule(graph, group.id)), step = 440 + 24;
  const base = columns.frame(graph, tm, room()).columns.length, count = () => columns.frame(graph, tm, room()).columns.length;
  assert.equal(columns.drag(graph, tm, step, 0), true);
  assert.equal(count(), base + 1);
  assert.equal(columns.drag(graph, tm, step + 10, 0), false, 'the same count: nothing to redraw');
  columns.drag(graph, tm, -100 * step, 0); assert.equal(count(), 1);
  columns.drag(graph, tm, 100 * step, 0); assert.equal(count(), 9, 'at most one section per column');
  columns.drag(graph, tm, 0, 100000); assert.equal(count(), 1, 'dragged far down: one column fits');
  columns.drag(graph, tm, 0, -100); assert.equal(count(), base + 1, 'a little shorter than the tallest column: one more column');
  const stored = columns.release(graph, tm, { dx: step, dy: 0 });
  assert.equal(stored?.length, base + 1);
  assert.deepEqual(stored?.flat(), [ids.seeds, ids.params, ids.scene, ids.reward, ids.steps, ids.weights, ids.trainer, ids.cands, ids.evaluator, ids.report, ids.execution]);
  assert.equal(count(), base, 'released: the frame draws its own split until the stored one arrives');
  columns.drag(graph, tm, step, 0);
  assert.equal(columns.release(graph, tm, null), null, 'a click');
  assert.equal(count(), base);
  // never past MAX_COLUMNS
  for (let i = 0; i < 20; i++) graph.addToGroup(group.id, graph.addNode({ kind: 'dataset' }).id);
  const many = /** @type {any} */ (trainingModule(graph, group.id));
  columns.drag(graph, many, 100 * step, 0);
  assert.equal(columns.frame(graph, many, room()).columns.length, MAX_COLUMNS);
});
