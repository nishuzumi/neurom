import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import './kinds/index.js';
import { ModuleGraph, GraphError } from './graph.js';
import { instantiateInto, fromSelection, parseTemplate, templateToYAML } from './template.js';
import { prefabState, fillSlot, restoreWire } from './prefab.js';
import { buildBundle, bundleHash } from './bundle.js';
import { canonicalJSON } from './canonical.js';
import { COUNTER_YAML } from './fixtures/counter.js';
import { builtinTemplate, builtinTemplates } from '../templates/index.js';

const instance = id => { const graph = new ModuleGraph(); const r = instantiateInto(graph, builtinTemplate(id)); return { graph, ...r }; };
const text = w => `${w.from.node}.${w.from.port}→${w.to.node}.${w.to.port}`;

test('every builtin create entry adds a module that wires into its slot without an error of its own or a width mismatch', () => {
  // the slots of the template's own group (key null) and of each nested group that declares slots
  const prefabs = tpl => [[null, tpl.slots], ...Object.entries(tpl.groups).map(([key, g]) => [key, g.slots ?? []])];
  for (const tpl of builtinTemplates()) for (const [key, slots] of prefabs(tpl)) for (const slot of slots) for (const [i, spec] of slot.create.entries()) {
    const r = instance(tpl.id), { graph } = r, group = key === null ? r.group.id : r.groupIds[key];
    const s = prefabState(graph, group).slots.find(x => x.id === slot.id);
    // a taken single input is emptied first: the create entry is what replaces its content
    if (!s.open) for (const p of graph.producers(s.node, s.port)) graph.disconnect(p.wire.id);
    const node = fillSlot(graph, group, slot.id, i);
    const where = `${tpl.id} ${key ?? ''} ${slot.id}[${i}] ${spec.kind}`;
    assert.ok(graph.group(group).members.includes(node.id), `${where}: inside the prefab`);
    assert.deepEqual(prefabState(graph, group).slots.find(x => x.id === slot.id).filled.filter(n => n === node.id), [node.id], `${where}: fills the slot`);
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

/** The counter task trained twice: two training modules `a` and `b`, each a nested group with slots, around its own
 *  loop box and drivers. The environment (scene, params, seeds), the reward and the metric stay in the top group, and
 *  both training modules share them. */
function sharedCounter() {
  const raw = YAML.parse(COUNTER_YAML);
  for (const id of ['loop', 'net', 'readout', 'trainer', 'cands', 'evaluator', 'execution']) raw.modules[`${id}2`] = structuredClone(raw.modules[id]);
  const own = /^(loop|net|readout|trainer|cands|evaluator|execution)\./;
  for (const kind of ['value', 'call']) {
    raw.wires[kind].push(...raw.wires[kind].filter(w => own.test(w.split('→')[1])).map(w => w.split('→').map(e => (own.test(e) ? e.replace('.', '2.') : e)).join('→')));
  }
  const slots = n => [
    { id: 'scenario', title: '场景', port: `loop${n}.scenario`, create: [{ kind: 'code', title: '场景', ports: { module: 'scenario' } }] },
    { id: 'objective', title: '目标', port: `trainer${n}.objective`, create: [{ kind: 'code', title: '奖励' }] },
  ];
  raw.groups = {
    box: { title: 'loop', loop: 'loop', members: ['loop', 'net', 'readout'] },
    box2: { title: 'loop', loop: 'loop2', members: ['loop2', 'net2', 'readout2'] },
    a: { title: 'A', members: ['box', 'trainer', 'cands', 'evaluator', 'execution'], slots: slots('') },
    b: { title: 'B', members: ['box2', 'trainer2', 'cands2', 'evaluator2', 'execution2'], slots: slots('2') },
  };
  return raw;
}

test('a nested group that declares slots is a training module of its own, and two of them share one environment', () => {
  const tpl = parseTemplate(sharedCounter());
  assert.equal(canonicalJSON(parseTemplate(templateToYAML(tpl))), canonicalJSON(tpl), 'group slots survive YAML');
  const graph = new ModuleGraph(), { ids, group, groupIds } = instantiateInto(graph, tpl);
  assert.equal(group.prefab, null, 'the top group holds the shared modules and is no training module');
  for (const [g, n] of [['a', ''], ['b', '2']]) {
    const state = prefabState(graph, groupIds[g]);
    assert.deepEqual(state.slots.map(s => [s.id, s.node, s.filled]), [['scenario', ids[`loop${n}`], [ids.scene]], ['objective', ids[`trainer${n}`], [ids.reward]]], `${g}: the shared modules fill its slots`);
    assert.deepEqual(state.missing, []);
    // the expected wires are those of its own members, outside its slots
    const mine = new Set(graph.memberNodes(groupIds[g]));
    assert.ok(graph.group(groupIds[g]).prefab.expect.every(w => mine.has(w.from.node) || mine.has(w.to.node)), g);
    assert.ok(graph.group(groupIds[g]).prefab.expect.some(w => w.from.node === ids.seeds && w.to.node === ids[`trainer${n}`]), `${g}: a shared feed outside the slots is expected`);
  }
  // a create entry adds the module into its own training module
  graph.removeNode(ids.reward);
  const reward = fillSlot(graph, groupIds.b, 'objective', 0);
  assert.equal(graph.parentOf(reward.id).id, groupIds.b);
  // saving the whole instance keeps both training modules with their slots
  const saved = fromSelection(graph, graph.memberNodes(group.id), { id: 'saved', name: 'saved' });
  assert.deepEqual(Object.values(saved.groups).filter(x => x.slots).map(x => x.slots.map(s => s.id)), [['scenario', 'objective'], ['scenario', 'objective']]);
  const bad = (mutate, pattern) => { const r = sharedCounter(); mutate(r); assert.throws(() => parseTemplate(r), e => pattern.test(e.message)); };
  bad(r => { r.groups.a.slots[0].port = 'loop2.scenario'; }, /不属于/);
  bad(r => { r.groups.a.slots[1].id = 'scenario'; }, /重复/);
});
