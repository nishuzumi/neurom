import { test } from 'node:test';
import assert from 'node:assert/strict';
import './kinds/index.js';
import { ModuleGraph, GraphError } from './graph.js';
import { registerKind } from './registry.js';
import { callIn, fnOut } from './kinds/common.js';
import { NUMBER } from './types.js';
import { counterGraph } from './fixtures/counter.js';
import { loopBody } from './kinds/loop.js';

const code = (graph, source, inputs = []) => graph.addNode({ kind: 'code', config: { inputs, source } });
/** A minimal scenario source: one role per line, `patch` replaces (or with '' drops) roles by name. */
const SCENARIO = {
  budget: 'export const budget = 5;',
  init: 'export function init(start) { return { count: 0 }; }',
  input: 'export function input(state) { return bits(state.count, 2); }',
  step: 'export function step(state, action) { return { state: { count: state.count + action }, done: state.count + action > 2, success: state.count + action > 2 }; }',
};
const scenario = (patch = {}) => Object.values({ ...SCENARIO, ...patch }).filter(Boolean).join('\n');
const value = (from, to) => ({ kind: 'value', from, to });
const call = (from, to) => ({ kind: 'call', from, to });
const rejects = (graph, spec, pattern) => {
  const before = graph.wires.size;
  assert.throws(() => graph.connect(spec), error => error instanceof GraphError && pattern.test(error.message));
  assert.equal(graph.wires.size, before, 'a rejected wire leaves the graph unchanged');
  assert.equal(graph.canConnect(spec).ok, false);
};
/** A loop running a scenario code module (`module → loop.scenario`), driven by a trainer from a seed partition. */
function sceneGraph(source = scenario(), inputs = []) {
  const graph = new ModuleGraph();
  const params = graph.addNode({ kind: 'params', config: { fields: { target: { type: 'int', default: 3 }, bonus: { type: 'number', default: 0.5 } } } });
  const scene = code(graph, source, inputs), loop = graph.addNode({ kind: 'loop' }), seeds = graph.addNode({ kind: 'partition' }), trainer = graph.addNode({ kind: 'trainer' });
  graph.connect(call({ node: scene.id, port: 'module' }, { node: loop.id, port: 'scenario' }));
  graph.connect(value({ node: loop.id, port: 'loop' }, { node: trainer.id, port: 'loop' }));
  graph.connect(value({ node: seeds.id, port: 'training' }, { node: trainer.id, port: 'training' }));
  return { graph, params, scene, loop, seeds, trainer };
}
/** The messages of the problems a loop reports on its `scenario` port (plus the scenario module's own). */
const scenarioMessages = (graph, { loop, scene }) => graph.problems().filter(p => (p.node === loop.id && p.port === 'scenario') || p.node === scene.id).map(p => p.message).join('\n');

test('value wire: type mismatch is rejected, matching widths accepted', () => {
  const graph = new ModuleGraph();
  const src8 = code(graph, 'export const b = bits(0, 8);');
  const readout = graph.addNode({ kind: 'readout', config: { mode: 'argmax', map: [0, 1, 2] } });
  const net = graph.addNode({ kind: 'network' });
  const loop = graph.addNode({ kind: 'loop' }), text = graph.addNode({ kind: 'text' });
  rejects(graph, value({ node: text.id, port: 'text' }, { node: loop.id, port: 'action' }), /number/);
  rejects(graph, value({ node: src8.id, port: 'b' }, { node: readout.id, port: 'scores' }), /vector\[3\]/);
  graph.connect(value({ node: src8.id, port: 'b' }, { node: net.id, port: 'in' }));
  graph.connect(value({ node: net.id, port: 'scores' }, { node: readout.id, port: 'scores' }));
  assert.deepEqual(graph.resolved().typeOf(net.id, 'scores'), { type: 'vector', width: 3 });
  rejects(graph, value({ node: src8.id, port: 'b' }, { node: net.id, port: 'in' }), /已经接了一条线/);
});

test('wire kind must match the ports on both ends', () => {
  const graph = new ModuleGraph();
  const fn = code(graph, 'export function f(x) { return x; }\nexport const k = 1;');
  const trainer = graph.addNode({ kind: 'trainer' });
  rejects(graph, value({ node: fn.id, port: 'f' }, { node: trainer.id, port: 'structure' }), /值线只能/);
  rejects(graph, call({ node: fn.id, port: 'k' }, { node: trainer.id, port: 'objective' }), /调用线只能/);
  rejects(graph, call({ node: fn.id, port: 'f' }, { node: trainer.id, port: 'nope' }), /没有输入端口/);
  rejects(graph, value({ node: trainer.id, port: 'run' }, { node: trainer.id, port: 'training' }), /不能连接自己/);
});

test('code module ports: the exports, plus module; they stay while the source does not parse', () => {
  const graph = new ModuleGraph();
  const outputs = node => graph.ports(node.id).outputs.map(p => [p.id, p.wire]);
  const m = code(graph, '/** 倍增 */\nexport function twice(k) { return k * 2; }\nexport const k = 1;\nfunction helper(x) { return x; }', ['seed']);
  assert.deepEqual(outputs(m), [['module', 'call'], ['twice', 'call'], ['k', 'value']], 'helpers are not ports');
  assert.deepEqual(graph.ports(m.id).inputs.map(p => [p.id, p.required]), [['seed', true]], 'each declared input is a required value input');
  assert.equal(graph.ports(m.id).outputs[1].doc, '倍增', 'the JSDoc summary travels on the port');
  graph.patchConfig(m.id, { source: 'export function twice(k) { return k * ; }' });
  assert.deepEqual(outputs(m), [['module', 'call'], ['twice', 'call'], ['k', 'value']], 'the last parse’s exports stay while the source is broken');
  assert.ok(graph.problems().some(p => p.node === m.id && /代码无法编译/.test(p.message)));
  graph.patchConfig(m.id, { source: 'export function thrice(k) { return k * 3; }' });
  assert.deepEqual(outputs(m), [['module', 'call'], ['thrice', 'call']], 'a parsing source decides the ports again');
  const clash = code(graph, 'export const module = 1;');
  assert.ok(graph.problems().some(p => p.node === clash.id && /module 是整个文件的输出端口/.test(p.message)));
});

test('JSDoc documents, never types: {Type} groups are ignored, types come from the call site', () => {
  const graph = new ModuleGraph();
  const d = code(graph, '/** 倍增\n * @param {numbr} k 系数\n * @returns {string} 两倍 */\nexport function twice(k) { return k * 2; }');
  assert.deepEqual(graph.problems().filter(p => p.node === d.id), [], 'an unknown or wrong {Type} is not a problem');
  const params = graph.addNode({ kind: 'params', config: { fields: { n: { type: 'int', default: 1 } }, functions: ['options'] } });
  const opts = code(graph, '/** @param {string} params */\nexport function options(params) { return { twice: params.n * 2 }; }');
  graph.connect(call({ node: opts.id, port: 'options' }, { node: params.id, port: 'options' }));
  assert.deepEqual(graph.problems().filter(p => p.node === opts.id || p.node === params.id), [], 'params is typed as the params record its caller passes');
});

test('scenario: a role whose result does not satisfy the runner signature is a problem on the loop’s scenario port', () => {
  const g = sceneGraph(), { graph, scene, loop, trainer } = g;
  const problemsWith = patch => {
    graph.patchConfig(scene.id, { source: scenario(patch) });
    return scenarioMessages(graph, g);
  };
  assert.equal(problemsWith({}), '');
  // step must return { state: State, done, success }. A bare State is not enough, and nothing else may ride along
  assert.match(problemsWith({ step: 'export function step(state, action) { return state; }' }), /step.*state/);
  assert.match(problemsWith({ step: 'export function step(state, action) { return { state, done: true, success: false, extra: 1 }; }' }), /多了 extra/);
  assert.match(problemsWith({ step: 'export function step(state, action) { return { state, done: 1, success: false }; }' }), /step.*boolean/);
  // the runner fixes the parameter count and types, not the names
  assert.match(problemsWith({ input: 'export function input() { return bits(0, 2); }' }), /input 有 0 个参数，调用方传入 1 个/);
  assert.equal(problemsWith({ input: 'export function input(s) { return bits(s.count, 2); }' }), '', 'a scenario names its parameters as it likes');
  assert.match(problemsWith({ input: '' }), /没有导出函数 input/);
  // an unexported role is a helper, not a role
  assert.match(problemsWith({ input: 'function input(s) { return bits(0, 2); }' }), /没有导出函数 input/);
  // the step limit is a required number export
  assert.match(problemsWith({ budget: '' }), /没有导出常量 budget/);
  assert.ok(graph.problems().find(p => p.node === loop.id && /budget/.test(p.message)).incomplete, 'a missing budget blocks the bundle, not the wiring');
  assert.match(problemsWith({ budget: 'export const budget = "five";' }), /budget 需要数字/);
  // a correct source has no problems again. State came from init, and the drivers see the loop's refs
  assert.equal(problemsWith({}), '');
  assert.deepEqual(graph.resolved().refsOf(loop.id).State, { type: 'record', fields: { count: { type: 'number' } } });
  assert.equal(graph.resolved().refsOf(loop.id).I, 2, 'input’s width is the loop’s input width');
  assert.deepEqual(graph.resolved().refsOf(trainer.id).State, graph.resolved().refsOf(loop.id).State);
  // without init the state is the Start record itself
  assert.equal(problemsWith({ init: '', input: 'export function input(state) { return bits(state.seed % 4, 2); }', step: 'export function step(state, action) { return { state, done: true, success: action > 0 }; }' }), '');
  assert.deepEqual(graph.resolved().refsOf(loop.id).State, { type: 'record', fields: { seed: { type: 'number' } } });
  // Start comes from the drivers' partitions: without a driver the roles cannot be typed yet
  graph.disconnect(graph.producers(trainer.id, 'loop')[0].wire.id);
  assert.match(scenarioMessages(graph, g), /先把回路接到/);
});

test('scenario: an exported function that is neither a role nor wired anywhere is a problem (a misspelt role)', () => {
  const g = sceneGraph(scenario({ input: 'export function input(state) { return bits(state.count, 2); }\nexport function inputs(state) { return 1; }' }));
  const { graph, scene, trainer } = g;
  assert.match(scenarioMessages(graph, g), /场景导出了 inputs，但运行器不调用它/);
  assert.ok(graph.problems().find(p => /inputs/.test(p.message)).incomplete, 'it blocks the bundle, not the wiring (the export may be wired next)');
  graph.patchConfig(scene.id, { source: scenario({ input: 'export function input(state) { return bits(state.count, 2); }\nexport function reward(transition) { return transition.action > 0 ? 1 : 0; }' }) });
  graph.connect(call({ node: scene.id, port: 'reward' }, { node: trainer.id, port: 'objective' }));
  assert.equal(scenarioMessages(graph, g), '', 'an export wired to another module is not a misspelt role');
  graph.patchConfig(scene.id, { source: scenario({ input: 'export function input(state) { return bits(state.count, 2); }\nfunction inputs(s) { return 1; }' }) });
  assert.equal(graph.problems().filter(p => /inputs/.test(p.message)).length, 0, 'a helper is not reported');
});

test('loop: drivers must run it on one episode kind; a network declares the width wired into it', () => {
  const { graph, loop } = sceneGraph();
  const onLoop = () => graph.problems().filter(p => p.node === loop.id && p.port === 'loop').map(p => p.message).join('\n');
  assert.equal(onLoop(), '');
  const windows = graph.addNode({ kind: 'partition', config: { kind: 'window' } }), evaluator = graph.addNode({ kind: 'evaluator' });
  graph.connect(value({ node: loop.id, port: 'loop' }, { node: evaluator.id, port: 'loop' }));
  graph.connect(value({ node: windows.id, port: 'test' }, { node: evaluator.id, port: 'partition' }));
  assert.match(onLoop(), /驱动回路的分区回合种类不一致/);
  assert.equal(graph.resolved().refsOf(loop.id).Start, null, 'disagreeing drivers type no Start');
  graph.disconnect(graph.producers(evaluator.id, 'partition')[0].wire.id);
  assert.equal(onLoop(), '');
  // I is declared on the network by hand and must equal the width wired into it (the loop's input: 2)
  const net = graph.addNode({ kind: 'network', config: { inputs: 3 } });
  rejects(graph, value({ node: loop.id, port: 'input' }, { node: net.id, port: 'in' }), /接入 2 位，网络声明输入 3 位/);
  graph.patchConfig(net.id, { inputs: 2 });
  graph.connect(value({ node: loop.id, port: 'input' }, { node: net.id, port: 'in' }));
  graph.patchConfig(net.id, { inputs: 4 });
  assert.ok(graph.problems().some(p => p.node === net.id && p.port === 'in' && /接入 2 位，网络声明输入 4 位/.test(p.message)), 'editing the declared width later is reported');
});

test('loop body: the modules between input and action; the box must hold exactly them; only per-step kinds', () => {
  const { graph, ids, groupIds } = counterGraph();
  const body = () => loopBody(graph, ids.loop);
  const messages = () => graph.problems().filter(p => p.node === ids.loop).map(p => p.message).join('\n');
  assert.deepEqual(body(), { nodes: [ids.net, ids.readout], closed: true }, 'producers first; trainer and candidates close through net.weights, not the body');
  assert.equal(messages(), '');
  graph.removeFromGroup(ids.readout);
  assert.match(messages(), /回路框 .* 的成员与回路体不一致。多出的成员：—。缺少的成员：readout/);
  graph.addToGroup(groupIds.box, ids.readout);
  const note = graph.addNode({ kind: 'text' });
  graph.addToGroup(groupIds.box, note.id);
  assert.match(messages(), /多出的成员：文字。/);
  graph.removeFromGroup(note.id);
  // a code module on the path is not a per-step module
  graph.disconnect(graph.producers(ids.net, 'in')[0].wire.id);
  const relay = code(graph, 'export const y = x;', ['x']);
  graph.connect(value({ node: ids.loop, port: 'input' }, { node: relay.id, port: 'x' }));
  graph.connect(value({ node: relay.id, port: 'y' }, { node: ids.net, port: 'in' }));
  assert.deepEqual(body().nodes, [relay.id, ids.net, ids.readout]);
  assert.match(messages(), /不能放在回路里/);
  // an action that does not come from the input does not close the loop
  graph.disconnect(graph.producers(ids.loop, 'action')[0].wire.id);
  const one = code(graph, 'export const k = 1;');
  graph.connect(value({ node: one.id, port: 'k' }, { node: ids.loop, port: 'action' }));
  assert.deepEqual(body(), { nodes: [], closed: false });
  assert.ok(graph.problems().find(p => p.node === ids.loop && /回路未闭合/.test(p.message)).incomplete, 'the path may still be wired: it blocks the bundle, not the wiring');
});

test('call wire: handles only feed ports asking for the same handle', () => {
  const graph = new ModuleGraph();
  const trainer = graph.addNode({ kind: 'trainer' }), loop = graph.addNode({ kind: 'loop' });
  const fn = code(graph, 'export function f(tr) { return 1; }');
  rejects(graph, call({ node: fn.id, port: 'f' }, { node: loop.id, port: 'scenario' }), /需要 module 句柄/);
  rejects(graph, call({ node: fn.id, port: 'module' }, { node: trainer.id, port: 'objective' }), /module 句柄/);
  graph.connect(call({ node: fn.id, port: 'module' }, { node: loop.id, port: 'scenario' }));
});

test('code inputs: file-level names bound by value wires; a bad binding is rejected', () => {
  const { graph, params, trainer } = sceneGraph();
  const reward = code(graph, 'export function reward(transition) { return transition.action > 0 ? w.bonus : 0; }', ['w']);
  graph.connect(call({ node: reward.id, port: 'reward' }, { node: trainer.id, port: 'objective' }));
  assert.ok(graph.problems().some(p => p.node === reward.id && p.port === 'w' && p.incomplete), 'unbound w is reported as incomplete');
  graph.connect(value({ node: params.id, port: 'params' }, { node: reward.id, port: 'w' }));
  assert.equal(graph.problems().filter(p => p.node === reward.id).length, 0);
  const site = graph.resolved().callSite(trainer.id, 'objective');
  assert.deepEqual(site.carries.bound, { w: { type: 'record', fields: { bonus: NUMBER, target: NUMBER } } });
  assert.deepEqual(site.result, NUMBER);
  // binding a wrongly typed value breaks the call-site check and is rejected
  const text = graph.addNode({ kind: 'text' });
  graph.disconnect(graph.producers(reward.id, 'w')[0].wire.id);
  rejects(graph, value({ node: text.id, port: 'text' }, { node: reward.id, port: 'w' }), /./);
  // a field path must name an existing field of a record output
  rejects(graph, value({ node: params.id, port: 'params.missing' }, { node: reward.id, port: 'w' }), /没有输出端口/);
  rejects(graph, value({ node: params.id, port: 'params.bonus.deeper' }, { node: reward.id, port: 'w' }), /没有输出端口/);
  // the field path wire carries the field's type (bonus: number ≠ record w). A record-valued path is accepted
  const nested = code(graph, 'export const nest = { cfg: { bonus: 2, tag: "x" }, n: 1 };');
  graph.connect(value({ node: nested.id, port: 'nest.cfg' }, { node: reward.id, port: 'w' }));
  assert.equal(graph.problems().filter(p => p.node === reward.id && !p.incomplete).length, 0);
  assert.deepEqual(graph.resolved().typeOf(nested.id, 'nest.cfg.bonus'), NUMBER);
  assert.deepEqual(graph.consumers(nested.id, 'nest').map(c => c.port), ['w'], 'consumers of a port include its field paths');
});

test('value cycles close only into loop inputs (a loop’s action, a network’s weights); call recursion is rejected', () => {
  const graph = new ModuleGraph();
  const a = code(graph, 'export const a = x + 1;', ['x']), b = code(graph, 'export const b = y * 2;', ['y']);
  graph.connect(value({ node: a.id, port: 'a' }, { node: b.id, port: 'y' }));
  rejects(graph, value({ node: b.id, port: 'b' }, { node: a.id, port: 'x' }), /环路/);
  // params → options code (value) and options → params.options (call) is a function boundary, not a cycle
  const params = graph.addNode({ kind: 'params', config: { fields: { n: { type: 'int', default: 1 } } } });
  const options = code(graph, 'export function options(params) { return { max: params.n * 2 + m.n }; }', ['m']);
  graph.connect(call({ node: options.id, port: 'options' }, { node: params.id, port: 'options' }));
  graph.connect(value({ node: params.id, port: 'params' }, { node: options.id, port: 'm' }));
  // the counter task closes loop.input → net → readout → loop.action and net → trainer → cands → net.weights.
  // If the same bits close into the network's `in`, that is an ordinary cycle
  const { graph: loop, ids } = counterGraph();
  const mix = loop.addNode({ kind: 'bits', config: { parts: [{ port: 'a', offset: 0, width: 2 }, { port: 'b', offset: 0, width: 1 }] } });
  loop.connect(value({ node: ids.readout, port: 'bits' }, { node: mix.id, port: 'a' }));
  loop.connect(value({ node: ids.loop, port: 'input' }, { node: mix.id, port: 'b' }));
  loop.disconnect(loop.producers(ids.net, 'in')[0].wire.id);
  rejects(loop, value({ node: mix.id, port: 'bits' }, { node: ids.net, port: 'in' }), /环路/);
  // call recursion: two relays calling each other
  registerKind({ kind: 'test-relay', label: '测试中继', config: { defaults: {}, schema: {} }, ports: () => ({ inputs: [callIn('in', { params: [NUMBER], names: ['x'], result: NUMBER })], outputs: [fnOut('fn')] }), infer: () => ({}), problems: () => [] });   // i18n-ignore: test-only kind
  const r1 = graph.addNode({ kind: 'test-relay' }), r2 = graph.addNode({ kind: 'test-relay' });
  graph.connect(call({ node: r1.id, port: 'fn' }, { node: r2.id, port: 'in' }));
  rejects(graph, call({ node: r2.id, port: 'fn' }, { node: r1.id, port: 'in' }), /递归/);
});

test('params function inputs: one call port per declared name; a key two inputs both return is a problem', () => {
  const graph = new ModuleGraph();
  const params = graph.addNode({ kind: 'params', config: { fields: { n: { type: 'int', default: 1 } }, functions: ['options', 'extra'] } });
  assert.deepEqual(graph.ports(params.id).inputs.map(p => p.id), ['options', 'extra']);
  const a = code(graph, 'export function a(params) { return { twice: params.n * 2, actions: ["x"] }; }');
  const b = code(graph, 'export function b(params) { return { hint: params.n }; }');
  graph.connect(call({ node: a.id, port: 'a' }, { node: params.id, port: 'options' }));
  graph.connect(call({ node: b.id, port: 'b' }, { node: params.id, port: 'extra' }));
  assert.deepEqual(graph.problems().filter(p => p.node === params.id), [], 'distinct keys merge');
  graph.patchConfig(b.id, { source: 'export function b(params) { return { twice: 3 }; }' });
  assert.ok(graph.problems().some(p => p.node === params.id && /options \/ extra/.test(p.message) && /\btwice\b/.test(p.message)), 'the conflicting key names both ports');
  assert.equal(graph.ports(graph.addNode({ kind: 'params' }).id).inputs.map(p => p.id).join(), 'options', 'an undeclared config keeps the one options input');
});

test('a code function feeding two call ports must be typed identically by both', () => {
  const { graph, ids } = counterGraph();
  const trainer2 = graph.addNode({ kind: 'trainer', config: { method: 'cross-entropy' } });
  graph.connect(value({ node: ids.loop, port: 'loop' }, { node: trainer2.id, port: 'loop' }));
  graph.connect(value({ node: ids.seeds, port: 'training' }, { node: trainer2.id, port: 'training' }));
  graph.connect(value({ node: ids.net, port: 'structure' }, { node: trainer2.id, port: 'structure' }));
  // the reward fn(Transition)→number cannot also serve as a target fn(State)→bits[2]
  rejects(graph, call({ node: ids.reward, port: 'reward' }, { node: trainer2.id, port: 'objective' }), /./);
  // a proper target objective is accepted and typed as a mask of width O
  const target = code(graph, 'export function target(state) { return [state.count < 3 ? 0 : 1, state.count < 3 ? 1 : 0]; }');
  graph.connect(call({ node: target.id, port: 'target' }, { node: trainer2.id, port: 'objective' }));
  assert.deepEqual(graph.resolved().callSite(trainer2.id, 'objective').result, { type: 'vector', width: 2 });
});

test('nested groups: single parent, no self-containment, expose only member ports, dissolve keeps nodes', () => {
  const { graph, ids, group } = counterGraph();
  assert.equal(graph.parentOf(ids.scene).id, group.id);
  assert.throws(() => graph.createGroup({ members: [ids.scene] }), /已经属于另一个组合/);
  const outer = graph.createGroup({ title: 'outer', members: [group.id] });
  assert.equal(graph.parentOf(group.id).id, outer.id);
  assert.throws(() => graph.addToGroup(group.id, outer.id), /祖先/);
  assert.deepEqual(new Set(graph.memberNodes(outer.id)), new Set(Object.values(ids)));
  const note = graph.addNode({ kind: 'text' });
  assert.throws(() => graph.setExpose(outer.id, [{ node: note.id, port: 'text' }]), /不属于组合成员/);
  graph.setExpose(outer.id, [{ node: ids.cands, port: 'artifact' }, { node: ids.net, port: 'in' }]);
  assert.deepEqual(graph.exposedPorts(outer.id).map(e => e.direction), ['output', 'input']);
  graph.removeGroup(group.id);
  assert.equal(graph.parentOf(ids.scene).id, outer.id, 'members of a dissolved group move to its parent');
  assert.equal(graph.nodes.size, Object.keys(ids).length + 1);
  graph.removeNode(ids.cands);
  assert.deepEqual(graph.exposedPorts(outer.id).map(e => e.node), [ids.net], 'expose entries follow node removal');
});

test('toJSON / fromJSON round-trips through the validating mutators', () => {
  const { graph } = counterGraph();
  const json = graph.toJSON();
  const back = ModuleGraph.fromJSON(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(back.toJSON(), json);
  assert.equal(json.groups.filter(g => g.loop).length, 1, 'the loop box keeps its loop');
  json.wires[0].to.port = 'nope';
  assert.throws(() => ModuleGraph.fromJSON(json), GraphError);
});

test('a group\'s stored section split: distinct ids in 1..16 non-empty columns; a column count is not a split', () => {
  const { graph, group, ids } = counterGraph();
  assert.throws(() => graph.setGroupLayout(group.id, { columns: [[ids.trainer], []] }), GraphError);
  assert.throws(() => graph.setGroupLayout(group.id, { columns: [[ids.trainer], [ids.trainer]] }), GraphError);
  assert.throws(() => graph.setGroupLayout(group.id, { columns: 3 }), GraphError);
  graph.setGroupLayout(group.id, { columns: [[ids.trainer], [ids.cands]] });
  const json = JSON.parse(JSON.stringify(graph.toJSON()));
  assert.deepEqual(ModuleGraph.fromJSON(json).group(group.id).columns, [[ids.trainer], [ids.cands]]);
  json.groups.find(g => g.id === group.id).columns = 3;
  assert.throws(() => ModuleGraph.fromJSON(json), GraphError, 'one reader per format (ADR 0008)');
});

/** A record typed by a wire: `params → relay.p`, relay exports `out = p`, and the field path `out.bonus` reads it. */
function relayGraph() {
  const graph = new ModuleGraph();
  const params = graph.addNode({ kind: 'params', config: { fields: { bonus: { type: 'number', default: 0.5 } } } });
  const relay = code(graph, 'export const out = p;', ['p']), user = code(graph, 'export const twice = b * 2;', ['b']);
  graph.connect(value({ node: params.id, port: 'params' }, { node: relay.id, port: 'p' }));
  graph.connect(value({ node: relay.id, port: 'out.bonus' }, { node: user.id, port: 'b' }));
  return { graph, params, relay, user };
}
const wireSet = json => json.wires.map(w => `${w.id}:${w.from.node}.${w.from.port}→${w.to.node}.${w.to.port}`).sort();

test('admit: a field-path wire may come before the wire that types its record', () => {
  const { graph } = relayGraph();
  const json = JSON.parse(JSON.stringify(graph.toJSON()));
  json.wires.reverse();
  assert.deepEqual(wireSet(ModuleGraph.fromJSON(json).toJSON()), wireSet(graph.toJSON()));
});

test('admit strict: the first refusal throws and the graph is left as it was', () => {
  const { graph } = counterGraph();
  const json = JSON.parse(JSON.stringify(graph.toJSON())), before = JSON.stringify(graph.toJSON());
  json.wires.push({ ...json.wires[0], id: 'late', to: { ...json.wires[0].to, port: 'nope' } });
  assert.throws(() => graph.admit(json, { fresh: true }), GraphError);
  assert.equal(JSON.stringify(graph.toJSON()), before, 'nodes, wires and groups it had added are gone');
  json.wires.pop();
  json.groups[0].members.push('ghost');
  assert.throws(() => ModuleGraph.fromJSON(json), /ghost/, 'a strict load refuses a reference it cannot resolve');
});

test('admit fresh: a copy gets new ids and offset positions; its loop box, exposes, prefab and columns follow, references to modules left behind go', () => {
  const { graph, ids, group, groupIds } = counterGraph();
  graph.setExpose(group.id, [{ node: ids.cands, port: 'artifact' }]);
  graph.setGroupLayout(group.id, { columns: [[ids.trainer], [ids.cands, ids.evaluator]] });
  graph.setPrefab(group.id, {
    slots: [{ id: 'objective', title: 'objective', node: ids.trainer, port: 'objective', create: [] }, { id: 'metrics', title: 'metrics', node: ids.evaluator, port: 'metrics', create: [] }],
    expect: [value({ node: ids.loop, port: 'loop' }, { node: ids.trainer, port: 'loop' }), value({ node: ids.loop, port: 'loop' }, { node: ids.evaluator, port: 'loop' })],
  });
  const json = graph.toJSON();
  const slice = { ...json, nodes: json.nodes.filter(n => n.id !== ids.evaluator), wires: json.wires.filter(w => w.from.node !== ids.evaluator && w.to.node !== ids.evaluator) };
  const { ids: map, notes } = graph.admit(slice, { fresh: true, dx: 40, dy: 10, strict: false });
  assert.deepEqual(notes, []);
  const at = id => map.get(id);
  for (const n of slice.nodes) {
    assert.notEqual(at(n.id), n.id);
    assert.deepEqual([graph.node(at(n.id)).x, graph.node(at(n.id)).y], [n.x + 40, n.y + 10]);
  }
  const copied = new Set(slice.nodes.map(n => at(n.id)));
  assert.equal([...graph.wires.values()].filter(w => copied.has(w.from.node)).length, slice.wires.length, 'every wire between copied modules');
  const top = graph.group(at(group.id)), box = graph.group(at(groupIds.box));
  assert.equal(box.loop, at(ids.loop));
  assert.equal(graph.parentOf(box.id).id, top.id);
  assert.ok(!top.members.some(m => m === ids.evaluator || m === undefined));
  assert.deepEqual(top.expose.map(e => e.node), [at(ids.cands)]);
  assert.deepEqual(top.columns, [[at(ids.trainer)], [at(ids.cands)]]);
  assert.deepEqual(top.prefab.slots.map(s => [s.id, s.node]), [['objective', at(ids.trainer)]]);
  assert.deepEqual(top.prefab.expect, [value({ node: at(ids.loop), port: 'loop' }, { node: at(ids.trainer), port: 'loop' })]);
});

test('admit lenient: each refusal is dropped and noted, the rest is admitted', () => {
  const { graph, relay, user } = relayGraph();
  const json = JSON.parse(JSON.stringify(graph.toJSON()));
  json.wires.push({ id: 'bad', kind: 'value', from: { node: relay.id, port: 'out' }, to: { node: user.id, port: 'nope' } });
  json.groups.push({ id: 'g1', title: 'g', members: [relay.id, 'ghost'], expose: [], loop: user.id, collapsed: false, x: 0, y: 0, w: 10, h: 10 });
  const back = new ModuleGraph(), { notes } = back.admit(json, { strict: false });
  assert.equal(notes.length, 2);
  assert.match(notes[0], /丢弃一条现在不允许的连线/);
  assert.match(notes[1], /回路模块/);
  assert.deepEqual(wireSet(back.toJSON()), wireSet(graph.toJSON()));
  assert.deepEqual(back.group('g1').members, [relay.id], 'a member the graph does not hold is dropped');
  assert.equal(back.group('g1').loop, null);
});

test('network layers: a layer list of plain layers is no problem of the network nor of either trainer backend', () => {
  const { graph, ids } = counterGraph();
  const messages = id => graph.problems().filter(p => p.node === id).map(p => p.message).join('\n');
  graph.patchConfig(ids.net, { layers: [{ hidden: 8 }, { hidden: 4 }] });
  assert.equal(messages(ids.net), '');
  graph.patchConfig(ids.trainer, { backend: 'python' });
  assert.equal(messages(ids.trainer), '');
  graph.patchConfig(ids.net, { layers: [{ tools: 'tools' }] });
  assert.match(messages(ids.net), /工具层/);
  assert.throws(() => graph.patchConfig(ids.net, { layers: [{ hidden: 0 }] }), /hidden/);
  graph.patchConfig(ids.net, { engine: 'threshold-layers', kind: 'feedforward', ticks: 1, leak_shift: 0, layers: [{ hidden: 8 }] });
  assert.match(messages(ids.net), /每一层是一个宽度/);
});
