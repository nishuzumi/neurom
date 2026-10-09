import { test } from 'node:test';
import assert from 'node:assert/strict';
import './kinds/index.js';
import { ModuleGraph, GraphError } from './graph.js';
import { instantiateInto, fromSelection, parseTemplate } from './template.js';
import { prefabState, fillSlot, restoreWire } from './prefab.js';
import { buildBundle, bundleHash } from './bundle.js';
import { builtinTemplate, builtinTemplates } from '../templates/index.js';

const instance = id => { const graph = new ModuleGraph(); const r = instantiateInto(graph, builtinTemplate(id)); return { graph, ...r }; };
const text = w => `${w.from.node}.${w.from.port}→${w.to.node}.${w.to.port}`;

test('every builtin create entry adds a module that wires into its slot without an error of its own or a width mismatch', () => {
  for (const tpl of builtinTemplates()) for (const slot of tpl.slots) for (const [i, spec] of slot.create.entries()) {
    const { graph, group } = instance(tpl.id);
    const s = prefabState(graph, group.id).slots.find(x => x.id === slot.id);
    // a taken single input is emptied first: the create entry is what replaces its content
    if (!s.open) for (const p of graph.producers(s.node, s.port)) graph.disconnect(p.wire.id);
    const node = fillSlot(graph, group.id, slot.id, i);
    const where = `${tpl.id} ${slot.id}[${i}] ${spec.kind}`;
    assert.ok(graph.group(group.id).members.includes(node.id), `${where}: inside the prefab`);
    assert.deepEqual(prefabState(graph, group.id).slots.find(x => x.id === slot.id).filled.filter(n => n === node.id), [node.id], `${where}: fills the slot`);
    // a stub scenario's input must match what reads it: a width mismatch shows on the network's `in`
    assert.deepEqual(graph.problems().filter(p => !p.incomplete && (p.node === node.id || p.port === 'in')).map(p => `${graph.node(p.node).title}: ${p.message}`), [], where);
  }
});

test('a code create entry without config starts from its slot port\'s contract, read against the live graph', () => {
  const { graph, group } = instance('mining-task');
  const fresh = slotId => {
    const s = prefabState(graph, group.id).slots.find(x => x.id === slotId);
    for (const p of graph.producers(s.node, s.port)) graph.removeNode(p.node);
    return fillSlot(graph, group.id, slotId, 0).config.source;
  };
  // the scenario's input returns as many bits as the network reading the loop's input declares (185: four bits() parts)
  assert.equal(fresh('scenario'), 'export const budget = 1;\nexport function init(start) {\n  return { ...start };\n}\nexport function input(state) {\n  return concat(bits(0, 53), bits(0, 53), bits(0, 53), bits(0, 26));\n}\nexport function step(state, action) {\n  return { state, done: true, success: false };\n}\n');
  assert.equal(fresh('objective'), 'export function reward(transition) {\n  return transition.success ? 1 : 0;\n}\n');
  assert.equal(fresh('metric'), 'export function metric(episode) {\n  return episode.success ? 1 : 0;\n}\n');
  const add4 = instance('arithmetic-add4'), slot = prefabState(add4.graph, add4.group.id).slots.find(x => x.id === 'objective');
  for (const p of add4.graph.producers(slot.node, slot.port)) add4.graph.removeNode(p.node);
  assert.equal(fillSlot(add4.graph, add4.group.id, 'objective', 0).config.source, 'export function target(state) {\n  return bits(0, 5);\n}\n');
});

test('the template wires outside the slots are expected; a missing one is reported and restored in place', () => {
  const { graph, group, ids } = instance('mining-task');
  const P = graph.group(group.id).prefab, expected = new Set(P.expect.map(text));
  // slot content is not expected: the scenario, the partition, the objective and metric, the drivers on loop.loop
  for (const [from, to] of [['scene', 'loop'], ['seeds', 'trainer'], ['reward', 'trainer'], ['settled', 'trainer'], ['loop', 'evaluator'], ['loop', 'execution']])
    assert.ok(![...expected].some(w => w.startsWith(`${ids[from]}.`) && w.includes(`→${ids[to]}.`)), `${from}→${to}`);
  assert.ok(expected.has(`${ids.cands}.weights→${ids.net}.weights`) && expected.has(`${ids.loop}.loop→${ids.trainer}.loop`));
  assert.deepEqual(prefabState(graph, group.id).missing, []);
  // another candidates takes the network's one weights input: the expected wire is missing. Restoring replaces the other.
  const other = graph.addNode({ kind: 'candidates' });
  graph.disconnect(graph.producers(ids.net, 'weights')[0].wire.id);
  graph.connect({ kind: 'value', from: { node: other.id, port: 'weights' }, to: { node: ids.net, port: 'weights' } });
  const [missing] = prefabState(graph, group.id).missing;
  assert.equal(text(missing), `${ids.cands}.weights→${ids.net}.weights`);
  restoreWire(graph, group.id, missing.index);
  assert.deepEqual(prefabState(graph, group.id).missing, []);
  assert.deepEqual(graph.producers(ids.net, 'weights').map(p => p.node), [ids.cands]);
});

test('a filled slot is read from the wires: replacing the content keeps the prefab whole', () => {
  const { graph, group, ids } = instance('mining-task');
  const objective = () => prefabState(graph, group.id).slots.find(s => s.id === 'objective');
  assert.deepEqual(objective().filled, [ids.reward]);
  assert.throws(() => fillSlot(graph, group.id, 'objective', 0), GraphError, 'a taken single slot takes no second module');
  graph.removeNode(ids.reward);
  assert.equal(objective().open, true);
  const reward = fillSlot(graph, group.id, 'objective', 0);
  assert.deepEqual(objective().filled, [reward.id]);
  assert.deepEqual(prefabState(graph, group.id).missing, [], 'the removed module took its expected wires with it');
});

test('the prefab record is presentation: the trainer bundle is the same without it, and it survives JSON', async () => {
  const { graph, group, ids } = instance('mining-task');
  const before = await bundleHash(buildBundle(graph, ids.trainer));
  const json = graph.toJSON();
  const back = ModuleGraph.fromJSON(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(back.group(group.id).prefab, graph.group(group.id).prefab);
  graph.setPrefab(group.id, null);
  assert.equal(await bundleHash(buildBundle(graph, ids.trainer)), before);
  // a record naming a module that is not there is refused, not repaired
  json.groups.find(g => g.id === group.id).prefab.slots[0].node = 'ghost';
  assert.throws(() => ModuleGraph.fromJSON(json), GraphError);
});

test('saving a whole prefab as a template keeps its slots', () => {
  const { graph, group } = instance('training-module');
  fillSlot(graph, group.id, 'objective', 0);
  const tpl = fromSelection(graph, graph.memberNodes(group.id), { id: 'mine', name: 'mine' });
  assert.deepEqual(tpl.slots.map(s => s.id), builtinTemplate('training-module').slots.map(s => s.id));
  const again = new ModuleGraph(), { group: g2 } = instantiateInto(again, tpl);
  assert.deepEqual(prefabState(again, g2.id).slots.find(s => s.id === 'objective').filled.length, 1, 'the saved content fills its slot again');
  assert.deepEqual(prefabState(again, g2.id).missing, []);
});

test('malformed slots are rejected when the template is parsed', () => {
  const raw = structuredClone(builtinTemplate('training-module'));
  const bad = (mutate, pattern) => { const r = structuredClone(raw); mutate(r); assert.throws(() => parseTemplate(r), e => pattern.test(e.message)); };
  bad(r => { r.slots[0].port = 'loop.nope'; }, /没有端口/);
  bad(r => { r.slots[1].id = r.slots[0].id; }, /重复/);
  bad(r => { r.slots[1].create[0].ports = { training: 'ghost' }; }, /不存在的槽位/);
  bad(r => { r.slots[1].create[0].ports = { validation: 'validation' }; }, /槽位自己/);
  bad(r => { r.slots[1].create = [{ kind: 'code', title: 'x' }]; }, /config/);   // a value port has no contract to write code from
  bad(r => { r.preset = { label: 'x', accept: { loop: 'some-artifact' } }; }, /preset/);
});
