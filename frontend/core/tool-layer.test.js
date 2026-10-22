// Tool layers (ADR 0010 §2–§4). Tests: a selector with two tools (a code AND and a frozen OR network), built on a real
// graph, bundled and run by the loop executor. The engine's LIF segments against hand-computed references. The
// problems the network kind reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './kinds/index.js';
import { ModuleGraph } from './graph.js';
import { buildBundle } from './bundle.js';
import { createLoop, runEpisodes, toolCaller } from './loop.js';
import { shapedArtifact } from './sessions/fixtures.js';
import { createExecutor } from './sessions/executor.js';
import { integerStep, encodeDenseWeights } from '../runtime/dense-policy.js';
import { denseWeightBytes, deploymentProblem, moduleStateWidth, toolEntriesDepth, MAX_TOOL_DEPTH } from './kinds/network.js';
import { rolesOf } from './roles.js';

const POLICY_ID = '0x' + 'a'.repeat(64), OR_ID = '0x' + 'b'.repeat(64);
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const identity = n => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, k) => (k === i ? 1 : 0)));
const FF = { kind: 'feedforward', ticks: 1, leak_shift: 0, reset: 0 };
/** A region's scale 1 and shift 0: its integer codes are its real values. */
const UNIT = { scale: 1, k: 0 }, UNIT_HEAD = { scale_c: 1, k_c: 0, scale_d: 1, k_d: 0 };
/** The OR tool: 2 input bits → [a | b, 1] (threshold layers: OR and a constant-1 unit, then a copy). */
const OR_MODEL = { format: 'threshold-layers', inputs: 2, outputs: 2, weightBits: 8, layers: [{ W: [[1, 1], [0, 0]], th: [1, 0], ...UNIT }, { W: identity(2), th: [1, 1], ...UNIT }] };
/** The selector's head on its first layer (a copy of the 3 input bits): choice logits [x2, 1] → OR (0) when x2 = 1
 *  (a tie, the first maximum wins), AND (1) when x2 = 0. data = the 3 bits. */
const HEAD = { tools: 'tools', K: 2, D: 3, R: 2, Wc: [[0, 0, 1], [0, 0, 0]], bc: [0, 1], Wd: I3, bd: [0, 0, 0], ...UNIT_HEAD };
/** The selector model: trailing tool layer (its 2 result bits are the output), or a plain 5-wide copy layer after it. */
function policyModel(trailing) {
  const first = { hidden: 3, W: I3, b: [0, 0, 0], ...UNIT };
  if (trailing) return { format: 'dense-policy', inputs: 3, outputs: 2, weightBits: 8, ...FF, layers: [first, HEAD] };
  return { format: 'dense-policy', inputs: 3, outputs: 5, weightBits: 8, ...FF, layers: [first, HEAD, { hidden: 5, W: identity(5), b: [0, 0, 0, 0, 0], ...UNIT }], output: { W: identity(5).map(r => r.map(w => 2 * w)), b: [-1, -1, -1, -1, -1], ...UNIT } };
}
const AND_SOURCE = 'export function and(data) {\n  return bits(data[0] * data[1], 1);\n}\n';
const LIF_TOOL_ID = '0x' + 'c'.repeat(64), MID_ID = '0x' + 'd'.repeat(64);
/** A LIF tool: 2 bits → [fired, 1]. One neuron adds the first bit each time the tool is called and fires at 2 (then
 *  rests at 0). So a call answers 1 on every second 1 it is handed. The tool remembers between calls. */
const LIF_TOOL = { format: 'dense-policy', kind: 'lif', inputs: 2, outputs: 2, weightBits: 8, ticks: 1, leak_shift: 10, reset: 0,
  layers: [{ hidden: 1, W: [[1, 0]], b: [0], ...UNIT, threshold: 2 }], output: { W: [[1], [0]], b: [-1, 0], ...UNIT } };
/** A network with its own tool layer: 3 bits → copy → its one tool on the first 2 bits. The tool's result is its output. */
const MID_MODEL = { format: 'dense-policy', inputs: 3, outputs: 2, weightBits: 8, ...FF, layers: [{ hidden: 3, W: I3, b: [0, 0, 0], ...UNIT },
  { tools: 'tools', K: 1, D: 2, R: 2, Wc: [[0, 0, 0]], bc: [0], Wd: [[1, 0, 0], [0, 1, 0]], bd: [0, 0], ...UNIT_HEAD }] };

/** scene → loop. loop.input → policy → policyR → loop.action. tools: OR (orNet → orR.run), then AND (code).
 *  `tool: 'lif'` puts the LIF counter LIF_TOOL in OR's place. `tool: 'nested'` puts MID there, whose own tool is
 *  LIF_TOOL (lifNet → lifR.run → mid.tools). */
function selectorGraph({ trailing = true, data = 3, tool = 'or' } = {}) {
  const g = new ModuleGraph();
  const add = (kind, title, config = {}) => g.addNode({ kind, title, config });
  const scene = add('code', 'scene', { source: 'export const budget = 2;\nexport function init(start) { return { seed: start.seed }; }\nexport function input(state) { return bits(state.seed, 3); }\nexport function step(state, action) { return { state, done: false, success: action > 0 }; }\n' });
  const seeds = add('partition'), loop = add('loop'), execution = add('execution');
  const tools = { tools: 'tools', ...(data ? { data } : {}) };
  const policy = add('network', '策略', { engine: 'dense-policy', ...FF, inputs: 3, layers: trailing ? [{ hidden: 3 }, tools] : [{ hidden: 3 }, tools, { hidden: 5 }], artifact: POLICY_ID });
  const policyR = add('readout', 'policyR', { mode: 'bits', width: trailing ? 2 : 5, decode: 'lsb-int' });
  const lifConfig = { engine: 'dense-policy', kind: 'lif', inputs: 2, layers: [{ hidden: 1 }], ticks: 1, leak_shift: 10, reset: 0, artifact: LIF_TOOL_ID };
  const orNet = tool === 'or' ? add('network', 'OR', { engine: 'threshold-layers', kind: 'feedforward', inputs: 2, layers: [2], artifact: OR_ID })
    : tool === 'lif' ? add('network', 'LIF', lifConfig)
    : add('network', 'MID', { engine: 'dense-policy', ...FF, inputs: 3, layers: [{ hidden: 3 }, { tools: 'tools', data: 2 }], artifact: MID_ID });
  const orR = add('readout', 'orR', { mode: 'bits', width: 2, decode: 'lsb-int' });
  const and = add('code', 'AND', { source: AND_SOURCE });
  const wire = (kind, a, p, b, q) => g.connect({ kind, from: { node: a.id, port: p }, to: { node: b.id, port: q } });
  wire('call', scene, 'module', loop, 'scenario');
  wire('value', loop, 'loop', execution, 'loop'); wire('value', seeds, 'test', execution, 'partition');
  wire('value', loop, 'input', policy, 'in'); wire('value', policy, 'scores', policyR, 'scores'); wire('value', policyR, 'action', loop, 'action');
  wire('value', orNet, 'scores', orR, 'scores');
  let lifNet = null;
  if (tool === 'nested') {
    lifNet = add('network', 'LIF', lifConfig);
    const lifR = add('readout', 'lifR', { mode: 'bits', width: 2, decode: 'lsb-int' });
    wire('value', lifNet, 'scores', lifR, 'scores');
    wire('call', lifR, 'run', orNet, 'tools');
  }
  wire('call', orR, 'run', policy, 'tools');
  wire('call', and, 'and', policy, 'tools');
  const models = { [POLICY_ID]: [policy.id, policyModel(trailing)], [OR_ID]: [orNet.id, OR_MODEL], [LIF_TOOL_ID]: [lifNet?.id ?? orNet.id, LIF_TOOL], [MID_ID]: [orNet.id, MID_MODEL] };
  let midTool = LIF_TOOL_ID;
  const artifacts = id => {
    if (!models[id]) return null;
    const a = shapedArtifact(g, ...models[id]);
    if (id === MID_ID) a.bundle.loop.nodes.net.tools = { tools: [{ kind: 'net', artifactId: midTool }] };   // the tools MID was trained with
    return a;
  };
  return { g, ids: { scene: scene.id, loop: loop.id, execution: execution.id, policy: policy.id, policyR: policyR.id, orNet: orNet.id, orR: orR.id, and: and.id, lifNet: lifNet?.id ?? null }, artifacts,
    trainMidWith: id => { midTool = id; } };
}
const bitsOf = (n, width) => Array.from({ length: width }, (_, k) => (n >> k) & 1);

test('tool layer widths: D is the declared data (else the widest network tool input), R the widest tool result', () => {
  const { g, ids } = selectorGraph();
  assert.deepEqual(g.resolved().problemsOf(ids.policy), []);
  assert.deepEqual(g.resolved().refsOf(ids.policy).tools, { tools: { K: 2, D: 3, R: 2 } });
  const derived = selectorGraph({ data: null });
  assert.deepEqual(derived.g.resolved().refsOf(derived.ids.policy).tools, { tools: { K: 2, D: 2, R: 2 } }, 'no data: the OR network\'s 2 input bits');
  const port = g.resolved().portsOf(ids.policy).inputs.find(p => p.id === 'tools');
  assert.equal(port.wire, 'call'); assert.equal(port.many, true);
  assert.deepEqual(port.signature.params, [{ type: 'vector', width: 3, binary: true }], 'code tools are typed at bits[D]');
  assert.equal(denseWeightBytes(3, [{ hidden: 3 }, { tools: 'tools', K: 2, D: 3, R: 2 }], 2, 8), 32 * (4 + 4 + 4), 'W|b, then the head (Wc|bc, Wd|bd), no output layer: one word per column');
  assert.equal(encodeDenseWeights(policyModel(true)).length, 2 + 2 * 32 * (4 + 4 + 4));
});

test('a trailing tool layer: only the chosen tool runs, a narrower tool reads its first bits, results are zero-extended', async () => {
  const { g, ids, artifacts } = selectorGraph();
  const bundle = buildBundle(g, ids.execution, { artifacts });
  const net = bundle.loop.nodes[ids.policy];
  assert.deepEqual(Object.keys(net.tools), ['tools']);
  assert.deepEqual(net.tools.tools.map(tool => tool.kind), ['net', 'program'], 'wire order: OR, then AND');
  assert.deepEqual(net.tools.tools[0].model, OR_MODEL);
  assert.equal(bundle.loop.nodes[ids.orNet], undefined, 'a tool\'s own nodes are not part of the loop body');
  const loop = createLoop(bundle.loop);
  for (let x = 0; x < 8; x++) {
    const [a, b, sel] = bitsOf(x, 3), r = loop.step([a, b, sel]);
    const record = r.tools[ids.policy].tools;
    assert.deepEqual(record.data, [a, b, sel], 'data = logit > 0 of the head over the copied bits');
    if (sel) assert.deepEqual([record.choice, record.result], [0, [a | b, 1]], 'OR reads the first 2 of the 3 data bits');
    else assert.deepEqual([record.choice, record.result], [1, [a & b, 0]], 'AND\'s 1-bit result is zero-extended to R = 2');
    assert.equal(r.action, record.result[0] + 2 * record.result[1]);
  }
  // a tool that would fail if it ran: a copy of the OR tool whose readout is one bit too wide
  const poisoned = tool => ({ ...tool, readout: { ...tool.readout, width: 3 } });
  const orPoisoned = createLoop({ ...bundle.loop, nodes: { ...bundle.loop.nodes, [ids.policy]: { ...net, tools: { tools: [poisoned(net.tools.tools[0]), net.tools.tools[1]] } } } });
  assert.deepEqual(orPoisoned.step([1, 1, 0]).tools[ids.policy].tools.result, [1, 0], 'AND chosen: the broken OR tool is not evaluated');
  assert.throws(() => orPoisoned.step([1, 1, 1]), /读出需要 3 个分数/, 'OR chosen: the broken tool runs');
  const andPoisoned = createLoop({ ...bundle.loop, nodes: { ...bundle.loop.nodes, [ids.policy]: { ...net, tools: { tools: [net.tools.tools[0], poisoned(net.tools.tools[0])] } } } });
  assert.deepEqual(andPoisoned.step([0, 1, 1]).tools[ids.policy].tools.result, [1, 1], 'OR chosen: the broken tool in AND\'s place is not evaluated');
  assert.throws(() => andPoisoned.step([0, 1, 0]), /读出需要 3 个分数/);
  // the greedy runner and the execution history carry the record
  const [episode] = runEpisodes(bundle, { episodes: [{ seed: 5 }], trace: true });
  assert.deepEqual(episode.trace[0].tools[ids.policy].tools, { choice: 0, data: [1, 0, 1], result: [1, 1] });
});

test('a plain layer after a tool layer receives result ‖ layer before', () => {
  const { g, ids, artifacts } = selectorGraph({ trailing: false });
  assert.deepEqual(g.resolved().problemsOf(ids.policy), []);
  const loop = createLoop(buildBundle(g, ids.execution, { artifacts }).loop);
  for (let x = 0; x < 8; x++) {
    const input = bitsOf(x, 3), r = loop.step(input), { result } = r.tools[ids.policy].tools;
    assert.deepEqual(r.values[`${ids.policyR}.bits`], [...result, ...input], 'the 5-wide copy layer sees the 2 result bits, then the 3 bits before');
  }
});

test('the engine calls only the chosen tool, once, with the data bits', () => {
  const calls = [], box = calls => ({ width: 0, call: (port, choice, data) => { calls.push([port, choice, data]); return choice ? [1] : [0, 1]; } });
  const exec = createExecutor(policyModel(true), null, { tools: box(calls) });
  assert.deepEqual(exec.step([1, 0, 0]).tools, { tools: { choice: 1, data: [1, 0, 0], result: [1, 0] } });
  assert.deepEqual(exec.step([0, 1, 1]).scores, [-1, 1], 'a trailing tool layer\'s scores are +1 / -1 per result bit');
  assert.deepEqual(calls, [['tools', 1, [1, 0, 0]], ['tools', 0, [0, 1, 1]]]);
  assert.throws(() => createExecutor(policyModel(true)).step([0, 0, 0]), /没有接工具/);
  assert.throws(() => createExecutor(policyModel(true), null, { tools: { width: 0, call: () => [1, 1, 1] } }).step([0, 0, 0]), /最多 2 位/);
});

// ------------------------------------------------------------------ stateful and nested tools (ADR 0014)
/** a·b·sel as input bits: sel = 1 chooses tool 0 (the LIF counter, or MID calling it) on [a, b], sel = 0 AND. */
const COUNTS = [[1, 0, 1], [1, 1, 0], [0, 1, 1], [1, 0, 1], [1, 0, 1]];
/** per step: the result bits and the counter's potential after it (only tool 0 steps advance it) */
const COUNTED = [[[0, 1], 1], [[1, 0], 1], [[0, 1], 1], [[1, 1], 0], [[0, 1], 1]];

test('a LIF tool keeps its potential in the caller\'s state, only when chosen; reset clears it; two sessions never share it', () => {
  const { g, ids, artifacts } = selectorGraph({ tool: 'lif' });
  assert.deepEqual(g.resolved().problemsOf(ids.policy), []);
  const bundle = buildBundle(g, ids.execution, { artifacts }), n = bundle.loop.nodes[ids.policy];
  assert.deepEqual(n.tools.tools[0].model, LIF_TOOL);
  const loop = createLoop(bundle.loop), other = createLoop(bundle.loop);
  COUNTS.forEach((x, k) => {
    const r = loop.step(x);
    assert.deepEqual([r.tools[ids.policy].tools.result, loop.states()[ids.policy]], [COUNTED[k][0], [COUNTED[k][1]]], `step ${k + 1}: the FF selector's state is its LIF tool's potential`);
  });
  assert.deepEqual(other.states()[ids.policy], [0], 'another session (executor) was never touched');
  other.step([1, 0, 1]);
  assert.deepEqual([loop.states()[ids.policy], other.states()[ids.policy]], [[1], [1]]);
  loop.reset();
  assert.deepEqual(loop.states()[ids.policy], [0], 'reset clears the tool\'s state with the caller\'s');
  // peek decides from the state without advancing it, the contract's peek
  const exec = createExecutor(n.model, n.structure, { tools: toolCaller(ids.policy, n) });
  exec.step([1, 0, 1]);
  assert.deepEqual(exec.peek([1, 0, 1]).voltages, [0], 'the peeked step would fire and rest the counter');
  assert.deepEqual(exec.voltages(), [1], 'peek leaves the state where it is');
  // a LIF selector's own potentials come first, its tools' states after them
  const lifSel = { ...policyModel(true), kind: 'lif', ticks: 1, leak_shift: 10, layers: [{ ...policyModel(true).layers[0], threshold: 1 }, HEAD] };
  const both = createExecutor(lifSel, null, { tools: toolCaller(ids.policy, n) });
  assert.deepEqual(both.step([1, 0, 1]).voltages, [0, 0, 0, 1], 'own 3 potentials (fired, reset), then the counter');
});

test('a tool with its own tool layer: its tools run inside it, their state nested in the outermost caller\'s', () => {
  const nested = selectorGraph({ tool: 'nested' });
  assert.deepEqual(nested.g.resolved().problemsOf(nested.ids.policy), []);
  const bundle = buildBundle(nested.g, nested.ids.execution, { artifacts: nested.artifacts }), mid = bundle.loop.nodes[nested.ids.policy].tools.tools[0];
  assert.deepEqual([mid.model, mid.tools.tools[0].model], [MID_MODEL, LIF_TOOL], 'the tool carries its own tools');
  const loop = createLoop(bundle.loop);
  COUNTS.forEach((x, k) => {
    const r = loop.step(x);
    assert.deepEqual([r.tools[nested.ids.policy].tools.result, loop.states()[nested.ids.policy]], [COUNTED[k][0], [COUNTED[k][1]]], `step ${k + 1}: as if the counter were wired directly`);
  });
  nested.trainMidWith(OR_ID);
  assert.throws(() => buildBundle(nested.g, nested.ids.execution, { artifacts: nested.artifacts }), /工具网络 MID 接的工具与它的产物训练时用的不同/,
    'MID must call the tools its artifact was trained with: on chain its module calls those');
});

test('tool nesting is bounded: a network more than MAX_TOOL_DEPTH deep is a problem, and the deployment check agrees', () => {
  const g = new ModuleGraph();
  const net = (title, tools) => g.addNode({ kind: 'network', title, config: { engine: 'dense-policy', ...FF, inputs: 2, layers: tools ? [{ hidden: 2 }, { tools: 'tools', data: 2 }] : [{ hidden: 2 }] } });
  const read = n => { const r = g.addNode({ kind: 'readout', config: { mode: 'bits', width: 2, decode: 'lsb-int' } }); g.connect({ kind: 'value', from: { node: n.id, port: 'scores' }, to: { node: r.id, port: 'scores' } }); return r; };
  // N_d calls N_{d-1} through its readout's run: N_d nests d deep
  const chain = Array.from({ length: MAX_TOOL_DEPTH + 2 }, (_, d) => net(`N${d}`, d > 0)), outs = chain.map(read);
  const call = d => g.connect({ kind: 'call', from: { node: outs[d - 1].id, port: 'run' }, to: { node: chain[d].id, port: 'tools' } });
  for (let d = MAX_TOOL_DEPTH + 1; d >= 1; d--) call(d);                     // top down: the wire into N2 makes N4 4 deep, the problem lands on N4
  const deep = /工具嵌套 \d 层，超过上限 3 层/;
  assert.ok(!messages(g, chain[MAX_TOOL_DEPTH].id).some(m => deep.test(m)), `depth ${MAX_TOOL_DEPTH} is allowed`);
  assert.ok(messages(g, chain[MAX_TOOL_DEPTH + 1].id).some(m => /工具嵌套 4 层，超过上限 3 层/.test(m)), 'depth 4 is a problem on the network');
  g.disconnect(g.producers(chain[MAX_TOOL_DEPTH + 1].id, 'tools')[0].wire.id);
  assert.throws(() => call(MAX_TOOL_DEPTH + 1), /工具嵌套 4 层/, 'wiring the tool that makes it too deep is refused at once');
  // the deployment check over Tool entries (what the Factory refuses with "depth")
  const spec = { engine: 'dense-policy', kind: 'feedforward', inputs: 2, outputs: 2, layers: [{ hidden: 2 }, { tools: 'tools', K: 1, D: 2, R: 2 }] };
  const leaf = { kind: 'net', structure: { ...spec, layers: [{ hidden: 2 }] }, tools: undefined };
  const wrap = (tool, d) => (d ? wrap({ kind: 'net', structure: spec, tools: { tools: [tool] } }, d - 1) : tool);
  assert.equal(toolEntriesDepth([wrap(leaf, MAX_TOOL_DEPTH - 1)]), MAX_TOOL_DEPTH);
  assert.equal(deploymentProblem(spec, [wrap(leaf, MAX_TOOL_DEPTH - 1)]), null);
  assert.match(deploymentProblem(spec, [wrap(leaf, MAX_TOOL_DEPTH)]), /工具嵌套 4 层，超过上限 3 层/);
  // the state a module keeps per session: its LIF potentials, then each network tool's state
  const lifLeaf = { kind: 'net', structure: { ...spec, kind: 'lif', layers: [{ hidden: 200 }] } };
  assert.equal(moduleStateWidth({ ...spec, kind: 'lif' }, [lifLeaf, wrap(lifLeaf, 1)]), 2 + 200 + 200);
  assert.match(deploymentProblem(spec, [lifLeaf, lifLeaf]), /状态共 400 个 int32/);
});

// ------------------------------------------------------------------ the Transition's loop (ADR 0010 §10)
/** selectorGraph with an evaluator on the same loop whose reward reads the policy's tool layer. */
function rewardGraph(source) {
  const sel = selectorGraph(), { g, ids } = sel;
  const evaluator = g.addNode({ kind: 'evaluator' }), seeds = g.producers(ids.execution, 'partition')[0].node;
  const reward = g.addNode({ kind: 'code', title: 'reward', config: { source } });
  g.connect({ kind: 'value', from: { node: ids.loop, port: 'loop' }, to: { node: evaluator.id, port: 'loop' } });
  g.connect({ kind: 'value', from: { node: seeds, port: 'test' }, to: { node: evaluator.id, port: 'partition' } });
  g.connect({ kind: 'call', from: { node: reward.id, port: 'reward' }, to: { node: evaluator.id, port: 'objective' } });
  return { ...sel, ids: { ...ids, evaluator: evaluator.id, reward: reward.id } };
}
const READS_DATA = 'export function reward(transition) { const d = transition.loop.策略.tools.data; return at(d, 0) + 2 * at(d, 1) + 4 * at(d, 2) + 8 * transition.loop.策略.tools.choice; }';

test('the reward reads transition.loop.<title>.<port>: typed from the tool layer, fed with what the executor recorded', () => {
  const { g, ids, artifacts } = rewardGraph(READS_DATA), res = g.resolved();
  assert.deepEqual(res.problemsOf(ids.reward), []);
  assert.deepEqual(res.refsOf(ids.loop).Transition.fields.loop, { type: 'record', fields: { 策略: { type: 'record', fields: { tools: { type: 'record', fields: {
    choice: { type: 'number' }, data: { type: 'vector', width: 3, binary: true }, result: { type: 'vector', width: 2, binary: true } } } } } } });
  const doc = rolesOf(g, res, ids.reward).docs('reward').transition.fields.loop;
  assert.deepEqual(Object.keys(doc.fields.策略.fields.tools.fields).sort(), ['choice', 'data', 'result'], 'the role help documents every field');
  const bundle = buildBundle(g, ids.evaluator, { artifacts });
  assert.equal(bundle.loop.nodes[ids.policy].title, '策略', 'the bundle names each tool-layer network: the key its record goes under');
  const results = runEpisodes(bundle, { episodes: [{ seed: 1 }, { seed: 5 }, { seed: 6 }], trace: true });
  for (const r of results) {
    const want = r.trace.reduce((sum, step) => { const { choice, data } = step.tools[ids.policy].tools; return sum + data[0] + 2 * data[1] + 4 * data[2] + 8 * choice; }, 0);
    assert.equal(r.return, want, 'the reward sums the executed decisions');
    for (const step of r.trace) assert.deepEqual(step.transition.loop, { 策略: step.tools[ids.policy] });
  }
  g.patchConfig(ids.reward, { source: READS_DATA.replace('.tools.data', '.tools.dta') });
  const typo = g.resolved().problemsOf(ids.reward).find(p => /dta/.test(p.message));
  assert.ok(typo && !typo.incomplete, 'a misspelt field is a type error');
});

test('network titles in a loop with a tool layer are unique: a duplicate is a problem on the loop, never resolved', () => {
  const { g, ids } = rewardGraph(READS_DATA);
  // loop.input → pre (a plain network) → preR → policy.in: two networks in the body
  const pre = g.addNode({ kind: 'network', title: 'pre', config: { engine: 'dense-policy', ...FF, inputs: 3, layers: [{ hidden: 3 }] } });
  const preR = g.addNode({ kind: 'readout', config: { mode: 'bits', width: 3, decode: 'lsb-int' } });
  g.disconnect(g.producers(ids.policy, 'in')[0].wire.id);
  g.connect({ kind: 'value', from: { node: ids.loop, port: 'input' }, to: { node: pre.id, port: 'in' } });
  g.connect({ kind: 'value', from: { node: pre.id, port: 'scores' }, to: { node: preR.id, port: 'scores' } });
  g.connect({ kind: 'value', from: { node: preR.id, port: 'bits' }, to: { node: ids.policy, port: 'in' } });
  const duplicate = () => g.resolved().problemsOf(ids.loop).find(p => /标题重复/.test(p.message));
  assert.equal(duplicate(), undefined);
  assert.deepEqual(Object.keys(g.resolved().refsOf(ids.loop).Transition.fields.loop.fields), ['策略'], 'only networks with tool layers have a record');
  g.setTitle(pre.id, '策略');
  assert.match(duplicate()?.message ?? '', /策略/);
  assert.equal(g.resolved().refsOf(ids.loop).Transition, null, 'the Transition is not guessed');
  assert.ok(g.resolved().problemsOf(ids.reward).every(p => p.incomplete), 'the reward waits for the loop instead of erroring on a guess');
  const other = selectorGraph();
  other.g.setTitle(other.ids.orNet, '策略');
  assert.equal(other.g.resolved().problemsOf(other.ids.loop).find(p => /标题重复/.test(p.message)), undefined, 'a tool network is not in the body');
});

// ------------------------------------------------------------------ LIF segments
const LIF = { format: 'dense-policy', kind: 'lif', weightBits: 8, ticks: 3, leak_shift: 1, reset: 0 };
const L1 = { hidden: 3, W: [[3, 0], [2, 2], [0, 5]], b: [1, 0, -1], ...UNIT, threshold: 4 };
const L2 = { hidden: 2, W: [[2, 0, 1, 1, 0], [0, 3, 0, 0, 2]], b: [0, 1], ...UNIT, threshold: 4 };
/** head over L1's spike counts (0..3): choice by count[2] vs 1.5 (bias × ticks), data bit d = count[d] > 1 */
const LIF_HEAD = { tools: 'tools', K: 2, D: 2, R: 2, Wc: [[0, 0, 2], [0, 0, 0]], bc: [-1, 0], Wd: [[2, 0, 0], [0, 2, 0]], bd: [-1, -1], ...UNIT_HEAD };
const OUT = (width, n) => ({ W: Array.from({ length: n }, (_, a) => Array.from({ length: width }, (__, j) => ((a + j) % 3) - 1)), b: Array.from({ length: n }, (_, a) => a), ...UNIT });
const toolFn = (_port, choice, data) => (choice ? [data[0] & data[1]] : [data[0] | data[1], 1]);

test('LIF: one segment behaves exactly as the network without a tool layer', () => {
  const plain = { ...LIF, inputs: 2, outputs: 3, layers: [L1], output: OUT(3, 3) };
  const tooled = { ...LIF, inputs: 2, outputs: 2, layers: [L1, LIF_HEAD] };
  const v1 = new Array(3).fill(0), v2 = new Array(3).fill(0);
  for (const x of [[1, 0], [1, 1], [0, 1], [1, 1], [0, 0], [1, 0]]) {
    const a = integerStep(plain, x, v1), b = integerStep(tooled, x, v2, toolFn);
    assert.deepEqual(b.count, a.count); assert.deepEqual(v2, v1);
    const counts = a.count;
    const choice = 2 * counts[2] - 3 > 0 ? 0 : 1, data = [2 * counts[0] - 3 > 0 ? 1 : 0, 2 * counts[1] - 3 > 0 ? 1 : 0];
    assert.deepEqual(b.tools.tools, { choice, data, result: toolFn('tools', choice, data).concat([0, 0]).slice(0, 2) }, 'the head reads spike counts, biases × ticks');
  }
});

test('LIF: two segments each run all ticks; the second sees result ‖ fired at least once; potentials persist per layer', () => {
  const model = { ...LIF, inputs: 2, outputs: 3, layers: [L1, LIF_HEAD, L2], output: OUT(2, 3) };
  const seg1 = { ...LIF, inputs: 2, outputs: 1, layers: [L1], output: OUT(3, 1) }, seg2 = { ...LIF, inputs: 5, outputs: 3, layers: [L2], output: OUT(2, 3) };
  const v = new Array(5).fill(0), r1 = new Array(3).fill(0), r2 = new Array(2).fill(0);
  let secondFired = 0;
  for (const x of [[1, 1], [1, 0], [0, 1], [1, 1], [1, 1], [0, 0], [1, 0]]) {
    const step = integerStep(model, x, v, toolFn), a = integerStep(seg1, x, r1);
    const { result } = step.tools.tools, before = a.count.map(c => (c > 0 ? 1 : 0));
    const b = integerStep(seg2, [...result, ...before], r2);
    assert.deepEqual(step.count, [...a.count, ...b.count]);
    assert.deepEqual(v, [...r1, ...r2]);
    assert.deepEqual(step.scores, b.scores, 'the output layer reads the second segment\'s counts');
    secondFired = Math.max(secondFired, ...b.count);
  }
  assert.equal(secondFired, 3, 'the second segment ran 3 ticks (a neuron fired on each of them)');
});

// ------------------------------------------------------------------ problems
const messages = (g, id) => g.resolved().problemsOf(id).map(p => p.message);

test('problems: threshold tool layer, duplicate ports, undetermined D, non-bits readout, a tool that cannot be called', () => {
  const g = new ModuleGraph();
  const th = g.addNode({ kind: 'network', config: { engine: 'threshold-layers', kind: 'feedforward', layers: [{ tools: 'tools' }] } });
  assert.ok(messages(g, th.id).some(m => /threshold-layers 不支持工具层/.test(m)));
  const dup = g.addNode({ kind: 'network', config: { layers: [{ hidden: 4 }, { tools: 'tools' }, { tools: 'tools' }] } });
  assert.ok(messages(g, dup.id).some(m => /工具层端口 tools 重复声明/.test(m)));
  const both = g.addNode({ kind: 'network', config: { layers: [{ hidden: 4, tools: 'tools' }] } });
  assert.ok(messages(g, both.id).some(m => /不能同时有 hidden 和 tools/.test(m)));

  const codeOnly = selectorGraph({ data: null });
  codeOnly.g.disconnect(codeOnly.g.producers(codeOnly.ids.policy, 'tools')[0].wire.id);
  const p = codeOnly.g.resolved().problemsOf(codeOnly.ids.policy).find(x => /数据宽度未定/.test(x.message));
  assert.ok(p?.incomplete, 'a code-only tool layer without data is incomplete: set data');
  codeOnly.g.patchConfig(codeOnly.ids.policy, { layers: [{ hidden: 3 }, { tools: 'tools', data: 2 }] });
  assert.deepEqual(codeOnly.g.resolved().refsOf(codeOnly.ids.policy).tools, { tools: { K: 1, D: 2, R: 1 } }, 'with data a code-only layer works');

  const argmax = selectorGraph();
  argmax.g.patchConfig(argmax.ids.policyR, { mode: 'argmax', map: [0, 1] });
  assert.ok(messages(argmax.g, argmax.ids.policy).some(m => /读出必须是位读出/.test(m)));
  const wide = selectorGraph();
  wide.g.patchConfig(wide.ids.policyR, { width: 3 });
  assert.ok(messages(wide.g, wide.ids.policy).some(m => /读出宽度 3 必须等于工具结果的 2 位/.test(m)));

  // any frozen network is a tool (ADR 0014): a LIF one too
  const lif = selectorGraph();
  lif.g.patchConfig(lif.ids.orNet, { engine: 'dense-policy', kind: 'lif', layers: [{ hidden: 2 }], ticks: 2, leak_shift: 1, reset: 0 });
  assert.deepEqual(lif.g.resolved().problemsOf(lif.ids.policy), [], 'a LIF network tool is no problem');
});

test('an argmax readout\'s frozen network is a tool: no problem on the graph, its result is the one-hot of the first maximum', () => {
  const { g, ids, artifacts } = selectorGraph();
  g.patchConfig(ids.orR, { mode: 'argmax', map: [0, 1] });
  assert.deepEqual(g.resolved().problemsOf(ids.policy), []);
  assert.deepEqual(g.resolved().problemsOf(ids.orR), []);
  assert.deepEqual(g.resolved().refsOf(ids.policy).tools, { tools: { K: 2, D: 3, R: 2 } });
  const bundle = buildBundle(g, ids.execution, { artifacts }), tool = bundle.loop.nodes[ids.policy].tools.tools[0];
  assert.deepEqual(tool.readout, { mode: 'argmax', map: [0, 1], width: 2 });
  const loop = createLoop(bundle.loop);
  for (let x = 0; x < 8; x++) {
    const [a, b, sel] = bitsOf(x, 3), record = loop.step([a, b, sel]).tools[ids.policy].tools;
    // OR's scores are [(a | b) − 1, 0]: a tie when a | b = 1, and the first maximum wins
    if (sel) assert.deepEqual([record.choice, record.result], [0, a | b ? [1, 0] : [0, 1]]);
  }
  assert.match(deploymentProblem({ engine: 'dense-policy', inputs: 3, outputs: 2, layers: [{ hidden: 3 }, { tools: 'tools', K: 1, D: 3, R: 2 }] }, [tool]),
    /argmax 读出的网络工具不能部署/, 'on chain a tool layer reads its tool\'s scores as bits');
});

test('trainer: a tool-layer network trains by REINFORCE only (bits readout when the tool layer is last), on either backend', () => {
  const { g, ids } = selectorGraph();
  const trainer = g.addNode({ kind: 'trainer', config: { backend: 'python' } });
  g.connect({ kind: 'value', from: { node: ids.loop, port: 'loop' }, to: { node: trainer.id, port: 'loop' } });
  g.patchConfig(ids.policy, { artifact: null });
  g.connect({ kind: 'value', from: { node: ids.policy, port: 'structure' }, to: { node: trainer.id, port: 'structure' } });
  assert.ok(!messages(g, trainer.id).some(m => /工具层|读出/.test(m)), 'reinforce accepts the trailing tool layer and its bits readout');
  for (const method of ['cross-entropy', 'hinge']) {
    g.patchConfig(trainer.id, { method });
    assert.ok(messages(g, trainer.id).includes('带工具层的网络只能用强化学习训练'), method);
  }
  const after = selectorGraph({ trailing: false });
  const t2 = after.g.addNode({ kind: 'trainer', config: { method: 'reinforce' } });
  after.g.patchConfig(after.ids.policy, { artifact: null });
  assert.throws(() => after.g.connect({ kind: 'value', from: { node: after.ids.policy, port: 'structure' }, to: { node: t2.id, port: 'structure' } }),
    /reinforce 需要 argmax 读出/, 'with layers after the tool layer the readout is argmax as for any network');
});
