import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterGraph } from '../core/fixtures/counter.js';
import { ModuleGraph } from '../core/graph.js';
import { instantiateInto } from '../core/template.js';
import { builtinTemplates } from '../templates/index.js';
import { canvasGeometry } from './canvas-geometry.ts';
import { sectionColumns } from './training-module.js';
import { intersects } from './layout.ts';
import { GAP } from './sizes.ts';

/** a geometry over `graph` (nothing measured unless `measured` says so, a 16:9 viewport), and how to store its moves */
function geometryOf(/** @type {ModuleGraph} */ graph, measured = new Map()) {
  const geo = canvasGeometry({ graph: () => graph, measured: id => measured.get(id), aspect: () => 16 / 9, columns: sectionColumns() });
  const apply = (/** @type {{ id: string, x: number, y: number }[]} */ moves) => {
    for (const m of moves) if (graph.groups.has(m.id)) graph.setGroupLayout(m.id, { x: m.x, y: m.y }); else graph.moveNode(m.id, m.x, m.y);
  };
  return { geo, apply };
}
/** the counter task with every group expanded. `prefab`: its outer group drawn as a training module */
function counter({ prefab = false } = {}) {
  const { graph, ids, group, groupIds } = counterGraph();
  for (const id of [group.id, ...Object.values(groupIds)]) graph.setGroupLayout(id, { collapsed: false });
  if (prefab) graph.setPrefab(group.id, { slots: [], expect: [] });
  return { graph, ids, group: group.id, box: groupIds.box };
}
/** every placed builtin template, as graph_app.js places one: prefab groups expanded, then 整理 of its modules */
function placed(template) {
  const graph = new ModuleGraph(), r = instantiateInto(graph, template, { x: 0, y: 0 });
  if (r.group?.prefab) for (const id of [r.group.id, ...Object.values(r.groupIds)]) graph.setGroupLayout(id, { collapsed: false });
  return { graph, r };
}

test('Arrange: drivers stand before their loop box, and the frame moves with its members', () => {
  const { graph, ids, group, box } = counter();
  const { geo, apply } = geometryOf(graph);
  const r = geo.arrange(graph.memberNodes(group));
  assert.equal(r?.settle, group, 'exactly one group selected: that group is laid out, and untangled once measured');
  apply(r.moves);
  for (const driver of [ids.trainer, ids.evaluator, ids.execution]) assert.ok(geo.rect(driver).x + geo.rect(driver).w <= geo.rect(box).x, driver);
  assert.equal(geo.arrange([]), null, 'nothing selected');
});

test('Arrange: a scenario outside a training module that only hands itself to its loop sits right below the loop box', () => {
  const { graph, ids, group, box } = counter();
  graph.disconnect(graph.producers(ids.scene, 'params')[0].wire.id);
  const { geo, apply } = geometryOf(graph);
  apply(geo.arrange(graph.memberNodes(group))?.moves ?? []);
  const scene = geo.rect(ids.scene), loop = geo.rect(box);
  assert.deepEqual([scene.x, scene.y], [loop.x, loop.y + loop.h + GAP.y]);
});

test('Arrange inside a training module lays out only its sub-canvas: sections are not moved and keep a placed split', () => {
  const { graph, ids, group, box } = counter({ prefab: true });
  const { geo, apply } = geometryOf(graph);
  const sections = geo.training(group)?.sections ?? [];
  assert.ok(sections.includes(ids.trainer) && geo.training(group)?.canvas.includes(box));
  graph.setGroupLayout(group, { columns: [[ids.trainer], sections.filter(id => id !== ids.trainer)] });
  const r = geo.arrange(graph.memberNodes(group));
  const moved = new Set(r?.moves.map(m => m.id));
  for (const id of sections) assert.ok(!moved.has(id), `section ${id} is drawn by the frame, not moved`);
  assert.ok(moved.has(ids.net) && moved.has(box));
  apply(r?.moves ?? []);
  assert.deepEqual(geo.frame(group).columns[0], [ids.trainer], 'a split the user placed stays');
  // a module selected with something outside moves as the frame it is drawn in
  const outside = graph.addNode({ kind: 'view', x: 5000, y: 0 });
  const flat = geo.arrange([ids.trainer, outside.id]);
  assert.deepEqual(new Set(flat?.moves.filter(m => m.id === group || m.id === outside.id).map(m => m.id)), new Set([group, outside.id]));
  assert.equal(flat?.settle, undefined);
});

test('Arrange leaves no two units of a level overlapping, for every builtin template', () => {
  for (const template of builtinTemplates()) {
    const { graph, r } = placed(template), { geo, apply } = geometryOf(graph);
    apply(geo.arrange(r.nodes.map(n => n.id))?.moves ?? []);
    const drawn = new Set(geo.groups().map(g => g.id));
    const levels = new Map();
    for (const id of [...graph.nodes.keys(), ...graph.groups.keys()]) {
      if (graph.groups.has(id) ? !drawn.has(id) : geo.shownBy(id) !== id) continue;
      const parent = graph.parentOf(id)?.id ?? null;
      if (!levels.has(parent)) levels.set(parent, []);
      levels.get(parent).push(id);
    }
    for (const [parent, units] of levels) for (const [i, a] of units.entries()) for (const b of units.slice(i + 1)) {
      assert.ok(!intersects(geo.rect(a), geo.rect(b)), `${template.id}: ${a} and ${b} overlap in ${parent ?? 'the canvas'}`);
    }
  }
});

test('docking: every member port maps to one flow node handle and back — own card, collapsed group, loop box, section, tool card', () => {
  const round = (geo, node, port) => { const s = geo.socket(node, port); assert.deepEqual(geo.member(s.node, s.handle), { node, port }); return s; };
  // collapsed: the outermost collapsed group shows its members' slots
  const { graph: g1, ids: c1, group: outer } = (() => { const { graph, ids, group } = counterGraph(); return { graph, ids, group: group.id }; })();
  const a = geometryOf(g1).geo;
  assert.deepEqual(round(a, c1.trainer, 'loop'), { node: outer, handle: `${c1.trainer}/loop` });
  assert.deepEqual(round(a, c1.loop, 'action'), { node: outer, handle: `${c1.loop}/action` }, 'a loop inside a collapsed box inside a collapsed group');
  // expanded: a module's own card, and a box's loop node on the box's frame
  const { graph: g2, ids: c2, box } = counter(), b = geometryOf(g2).geo;
  assert.deepEqual(round(b, c2.trainer, 'loop'), { node: c2.trainer, handle: 'loop' });
  assert.deepEqual(round(b, c2.loop, 'action'), { node: box, handle: `${c2.loop}/action` });
  assert.deepEqual(b.member(c2.trainer, `${c2.evaluator}/loop`), { node: c2.trainer, port: `${c2.evaluator}/loop` }, 'a slot naming a module the node does not show is its own port');
  // a training module's section
  const { graph: g3, ids: c3, group: frame } = counter({ prefab: true }), c = geometryOf(g3).geo;
  assert.deepEqual(round(c, c3.trainer, 'structure'), { node: frame, handle: `${c3.trainer}/structure` });
  assert.equal(c.sectionOf(c3.reward), frame);
  // a code tool drawn inside its network's card
  const g4 = new ModuleGraph();
  const policy = g4.addNode({ kind: 'network', config: { engine: 'dense-policy', kind: 'feedforward', inputs: 11, layers: [{ hidden: 8 }, { tools: 'tools', data: 8 }], ticks: 1, leak_shift: 0, reset: 0 } }).id;
  const tool = g4.addNode({ kind: 'code', config: { source: 'export function only(data) { return data; }' } }).id;
  g4.connect({ kind: 'call', from: { node: tool, port: 'only' }, to: { node: policy, port: 'tools' } });
  const d = geometryOf(g4).geo;
  assert.equal(d.toolHost(tool), policy);
  assert.deepEqual(round(d, tool, 'only'), { node: policy, handle: `${tool}/only` });
  assert.deepEqual(d.toolLayers(policy).map(L => L.port), ['tools']);
});

test('rects: measured sizes win; a training frame holds its well around the sub-canvas and its columns to the left', () => {
  const { graph, ids, group, box } = counter({ prefab: true }), measured = new Map([[ids.net, { w: 777, h: 333 }]]);
  const { geo } = geometryOf(graph, measured);
  assert.deepEqual(geo.rect(ids.net), { x: graph.node(ids.net).x, y: graph.node(ids.net).y, w: 777, h: 333 });
  const frame = geo.frame(group), inner = geo.rect(box);
  assert.deepEqual(geo.rect(group), frame.rect);
  assert.ok(frame.well.x < inner.x && frame.well.y < inner.y && frame.well.x + frame.well.w > inner.x + inner.w && frame.well.y + frame.well.h > inner.y + inner.h);
  assert.equal(frame.well.x - frame.rect.x, 20 + frame.colW + 24, 'the columns sit between the frame padding and the well');
  measured.set(group, { w: 1, h: frame.rect.h + 500 });
  assert.equal(geo.rect(group).h, frame.rect.h + 500, 'a taller measured column stretches the frame down');
});

test('a drop joins the deepest expanded frame its centre lands in, leaves its group when dropped wholly outside, and stays when it still touches its frame', () => {
  const { graph, ids, group, box } = counter();
  const { geo } = geometryOf(graph);
  const frames = new Map(geo.groups().map(g => [g.id, geo.rect(g.id)]));
  const at = (/** @type {{ x: number, y: number, w: number, h: number }} */ f) => ({ x: f.x + f.w / 2 - 10, y: f.y + f.h / 2 - 10, w: 20, h: 20 });
  assert.deepEqual(geo.regroup([{ id: ids.trainer, rect: at(frames.get(box)) }], frames), [{ id: ids.trainer, from: group, to: box }]);
  assert.deepEqual(geo.regroup([{ id: ids.net, rect: { x: 1e5, y: 1e5, w: 20, h: 20 } }], frames), [{ id: ids.net, from: box, to: null }]);
  const edge = frames.get(group);
  assert.deepEqual(geo.regroup([{ id: ids.trainer, rect: { x: edge.x + edge.w - 5, y: edge.y + 50, w: 40, h: 40 } }], frames), [], 'still touching its own frame: it only moved');
  assert.deepEqual(geo.regroup([{ id: box, rect: { x: 1e5, y: 0, w: 20, h: 20 } }, { id: ids.net, rect: { x: 1e5, y: 0, w: 20, h: 20 } }], frames), [{ id: box, from: group, to: null }], 'a member of a dragged group moves with it');
});
