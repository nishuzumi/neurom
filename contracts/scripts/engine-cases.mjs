// engine-cases.mjs — the fixed input set of the engine version check (engine-version-check.mjs, ADR 0017). It holds
// every builtin artifact plus generated networks:
//   - FF and LIF, one and several layers
//   - every lane path of the column engine (up to 16 / 32 rows on the stack, more in memory, row counts off the lane grid)
//   - weights over several chunks
//   - tool layers in FF and LIF networks (after a plain layer and first in a segment)
//   - a LIF tool in a LIF selector, and a tool with a tool layer of its own that calls a LIF tool (their state kept in
//     the selector's session)
//   - a deep threshold network.
// Each generated network comes once per weight width of the model format (WEIGHT_BITS, ADR 0015).
// Every case is a `neurom-module` artifact that the production bridge deploys, and a fixed list of inputs. The list
// holds all inputs when the network reads at most 8 bits, else a spread of densities. A stateful case (LIF, or calling
// a LIF tool) uses one session's steps in order as its inputs, so the check compares its next state step by step.
// Generated weights are drawn across a width's whole code range (both extremes included), and biases and thresholds
// across int16. Every width has regions with a shift k > 0. The stateful and nested tool cases are the session tests'
// fixed-weight tool networks (core/sessions/fixtures.js toolNetworkArtifacts).
import { makeArtifact } from '../../frontend/core/store.js';
import { buildBundle } from '../../frontend/core/bundle.js';
import { counterGraph } from '../../frontend/core/fixtures/counter.js';
import { trainedOf, trainedTools } from '../../frontend/core/loop.js';
import { isToolLayer, moduleStateWidth } from '../../frontend/core/kinds/network.js';
import { DENSE_FORMAT, WEIGHT_BITS } from '../../frontend/runtime/dense-policy.js';
import { THRESHOLD_FORMAT } from '../../frontend/runtime/threshold-layers.js';
import { builtinArtifacts } from '../../frontend/templates/artifacts/index.js';
import { toolNetworkArtifacts } from '../../frontend/core/sessions/fixtures.js';

/**
 * One region's unit at weight width `bits` (ADR 0015) for the r-th region of a generated network. `scale` = the
 * largest code (a real weight of 1.0). The shifts k are around 16 − bits, where a full-range weight · 2^k is about a
 * full-range int16 bias (as the trainer's quantiser picks them): 7, 8, 9 for int8 and 0, 1 for int16.
 */
function unitOf(bits, r) {
  const k = Math.max(0, 16 - bits + [0, 1, -1][r % 3]);
  return { scale: 2 ** (bits - 1) - 1, k };
}

/** Exhaustive inputs up to this many bits; wider networks get STATELESS_INPUTS / LIF_STEPS inputs. */
const EXHAUSTIVE_BITS = 8;
const STATELESS_INPUTS = 32;
const LIF_STEPS = 16;
/** Share of ones in the generated inputs, cycled (the first two inputs are all zeros and all ones). */
const DENSITIES = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 3 / 4];

/** A deterministic hash of two integers to [0, 1). */
function unit(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

/** The inputs of a network reading `n` bits: all 2^n when n ≤ EXHAUSTIVE_BITS, else `count` spread over densities. */
function inputsOf(n, count) {
  if (n <= EXHAUSTIVE_BITS) return Array.from({ length: 2 ** n }, (_, x) => Array.from({ length: n }, (_, i) => (x >> i) & 1));
  return Array.from({ length: count }, (_, s) => Array.from({ length: n }, (_, i) => (s === 0 ? 0 : s === 1 ? 1 : unit(s, i) < DENSITIES[s % DENSITIES.length] ? 1 : 0)));
}

const INT16 = [-32768, 32767];

/** Integers of the generated network `name` in [lo, hi]: the k-th draw of the whole model, both ends included. */
function numberSource(name) {
  let seed = 0, k = 0;
  for (const c of name) seed = Math.floor(unit(seed, c.codePointAt(0)) * 2 ** 31);
  const next = ([lo, hi]) => { const u = unit(seed, k++); return u < 0.02 ? lo : u > 0.98 ? hi : lo + Math.floor(((u - 0.02) / 0.96) * (hi - lo + 1)); };
  return { matrix: (rows, cols, range) => Array.from({ length: rows }, () => Array.from({ length: cols }, () => next(range))), vector: (n, range) => Array.from({ length: n }, () => next(range)) };
}

/** Every weight code of `bits`: −2^(bits−1) .. 2^(bits−1) − 1. */
const codes = bits => [-(2 ** (bits - 1)), 2 ** (bits - 1) - 1];

const FF = { kind: 'feedforward', ticks: 1, leak_shift: 0, reset: 0 };
const LIF = { kind: 'lif', ticks: 3, leak_shift: 2, reset: -8192 };

/** A dense model at `bits` over `layers` (`{ hidden }` or `{ K, D, R }`, the tool port named `tools`). A LIF plain
 *  layer's threshold is 1.0 real in its unit (scale · 2^k), as the trainer sets it. */
function denseModel({ name, inputs, outputs, layers, params, bits }) {
  const n = numberSource(name), W = codes(bits), lif = params.kind === 'lif';
  let cols = inputs, r = 0;
  const region = (rows, w = 'W', b = 'b', scale = 'scale', k = 'k') => {
    const u = unitOf(bits, r++);
    return { [w]: n.matrix(rows, cols, W), [b]: n.vector(rows, INT16), [scale]: u.scale, [k]: u.k };
  };
  const model = { format: DENSE_FORMAT, ...params, weightBits: bits, inputs, outputs, layers: layers.map(L => {
    if (L.K) { const layer = { tools: 'tools', K: L.K, D: L.D, R: L.R, ...region(L.K, 'Wc', 'bc', 'scale_c', 'k_c'), ...region(L.D, 'Wd', 'bd', 'scale_d', 'k_d') }; cols += L.R; return layer; }
    const layer = { hidden: L.hidden, ...region(L.hidden) };
    if (lif) layer.threshold = layer.scale * 2 ** layer.k;
    cols = L.hidden;
    return layer;
  }) };
  if (!layers.at(-1).K) model.output = region(outputs);
  return model;
}

/** A dense network on the counter loop (the loop's network and readout widened to match). */
async function counterNetwork(name, { inputs, outputs, hidden, params, bits }) {
  const { graph, ids } = counterGraph();
  const bundle = buildBundle(graph, ids.trainer), net = bundle.loop.nodes[ids.net], readout = bundle.loop.nodes[ids.readout];
  const layers = hidden.map(h => ({ hidden: h }));
  net.structure = { ...net.structure, ...params, weightBits: bits, inputs, outputs, layers };
  readout.readout = { mode: 'argmax', map: Array.from({ length: outputs }, (_, a) => a % 2), width: outputs };
  return makeArtifact({ bundle, model: denseModel({ name, inputs, outputs, layers, params, bits }), provenance: { engineCase: name } });
}

/** The combiner's policy (11 bits → tools ADD4 / SUB4 / MUL4 → 8 bits) with `layers` around its tool layer. */
async function combinerNetwork(name, combiner, { layers, params, bits }) {
  const bundle = structuredClone(combiner.bundle), net = bundle.loop.nodes[trainedOf(bundle.loop).id];
  const { inputs, outputs } = net.structure, tool = net.structure.layers.find(isToolLayer);
  const shape = layers.map(L => (L === 'tools' ? { tools: tool.tools, K: tool.K, D: tool.D, R: tool.R } : { hidden: L }));
  net.structure = { ...net.structure, ...params, weightBits: bits, layers: shape };
  return makeArtifact({ bundle, model: denseModel({ name, inputs, outputs, layers: shape, params, bits }), provenance: { engineCase: name } });
}

/** A threshold network at `bits` on the ADD4 loop: 8 bits through `hidden` to its 5 outputs. */
async function thresholdNetwork(name, add4, { hidden, bits }) {
  const bundle = structuredClone(add4.bundle), net = bundle.loop.nodes[trainedOf(bundle.loop).id];
  const widths = [net.structure.inputs, ...hidden, net.structure.outputs], n = numberSource(name);
  net.structure = { ...net.structure, weightBits: bits, layers: hidden };
  const layers = widths.slice(1).map((rows, l) => ({ W: n.matrix(rows, widths[l], codes(bits)), th: n.vector(rows, INT16), ...unitOf(bits, l) }));
  return makeArtifact({ bundle, model: { format: THRESHOLD_FORMAT, weightBits: bits, inputs: widths[0], outputs: widths.at(-1), layers }, provenance: { engineCase: name } });
}

/** The generated networks at weight width `bits` → `[{ name, artifact }]`. */
async function generated(bits, { combiner, add4 }) {
  const at = name => `${name} int${bits}`;
  const counter = async (name, shape) => ({ name: at(name), artifact: await counterNetwork(at(name), { ...shape, bits }) });
  const tools = async (name, shape) => ({ name: at(name), artifact: await combinerNetwork(at(name), combiner, { ...shape, bits }) });
  return [
    await counter('FF 12→8→4', { inputs: 12, outputs: 4, hidden: [8], params: FF }),
    await counter('FF 185→32→7', { inputs: 185, outputs: 7, hidden: [32], params: FF }),
    await counter('FF 40→48→20→5', { inputs: 40, outputs: 5, hidden: [48, 20], params: FF }),
    await counter('FF 256→256→200 (several chunks)', { inputs: 256, outputs: 200, hidden: [256], params: FF }),
    await counter('LIF 12→8→4', { inputs: 12, outputs: 4, hidden: [8], params: LIF }),
    await counter('LIF 20→24→40→6', { inputs: 20, outputs: 6, hidden: [24, 40], params: LIF }),
    await tools('FF 11→16→tools→12→8', { layers: [16, 'tools', 12], params: FF }),
    await tools('LIF 11→16→tools→12→8', { layers: [16, 'tools', 12], params: LIF }),
    await tools('LIF 11→tools→12→8', { layers: ['tools', 12], params: LIF }),
    { name: at('threshold 8→40→33→5'), artifact: await thresholdNetwork(at('threshold 8→40→33→5'), add4, { hidden: [40, 33], bits }) },
  ];
}

/** The engines (names) a module of `artifact` computes with: its own and its tools', recursively. */
function enginesOf(artifact, artifacts) {
  const out = new Set([trainedOf(artifact.bundle.loop).structure.engine]);
  for (const tool of trainedTools(artifact.bundle.loop)) for (const e of enginesOf(artifacts(tool.artifactId), artifacts)) out.add(e);
  return out;
}

/**
 * The fixed input set → `{ cases, artifacts }`. A case is `{ name, artifact, engines, stateful, inputs }`. `engines` =
 * the engine names that its module computes with (tools included). `stateful` = whether its inputs are one session's
 * steps (its module keeps state: LIF potentials or its tools' states) or independent decisions from rest.
 * `artifacts(id)` resolves every tool artifact.
 */
export async function engineCases() {
  const builtins = await builtinArtifacts(), byName = name => builtins.find(e => e.name === name).artifact;
  const all = builtins.map(e => ({ name: e.name, artifact: e.artifact })), tools = [];
  const arithmetic = { add4: byName('arithmetic-add4'), sub4: byName('arithmetic-sub4'), mul4: byName('arithmetic-mul4'), combiner: byName('arithmetic-combiner-policy') };
  for (const bits of WEIGHT_BITS) {
    all.push(...await generated(bits, { combiner: arithmetic.combiner, add4: arithmetic.add4 }));
    const made = await toolNetworkArtifacts(arithmetic, { weightBits: bits });
    tools.push(made.lifTool, made.mid);
    all.push({ name: `LIF 11→16→tools [LIF tool, SUB4, MUL4]→8 int${bits}`, artifact: made.lifSelector },
      { name: `FF 11→16→tools [tool with tools [LIF tool, ADD4], SUB4, MUL4]→8 int${bits}`, artifact: made.nestedSelector });
  }
  const artifacts = id => builtins.find(e => e.artifact.id === id)?.artifact ?? tools.find(a => a.id === id) ?? null;
  const cases = all.map(({ name, artifact }) => {
    const { structure } = trainedOf(artifact.bundle.loop), stateful = moduleStateWidth(structure, trainedTools(artifact.bundle.loop)) > 0;
    return { name, artifact, engines: enginesOf(artifact, artifacts), stateful, inputs: inputsOf(structure.inputs, stateful ? LIF_STEPS : STATELESS_INPUTS) };
  });
  return { cases, artifacts };
}
