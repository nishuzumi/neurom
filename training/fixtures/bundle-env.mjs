// training/fixtures/bundle-env.mjs — generates, with the browser code alone, the runner / loop executor parity corpus
// (each case recorded through parity.mjs; bundle-env.test.mjs re-runs the committed cases in JS, test_bundle_env.py and
// test_bundle_train.py replay them in Python):
//   bundle-env.json  `envs`: scripted episodes of the browser runner (counter task of frontend/core/fixtures/counter.js;
//                    a scene without init; window episodes over a table with a full-table target), per step the input
//                    bits, the Transition and the target; `loops`: greedy episodes of whole loops on fixed integer
//                    models (a frozen upstream network feeding another; two plain layers FF / LIF; a tool layer between
//                    plain layers FF / LIF, first in a LIF net, and last FF / LIF, over code and network tools; a LIF
//                    network tool, and a nested network tool with its own tool layer over a LIF tool), per
//                    step the input bits, every evaluated value, the nodes that ran, the action, every tool layer
//                    record, the Transition and every network's state (own potentials ‖ its tools' states), plus the
//                    lockstep runner's summaries (rewards of the tool loops read `transition.loop`); `intercepted`:
//                    lockstep episodes of trainer bundles
//                    whose trained network a script decides (slots, scores, bits with values beyond 0/1, tool layer
//                    records; a table target, lanes ending at different steps), per step the input and target bits it
//                    was handed, its result, the action, the Transition with `loop` and the reward; `errors`:
//                    intercepted results and bundles both runners refuse; `partitions`: the episodes of partition
//                    entries; `validations`: greedy validation (training/run.js validateGreedy) of hand-made candidates
//                    under both accuracy rules (hinge: every decided step; cross-entropy: steps with a target bit set);
//                    `quantizations`: regions through the per-layer quantiser at both widths and every role (ADR 0015).
//   bundles.json     trainer bundles: reinforce / cross-entropy on the counter, hinge on a two-bit adder, reinforce
//                    of a policy reading the outputs of two frozen threshold networks (AND / OR) beside its input, and
//                    the gate task through a tool layer (trailing; reward reading transition.loop; a layer after it;
//                    AND a nested network tool; OR a LIF network tool over two-step episodes).
//   node training/fixtures/bundle-env.mjs        (Python-trained replays: replays.mjs)
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import '../../frontend/core/kinds/index.js';
import { buildBundle } from '../../frontend/core/bundle.js';
import { episodesOf } from '../../frontend/core/sessions/common.js';
import { counterGraph } from '../../frontend/core/fixtures/counter.js';
import { ModuleGraph } from '../../frontend/core/graph.js';
import { parseTemplate, instantiateInto } from '../../frontend/core/template.js';
import { shapedArtifact } from '../../frontend/core/sessions/fixtures.js';
import { envTrace, loopTrace, interceptTrace, validation, quantization } from './parity.mjs';

/** Replace (or add) one exported function of the scenario module's source; `source` null removes it. */
const setEntry = (graph, sceneId, name, source) => {
  const text = graph.node(sceneId).config.source, re = new RegExp(`(?:export )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  graph.patchConfig(sceneId, { source: re.test(text) ? text.replace(re, source ?? '') : `${text}\n${source}` });
};
const instance = yaml => { const graph = new ModuleGraph(); const { ids } = instantiateInto(graph, parseTemplate(yaml), { x: 0, y: 0 }); return { graph, ids }; };
const artifactId = k => '0x' + k.toString(16).padStart(2, '0').repeat(32);
/** `artifacts(id)` for hand-made models pinned by frozen networks' `artifact`: `{ <artifactId>: [localId, model, tools?] }`
 *  (`tools`: the network tools a model with a tool layer was trained with, `{ <port>: [artifactId…] }`, wire order). */
const pinned = (graph, ids, models) => id => {
  if (!models[id]) return null;
  const [local, model, tools] = models[id], a = shapedArtifact(graph, ids[local], model);
  if (tools) a.bundle.loop.nodes.net.tools = Object.fromEntries(Object.entries(tools).map(([port, list]) => [port, list.map(artifactId => ({ kind: 'net', artifactId }))]));
  return a;
};

// ------------------------------------------------------------------ env traces
function counter() {
  const { graph, ids } = counterGraph();
  return { name: 'counter', bundle: buildBundle(graph, ids.trainer), tables: null,
           starts: [{ seed: 1 }, { seed: 2 }, { seed: 3 }, { seed: 4 }, { seed: 5 }],
           scripts: [[1, 1, 1], [0], [0, 0, 1, 1, 1], [1, 0, 1, 0, 1], [0, 1]] };
}

function noInit() {
  const { graph, ids } = counterGraph();
  setEntry(graph, ids.scene, 'init', null);
  setEntry(graph, ids.scene, 'input', 'export function input(state) {\n  return thermometer(state.seed, [11, 12, 13]);\n}');
  setEntry(graph, ids.scene, 'step', 'export function step(state, action) {\n  return { state: { seed: state.seed + action }, done: state.seed + action >= 13, success: action > 0 };\n}');
  return { name: 'no-init', bundle: buildBundle(graph, ids.trainer), tables: null,
           starts: [{ seed: 10 }, { seed: 11 }, { seed: 12 }], scripts: [[1, 1, 1], [0, 0, 1], [0]] };
}

function windowed() {
  const { graph, ids } = counterGraph();
  const datasetId = 'ds-prices';
  const ds = graph.addNode({ kind: 'dataset', title: 'prices', config: { datasetId, name: 'prices', columns: ['price'], rows: 20, hash: '0x' + 'ab'.repeat(32) } });
  graph.setConfig(ids.seeds, { kind: 'window', window: { length: 5, stride: 1, embargo: 0, splits: { training: [0, 0.5], validation: [0.5, 1] } } });
  graph.connect({ kind: 'value', from: { node: ds.id, port: 'table' }, to: { node: ids.seeds, port: 'table' } });
  setEntry(graph, ids.scene, 'init', 'export function init(start) {\n  return { count: 0, cursor: start.start };\n}');
  setEntry(graph, ids.scene, 'input', "export function input(state, table) {\n  return thermometer(state.count + table.at(state.cursor, 'price'), [1, 2, 3, 6, 10]);\n}");
  setEntry(graph, ids.scene, 'step', "export function step(state, action, table) {\n  const next = table.at(state.cursor + 1, 'price');\n  return { state: { count: state.count + action, cursor: state.cursor + 1 }, done: state.count + action >= params.target, success: next > 5 };\n}");
  graph.patchConfig(ids.net, { inputs: 5, kind: 'feedforward', ticks: 1, leak_shift: 0, reset: 0 });
  graph.patchConfig(ids.trainer, { method: 'cross-entropy' });
  graph.disconnect(graph.producers(ids.trainer, 'objective')[0].wire.id);
  const target = graph.addNode({ kind: 'code', title: 'target', config: { source: "export function target(state, table) {\n  const up = table.at(state.cursor + 3, 'price') > 5 ? 1 : 0;\n  return [1 - up, up];\n}" } });
  graph.connect({ kind: 'call', from: { node: target.id, port: 'target' }, to: { node: ids.trainer, port: 'objective' } });
  const price = Array.from({ length: 20 }, (_, i) => (i * 7) % 11);
  return { name: 'window-table', bundle: buildBundle(graph, ids.trainer), tables: { [datasetId]: { price } },
           starts: [{ start: 0, length: 5 }, { start: 5, length: 5 }, { start: 10, length: 5 }, { start: 3, length: 5 }],
           scripts: [[1, 1, 1], [0, 0, 0, 0, 0], [1, 0, 1, 0, 1], [0, 1, 1, 1]] };
}

const recordEnv = sc => {
  const { env, objective } = sc.bundle;
  return { name: sc.name, env, objective, tables: sc.tables, scripts: sc.scripts, lanes: envTrace({ env, objective, tables: sc.tables, starts: sc.starts, scripts: sc.scripts }) };
};

// ------------------------------------------------------------------ loop traces
/** Deterministic small-integer dense model (mulberry32 over `seed`) for a layer list: plain layers `{ hidden }`, tool
 *  layers `{ tools, K, D, R }` (their decision heads drawn like any weights); an output layer unless the last is a tool.
 *  int8 weights, every region its own shift k ∈ 0..2 (drawn too), a LIF plain layer `threshold` · 2^k. */
function denseModel(seed, { kind = 'lif', inputs, hidden, layers = [{ hidden }], outputs, ticks = 2, leak_shift = 1, threshold = 4, reset = 0, lo = -4, hi = 5 }) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const int = () => lo + Math.floor(rnd() * (hi - lo));
  const mat = (r, c) => Array.from({ length: r }, () => Array.from({ length: c }, int));
  const shift = () => Math.floor(rnd() * 3);
  if (kind === 'feedforward') [ticks, leak_shift, reset] = [1, 0, 0];
  let width = inputs;
  const list = layers.map(L => {
    if (L.tools) { const head = { tools: L.tools, K: L.K, D: L.D, R: L.R, Wc: mat(L.K, width), bc: mat(1, L.K)[0], scale_c: 1, k_c: shift(), Wd: mat(L.D, width), bd: mat(1, L.D)[0], scale_d: 1, k_d: shift() }; width += L.R; return head; }
    const k = shift(), layer = { hidden: L.hidden, W: mat(L.hidden, width), b: mat(1, L.hidden)[0], scale: 1, k, ...(kind === 'lif' ? { threshold: threshold << k } : {}) }; width = L.hidden; return layer;
  });
  const trailing = !!layers[layers.length - 1].tools;
  return { format: 'dense-policy', kind, inputs, outputs: trailing ? layers[layers.length - 1].R : outputs, weightBits: 8, ticks, leak_shift, reset, layers: list,
           ...(trailing ? {} : { output: { W: mat(outputs, width), b: mat(1, outputs)[0], scale: 1, k: shift() } }) };
}
/** The network config running model `m` frozen on its own `artifact` (tool layers declare their `data` width D). */
const netConfig = (m, artifact) => `{ engine: dense-policy, kind: ${m.kind}, inputs: ${m.inputs}, layers: ${JSON.stringify(m.layers.map(L => (L.tools ? { tools: L.tools, data: L.D } : { hidden: L.hidden })))}, ticks: ${m.ticks}, leak_shift: ${m.leak_shift}, reset: ${m.reset}, artifact: '${artifact}' }`;

const COUNTER_SCENE = `
  params:
    kind: params
    config:
      fields:
        target: { type: int, min: 1, max: 10, default: 3 }
        budget: { type: int, min: 1, max: 100, default: 6 }
  reward:
    kind: code
    config:
      source: |-
        export function reward(transition) {
          return transition.success ? 1 : 0;
        }
  seeds: { kind: partition }
  scene:
    kind: code
    config:
      inputs: [params]
      source: |-
        export const budget = params.budget;

        export function init(start) {
          return { count: 0, seed: start.seed };
        }
        export function input(state) {
          return concat(thermometer(state.count, [1, 2, 3]), bits(state.seed, 2));
        }
        export function step(state, action) {
          const next = state.count + action;
          return { state: { count: next, seed: state.seed }, done: next >= params.target, success: next >= params.target };
        }
  loop: { kind: loop }
  evaluator: { kind: evaluator }`;
const COUNTER_WIRES = `
    - params.params→scene.params
    - loop.loop→evaluator.loop
    - seeds.test→evaluator.partition`;

/** loop.input → up (frozen LIF, bits readout) → net (LIF, argmax) → loop.action. */
function frozenUpstream() {
  const up = denseModel(7, { inputs: 5, hidden: 4, outputs: 3 }), net = denseModel(11, { inputs: 3, hidden: 4, outputs: 2 });
  const models = { [artifactId(1)]: ['up', up], [artifactId(2)]: ['net', net] };
  const { graph, ids } = instance(`
format: neurom-template
id: frozen-upstream
revision: 1
name: frozen upstream
kind: composite
modules:${COUNTER_SCENE}
  up: { kind: network, config: ${netConfig(up, artifactId(1))} }
  upOut: { kind: readout, config: { mode: bits, width: 3, decode: lsb-int } }
  net: { kind: network, config: ${netConfig(net, artifactId(2))} }
  readout: { kind: readout, config: { mode: argmax, map: [0, 1] } }
wires:
  value:${COUNTER_WIRES}
    - loop.input→up.in
    - up.scores→upOut.scores
    - upOut.bits→net.in
    - net.scores→readout.scores
    - readout.action→loop.action
  call:
    - scene.module→loop.scenario
    - reward→evaluator.objective
`);
  return { name: 'frozen-upstream', bundle: buildBundle(graph, ids.evaluator, { artifacts: pinned(graph, ids, models) }),
           starts: [0, 1, 2, 3, 0].map(seed => ({ seed })) };
}

/** loop.input → net (frozen dense layer list, argmax) → loop.action: two plain layers, FF or LIF. */
function twoLayer(kind) {
  const net = denseModel(kind === 'lif' ? 13 : 17, { kind, inputs: 5, layers: [{ hidden: 4 }, { hidden: 3 }], outputs: 2 });
  const models = { [artifactId(3)]: ['net', net] };
  const { graph, ids } = instance(`
format: neurom-template
id: two-layer-${kind}
revision: 1
name: two plain layers
kind: composite
modules:${COUNTER_SCENE}
  net: { kind: network, config: ${netConfig(net, artifactId(3))} }
  readout: { kind: readout, config: { mode: argmax, map: [0, 1] } }
wires:
  value:${COUNTER_WIRES}
    - loop.input→net.in
    - net.scores→readout.scores
    - readout.action→loop.action
  call:
    - scene.module→loop.scenario
    - reward→evaluator.objective
`);
  return { name: `two-layer-${kind}`, bundle: buildBundle(graph, ids.evaluator, { artifacts: pinned(graph, ids, models) }),
           starts: [0, 1, 2, 3, 0].map(seed => ({ seed })) };
}

/** The OR tool (threshold layers, 2 bits → [a | b, 1]) and a 3 → 2 dense FF tool, both read through bits readouts. */
const OR_TOOL = { format: 'threshold-layers', inputs: 2, outputs: 2, weightBits: 8, layers: [{ W: [[1, 1], [0, 0]], th: [1, 0], scale: 1, k: 0 }, { W: [[1, 0], [0, 1]], th: [1, 1], scale: 1, k: 0 }] };
const DENSE_TOOL = denseModel(23, { kind: 'feedforward', inputs: 3, layers: [{ hidden: 3 }], outputs: 2 });
/** Stateful tools (ADR 0014): a 3 → 2 LIF network, and a nested FF network whose own trailing tool layer (D = 3, R = 2)
 *  calls a second LIF network or a copy of the dense FF tool (its state: that LIF tool's potentials; the tools its
 *  artifact was trained with). */
const LIF_TOOL = denseModel(47, { kind: 'lif', inputs: 3, layers: [{ hidden: 3 }], outputs: 2, threshold: 3 });
const INNER_TOOL = denseModel(53, { kind: 'feedforward', inputs: 3, layers: [{ hidden: 3 }, { tools: 'tools', K: 2, D: 3, R: 2 }] });
const BITS2 = '{ mode: bits, width: 2, decode: lsb-int }';
/** Every tool a tool loop may wire into `sel`: its modules, value wires, the call wires it needs itself, the call
 *  output wired into `sel.tools`, and the frozen models it pins. Code tools over D = 3 data bits: `mix` → 2 bits,
 *  `one` → 1 bit (zero-extended to R). */
const TOOL_PARTS = {
  mix: { modules: ['  mix: { kind: code, config: { source: "export function mix(data) { return concat(bits(at(data, 0) * at(data, 1), 1), bits(at(data, 2), 1)); }" } }'], run: 'mix.mix' },
  one: { modules: ['  one: { kind: code, config: { source: "export function one(data) { return bits(at(data, 0) + at(data, 2) > 0 ? 1 : 0, 1); }" } }'], run: 'one.one' },
  or: { modules: [`  orNet: { kind: network, config: { engine: threshold-layers, kind: feedforward, inputs: 2, layers: [2], ticks: 1, leak_shift: 0, reset: 0, artifact: '${artifactId(4)}' } }`, `  orR: { kind: readout, config: ${BITS2} }`],
        value: ['orNet.scores→orR.scores'], run: 'orR.run', models: { [artifactId(4)]: ['orNet', OR_TOOL] } },
  dense: { modules: [`  dn: { kind: network, config: ${netConfig(DENSE_TOOL, artifactId(5))} }`, `  dnR: { kind: readout, config: ${BITS2} }`],
           value: ['dn.scores→dnR.scores'], run: 'dnR.run', models: { [artifactId(5)]: ['dn', DENSE_TOOL] } },
  lif: { modules: [`  lif: { kind: network, config: ${netConfig(LIF_TOOL, artifactId(8))} }`, `  lifR: { kind: readout, config: ${BITS2} }`],
         value: ['lif.scores→lifR.scores'], run: 'lifR.run', models: { [artifactId(8)]: ['lif', LIF_TOOL] } },
  inner: { modules: [`  inner: { kind: network, config: ${netConfig(INNER_TOOL, artifactId(10))} }`, `  innerR: { kind: readout, config: ${BITS2} }`,
                     `  deep: { kind: network, config: ${netConfig(LIF_TOOL, artifactId(9))} }`, `  deepR: { kind: readout, config: ${BITS2} }`,
                     `  dn2: { kind: network, config: ${netConfig(DENSE_TOOL, artifactId(11))} }`, `  dn2R: { kind: readout, config: ${BITS2} }`],
           value: ['inner.scores→innerR.scores', 'deep.scores→deepR.scores', 'dn2.scores→dn2R.scores'], call: ['deepR.run→inner.tools', 'dn2R.run→inner.tools'], run: 'innerR.run',
           models: { [artifactId(9)]: ['deep', LIF_TOOL], [artifactId(11)]: ['dn2', DENSE_TOOL], [artifactId(10)]: ['inner', INNER_TOOL, { tools: [artifactId(9), artifactId(11)] }] } },
};

/** loop.input → sel (frozen, tool layer over `tools` in wire order, D = 3, R = 2) → loop.action. `layers` between /
 *  after the tool layer decide the shape; a trailing tool layer's result bits are the action (bits readout), and the
 *  reward reads `transition.loop.sel.tools` (ADR 0010 §10). */
function toolLoop(name, kind, layers, seed, tools = ['mix', 'or', 'dense', 'one']) {
  const net = denseModel(seed, { kind, inputs: 5, layers: layers.map(L => (L.tools ? { ...L, K: tools.length, D: 3, R: 2 } : L)), outputs: 2, threshold: 3 });
  const trailing = !!layers[layers.length - 1].tools;
  const parts = tools.map(t => TOOL_PARTS[t]);
  const models = Object.assign({ [artifactId(3)]: ['sel', net] }, ...parts.map(p => p.models ?? {}));
  const scene = COUNTER_SCENE.replace('return transition.success ? 1 : 0;', 'return (transition.success ? 1 : 0) + transition.loop.sel.tools.choice + 2 * at(transition.loop.sel.tools.result, 0) + 4 * at(transition.loop.sel.tools.data, 2);');
  const lines = list => list.map(w => `\n    - ${w}`).join('');
  const { graph, ids } = instance(`
format: neurom-template
id: ${name}
revision: 1
name: ${name}
kind: composite
modules:${scene}
${parts.flatMap(p => p.modules).join('\n')}
  sel: { kind: network, title: sel, config: ${netConfig(net, artifactId(3))} }
  readout: { kind: readout, config: ${trailing ? BITS2 : '{ mode: argmax, map: [0, 1] }'} }
wires:
  value:${COUNTER_WIRES}
    - loop.input→sel.in
    - sel.scores→readout.scores
    - readout.action→loop.action${lines(parts.flatMap(p => p.value ?? []))}
  call:
    - scene.module→loop.scenario
    - reward→evaluator.objective${lines(parts.flatMap(p => p.call ?? []))}${lines(tools.map(t => `${TOOL_PARTS[t].run}→sel.tools`))}
`);
  return { name, bundle: buildBundle(graph, ids.evaluator, { artifacts: pinned(graph, ids, models) }), starts: [0, 1, 2, 3, 0, 2].map(seed => ({ seed })) };
}
const TOOLS = { tools: 'tools' };
const toolLoops = () => [toolLoop('tool-between-ff', 'feedforward', [{ hidden: 4 }, TOOLS, { hidden: 3 }], 29), toolLoop('tool-between-lif', 'lif', [{ hidden: 4 }, { hidden: 3 }, TOOLS, { hidden: 3 }], 31),
                         toolLoop('tool-first-lif', 'lif', [TOOLS, { hidden: 3 }], 37), toolLoop('tool-trailing-ff', 'feedforward', [{ hidden: 4 }, TOOLS], 41),
                         toolLoop('tool-trailing-lif', 'lif', [{ hidden: 4 }, TOOLS], 43),
                         // stateful tools: a LIF network tool under an FF selector (its state is the tool's alone), and a
                         // LIF selector over a nested network tool and a LIF tool (own potentials ‖ nested ‖ LIF)
                         toolLoop('lif-tool-ff', 'feedforward', [{ hidden: 4 }, TOOLS, { hidden: 3 }], 70, ['mix', 'lif', 'dense', 'one']),
                         toolLoop('nested-tool-lif', 'lif', [{ hidden: 4 }, TOOLS, { hidden: 3 }], 70, ['inner', 'lif', 'mix', 'or'])];

const recordLoop = sc => ({ name: sc.name, bundle: sc.bundle, ...loopTrace(sc) });

// ------------------------------------------------------------------ trainer bundles
/** The counter task trained by cross-entropy (FF) on target `source` (a code export reading `params`). */
function counterTarget(source) {
  const { graph, ids } = counterGraph();
  graph.patchConfig(ids.net, { kind: 'feedforward', ticks: 1, leak_shift: 0, reset: 0 });
  graph.patchConfig(ids.trainer, { method: 'cross-entropy' });
  graph.disconnect(graph.producers(ids.trainer, 'objective')[0].wire.id);
  const target = graph.addNode({ kind: 'code', title: 'target', config: { inputs: ['params'], source } });
  graph.connect({ kind: 'value', from: { node: ids.params, port: 'params' }, to: { node: target.id, port: 'params' } });
  graph.connect({ kind: 'call', from: { node: target.id, port: 'target' }, to: { node: ids.trainer, port: 'objective' } });
  return buildBundle(graph, ids.trainer);
}
function trainerBundles() {
  const gate = (yaml, models = {}) => { const { graph, ids } = instance(yaml); return buildBundle(graph, ids.trainer, { artifacts: pinned(graph, ids, models) }); };
  const reinforce = (() => { const { graph, ids } = counterGraph(); return buildBundle(graph, ids.trainer); })();
  const crossEntropy = counterTarget('export function target(state) {\n  const want = state.count < params.target ? 1 : 0;\n  return [1 - want, want];\n}');
  const hinge = (() => { const { graph, ids } = instance(ADD2_YAML); return buildBundle(graph, ids.trainer); })();
  const frozenGates = gate(GATES_YAML, { [artifactId(6)]: ['and', GATE(2)], [artifactId(7)]: ['or', GATE(1)] });
  return { format: 'neurom-trainer-bundles', reinforce, crossEntropy, hinge, frozenGates, gate: gate(GATE_YAML), gateLoop: gate(GATE_LOOP_YAML), gateAfter: gate(GATE_AFTER_YAML),
           gateNested: gate(GATE_NESTED_YAML, { [artifactId(13)]: ['and', NESTED_AND, { tools: [artifactId(14)] }], [artifactId(14)]: ['gateAnd', GATE(2)] }),
           gateLif: gate(GATE_LIF_YAML, { [artifactId(12)]: ['or', LIF_OR] }) };
}

// ------------------------------------------------------------------ intercepted lockstep episodes
const sum = v => v.reduce((s, x) => s + x, 0);
/** The trained network's tool layer (null without): its `{ tools, K, D, R }` entry. */
const toolLayer = bundle => bundle.loop.nodes[bundle.loop.trained].structure.layers.find(L => L.tools) ?? null;
/** A scripted tool layer record of lane b at step k: a choice, data bits taken from the input, result bits. */
const toolRecord = ({ K, D, R }, b, k, x) => ({ choice: (b + k) % K, data: Array.from({ length: D }, (_, d) => x[(d + b) % x.length]), result: Array.from({ length: R }, (_, r) => (b + k + r + x[0]) % 2) });
const slots = O => (b, k, x) => ({ slot: (b + k + sum(x)) % O });
/** Scores with ties (the readout takes the first maximum). */
const scores = O => (b, k, x) => ({ scores: Array.from({ length: O }, (_, j) => ((b + 1) * (j + 1) + k + x[j % x.length]) % 3) });
/** The target bits, set bits written as 1, 2 or 5 and some clear bits as −1: the readout coerces them to 0/1. */
const loose = (b, k, x, y) => ({ bits: y.map((v, j) => (v ? [1, 2, 5][(b + j) % 3] : ((b + k + j) % 4 === 0 ? -1 : 0))) });
function intercepted(bundles, window) {
  const cases = [
    ['cross-entropy-counter', bundles.crossEntropy, null, [1, 2, 3, 4].map(seed => ({ seed })), slots(2)],
    ['window-table-target', window.bundle, window.tables, window.starts, slots(2)],
    ['hinge-coerced-bits', bundles.hinge, null, episodesOf(bundles.hinge.partitions.training).slice(0, 6), loose],
    ['frozen-gates-scores', bundles.frozenGates, null, episodesOf(bundles.frozenGates.partitions.training), scores(2)],
    ['gate-loop-trailing-tools', bundles.gateLoop, null, episodesOf(bundles.gateLoop.partitions.training), (b, k, x) => { const r = toolRecord(toolLayer(bundles.gateLoop), b, k, x); return { bits: r.result, tools: { [toolLayer(bundles.gateLoop).tools]: r } }; }],
    ['gate-after-tools', bundles.gateAfter, null, episodesOf(bundles.gateAfter.partitions.training), (b, k, x) => ({ ...slots(2)(b, k, x), tools: { [toolLayer(bundles.gateAfter).tools]: toolRecord(toolLayer(bundles.gateAfter), b, k, x) } })],
  ];
  return cases.map(([name, bundle, tables, starts, script]) => ({ name, bundle, tables, lanes: interceptTrace({ bundle, tables, starts }, script) }));
}
/** Intercepted results and bundles both runners refuse: `results[lane][step]` is what the decider answers. */
function errors(bundles) {
  const ce = bundles.crossEntropy, readoutId = Object.keys(ce.loop.nodes).find(id => ce.loop.nodes[id].kind === 'readout');
  const twoReadouts = { ...ce, loop: { ...ce.loop, nodes: { ...ce.loop.nodes, second: ce.loop.nodes[readoutId] } } };
  const bitTarget = counterTarget('export function target(state) {\n  return [state.count, 0];\n}');
  const cases = [
    ['bits-too-wide', bundles.hinge, [[{ bits: [0, 1, 0, 1] }]]],
    ['slot-out-of-range', ce, [[{ slot: 2 }]]],
    ['slot-not-an-integer', ce, [[{ slot: 0.5 }]]],
    ['bits-for-an-argmax-readout', ce, [[{ bits: [0, 1] }]]],
    ['two-readouts-on-the-trained-network', twoReadouts, [[{ slot: 1 }]]],
    ['target-not-bits', bitTarget, [[{ slot: 1 }, { slot: 1 }, { slot: 1 }]]],
  ];
  return cases.map(([name, bundle, results]) => {
    const starts = results.map((_, i) => ({ seed: i + 1 })), episode = bundle === bundles.hinge ? episodesOf(bundle.partitions.training).slice(0, 1) : starts;
    assert.throws(() => interceptTrace({ bundle, starts: episode }, (b, k) => results[b][k]), Error, name);
    return { name, bundle, starts: episode, results };
  });
}

/** The gate task of frontend/training/train.test.js: answer = s ? a OR b : a AND b on input s‖a‖b; tools code AND, code
 *  OR on 2 data bits the network must copy from its input; a trailing tool layer (its result bit is the action). */
const GATE_YAML = `
format: neurom-template
id: gate-task
revision: 1
name: gate
kind: composite
modules:
  reward: { kind: code, config: { source: "export function reward(transition) { return transition.success ? 1 : 0; }" } }
  split:
    kind: partition
    config: { kind: enumerate, enumerate: { axes: { s: [0, 1], a: [0, 1], b: [0, 1] }, roles: { training: all, validation: all, test: all } } }
  scene:
    kind: code
    config:
      source: |-
        export const budget = 1;
        export function init(start) { return { s: start.s, a: start.a, b: start.b }; }
        export function input(state) { return [state.s, state.a, state.b]; }
        export function step(state, action) { return { state, done: true, success: action === (state.s === 1 ? (state.a + state.b > 0 ? 1 : 0) : state.a * state.b) }; }
  and: { kind: code, config: { source: "export function and(data) { return bits(at(data, 0) * at(data, 1), 1); }" } }
  or: { kind: code, config: { source: "export function or(data) { return bits(at(data, 0) + at(data, 1) > 0 ? 1 : 0, 1); }" } }
  loop: { kind: loop }
  readout: { kind: readout, config: { mode: bits, width: 1, decode: lsb-int } }
  net: { kind: network, config: { inputs: 3, layers: [{ hidden: 8 }, { tools: tools, data: 2 }], kind: feedforward, ticks: 1, leak_shift: 0, reset: 0 } }
  trainer: { kind: trainer, config: { method: reinforce, epochs: 60, evalEvery: 10, lr: 0.05, replicas: 8, calibrationEpisodes: 8 } }
wires:
  value:
    - split.training→trainer.training
    - split.validation→trainer.validation
    - loop.loop→trainer.loop
    - loop.input→net.in
    - net.scores→readout.scores
    - readout.action→loop.action
    - net.structure→trainer.structure
  call:
    - scene.module→loop.scenario
    - reward→trainer.objective
    - and.and→net.tools
    - or.or→net.tools
`;
/** The gate task whose reward also pays 1 for handing the tool exactly a‖b, read from `transition.loop` (ADR 0010 §10). */
const GATE_LOOP_YAML = GATE_YAML.replace('net: { kind: network, config:', 'net: { kind: network, title: 门, config:')
  .replace('"export function reward(transition) { return transition.success ? 1 : 0; }"',
    '"export function reward(transition) { const d = transition.loop.门.tools.data; return (transition.success ? 1 : 0) + (at(d, 0) === transition.prev.a && at(d, 1) === transition.prev.b ? 1 : 0); }"');
/** The gate task with a plain layer after the tool layer (it sees result ‖ the layer before) and an argmax readout. */
const GATE_AFTER_YAML = GATE_YAML.replace('[{ hidden: 8 }, { tools: tools, data: 2 }]', '[{ hidden: 8 }, { tools: tools, data: 2 }, { hidden: 4 }]')
  .replace('{ mode: bits, width: 1, decode: lsb-int }', '{ mode: argmax, map: [0, 1] }');
/** A nested AND tool (ADR 0014): an FF network copying a‖b into its own tool layer, whose one tool is the threshold
 *  AND gate (the tool its artifact was trained with). */
const NESTED_AND = { format: 'dense-policy', kind: 'feedforward', inputs: 2, outputs: 1, weightBits: 8, ticks: 1, leak_shift: 0, reset: 0,
  layers: [{ hidden: 2, W: [[1, 0], [0, 1]], b: [0, 0], scale: 1, k: 0 },
           { tools: 'tools', K: 1, D: 2, R: 1, Wc: [[0, 0]], bc: [0], scale_c: 1, k_c: 0, Wd: [[1, 0], [0, 1]], bd: [0, 0], scale_d: 1, k_d: 0 }] };
/** A LIF OR tool: one neuron, current 3 per set bit − 1, threshold 2, leak 1/2: it fires on a | b from any potential it
 *  keeps (−1 after a step with a = b = 0, its state). */
const LIF_OR = { format: 'dense-policy', kind: 'lif', inputs: 2, outputs: 1, weightBits: 8, ticks: 1, leak_shift: 1, reset: 0,
  layers: [{ hidden: 1, W: [[3, 3]], b: [-1], scale: 1, k: 0, threshold: 2 }], output: { W: [[1]], b: [-1], scale: 1, k: 0 } };
const BITS1 = '{ mode: bits, width: 1, decode: lsb-int }';
const GATE_AND_CODE = '  and: { kind: code, config: { source: "export function and(data) { return bits(at(data, 0) * at(data, 1), 1); }" } }';
const GATE_OR_CODE = '  or: { kind: code, config: { source: "export function or(data) { return bits(at(data, 0) + at(data, 1) > 0 ? 1 : 0, 1); }" } }';
const GATE_VALUE_END = '    - net.structure→trainer.structure\n';
/** The gate task with AND as the nested network tool NESTED_AND (a tool with its own tool layer). */
const GATE_NESTED_YAML = GATE_YAML.replace(GATE_AND_CODE, `  and: { kind: network, config: ${netConfig(NESTED_AND, artifactId(13))} }
  andR: { kind: readout, config: ${BITS1} }
  gateAnd: { kind: network, config: { engine: threshold-layers, kind: feedforward, inputs: 2, layers: [2], ticks: 1, leak_shift: 0, reset: 0, artifact: '${artifactId(14)}' } }
  gateAndR: { kind: readout, config: ${BITS1} }`)
  .replace(GATE_VALUE_END, `${GATE_VALUE_END}    - and.scores→andR.scores\n    - gateAnd.scores→gateAndR.scores\n`)
  .replace('    - and.and→net.tools', '    - gateAndR.run→and.tools\n    - andR.run→net.tools');
/** The gate task with OR as the LIF network tool LIF_OR, two steps per episode on the same s, a, b (budget 2, never
 *  done): the tool's potential carries from the first step to the second on the lanes that chose it. */
const GATE_LIF_YAML = GATE_YAML.replace(GATE_OR_CODE, `  or: { kind: network, config: ${netConfig(LIF_OR, artifactId(12))} }
  orR: { kind: readout, config: ${BITS1} }`)
  .replace('export const budget = 1;', 'export const budget = 2;').replace('return { state, done: true,', 'return { state, done: false,')
  .replace(GATE_VALUE_END, `${GATE_VALUE_END}    - or.scores→orR.scores\n`)
  .replace('    - or.or→net.tools', '    - orR.run→net.tools');

/** Greedy validation of hand-made candidates under both accuracy rules: on the hinge bundle (the two-bit adder: every
 *  decided step labelled) the carry-free guess (s0 = a0 | b0, s1 = a1 | b1, s2 = a1 & b1) and a network that answers 0,
 *  `select` odd validating on half the grid; on a cross-entropy counter whose target leaves count 1 unlabelled (only
 *  steps with a target bit set count), two fixed dense networks. */
function validations(bundles) {
  const hinge = [[ADD2_GUESS, 'all'], [ADD2_ZERO, 'all'], [ADD2_GUESS, 'odd']].map(([model, select], i) => {
    const b = bundles.hinge;
    return { name: `hinge-${i}`, bundle: { ...b, partitions: { ...b.partitions, validation: { ...b.partitions.validation, select } } }, model, labelled: 'all' };
  });
  const sparse = counterTarget('export function target(state) {\n  const want = state.count < params.target ? 1 : 0;\n  return state.count === 1 ? [0, 0] : [1 - want, want];\n}');
  const net = sparse.loop.nodes[sparse.loop.trained].structure;
  const dense = seed => denseModel(seed, { kind: 'feedforward', inputs: net.inputs, layers: net.layers, outputs: net.outputs });
  const crossEntropy = [3, 5].map(seed => ({ name: `cross-entropy-${seed}`, bundle: sparse, model: dense(seed), labelled: 'any' }));
  return [...hinge, ...crossEntropy].map(v => ({ ...v, summary: validation(v) }));
}

const ADD2_YAML = `
format: neurom-template
id: add2-task
revision: 1
name: two-bit adder
kind: composite
modules:
  scene:
    kind: code
    config:
      source: |-
        export const budget = 1;

        export function init(start) {
          return { a: start.a, b: start.b, answer: -1 };
        }
        export function input(state) {
          return concat(bits(state.a, 2), bits(state.b, 2));
        }
        export function step(state, action) {
          return { state: { ...state, answer: action }, done: true, success: action === state.a + state.b };
        }
  target:
    kind: code
    config:
      source: |-
        export function target(state) {
          return bits(state.a + state.b, 3);
        }
  grid:
    kind: partition
    config:
      kind: enumerate
      enumerate:
        axes: { a: [0, 1, 2, 3], b: [0, 1, 2, 3] }
        roles: { training: all, validation: all, test: all }
  loop: { kind: loop }
  readout: { kind: readout, config: { mode: bits, width: 3, decode: lsb-int } }
  net: { kind: network, config: { engine: threshold-layers, kind: feedforward, inputs: 4, layers: [8], ticks: 1, leak_shift: 0, reset: 0 } }
  trainer: { kind: trainer, config: { method: hinge, epochs: 10 } }
wires:
  value:
    - grid.training→trainer.training
    - grid.validation→trainer.validation
    - loop.loop→trainer.loop
    - loop.input→net.in
    - net.scores→readout.scores
    - readout.action→loop.action
    - net.structure→trainer.structure
  call:
    - scene.module→loop.scenario
    - target→trainer.objective
`;

/** Threshold gate on two bits: hidden copies them, output fires iff a + b ≥ `need` (2 = AND, 1 = OR). */
const GATE = need => ({ format: 'threshold-layers', inputs: 2, outputs: 1, weightBits: 8, layers: [{ W: [[1, 0], [0, 1]], th: [1, 1], scale: 1, k: 0 }, { W: [[1, 1]], th: [need], scale: 1, k: 0 }] });
/** Two-bit adder candidates shaped like the hinge bundle's network (4 → 8 → 3): hidden 0..3 copy a0 a1 b0 b1. */
const copyHidden = { W: Array.from({ length: 8 }, (_, j) => [0, 1, 2, 3].map(i => (i === j ? 1 : 0))), th: [1, 1, 1, 1, 9, 9, 9, 9], scale: 1, k: 0 };
const outRow = (cols, th) => ({ w: Array.from({ length: 8 }, (_, j) => (cols.includes(j) ? 1 : 0)), th });
const add2 = rows => ({ format: 'threshold-layers', inputs: 4, outputs: 3, weightBits: 8, layers: [copyHidden, { W: rows.map(r => r.w), th: rows.map(r => r.th), scale: 1, k: 0 }] });
const ADD2_GUESS = add2([outRow([0, 2], 1), outRow([1, 3], 1), outRow([1, 3], 2)]);
const ADD2_ZERO = add2([outRow([], 1), outRow([], 1), outRow([], 1)]);
const GATES_YAML = `
format: neurom-template
id: frozen-gates-task
revision: 1
name: policy over frozen gates
kind: composite
modules:
  reward:
    kind: code
    config:
      source: |-
        export function reward(transition) {
          return transition.success ? 1 : 0;
        }
  scene:
    kind: code
    config:
      source: |-
        export const budget = 1;

        export function init(start) {
          return { op: start.op, a: start.a, b: start.b, action: -1 };
        }
        export function input(state) {
          return concat(oneHot(state.op, 2), bits(state.a, 1), bits(state.b, 1));
        }
        export function step(state, action) {
          const want = state.op === 0 ? state.a * state.b : state.a + state.b - state.a * state.b;
          return { state: { ...state, action }, done: true, success: action === want };
        }
  grid:
    kind: partition
    config:
      kind: enumerate
      enumerate:
        axes: { op: [0, 1], a: [0, 1], b: [0, 1] }
        roles: { training: all, validation: all, test: all }
  loop: { kind: loop }
  pair: { kind: bits, config: { parts: [{ port: in, offset: 2, width: 2 }] } }
  and: { kind: network, config: { engine: threshold-layers, kind: feedforward, inputs: 2, layers: [2], ticks: 1, leak_shift: 0, reset: 0, artifact: '${artifactId(6)}' } }
  andOut: { kind: readout, config: { mode: bits, width: 1, decode: lsb-int } }
  or: { kind: network, config: { engine: threshold-layers, kind: feedforward, inputs: 2, layers: [2], ticks: 1, leak_shift: 0, reset: 0, artifact: '${artifactId(7)}' } }
  orOut: { kind: readout, config: { mode: bits, width: 1, decode: lsb-int } }
  features: { kind: bits, config: { parts: [{ port: in, offset: 0, width: 4 }, { port: and, offset: 0, width: 1 }, { port: or, offset: 0, width: 1 }] } }
  policy: { kind: network, config: { engine: dense-policy, kind: feedforward, inputs: 6, layers: [{ hidden: 8 }], ticks: 1, leak_shift: 0, reset: 0 } }
  choice: { kind: readout, config: { mode: argmax, map: [0, 1] } }
  trainer: { kind: trainer, config: { method: reinforce, epochs: 10 } }
wires:
  value:
    - grid.training→trainer.training
    - grid.validation→trainer.validation
    - loop.loop→trainer.loop
    - loop.input→pair.in
    - pair.bits→and.in
    - and.scores→andOut.scores
    - pair.bits→or.in
    - or.scores→orOut.scores
    - loop.input→features.in
    - andOut.bits→features.and
    - orOut.bits→features.or
    - features.bits→policy.in
    - policy.scores→choice.scores
    - choice.action→loop.action
    - policy.structure→trainer.structure
  call:
    - scene.module→loop.scenario
    - reward→trainer.objective
`;

/** Quantiser cases (frontend/training/quantize.js ↔ bundle_train.quantize_region): every width × role over regions
 *  whose largest bias is far below, near and far above the largest weight (k from 20 down to a clipped bias), all-zero
 *  weights and biases, a LIF threshold bounded by int32, and halves that round up (2.5 → 3, −2.5 → −2). */
function quantizations() {
  let s = 99;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const region = (rows, cols, w, b) => ({ W: Array.from({ length: rows }, () => Array.from({ length: cols }, () => (rnd() * 2 - 1) * w)), b: Array.from({ length: rows }, () => (rnd() * 2 - 1) * b) });
  const shapes = [region(3, 4, 1, 0.3), region(5, 2, 9, 0.01), region(2, 6, 0.05, 40), region(4, 3, 0.002, 1e-9), region(2, 2, 1, 0),
    { W: [[0, 0], [0, 0]], b: [0, 0] }, { W: [[127, 2.5, -2.5]], b: [0.5] }, { W: [[32767, 0.5]], b: [-1.5] }];
  return [8, 16].flatMap(bits => ['ff', 'lif', 'threshold'].flatMap(role => shapes.map(({ W, b }) => ({ W, b, bits, role, expect: quantization({ W, b, bits, role }) }))));
}

const dir = dirname(fileURLToPath(import.meta.url));
const bundles = trainerBundles();
const PARTITIONS = [{ kind: 'enumerate', axes: { a: [0, 1, 2, 3, 4], op: ['*', '+', '-'] }, select: { mod: 5, rem: [2, 3, 4] } }, { kind: 'enumerate', axes: { a: [0, 1, 2], b: [0, 1] }, select: 'odd' },
                    { kind: 'seed', seed: 7, count: 3 }];
const windowTask = windowed();
const out = { format: 'neurom-bundle-env-fixtures', envs: [counter(), noInit(), windowTask].map(recordEnv),
              loops: [frozenUpstream(), twoLayer('feedforward'), twoLayer('lif'), ...toolLoops()].map(recordLoop),
              intercepted: intercepted(bundles, windowTask), errors: errors(bundles),
              partitions: PARTITIONS.map(entry => ({ entry, episodes: episodesOf(entry) })), validations: validations(bundles), quantizations: quantizations() };
writeFileSync(join(dir, 'bundle-env.json'), JSON.stringify(out));
const count = s => `${s.name} (${s.lanes.length} lanes, ${s.lanes.reduce((n, l) => n + l.steps.length, 0)} steps)`;
console.log(`wrote bundle-env.json: envs ${out.envs.map(count).join(', ')}; loops ${out.loops.map(count).join(', ')}; intercepted ${out.intercepted.map(count).join(', ')}; errors ${out.errors.map(e => e.name).join(', ')}; validations ${out.validations.map(v => `${v.name} ${v.summary.accuracy}`).join(', ')}`);
writeFileSync(join(dir, 'bundles.json'), JSON.stringify(bundles));
console.log(`wrote bundles.json: ${Object.keys(bundles).filter(k => k !== 'format').join(', ')}`);
