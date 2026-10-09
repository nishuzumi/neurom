import { test } from 'node:test';
import assert from 'node:assert/strict';
import './kinds/index.js';
import { ModuleGraph } from './graph.js';
import { instantiateInto } from './template.js';
import { fillSlot, prefabState } from './prefab.js';
import { rolesOf } from './roles.js';
import { builtinTemplate } from '../templates/index.js';
import { t } from '../i18n.js';

const mining = () => { const graph = new ModuleGraph(); return { graph, ...instantiateInto(graph, builtinTemplate('mining-task')) }; };
const roles = (graph, id) => rolesOf(graph, graph.resolved(), id);

test('a missing scenario role is written as the prefab writes it: input returns the width the loop body expects', () => {
  const { graph, group, ids } = mining();
  const slot = prefabState(graph, group.id).slots.find(x => x.id === 'scenario');
  for (const p of graph.producers(slot.node, slot.port)) graph.removeNode(p.node);
  const scene = fillSlot(graph, group.id, 'scenario', 0), created = /export function input[^}]*}\n/.exec(scene.config.source)[0];
  assert.match(created, /concat\(bits\(0, 53\), bits\(0, 53\), bits\(0, 53\), bits\(0, 26\)\)/, 'the prefab writes the 185 bits the network declares');
  assert.equal(roles(graph, scene.id).scenario.stub, scene.config.source, 'the prefab writes the scenario’s stub');
  graph.patchConfig(scene.id, { source: scene.config.source.replace(created, '') });
  const input = () => roles(graph, scene.id).scenario.roles.find(r => r.name === 'input');
  assert.equal(input().text, created, 'the Role Tab adds the input the prefab created');
  assert.equal(input().required, true);
  graph.patchConfig(ids.net, { inputs: 12 });
  assert.match(input().text, /return bits\(0, 12\);/, 'read against the live graph');
  for (const c of graph.consumers(ids.loop, 'input')) graph.disconnect(c.wire.id);
  assert.match(input().text, /return bits\(0, 1\);/, 'nothing reads the loop’s input: one bit');
  assert.deepEqual(roles(graph, scene.id).scenario.roles.map(r => [r.name, r.kind, r.required]),
    [['budget', 'const', true], ['actions', 'const', false], ['init', 'function', false], ['input', 'function', true], ['step', 'function', true]]);
});

test('the first caller types a role: a call wire with the types its checked call recorded, a loop with the runner’s arguments', () => {
  const { graph, ids } = mining();
  const res = graph.resolved(), reward = rolesOf(graph, res, ids.reward).role('reward');
  const [first] = graph.consumers(ids.reward, 'reward');
  assert.deepEqual(reward.callers.map(c => `${c.node}.${c.port}`), graph.consumers(ids.reward, 'reward').map(c => `${c.node}.${c.port}`), 'every call wire, in wire order');
  assert.deepEqual([reward.callers[0].via, reward.callers[0].label], ['call', `${graph.node(first.node).title}.${first.port}`]);
  assert.deepEqual(reward.args, res.calls.get(first.wire.id).paramTypes.slice(0, res.calls.get(first.wire.id).k));
  assert.deepEqual(reward.params.map(p => p.label), ['Transition']);
  assert.equal(reward.required, true);

  const scene = rolesOf(graph, res, ids.scene), step = scene.role('step'), loopRefs = res.refsOf(ids.loop);
  assert.deepEqual(step.callers.map(c => [c.node, c.via, c.label]), [[ids.loop, 'scenario', t('{consumer} 的 {role}', { consumer: graph.node(ids.loop).title, role: 'step' })]]);
  assert.deepEqual(step.args, [loopRefs.State, { type: 'number' }]);
  assert.equal(step.exact, true);
  assert.deepEqual(step.params.map(p => p.label), ['State', 'number']);
  assert.equal(scene.role('init').required, false, 'init is optional');
  assert.equal(scene.role('budget').kind, 'const');
  assert.equal(scene.role('actions').required, false);
  assert.equal(scene.scenario.loop, ids.loop);
  assert.equal(rolesOf(graph, res, ids.reward).scenario, null);
  assert.equal(rolesOf(graph, res, ids.reward).role('nothing'), null, 'an export nobody calls by protocol is no role');
});

test('a role param means what its first caller passes, under the protocol’s line and the module’s own Doc Comment', () => {
  const { graph, ids } = mining();
  const scene = roles(graph, ids.scene);
  // the protocol's line for a parameter documents it even where the module writes no @param of its own
  assert.equal(scene.role('step').argDoc(1).text, t('回路这一步给出的动作编号'));
  assert.equal(scene.role('step').argDoc(0).text, t('当前状态'));
  assert.match(scene.role('step').argDoc(0).fields.x.text, /x 坐标/, 'State fields: the JSDoc on init’s returned record keys');
  const step = scene.docs('step');
  assert.match(step.action.text, /^动作编号 0\.\.6/, 'an own param: the function’s @param wins');
  assert.match(step.state.fields.x.text, /x 坐标/, 'the runner’s State, through the loop');
  assert.match(step.params.fields.baseX.text, /^基地 X/, 'a bound input keeps its wire’s docs');
  // the reward code module is called by the trainer with a Transition: its param carries the trainer's docs
  assert.match(roles(graph, ids.reward).docs('reward').transition.fields.next.fields.x.text, /x 坐标/);
  const source = graph.nodes.get(ids.reward).config.source;
  graph.patchConfig(ids.reward, { source: source.replace('* @param transition 本步转移', '* @param transition 本步转移\n * @param transition.done 本模块自己的说明') });
  assert.equal(roles(graph, ids.reward).docs('reward').transition.fields.done.text, '本模块自己的说明', 'the module’s own @param name.field wins');
  assert.match(roles(graph, ids.reward).docs('reward').transition.fields.next.fields.y.text, /y 坐标/, 'other fields still come from the source');
  // nobody calls it: only its own Doc Comment
  for (const c of graph.consumers(ids.reward, 'reward')) graph.disconnect(c.wire.id);
  assert.equal(roles(graph, ids.reward).role('reward'), null);
  assert.deepEqual(roles(graph, ids.reward).docs('reward').transition, { text: '本步转移', fields: { done: { text: '本模块自己的说明' } } });
});
