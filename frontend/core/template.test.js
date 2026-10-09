import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import './kinds/index.js';
import { ModuleGraph } from './graph.js';
import { parseTemplate, templateToYAML, instantiateInto, fromSelection, TemplateError } from './template.js';
import { canonicalJSON } from './canonical.js';
import { COUNTER_YAML, counterGraph } from './fixtures/counter.js';

test('YAML → canonical JSON: key order and wire spelling do not change the identity', () => {
  const a = parseTemplate(COUNTER_YAML);
  const shuffled = YAML.parse(COUNTER_YAML);
  shuffled.wires.value.reverse();
  shuffled.wires.call = shuffled.wires.call.map(w => w.replace('→', ' -> '));
  shuffled.modules = Object.fromEntries(Object.entries(shuffled.modules).reverse());
  const b = parseTemplate({ ...Object.fromEntries(Object.entries(shuffled).reverse()) });
  assert.equal(canonicalJSON(a), canonicalJSON(b));
  assert.ok(a.wires.call.includes('reward.reward→trainer.objective'), 'a call wire without a source port names the one exported function');
  assert.ok(a.wires.value.includes('scene.actions→readout.actions'));
  assert.deepEqual(a.modules.readout.config, { mode: 'argmax', map: [0, 1], width: 4, decode: 'lsb-int' }, 'configs are stored with defaults filled');
  // export → import round-trip keeps the identity
  assert.equal(canonicalJSON(parseTemplate(templateToYAML(a))), canonicalJSON(a));
});

test('invalid templates are rejected with a reason', () => {
  const bad = (mutate, pattern) => { const raw = YAML.parse(COUNTER_YAML); mutate(raw); assert.throws(() => parseTemplate(raw), error => error instanceof TemplateError && pattern.test(error.message)); };
  bad(raw => { raw.modules.ghost = { kind: 'nope' }; }, /未知模块种类/);
  bad(raw => { raw.modules.e2 = { kind: 'evaluator' }; raw.wires.value.push('seeds.training→e2.loop'); }, /类型不匹配/);
  bad(raw => { raw.modules.reward.config.source = 'export function reward(transition) { return transition.done; }'; }, /number/);
  bad(raw => { raw.modules.scene.config.source = raw.modules.scene.config.source.replace('done: next >= params.target', 'done: 1'); }, /step.*boolean/);
  bad(raw => { raw.groups.box.loop = 'net'; }, /loop 必须是模板里的回路模块/);
  bad(raw => { raw.modules.reward.config.source = 'export function reward(transition) { return 1; }\nexport function other(transition) { return 2; }'; }, /导出了 2 个函数，连线需要写明端口/);
  bad(raw => { raw.expose = ['nobody.port']; }, /不存在的模块/);
  bad(raw => { raw.modules.net.config.layers = [{ hidden: 0 }]; }, /hidden/);
  bad(raw => { raw.id = 'Bad Id'; }, /模板 id/);
  bad(raw => { raw.kind = 'module'; }, /单模块模板/);
  bad(raw => { raw.wires.value.push('params.params→scene.params'); }, /已经接了一条线/);
});

test('instantiate: fresh ids each time, a collapsed group recording the template, exposed ports resolved', () => {
  const template = parseTemplate(COUNTER_YAML);
  const a = instantiateInto(new ModuleGraph(), template, { x: 100, y: 50 }), b = instantiateInto(new ModuleGraph(), template);
  assert.equal(a.nodes.length, Object.keys(template.modules).length);
  assert.equal(new Set([...a.nodes, ...b.nodes].map(n => n.id)).size, a.nodes.length * 2, 'no id is shared between two instances');
  assert.deepEqual(a.group.template, { id: 'counter-task', revision: 1 });
  assert.equal(a.group.collapsed, true);
  assert.equal(a.group.members.length, a.nodes.length - 3 + 1, 'the loop box holds loop, net and readout');
  assert.equal(a.group.expose.length, 0);
  assert.ok(a.nodes.every(n => n.x >= 100 && n.y >= 50));
  // instantiating twice into one graph is fine: two independent loops
  const graph = new ModuleGraph();
  const one = instantiateInto(graph, template); instantiateInto(graph, template, { x: 2000, y: 0 });
  assert.equal(graph.groups.size, 4);
  assert.equal(graph.group(one.groupIds.box).loop, one.ids.loop, 'groups.box.loop marks the box of that instance’s loop');
  assert.equal(graph.problems().filter(p => !p.incomplete).length, 0);
});

test('fromSelection: inner wires kept, boundary wires become exposed ports, and the result re-instantiates', () => {
  const { graph, ids } = counterGraph();
  const loop = ['scene', 'net', 'readout', 'params'].map(k => ids[k]);
  const tpl = fromSelection(graph, loop, { id: 'counter-loop', name: 'loop' });
  assert.equal(tpl.kind, 'composite');
  assert.equal(Object.keys(tpl.modules).length, loop.length);
  assert.ok(tpl.expose.includes('counter_scene.module'), 'the scenario handle the trainer and evaluator run is exposed');
  assert.ok(tpl.expose.includes('net.in') && tpl.expose.includes('readout.action'), 'the loop’s input and action wires cross the boundary');
  assert.ok(!tpl.wires.value.some(w => /trainer/.test(w)));
  const single = fromSelection(graph, [ids.net], { id: 'lif-8' });
  assert.equal(single.kind, 'module');
  const back = instantiateInto(new ModuleGraph(), tpl);
  assert.equal(back.nodes.length, loop.length);
  assert.equal(canonicalJSON(parseTemplate(templateToYAML(tpl))), canonicalJSON(tpl));
});

/** The counter template with a `scene` group and a `learn` group. The `scene` group is the scenario side and exposes
 *  its handle and actions. It contains a `world` group of what feeds the episodes (params and seeds). readout stays at
 *  the top level.
 *  The group `scene` shares its local id with the module it contains. */
function groupedCounter() {
  const raw = YAML.parse(COUNTER_YAML);
  raw.groups = {
    world: { title: '世界', members: ['params', 'seeds'] },
    scene: { title: '场景', members: ['world', 'scene'], expose: ['scene.module', 'scene.actions'] },
    learn: { title: '学习', members: ['net', 'reward', 'steps', 'trainer', 'cands', 'evaluator'], expose: ['net.in', 'net.scores', 'cands.artifact'] },
  };
  return raw;
}

test('nested groups: parsed canonically, re-exported to YAML with the same identity, rejected when malformed', () => {
  const tpl = parseTemplate(groupedCounter());
  assert.deepEqual(Object.keys(tpl.groups).sort(), ['learn', 'scene', 'world']);
  assert.deepEqual(tpl.groups.scene.members, ['scene', 'world'], 'members are sorted');
  assert.deepEqual(tpl.groups.scene.expose, ['scene.actions', 'scene.module']);
  assert.equal(tpl.groups.world.title, '世界');
  const yaml = templateToYAML(tpl);
  assert.match(yaml, /^groups:\n/m);
  assert.equal(canonicalJSON(parseTemplate(yaml)), canonicalJSON(tpl));
  const flat = YAML.parse(COUNTER_YAML); delete flat.groups;
  assert.ok(!templateToYAML(parseTemplate(flat)).includes('groups:'), 'no groups → no groups key in YAML');
  const bad = (mutate, pattern) => { const raw = groupedCounter(); mutate(raw); assert.throws(() => parseTemplate(raw), error => error instanceof TemplateError && pattern.test(error.message)); };
  bad(raw => { raw.groups.learn.members.push('params'); }, /同时属于组合/);
  bad(raw => { raw.groups.scene.members.push('ghost'); }, /不是模板里的模块或组合/);
  bad(raw => { raw.groups.learn.expose.push('scene.module'); }, /不属于它的成员/);
  bad(raw => { raw.groups.learn.members.push('learn'); }, /包含了自己/);
  bad(raw => { raw.groups.world.members.push('scene'); }, /同时属于组合/);   // resolves to the module scene, already in group scene
});

test('nested groups: instantiate nests them collapsed inside the template group, unlisted modules stay at the top', () => {
  const tpl = parseTemplate(groupedCounter());
  const graph = new ModuleGraph();
  const { ids, group, groupIds } = instantiateInto(graph, tpl);
  assert.equal(graph.groups.size, 4);
  const scene = graph.group(groupIds.scene), world = graph.group(groupIds.world), learn = graph.group(groupIds.learn);
  assert.equal(graph.parentOf(scene.id).id, group.id);
  assert.equal(graph.parentOf(learn.id).id, group.id);
  assert.equal(graph.parentOf(world.id).id, scene.id);
  assert.equal(graph.parentOf(ids.params).id, world.id);
  assert.equal(graph.parentOf(ids.readout).id, group.id, 'readout is not in any nested group');
  assert.ok(scene.collapsed && world.collapsed && learn.collapsed && group.collapsed);
  assert.equal(scene.title, '场景');
  assert.deepEqual(scene.expose.map(e => `${e.node}.${e.port}`).sort(), ['scene.module', 'scene.actions'].map(t => { const [m, p] = t.split('.'); return `${ids[m]}.${p}`; }).sort());
  assert.deepEqual(new Set(graph.memberNodes(group.id)), new Set(Object.values(ids)), 'every module is reachable from the top group');
  assert.equal(graph.problems().filter(p => !p.incomplete).length, 0);
});

test('nested groups: fromSelection records groups strictly inside the selection and drops the enclosing one', () => {
  const graph = new ModuleGraph();
  const { ids, group } = instantiateInto(graph, parseTemplate(groupedCounter()));
  const tpl = fromSelection(graph, graph.memberNodes(group.id), { id: 'counter-copy', name: 'copy' });
  assert.deepEqual(Object.values(tpl.groups).map(g => g.title).sort(), ['世界', '场景', '学习'].sort());
  const scene = Object.values(tpl.groups).find(g => g.title === '场景');
  assert.ok(scene.members.includes(Object.keys(tpl.groups).find(k => tpl.groups[k].title === '世界')), 'the inner group is a member of the outer one');
  assert.ok(scene.expose.some(e => e.endsWith('.module')));
  assert.deepEqual(tpl.expose, parseTemplate(COUNTER_YAML).expose.map(e => e), 'the enclosing template group contributes its exposes, nested groups do not');
  // saving only the scene group yields a template whose top-level exposes are the group's, with the world group nested
  const sceneGroup = [...graph.groups.values()].find(g => g.title === '场景');
  const sub = fromSelection(graph, graph.memberNodes(sceneGroup.id), { id: 'scene-only', name: 'scene' });
  assert.deepEqual(Object.values(sub.groups).map(g => g.title), ['世界']);
  assert.ok(sub.expose.includes('counter_scene.module'));
  assert.equal(canonicalJSON(parseTemplate(templateToYAML(sub))), canonicalJSON(sub));
  void ids;
});
