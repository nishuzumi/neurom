// core/loop.js — the loop executor (ADR 0009 §2). It holds the `loop` bundle section, one step of the loop body on the
// integer engines, and the lockstep runner. Every driver steps episodes through the runner, greedily or with a trainer
// that decides the trained network. Python twins: training/bundle_loop.py (the executor, batched over lanes) and
// training/bundle_train.py Session.run_steps (the lockstep runner of whole-loop training).
//
//   loop section  { I, action: Ref, nodes: { <id>: LoopNode }, trained: <networkId> | null }
//                 Ref = { node: <id> | '$input', port }; LoopNode = network { structure, in, model, artifactId, tools?, title? }
//                 | readout { readout, scores } | bits { parts, in: { <port>: Ref } }
//                 A network with tool layers carries `tools: { <port>: [Tool…] }` in wire order and its `title`. The
//                 title is the key of its record in the Transition's `loop` (ADR 0010 §10).
//                 Tool = { kind: 'net', structure, model, artifactId, readout, tools? }
//                 | { kind: 'program', program, bound, boundTypes, exact }.
//                 A net tool is a frozen network of any kind on its accepted artifact. That artifact is the module a
//                 deployment reuses or deploys for it. A net tool also carries the readout (bits or argmax) whose
//                 `run` is wired, and its own `tools` when it has tool layers. A program tool is a code export, typed
//                 at bits[D].
//                 Tools' own nodes are not part of the body.
//   step          demand-driven from `action`, memoised per step. `ran` holds the nodes evaluated this step. `values`
//                 holds every evaluated output ('<node>.<port>'). `tools` holds each tool layer's
//                 `{ choice, data, result }` (`tools.<network>.<port>`) of the networks that ran. A tool layer runs
//                 only its chosen tool. Networks keep their executor state across steps: their LIF potentials, then
//                 their network tools' states (toolCaller). A tool state advances only when the tool is chosen
//                 (ADR 0014).
//   intercept     inside the lockstep runner only (createLockstep `decide`). When a step demands the trained network,
//                 its `in` bits go to the trainer instead of the engine. The trainer answers `{ scores }`, `{ slot }`
//                 or `{ bits }`. Its readout decodes `{ scores }` as usual. `{ slot }` (argmax readouts) is the chosen
//                 readout slot. `{ bits }` (bits readouts) is the readout bits, coerced to 0/1, exactly the readout's
//                 width. `tools` (with any answer) is the intercepted network's tool layer record.
//   Transition    what the reward reads (loopTransition): the runner's record, plus `loop: { <title>: tools.<network> }`
//                 of every network with tool layers when the loop has any (typed by transitionTypeOf).
import { BundleError, programEntry } from './bundle.js';
import { networkStructure, structureConfig, readoutOf, isToolLayer, layersNotation, ownTools } from './kinds/network.js';
import { readoutEntry } from './kinds/readout.js';
import { partPorts, partsWidth } from './kinds/bits.js';
import { initCandidatesOf } from './kinds/trainer.js';
import { bodyIn, withLoopValues, graphView } from './kinds/loop.js';
import { readout as readScores, readoutBits, decodeBits, INVALID_ACTION } from './readout.js';
import { createExecutor, modelProblem, stateWidthOf, stepFrom } from './sessions/executor.js';
import { compileEntry, deepEqual } from './sessions/common.js';
import { bits as bitsType } from './types.js';
import { createEnv } from './runner.js';
import { t } from '../i18n.js';

export const INPUT = '$input';

class LoopError extends Error {
  constructor(message) { super(message); this.name = 'LoopError'; }
}

// ------------------------------------------------------------------ the bundle section
/**
 * The `loop` section of loop `loopId` in a resolved graph. `trained` is the network a trainer trains (its model stays
 * null). Every other network's model is its accepted artifact (acceptedArtifactId). The artifact is looked up with
 * `artifacts(id) → artifact | null` and checked against the network (networkCompatibility). Throws BundleError with
 * the blocking problems.
 */
export function loopSection(graph, res, loopId, { trained = null, artifacts = null } = {}) {
  const loop = graph.node(loopId);
  const errors = res.problemsOf(loopId);
  if (errors.length) throw new BundleError(t('回路 {title} 尚有问题：{message}', { title: loop.title, message: errors[0].message }), errors);
  const view = graphView(graph, res);
  const body = bodyIn(view, loopId), inBody = new Set(body.nodes);
  const refOf = (nodeId, port) => {
    const p = graph.producers(nodeId, port)[0];
    if (!p) throw new BundleError(t('必需输入 {port} 尚未连接', { port }));
    if (p.node === loopId && p.port === 'input') return { node: INPUT, port: 'bits' };
    if (!inBody.has(p.node)) throw new BundleError(t('{title} 的 {port} 来自回路外：回路体的逐步输入只能来自回路的 input 或回路体', { title: graph.node(nodeId).title, port }));
    return { node: p.node, port: p.port };
  };
  const nodes = {};
  for (const id of body.nodes) {
    const node = graph.node(id);
    for (const problem of res.problemsOf(id)) throw new BundleError(t('{title} 尚有问题：{message}', { title: node.title, message: problem.message }), [problem]);
    switch (node.kind) {
      case 'network': {
        const { I, O, tools = {} } = res.refsOf(id);
        if (!I || !O) throw new BundleError(t('网络 {title} 的输入或输出宽度尚未确定', { title: node.title }));
        const accepted = id === trained ? { model: null, artifactId: null } : acceptedModel(graph, res, node, artifacts);
        const structure = networkStructure(node.config, I, O, tools);
        nodes[id] = { kind: 'network', structure, in: refOf(id, 'in'), ...accepted, ...(structure.layers?.some(isToolLayer) ? { tools: toolsSection(graph, res, node, structure, artifacts), title: node.title } : {}) };
        break;
      }
      case 'readout': nodes[id] = { kind: 'readout', readout: readoutEntry(node.config), scores: refOf(id, 'scores') }; break;
      case 'bits': nodes[id] = { kind: 'bits', parts: node.config.parts.map(p => ({ port: p.port, offset: p.offset, width: p.width })), in: Object.fromEntries(partPorts(node.config.parts).map(port => [port, refOf(id, port)])) }; break;
      default: throw new BundleError(t('{title} 不能放在回路里：回路只能由网络、读出和位线组成', { title: node.title }));
    }
  }
  const section = { I: res.refsOf(loopId).I, action: refOf(loopId, 'action'), nodes, trained };
  if (trained !== null && nodes[trained]?.kind !== 'network') throw new BundleError(t('训练的网络 {title} 不在回路 {loop} 里', { title: graph.node(trained).title, loop: loop.title }));
  if (trained !== null) { const net = graph.node(trained), r = readoutOf(net, view); if (!r || !inBody.has(r.id)) throw new BundleError(t('网络 {title} 在回路里没有读出', { title: net.title })); }
  return section;
}

/** The artifact a network runs when no trainer trains it: its own `artifact`, else the accepted artifact of the
 *  candidates wired into its `weights`. null when it has neither. This is the one place that decides a network's
 *  accepted model. */
function acceptedArtifactId(graph, node) {
  if (node.config.artifact) return node.config.artifact;
  const w = graph.producers(node.id, 'weights')[0], cands = w ? graph.node(w.node) : null;
  return cands?.kind === 'candidates' ? cands.config.accepted ?? null : null;
}
/** The structure and readout (spec + width) network `node` has in the current graph → `{ structure, readout }`. */
export function networkShape(graph, res, node) {
  const { I, O, tools = {} } = res.refsOf(node.id), r = readoutOf(node, graph);
  return { structure: I && O ? networkStructure(node.config, I, O, tools) : null, readout: r ? readoutEntry(r.config) : null };
}
/** Why `artifact` cannot run as network shape `shape` (`{ structure, readout }`): its trained network must have the
 *  same structure and readout → `{ ok, reason }`. The candidates compatibility adds the environment on top. */
export function networkCompatibility(artifact, shape) {
  const a = trainedOf(artifact.bundle?.loop);
  if (!a) return { ok: false, reason: t('产物里没有训练的网络') };
  if (!deepEqual(a.structure, shape.structure)) return { ok: false, reason: t('网络结构不同：产物 {a}，当前 {b}', { a: describeNetwork(a.structure), b: shape.structure ? describeNetwork(shape.structure) : '?' }) };
  if (!deepEqual(a.readout, shape.readout)) return { ok: false, reason: t('读出规格不同') };
  return { ok: true, reason: '' };
}
const describeNetwork = n => `${n.engine}/${n.kind} ${n.inputs}→${layersNotation(n.layers)}→${n.outputs} int${n.weightBits}`;   // i18n-ignore: structural notation
/** The accepted model of a frozen network → `{ model, artifactId }`. The artifact must fit the network. */
function acceptedModel(graph, res, node, artifacts) {
  const artifactId = acceptedArtifactId(graph, node);
  const artifact = artifactId && artifacts ? artifacts(artifactId) : null;
  if (!artifact?.model) throw new BundleError(t('网络 {name} 没有已接受的权重', { name: node.title }));
  const fit = networkCompatibility(artifact, networkShape(graph, res, node));
  if (!fit.ok) throw new BundleError(t('网络 {name} 的产物不兼容：{reason}', { name: node.title, reason: fit.reason }));
  return { model: artifact.model, artifactId };
}
/** The start of a trainer's run: the accepted artifact of the candidates wired into its `init` → `{ model,
 *  artifactId }`, or null without the wire. The artifact must fit the trained network `net`, as the artifact of a
 *  frozen network must (networkCompatibility). Throws BundleError when it cannot start from it (ADR 0020). */
export function initModel(graph, res, trainer, net, artifacts) {
  if (!graph.producers(trainer.id, 'init').length) return null;
  const artifactId = initCandidatesOf(graph, trainer)?.config.accepted ?? null;
  const artifact = artifactId && artifacts ? artifacts(artifactId) : null;
  if (!artifact?.model) throw new BundleError(t('训练器 {name} 的 init 没有已接受的权重', { name: trainer.title }));
  const fit = networkCompatibility(artifact, networkShape(graph, res, net));
  if (!fit.ok) throw new BundleError(t('训练器 {name} 的 init 产物不兼容：{reason}', { name: trainer.title, reason: fit.reason }));
  return { model: artifact.model, artifactId };
}
/** A module outside the body that a bundle carries (a tool): its problems block the bundle as a body node's do. */
function ready(graph, res, id) {
  for (const problem of res.problemsOf(id)) throw new BundleError(t('{title} 尚有问题：{message}', { title: graph.node(id).title, message: problem.message }), [problem]);
}
/** `{ <port>: [Tool…] }` of a network with tool layers: every tool wired into each tool port, in wire order, as its
 *  typed call carries it (core/resolve.js). A tool is a program, or a frozen network on its accepted weights and its
 *  readout. A network tool with tool layers carries its own tools, recursively. Those must be the tools its artifact
 *  was trained with (the artifact's module calls them on chain). */
export function toolsSection(graph, res, node, structure, artifacts) {
  const out = {};
  for (const layer of structure.layers.filter(isToolLayer)) {
    if (!layer.K || !layer.D || !layer.R) throw new BundleError(t('网络 {title} 的工具层 {port} 宽度尚未确定', { title: node.title, port: layer.tools }));
    out[layer.tools] = graph.producers(node.id, layer.tools).map(p => {
      ready(graph, res, p.node);
      const carries = res.calls.get(p.wire.id)?.carries;
      if (carries?.kind === 'net') return netTool(graph, res, carries, artifacts);
      const e = programEntry(graph, res, node.id, layer.tools, p.wire.id);   // throws the call's problem when it did not type
      return { kind: 'program', program: e.program, bound: e.bound, boundTypes: e.boundTypes, exact: e.exact };
    });
  }
  return out;
}
/** The Tool of the network a typed call carries (`{ kind:'net', network, readout }`, core/resolve.js): the frozen
 *  network on its accepted weights, with its readout and its own tools. A tool layer and a script module
 *  (core/script-calls.js) call it. Throws BundleError when it cannot run. */
export function netTool(graph, res, carries, artifacts) {
  const net = carries.network, { I, O, tools: widths = {} } = res.refsOf(net.id);
  ready(graph, res, net.id);
  const own = networkStructure(net.config, I, O, widths), accepted = acceptedModel(graph, res, net, artifacts);
  if (!own.layers.some(isToolLayer)) return { kind: 'net', structure: own, ...accepted, readout: carries.readout };
  const tools = toolsSection(graph, res, net, own, artifacts);
  if (!sameTools(ownTools({ structure: own, tools }), trainedTools(artifacts(accepted.artifactId).bundle.loop))) {
    throw new BundleError(t('工具网络 {title} 接的工具与它的产物训练时用的不同：链上它调用产物里的工具', { title: net.title }));
  }
  return { kind: 'net', structure: own, ...accepted, readout: carries.readout, tools };
}
/** Whether two Tool lists (layer then wire order) call the same tools: network tools by artifact, programs by code and bound values. */
const sameTools = (a, b) => a.length === b.length && a.every((x, k) => x.kind === b[k].kind
  && (x.kind === 'net' ? x.artifactId === b[k].artifactId : deepEqual(x.program, b[k].program) && deepEqual(x.bound, b[k].bound)));

/** The trained network of a loop section and its readout → `{ id, structure, readoutId, readout }` (readout null when
 *  none consumes its scores), or null. A network read by more than one readout is an error (as in createLoop). */
export function trainedOf(loop) {
  const id = loop?.trained ?? null, net = id ? loop.nodes[id] : null;
  if (!net) return null;
  const readouts = Object.entries(loop.nodes).filter(([, n]) => n.kind === 'readout' && n.scores.node === id);
  if (readouts.length > 1) throw new LoopError(t('网络 {id} 在回路里有不止一个读出', { id }));
  const [readoutId, r] = readouts[0] ?? [null, null];
  return { id, structure: net.structure, readoutId, readout: r?.readout ?? null };
}
/** An artifact's trained network as network config (structureConfig): what gives a network the artifact's structure. */
export const structureOf = artifact => structureConfig(trainedOf(artifact.bundle.loop).structure);
/** Every tool of the trained network's tool layers, in layer then wire order (its bundle Tool entries). [] without them. */
export function trainedTools(loop) {
  const tr = trainedOf(loop);
  return tr ? ownTools(loop.nodes[tr.id]) : [];
}

/** The networks of a loop section with tool layers → `[{ id, title, tools: { <port>: { D, R } } }]`. */
function toolNetworks(loop) {
  return Object.entries(loop.nodes).filter(([, n]) => n.kind === 'network' && n.tools)
    .map(([id, n]) => ({ id, title: n.title, tools: Object.fromEntries(n.structure.layers.filter(isToolLayer).map(L => [L.tools, { D: L.D, R: L.R }])) }));
}
/** The Transition type a bundle's reward receives: the env's, with the `loop` field of its loop's tool layers. */
const transitionTypeOf = bundle => withLoopValues(bundle.env.types.Transition, bundle.loop ? toolNetworks(bundle.loop) : []);
/** `(transition, tools) → Transition` of a loop section: the runner's record, plus `loop` from the step's `tools`
 *  (`{ <network>: { <port>: { choice, data, result } } }`). The `loop` field is keyed by network title and is present
 *  when the loop has tool layers. */
export function loopTransition(loop) {
  const nets = toolNetworks(loop);
  if (!nets.length) return transition => transition;
  return (transition, tools) => ({ ...transition, loop: Object.fromEntries(nets.map(n => {
    if (!tools?.[n.id]) throw new LoopError(t('网络 {title} 这一步没有运行，转移里没有它的工具层记录', { title: n.title }));
    return [n.title, tools[n.id]];
  })) });
}

/** Bits width of a Ref (the input bits, a readout's / bits node's `bits`), or null. */
export function refWidth(loop, ref) {
  if (ref.node === INPUT) return loop.I;
  const n = loop.nodes[ref.node];
  if (n?.kind === 'readout' && ref.port === 'bits') return n.readout.width;
  if (n?.kind === 'bits') return partsWidth(n.parts);
  return null;
}

// ------------------------------------------------------------------ the executor
/**
 * An executor for a loop section, every network on its accepted model. → `{ reset(), step(bits) → { action, values,
 * ran, tools }, states() → { <networkId>: voltages } }`.
 */
export function createLoop(loop) {
  const { reset, begin, states } = loopExecutor(loop, {});
  return { reset, step: bits => begin(bits, null).finish(), states };
}
/** createLoop with the step split in two around the intercepted network `node`: `begin(bits, node) → { demanded: its
 *  in bits | null, finish(result) → { action, values, ran, tools } }`. Between the halves, the lockstep runner decides
 *  many lanes at once. */
function loopExecutor(loop, models) {
  if (!loop?.nodes || !loop.action) throw new LoopError(t('训练快照缺少回路'));
  const execs = {}, read = new Set();
  for (const [id, n] of Object.entries(loop.nodes)) {
    if (n.kind === 'readout') {
      if (read.has(n.scores.node)) throw new LoopError(t('网络 {id} 在回路里有不止一个读出', { id: n.scores.node }));
      read.add(n.scores.node);
    }
    if (n.kind !== 'network') continue;
    const model = models[id] ?? n.model;
    if (!model) { execs[id] = null; continue; }
    const problem = modelProblem(model, n.structure);
    if (problem) throw new LoopError(t('网络 {id} 的模型不能运行：{problem}', { id, problem }));
    execs[id] = createExecutor(model, null, { tools: n.tools ? toolCaller(id, n) : null });
  }
  let x = null, values = null, ran = null, tools = null, target = null, given = null;
  const key = ref => `${ref.node}.${ref.port}`;
  function* evalRef(ref) {
    if (ref.node === INPUT) return x;
    if (!ran.has(ref.node)) yield* evalNode(ref.node);
    return values[key(ref)];
  }
  function* evalNode(id) {
    const n = loop.nodes[id];
    if (!n) throw new LoopError(t('回路没有节点 {id}', { id }));
    switch (n.kind) {
      case 'network': {
        const bits = yield* evalRef(n.in);
        if (id === target) {
          const r = yield bits;
          if (!r || typeof r !== 'object') throw new LoopError(t('拦截 {id} 没有给出结果', { id }));
          if (r.scores) values[`${id}.scores`] = Array.from(r.scores);
          else given = r;
          if (r.tools) tools[id] = r.tools;
        } else {
          if (!execs[id]) throw new LoopError(t('网络 {id} 没有模型', { id }));
          const r = execs[id].step(bits);
          values[`${id}.scores`] = r.scores;
          if (r.tools) tools[id] = r.tools;
        }
        break;
      }
      case 'readout': {
        const spec = n.readout;
        let out;
        if (n.scores.node === target) {
          if (!ran.has(target)) yield* evalNode(target);
          if (!given) out = readScores(spec, values[key(n.scores)]);
          else if (spec.mode === 'argmax') {
            if (!Number.isInteger(given.slot) || given.slot < 0 || given.slot >= spec.width) throw new LoopError(t('拦截给出的读出位置 {slot} 越界', { slot: String(given.slot) }));
            const a = spec.map[given.slot];
            out = { action: a === null || a === undefined ? INVALID_ACTION : a, bits: Array.from({ length: spec.width }, (_, k) => (k === given.slot ? 1 : 0)) };
          } else {
            if (!given.bits || given.bits.length !== spec.width) throw new LoopError(t('拦截给出的读出位需要 {width} 位', { width: spec.width }));
            const bits = Array.from(given.bits, v => (v ? 1 : 0));
            out = { action: decodeBits(spec, bits), bits };
          }
        } else out = readScores(spec, yield* evalRef(n.scores));
        values[`${id}.action`] = out.action; values[`${id}.bits`] = out.bits;
        break;
      }
      case 'bits': {
        const out = [];
        for (const p of n.parts) { const v = yield* evalRef(n.in[p.port]); for (let k = p.offset; k < p.offset + p.width; k++) out.push(v[k]); }
        values[`${id}.bits`] = out;
        break;
      }
      default: throw new LoopError(t('未知回路节点种类：{kind}', { kind: String(n.kind) }));
    }
    ran.add(id);
  }
  function begin(bits, node) {
    if (!Array.isArray(bits) || bits.length !== loop.I) throw new LoopError(t('回路输入需要 {width} 位', { width: loop.I }));
    x = bits; values = {}; ran = new Set(); tools = {}; target = node; given = null;
    const gen = evalRef(loop.action);
    let r = gen.next();
    const out = () => {
      if (typeof r.value !== 'number' || !Number.isFinite(r.value)) throw new LoopError(t('回路的动作不是数字'));
      return { action: r.value, values, ran, tools };
    };
    return {
      demanded: r.done ? null : r.value,
      finish(result) { if (!r.done) { r = gen.next(result); if (!r.done) throw new LoopError(t('回路在一步里两次要求拦截的网络')); } return out(); },
    };
  }
  return {
    reset() { for (const e of Object.values(execs)) e?.reset(); },
    begin,
    states() { return Object.fromEntries(Object.entries(execs).filter(([, e]) => e).map(([id, e]) => [id, e.voltages()])); },
  };
}

/** The tools of loop network `id` (node `n`: its structure and `tools`) →
 *  `{ width, call(port, choice, data, state, at) }`. Each tool is compiled or loaded once. A call runs only the chosen
 *  tool. `width` is the length of the tools' states, one after another in layer then wire order. A network tool's state
 *  is its own potentials and its tools' states, recursively. A code tool has no state. The states sit in `state` from
 *  `at` (the caller's, after its own potentials). A call advances only the chosen tool's slice (ADR 0014). A network
 *  tool reads the first I bits of the data. A program tool gets all D bits. The executor and the trainers (which run
 *  the trained network themselves) call tools through it. */
export function toolCaller(id, n) {
  const runners = {};
  let width = 0;
  for (const layer of n.structure.layers.filter(isToolLayer)) {
    const list = n.tools[layer.tools] ?? [];
    if (list.length !== layer.K) throw new LoopError(t('网络 {id} 的工具层 {port} 需要 {K} 个工具，训练快照里有 {n} 个', { id, port: layer.tools, K: layer.K, n: list.length }));
    runners[layer.tools] = list.map((tool, k) => { const r = toolRunner(tool, layer.D, `${id}.${layer.tools}[${k}]`, width); width += r.width; return r.run; });
  }
  return { width, call: (port, choice, data, state, at = 0) => runners[port][choice](data, state, at) };
}
/** One tool → `{ width, run(data, state, at) → bits }`. Its state is `state[at + offset .. + width)`. */
function toolRunner(tool, D, name, offset) {
  if (tool?.kind === 'program') { const run = compileEntry(tool, [bitsType(D)], name); return { width: 0, run: data => Array.from(run(data)) }; }
  if (tool?.kind === 'net') {
    const problem = modelProblem(tool.model, tool.structure);
    if (problem) throw new LoopError(t('工具 {name} 的模型不能运行：{problem}', { name, problem }));
    const tools = tool.structure.layers?.some(isToolLayer) ? toolCaller(name, tool) : null, I = tool.structure.inputs;
    return { width: stateWidthOf(tool.model, tools), run: (data, state, at) => readoutBits(tool.readout, stepFrom(tool.model, tools, data.slice(0, I), state, at + offset).scores) };
  }
  throw new LoopError(t('未知工具种类：{kind}', { kind: String(tool?.kind) }));
}
/** A network Tool (netTool) as a function of its data bits that keeps no memory: each call starts from zero
 *  potentials. A script module calls a network this way (ADR 0019). */
export function statelessTool(tool, name) {
  if (tool?.kind !== 'net') throw new LoopError(t('未知工具种类：{kind}', { kind: String(tool?.kind) }));
  const r = toolRunner(tool, tool.structure.inputs, name, 0);
  return data => r.run(data, new Array(r.width).fill(0), 0);
}

// ------------------------------------------------------------------ the lockstep runner
/** Episodes a greedy lockstep run steps at once: bounds its lanes (an env and a loop executor each) however many
 *  episodes it is given. */
const GREEDY_LANES = 16;
/**
 * The lockstep runner of a bundle. It runs Start records through its env (core/runner.js) and loop executor together,
 * one lane per episode. Lanes are kept for the next run. A greedy run steps at most GREEDY_LANES episodes at once, wave
 * after wave on the same lanes. The runner owns the step protocol of every driver. Env and loop reset together. A lane
 * takes steps until its episode ends. A target objective is read on the state before the step, on the lanes where the
 * trained network decides. A reward objective reads the Transition with `loop` (loopTransition).
 * `models` overrides network models (the candidate of the trained network). Python twin of `run(…, { decide })`:
 * training/bundle_train.py Session.run_steps.
 * → `{ run(episodes, { decide, onStep, trace }) }`
 *
 *   decide(x, lanes, y)  the trained network (`loop.trained`) on every lane whose step demands it. The runner calls it
 *                        once per step, and never when no lane demands it. x Uint8Array(B·I) is their input bits
 *                        (lane b at b·I). lanes Uint8Array(B) is the lanes that decide. y Uint8Array(B·O) is their
 *                        target bits (target objectives, else null). It returns results, with results[b] for every
 *                        lane of `lanes` (see `intercept` above).
 *                        Without decide, the trained network runs greedily on its model and run returns the Episode
 *                        summaries `[{ start, success, steps, return, initial, final, trace? }]`.
 *   onStep(steps)        after every step: steps[b] = { bits, action, values, ran, tools, transition, reward, target }
 *                        for each lane that stepped, null for lanes already done. `reward` is set for reward
 *                        objectives, else null. `target` is set for target objectives on lanes where the trained
 *                        network ran, else null. A run with decide settles the Transition's `loop` (the decided tool
 *                        records) and the reward only for onStep. So a decider that does not read them need not hand
 *                        back tool records.
 *   trace                (greedy) keeps each lane's steps ({ bits, action, values, ran: [ids], tools, transition }) on
 *                        its summary.
 *   With decide, every episode is a lane of one wave (the trainer decides them all together). Greedy waves change only
 *   two things a caller sees: the indices of `steps` (lanes of the current wave) and the order of onStep calls.
 */
export function createLockstep(bundle, { models = {}, tables = {} } = {}) {
  const { env: envSection, loop: section, objective } = bundle;
  const trained = trainedOf(section), node = trained?.id ?? null, withLoop = loopTransition(section);
  const reward = objective?.kind === 'reward' ? compileEntry(objective, [transitionTypeOf(bundle)], 'objective') : null;
  const target = objective?.kind === 'target' && trained ? compileEntry(objective, [envSection.types.State, ...(envSection.types.table ? [envSection.types.table] : [])], 'objective') : null;
  const I = node ? refWidth(section, section.nodes[node].in) : 0, O = trained?.readout?.width ?? 0;
  const envs = [], loops = [];
  /** The target bits of a lane's state before the step: exactly O bits, each 0 or 1. */
  const targetOf = env => {
    const mask = envSection.types.table ? target(env.state, env.table) : target(env.state);
    if (mask.length !== O || !Array.prototype.every.call(mask, v => v === 0 || v === 1)) throw new LoopError(t('目标函数必须返回 {width} 个 0/1 位', { width: O }));
    return mask;
  };
  function run(episodes, { decide = null, onStep = null, trace = false } = {}) {
    if (decide) { wave(episodes, decide, onStep, false); return undefined; }
    const out = [];
    for (let i = 0; i < episodes.length; i += GREEDY_LANES) out.push(...wave(episodes.slice(i, i + GREEDY_LANES), null, onStep, trace));
    return out;
  }
  function wave(episodes, decide, onStep, trace) {
    const B = episodes.length, settle = !decide || !!onStep;
    while (envs.length < B) { envs.push(createEnv(envSection, { tables })); loops.push(loopExecutor(section, models)); }
    const initial = episodes.map((start, b) => { const state = envs[b].reset(start); loops[b].reset(); return state; });
    const live = new Uint8Array(B).fill(1), ret = new Float64Array(B), last = new Array(B), pending = new Array(B), inputs = new Array(B), targets = new Array(B);
    const traces = trace ? episodes.map(() => []) : null;
    let alive = B;
    while (alive > 0) {
      const x = decide ? new Uint8Array(B * I) : null, lanes = decide ? new Uint8Array(B) : null, y = decide && target ? new Uint8Array(B * O) : null;
      let deciding = false;
      for (let b = 0; b < B; b++) {
        targets[b] = null;
        if (!live[b]) continue;
        inputs[b] = envs[b].input();
        pending[b] = loops[b].begin(inputs[b], decide ? node : null);
        if (!pending[b].demanded) continue;
        x.set(pending[b].demanded, b * I); lanes[b] = 1; deciding = true;
        if (y) { targets[b] = targetOf(envs[b]); y.set(targets[b], b * O); }
      }
      const results = deciding ? decide(x, lanes, y) : null;
      const steps = onStep ? new Array(B).fill(null) : null;
      for (let b = 0; b < B; b++) {
        if (!live[b]) continue;
        const r = pending[b].finish(lanes?.[b] ? results[b] : undefined);
        if (target && !decide && steps && r.ran.has(node)) targets[b] = targetOf(envs[b]);   // greedy: the state is still the one before the step
        const transition = settle ? withLoop(envs[b].step(r.action), r.tools) : envs[b].step(r.action), gain = settle && reward ? reward(transition) : null;
        if (gain !== null) ret[b] += gain;
        last[b] = transition;
        if (steps) steps[b] = { bits: inputs[b], action: r.action, values: r.values, ran: r.ran, tools: r.tools, transition, reward: gain, target: targets[b] };
        traces?.[b].push({ bits: inputs[b], action: r.action, values: r.values, ran: [...r.ran], tools: r.tools, transition });
        if (transition.done) { live[b] = 0; alive--; }
      }
      onStep?.(steps);
    }
    return episodes.map((start, b) => ({ start, success: last[b].success, steps: envs[b].t, return: ret[b], initial: initial[b], final: envs[b].state, ...(traces ? { trace: traces[b] } : {}) }));
  }
  return { run };
}

/** One greedy lockstep run of `episodes` (createLockstep(bundle, { models, tables }).run(episodes, { onStep, trace })):
 *  the evaluator's and training validation's runner, so an exported model is measured exactly as it will run. */
export function runEpisodes(bundle, { models = {}, episodes, tables = {}, onStep = null, trace = false } = {}) {
  return createLockstep(bundle, { models, tables }).run(episodes, { onStep, trace });
}

