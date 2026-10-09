// core/sessions/fixtures.js — hand-made integer models for the counter task (frontend/core/fixtures/counter.js) and
// other fixtures that the session tests use:
//   - `counterModel(1)` always chooses "up" (score of slot 1 wins). `counterModel(0)` always stays.
//   - `firingCounterModel()` is a LIF model whose hidden units fire on some inputs. The chain tests compare its spike
//     counts and persisted potentials.
//   - `deepThresholdArtifact`: a threshold model with two hidden layers on the ADD4 loop.
//   - `toolNetworkArtifacts`: network tools of every kind with fixed weights on the arithmetic loops. These are a LIF
//     tool, a LIF selector that calls it, a tool with a tool layer of its own and a selector that calls that tool.
//   - `datasetWorkspace`: a window-partitioned workspace whose scenario reads an imported dataset.
import { counterGraph } from '../fixtures/counter.js';
import { buildBundle } from '../bundle.js';
import { networkShape, trainedOf } from '../loop.js';
import { makeArtifact, Workspace } from '../store.js';
import { createMemoryDatasetStore, importInto } from './dataset.js';
import { DENSE_FORMAT } from '../../runtime/dense-policy.js';

/** A stand-in artifact that holds a hand-made `model`. It is trained on network `nodeId` as it sits in `graph`, as far
 *  as core/loop.js networkCompatibility can tell. Its bundle's loop is that network's structure and readout alone. */
export function shapedArtifact(graph, nodeId, model) {
  const { structure, readout } = networkShape(graph, graph.resolved(), graph.node(nodeId));
  return { model, bundle: { loop: { trained: 'net', nodes: { net: { kind: 'network', structure }, readout: { kind: 'readout', readout, scores: { node: 'net', port: 'scores' } } } } } };
}

/** Dense LIF model over I=3 bits → O=2 scores matching the counter network (one layer of 8, ticks 2, leak 2, int8
 *  weights, threshold 256). The output bias makes slot `winner` win for every input (hidden units never reach the
 *  threshold). */
export function counterModel(winner, { hidden = 8, kind = 'lif' } = {}) {
  const W = Array.from({ length: hidden }, () => [1, 1, 1]);
  const b = new Array(hidden).fill(1);
  const lif = kind === 'lif' ? { ticks: 2, leak_shift: 2, reset: 0 } : { ticks: 1, leak_shift: 0, reset: 0 };
  return { format: DENSE_FORMAT, kind, inputs: 3, outputs: 2, weightBits: 8, ...lif, layers: [{ hidden, W, b, scale: 1, k: 0, ...(kind === 'lif' ? { threshold: 256 } : {}) }],
    output: { W: [0, 1].map(() => new Array(hidden).fill(0)), b: [0, 1].map(o => (o === winner ? 1 : 0)), scale: 1, k: 0 } };
}

/** The counter network's LIF shape with fixed int8 weights shifted by k = 1 around the threshold 256 (±252 per input
 *  bit, ±270 bias). Some hidden units fire on some inputs and not on others, so spike counts and potentials change
 *  from step to step. */
export function firingCounterModel() {
  const hidden = 8, step = k => ((k * 29 + 13) % 7) - 3;
  let k = 0;
  const W = Array.from({ length: hidden }, () => [step(k++) * 42, step(k++) * 42, step(k++) * 42]);
  const b = Array.from({ length: hidden }, () => step(k++) * 90);
  const output = { W: [0, 1].map(() => Array.from({ length: hidden }, () => step(k++) * 3)), b: [0, 0], scale: 1, k: 0 };
  return { ...counterModel(1, { hidden }), layers: [{ hidden, W, b, scale: 1, k: 1, threshold: 256 }], output };
}

/** A counter graph in a fresh state plus an artifact of the trainer bundle holding `model` (not yet accepted). */
export async function counterArtifact(model = counterModel(1), graphOf = counterGraph) {
  const { graph, ids, group } = graphOf();
  const bundle = buildBundle(graph, ids.trainer);
  const artifact = await makeArtifact({ bundle, model, provenance: { method: 'reinforce', backend: 'browser', seed: 1, epochs: 1, bundleHash: '0x' + '0'.repeat(64), recipe: {} }, evaluation: { metricName: 'return', metric: 3 } });
  return { graph, ids, group, bundle, artifact };
}

/** A counter workspace whose candidates accept an artifact holding `model`: every network of the loop has weights. */
export async function acceptedCounter(model = counterModel(1), graphOf = counterGraph) {
  const out = await counterArtifact(model, graphOf), ws = new Workspace(out.graph);
  await ws.addArtifact(out.artifact);
  out.graph.patchConfig(out.ids.cands, { accepted: out.artifact.id });
  return { ...out, ws, artifacts: id => ws.artifact(id) };
}

/** An 8 → 6 → 4 → 5 threshold artifact on the loop of `add4` (the builtin ADD4 artifact, with its trained network
 *  widened to match). It has two hidden layers with fixed weights (the middle one shifted by k = 1) whose activations
 *  change with the input. `weightBits` 16 multiplies every weight and threshold by 1000 (same activations, int16 codes). */
export function deepThresholdArtifact(add4, { weightBits = 8 } = {}) {
  const bundle = structuredClone(add4.bundle), net = bundle.loop.nodes[trainedOf(bundle.loop).id];
  const widths = [8, 6, 4, 5], unit = weightBits === 16 ? 1000 : 1, weight = k => (((k * 29 + 13) % 7) - 3) * unit;
  let k = 0;
  const layers = widths.slice(1).map((n, l) => ({ W: Array.from({ length: n }, () => Array.from({ length: widths[l] }, () => weight(k++))), th: Array.from({ length: n }, () => weight(k++)), scale: unit, k: l === 1 ? 1 : 0 }));
  net.structure = { ...net.structure, layers: widths.slice(1, -1), weightBits };
  return makeArtifact({ bundle, model: { format: 'threshold-layers', inputs: 8, outputs: 5, weightBits, layers }, provenance: { test: 'deep threshold' } });
}

/** The Tool entry (core/loop.js) of a network artifact read through its own bits readout. */
function toolEntry(artifact) {
  const tr = trainedOf(artifact.bundle.loop), tools = artifact.bundle.loop.nodes[tr.id].tools;
  return { kind: 'net', structure: tr.structure, model: artifact.model, artifactId: artifact.id, readout: tr.readout, ...(tools ? { tools } : {}) };
}
/** A fixed-weight dense model over `layers` (`{ hidden }` / `{ tools, K, D, R }`) at `weightBits`: small integer weights
 *  (−3..3 × 3) and biases, times 1000 at int16 (codes of the same real values). A LIF plain layer fires at 6 (×1000). */
function fixedDense({ kind, inputs, outputs, layers, weightBits, seed }) {
  const unit = weightBits === 16 ? 1000 : 1, lif = kind === 'lif';
  let k = seed;
  const w = () => ((((k++) * 29 + 13) % 7) - 3) * 3 * unit, b = () => ((((k++) * 17 + 5) % 5) - 1) * unit;
  const region = (rows, cols) => ({ W: Array.from({ length: rows }, () => Array.from({ length: cols }, w)), b: Array.from({ length: rows }, b) });
  let cols = inputs;
  const model = { format: DENSE_FORMAT, kind, inputs, outputs, weightBits, ...(lif ? { ticks: 2, leak_shift: 1, reset: 0 } : { ticks: 1, leak_shift: 0, reset: 0 }), layers: layers.map(L => {
    if (L.tools) {
      const c = region(L.K, cols), d = region(L.D, cols);
      cols += L.R;
      return { tools: L.tools, K: L.K, D: L.D, R: L.R, Wc: c.W, bc: c.b, scale_c: unit, k_c: 0, Wd: d.W, bd: d.b, scale_d: unit, k_d: 0 };
    }
    const layer = { hidden: L.hidden, ...region(L.hidden, cols), scale: unit, k: 0, ...(lif ? { threshold: 6 * unit } : {}) };
    cols = L.hidden;
    return layer;
  }) };
  if (!layers.at(-1).tools) model.output = { ...region(outputs, cols), scale: unit, k: 0 };
  return model;
}
/** An artifact of `base` (a builtin artifact whose loop it keeps) whose trained network becomes the dense `structure`
 *  calling `tools` (Tool entries, one tool layer `tools`), with fixed weights. */
function retrained(base, structure, tools, weightBits, seed, name) {
  const bundle = structuredClone(base.bundle), id = trainedOf(bundle.loop).id, net = bundle.loop.nodes[id];
  const { kind, inputs, outputs, layers } = structure;
  net.structure = { engine: 'dense-policy', ...structure, weightBits, ...(kind === 'lif' ? { ticks: 2, leak_shift: 1, reset: 0 } : { ticks: 1, leak_shift: 0, reset: 0 }) };
  if (tools) { net.tools = { tools }; net.title ??= name; } else delete net.tools;
  return makeArtifact({ bundle, model: fixedDense({ kind, inputs, outputs, layers, weightBits, seed }), provenance: { test: name } });
}
/**
 * Network tools of every kind on the builtin arithmetic loops (`builtins`: { add4, sub4, mul4, combiner }), with fixed
 * weights at `weightBits` (ADR 0014):
 *   lifTool        LIF 8 → 6 → 5 on the ADD4 loop: it remembers between calls.
 *   lifSelector    the combiner's LIF selector 11 → 16 → tools [lifTool, SUB4, MUL4] (D 8, R 8): its own potentials,
 *                  then lifTool's.
 *   mid            FF 8 → 8 → tools [lifTool, ADD4] (D 8, R 5) on the ADD4 loop: a tool with a tool layer of its own.
 *   nestedSelector the combiner's FF selector 11 → 16 → tools [mid, SUB4, MUL4]: lifTool's state nested two deep.
 */
export async function toolNetworkArtifacts({ add4, sub4, mul4, combiner }, { weightBits = 8 } = {}) {
  const lifTool = await retrained(add4, { kind: 'lif', inputs: 8, outputs: 5, layers: [{ hidden: 6 }] }, null, weightBits, 1, 'lif tool');
  const head = (K, D, R) => ({ tools: 'tools', K, D, R });
  const lifSelector = await retrained(combiner, { kind: 'lif', inputs: 11, outputs: 8, layers: [{ hidden: 16 }, head(3, 8, 8)] }, [lifTool, sub4, mul4].map(toolEntry), weightBits, 2, 'lif selector');
  const mid = await retrained(add4, { kind: 'feedforward', inputs: 8, outputs: 5, layers: [{ hidden: 8 }, head(2, 8, 5)] }, [lifTool, add4].map(toolEntry), weightBits, 3, 'mid');
  const nestedSelector = await retrained(combiner, { kind: 'feedforward', inputs: 11, outputs: 8, layers: [{ hidden: 16 }, head(3, 8, 8)] }, [mid, sub4, mul4].map(toolEntry), weightBits, 4, 'nested selector');
  return { lifTool, lifSelector, mid, nestedSelector };
}

/** CSV of `rows` rows `open,close` with close = 10·i. */
const priceCSV = (rows = 20) => 'open,close\n' + Array.from({ length: rows }, (_, i) => `${i},${i * 10}`).join('\n');

/** A workspace whose trainer trains on a window partition over an imported dataset: the scenario reads the table
 *  (`table` is the last argument of input / step when a dataset is wired to the drivers' partition.table). */
export async function datasetWorkspace(text = priceCSV(), { now = Date.now } = {}) {
  const ws = new Workspace(), store = createMemoryDatasetStore({ now }), g = ws.graph;
  const ds = g.addNode({ kind: 'dataset', title: 'prices' });
  const meta = await importInto({ workspace: ws, store, nodeId: ds.id, text });
  const code = source => g.addNode({ kind: 'code', config: { inputs: [], source } });
  const scene = code([
    'export const budget = 3;',
    'export function init(start) { return { t: start.start, price: 0 }; }',
    'export function step(state, action, table) { return { state: { t: state.t + 1, price: table.at(state.t + 1, "close") }, done: false, success: false }; }',
    'export function input(state, table) { return thermometer(table.at(state.t, "close"), [50, 100]); }',
  ].join('\n'));
  const loop = g.addNode({ kind: 'loop' });
  const part = g.addNode({ kind: 'partition', config: { kind: 'window', window: { length: 4, stride: 2, embargo: 1, splits: { training: [0, 0.5], validation: null, test: [0.5, 1] } } } });
  g.connect({ kind: 'value', from: { node: ds.id, port: 'table' }, to: { node: part.id, port: 'table' } });
  const readout = g.addNode({ kind: 'readout', config: { mode: 'argmax', map: [0, 1] } });
  const net = g.addNode({ kind: 'network', config: { inputs: 2 } });
  const reward = code('export function reward(transition) { return transition.next.price; }');
  const trainer = g.addNode({ kind: 'trainer' });
  g.connect({ kind: 'call', from: { node: scene.id, port: 'module' }, to: { node: loop.id, port: 'scenario' } });
  g.connect({ kind: 'value', from: { node: loop.id, port: 'loop' }, to: { node: trainer.id, port: 'loop' } });
  g.connect({ kind: 'value', from: { node: part.id, port: 'training' }, to: { node: trainer.id, port: 'training' } });
  g.connect({ kind: 'value', from: { node: loop.id, port: 'input' }, to: { node: net.id, port: 'in' } });
  g.connect({ kind: 'value', from: { node: net.id, port: 'scores' }, to: { node: readout.id, port: 'scores' } });
  g.connect({ kind: 'value', from: { node: readout.id, port: 'action' }, to: { node: loop.id, port: 'action' } });
  g.connect({ kind: 'value', from: { node: net.id, port: 'structure' }, to: { node: trainer.id, port: 'structure' } });
  g.connect({ kind: 'call', from: { node: reward.id, port: 'reward' }, to: { node: trainer.id, port: 'objective' } });
  return { ws, store, meta, ids: { ds: ds.id, scene: scene.id, loop: loop.id, part: part.id, readout: readout.id, net: net.id, reward: reward.id, trainer: trainer.id } };
}
