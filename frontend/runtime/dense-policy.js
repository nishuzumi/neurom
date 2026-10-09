// runtime/dense-policy.js — the dense FF / LIF integer engine (`dense-policy` models, engine `dense-policy`).
// It does the exact arithmetic that contracts/src/modules/DensePolicyEngine.sol does (ADR 0010, ADR 0014). Sessions,
// trainers and export share it. It is UI-independent and scenario-free. Inputs and outputs are any binary width 1..256
// (the loop around the network and its readout decide). The code that knows the task checks whether the widths of a
// model match the task (core/sessions/executor.js modelProblem against the structure of the loop network).
// Model: `{ format, kind, inputs, outputs, weightBits, ticks, leak_shift, reset, layers, output? }` (ADR 0015).
// `layers` holds plain layers `{ hidden, W, b, scale, k, threshold? }` and tool layers `{ tools: <port>, K, D, R, Wc,
// bc, scale_c, k_c, Wd, bd, scale_d, k_d }` (the decision head on the layer before: K choice logits, D data-bit
// logits). `output: { W, b, scale, k }` exists unless the last layer is a tool layer. In that case, the R result bits
// of that tool layer are the output (outputs = R). The scores are +1 for a 1 bit and -1 for a 0 bit, so a bits readout
// reads the result back.
// Every affine map ("region") has its own unit. W are weightBits-wide codes, and b are int16 biases in the accumulator
// unit. The map computes (Σ W·x)·2^k + b. `scale` (codes per real unit) is only for information. The `threshold` of a
// LIF plain layer is 1.0 real in its own accumulator unit (FF plain layers have none: they fire at ≥ 1).
// FF: each layer fires where its current ≥ 1 and gives those bits to the next layer.
// LIF: tool layers cut the network into segments. Each segment runs all `ticks` and passes the spikes of each tick
// from layer to layer. The potentials of each layer persist across steps.
// A tool layer (greedy, ADR 0010 §4) works like this:
//   - choice = first maximum of the K logits. data bit = logit > 0.
//   - Only the chosen tool runs (`call(port, choice, data)` → bits, zero-extended to R).
//   - The next layer sees `result ‖ the layer before`.
//   - The head reads the activations of the layer before (FF), or its spike counts with the biases scaled by `ticks`
//     (LIF, as the output layer does).
//   - "The layer before" that goes to the next layer is its activations (FF), or whether each neuron fired at least
//     once in the segment (LIF).
//   - A tool layer with no plain layer before it in its segment reads the input bits of that segment and gives them
//     on. Its biases are not scaled.
import { t } from '../i18n.js';

export const DENSE_FORMAT = 'dense-policy';
/** Model kinds. index = the on-chain kind code (ModuleKinds). */
export const DENSE_KINDS = Object.freeze(['feedforward', 'lif']);
const MIN_PORT = 1, MAX_PORT = 256, MAX_LAYERS = 8, MAX_SHIFT = 20, INT32_MAX = 2147483647;
/** The weight widths a model may use (ADR 0015). */
export const WEIGHT_BITS = Object.freeze([8, 16]);

function boundedInteger(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(t('{name} 必须是 {min}..{max} 的整数', { name, min, max }));
}

/** Throws when `model` has a top-level key outside `keys`, or its weightBits is not 8 / 16. */
export function checkModelKeys(model, keys) {
  for (const key of Object.keys(model)) if (!keys.includes(key)) throw new Error(t('模型含未知字段 {key}', { key }));
  if (!WEIGHT_BITS.includes(model.weightBits)) throw new Error(t('weightBits 必须是 8 或 16'));
}
const DENSE_KEYS = Object.freeze(['format', 'kind', 'inputs', 'outputs', 'weightBits', 'ticks', 'leak_shift', 'reset', 'layers', 'output']);

/** Throws unless one region's `scale` (a positive finite number) and shift `k` (0..20) are well-formed. */
export function checkUnit(scale, k, label) {
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) throw new Error(t('{label} 的 scale 必须是正数', { label }));
  boundedInteger(k, 0, MAX_SHIFT, `${label} k`);
}

/** Throws unless `model` is a well-formed dense model. Returns it. */
export function validateDenseModel(model) {
  if (!model || model.format !== DENSE_FORMAT) throw new Error(t('需要 {format} 模型', { format: DENSE_FORMAT }));
  checkModelKeys(model, DENSE_KEYS);
  if (!DENSE_KINDS.includes(model.kind)) throw new Error(t('未知策略引擎'));
  const lif = model.kind === 'lif', wMax = 2 ** (model.weightBits - 1);
  boundedInteger(model.inputs, MIN_PORT, MAX_PORT, 'inputs');
  boundedInteger(model.outputs, MIN_PORT, MAX_PORT, 'outputs');
  boundedInteger(model.ticks, 1, 64, 'ticks');
  boundedInteger(model.leak_shift, 0, 10, 'leak_shift');
  boundedInteger(model.reset, -32768, 32767, 'reset');
  const vector = (values, size, label, lo = -32768, hi = 32767) => {
    if (!Array.isArray(values) || values.length !== size) throw new Error(t('{label} 长度必须为 {size}', { label, size }));
    for (const value of values) boundedInteger(value, lo, hi, label);
  };
  const matrix = (values, rows, cols, label) => {
    if (!Array.isArray(values) || values.length !== rows) throw new Error(t('{label} 行数必须为 {rows}', { label, rows }));
    for (const row of values) vector(row, cols, label, -wMax, wMax - 1);
  };
  if (!Array.isArray(model.layers) || model.layers.length < 1 || model.layers.length > MAX_LAYERS) throw new Error(t('稠密模型的层数必须是 1..{max}', { max: MAX_LAYERS }));
  let width = model.inputs;
  model.layers.forEach((layer, l) => {
    if (layer && typeof layer === 'object' && Object.hasOwn(layer, 'tools')) {
      if (typeof layer.tools !== 'string' || !layer.tools) throw new Error(t('第 {index} 层的 tools 必须是端口名', { index: l + 1 }));
      for (const name of ['K', 'D', 'R']) boundedInteger(layer[name], 1, 256, `layers[${l}].${name}`);
      matrix(layer.Wc, layer.K, width, `layers[${l}].Wc`);
      vector(layer.bc, layer.K, `layers[${l}].bc`);
      checkUnit(layer.scale_c, layer.k_c, `layers[${l}].Wc`);
      matrix(layer.Wd, layer.D, width, `layers[${l}].Wd`);
      vector(layer.bd, layer.D, `layers[${l}].bd`);
      checkUnit(layer.scale_d, layer.k_d, `layers[${l}].Wd`);
      width += layer.R;
      return;
    }
    if (!layer || typeof layer !== 'object' || !Object.hasOwn(layer, 'hidden')) throw new Error(t('第 {index} 层必须是带 hidden 宽度的普通层', { index: l + 1 }));
    boundedInteger(layer.hidden, 1, 256, `layers[${l}].hidden`);
    matrix(layer.W, layer.hidden, width, `layers[${l}].W`);
    vector(layer.b, layer.hidden, `layers[${l}].b`);
    checkUnit(layer.scale, layer.k, `layers[${l}]`);
    if (lif) boundedInteger(layer.threshold, 1, INT32_MAX, `layers[${l}].threshold`);
    else if (Object.hasOwn(layer, 'threshold')) throw new Error(t('FF 层没有 threshold（它在 ≥ 1 时激活）'));
    width = layer.hidden;
  });
  const last = model.layers[model.layers.length - 1];
  if (isTool(last)) {
    if (model.output !== undefined && model.output !== null) throw new Error(t('最后一层是工具层时模型没有输出层 output'));
    if (model.outputs !== last.R) throw new Error(t('最后一层是工具层时 outputs 必须等于它的结果宽度 R'));
    return model;
  }
  if (!model.output || typeof model.output !== 'object') throw new Error(t('缺少输出层 output'));
  matrix(model.output.W, model.outputs, width, 'output.W');
  vector(model.output.b, model.outputs, 'output.b');
  checkUnit(model.output.scale, model.output.k, 'output');
  return model;
}

/** Whether a dense model layer is a tool layer. */
export const isTool = layer => Object.hasOwn(layer, 'tools');

/** Length of a dense model's temporal state (and of its counts): the widths of all its plain layers, one after another. */
export const denseStateWidth = model => model.layers.reduce((sum, layer) => sum + (isTool(layer) ? 0 : layer.hidden), 0);

/** (Σ_i row[i]·x[i])·2^k + factor·bias — one neuron of a region (exact: |Σ·2^k| stays far below 2^53). */
const affine = (row, x, k, bias, factor) => { let s = 0; for (let i = 0; i < row.length; i++) s += row[i] * x[i]; return s * 2 ** k + factor * bias; };

/** A tool layer's greedy decision on `prev` (biases × `factor`), then the chosen tool's result zero-extended to R. */
function toolStep(layer, prev, factor, call) {
  let choice = 0, best = -Infinity;
  for (let k = 0; k < layer.K; k++) {
    const logit = affine(layer.Wc[k], prev, layer.k_c, layer.bc[k], factor);
    if (logit > best) { best = logit; choice = k; }
  }
  const data = new Array(layer.D);
  for (let d = 0; d < layer.D; d++) data[d] = affine(layer.Wd[d], prev, layer.k_d, layer.bd[d], factor) > 0 ? 1 : 0;
  return { choice, data, result: callTool(layer, call, choice, data) };
}

/** Run tool layer `layer`'s tool `choice` on `data` through `call(port, choice, data, lane) → bits`: its result checked
 *  and zero-extended to R bits. Trainers call it too (`lane`: the batch lane, whose tools' states the call advances), so
 *  a trained forward pass reads tools exactly as execution does. */
export function callTool(layer, call, choice, data, lane = 0) {
  if (!call) throw new Error(t('模型有工具层 {port}，但没有接工具', { port: layer.tools }));
  const got = call(layer.tools, choice, data, lane);
  if (!got || got.length > layer.R) throw new Error(t('工具层 {port} 的工具 {choice} 返回 {n} 位，但是最多 {R} 位', { port: layer.tools, choice, n: String(got?.length), R: layer.R }));
  const result = new Array(layer.R).fill(0);
  for (let k = 0; k < got.length; k++) {
    if (got[k] !== 0 && got[k] !== 1) throw new Error(t('工具层 {port} 的工具 {choice} 返回的不是 0/1 位', { port: layer.tools, choice }));
    result[k] = got[k];
  }
  return result;
}

/** One step of a validated model on binary `input`. Mutates `voltage` (the LIF membrane potentials of every plain
 *  layer, one after another. FF does not use it). Validation-free: this is the hot path of trainers and benchmarks.
 *  core/sessions/executor.js checks the input at its interface. `count` = spikes (FF: activations) of every plain
 *  layer, same layout. `call(port, choice, data) → bits` runs the chosen tool of a tool layer. `tools` records the
 *  `{ choice, data, result }` of each tool layer by port (null for a model without tool layers). */
export function integerStep(model, input, voltage, call = null) {
  const { layers, output } = model, count = [];
  let tools = null, last;
  if (model.kind === 'feedforward') {
    let x = input;
    for (const layer of layers) {
      if (isTool(layer)) { const r = toolStep(layer, x, 1, call); (tools ??= {})[layer.tools] = r; x = [...r.result, ...x]; continue; }
      const act = new Array(layer.hidden);
      for (let j = 0; j < layer.hidden; j++) act[j] = affine(layer.W[j], x, layer.k, layer.b[j], 1) >= 1 ? 1 : 0;
      for (const a of act) count.push(a);
      x = act;
    }
    last = x;
  } else {
    // segments: runs of plain layers between tool layers. `x` is the input of a segment, `counts` the spike counts of its last layer
    let x = input, counts = null, at = 0;
    for (let s = 0; s < layers.length;) {
      if (isTool(layers[s])) {
        const r = counts ? toolStep(layers[s], counts, model.ticks, call) : toolStep(layers[s], x, 1, call);
        (tools ??= {})[layers[s].tools] = r;
        x = [...r.result, ...(counts ? counts.map(c => (c > 0 ? 1 : 0)) : x)]; counts = null; s++;
        continue;
      }
      let e = s; while (e < layers.length && !isTool(layers[e])) e++;
      const segment = layers.slice(s, e), first = segment[0], base = [];
      const constant = first.W.map((row, j) => affine(row, x, first.k, first.b[j], 1));
      const spikes = segment.map(layer => new Array(layer.hidden).fill(0)), n = segment.map(layer => new Array(layer.hidden).fill(0));
      for (const layer of segment) { base.push(at); at += layer.hidden; }
      for (let tick = 0; tick < model.ticks; tick++) {
        for (let l = 0; l < segment.length; l++) {
          const layer = segment[l], prev = l ? spikes[l - 1] : null, out = spikes[l], c = n[l];
          for (let j = 0; j < layer.hidden; j++) {
            const current = prev ? affine(layer.W[j], prev, layer.k, layer.b[j], 1) : constant[j];
            let v = voltage[base[l] + j];
            v = v - Math.floor(v / 2 ** model.leak_shift) + current;   // the engine's arithmetic shift, exact beyond int32
            if (v >= layer.threshold) { c[j]++; out[j] = 1; v = model.reset; } else out[j] = 0;
            voltage[base[l] + j] = v;
          }
        }
      }
      for (const c of n) for (const k of c) count.push(k);
      counts = n[n.length - 1]; s = e;
    }
    last = counts ?? x;
    // the module contract keeps int32 potentials and reverts ("volt") when one leaves that range after a decision
    if (voltage.some(v => v < -2147483648 || v > 2147483647)) throw new Error(t('LIF 电位超出 int32：链上会拒绝这一步（volt）'));
  }
  const final = layers[layers.length - 1];
  if (isTool(final)) {
    const scores = tools[final.tools].result.map(b => (b ? 1 : -1));
    return { action: scores.indexOf(Math.max(...scores)), scores, voltage, count, tools };
  }
  const factor = model.kind === 'lif' ? model.ticks : 1;
  const scores = output.W.map((row, a) => affine(row, last, output.k, output.b[a], factor));
  return { action: scores.indexOf(Math.max(...scores)), scores, voltage, count, tools };
}

/** Bytes of one on-chain weight region (contracts EngineBase): `rows` neurons over `cols` inputs, column-major. Each
 *  weight column is padded to whole 32-byte words (32 int8 or 16 int16). The int16 bias column comes after them. */
export const regionBytes = (rows, cols, weightBits) => cols * Math.ceil(rows * weightBits / 256) * 32 + Math.ceil(rows / 16) * 32;

/** One region as hex (contracts EngineBase layout). Column i holds W[j][i] of every row j as `weightBits`-wide
 *  big-endian two's complement. Then a column holds the biases `b` as int16. Each column is zero-padded to whole words.
 *  The values are already range-checked. */
export function regionHex(W, b, weightBits) {
  const rows = b.length, cols = rows ? W[0].length : 0, digits = weightBits / 4, mask = 2 ** weightBits - 1;
  const per = 256 / weightBits, wordsW = Math.ceil(rows / per), wordsB = Math.ceil(rows / 16), out = [];
  const column = (value, n, lanes, width, m) => { for (let j = 0; j < lanes; j++) out.push(((j < n ? value(j) : 0) & m).toString(16).padStart(width, '0')); };
  for (let i = 0; i < cols; i++) column(j => W[j][i], rows, wordsW * per, digits, mask);
  column(j => b[j], rows, wordsB * 16, 4, 65535);
  return out.join('');
}

/** The weight blob (contracts DensePolicyEngine) as hex, regions in layer order: W | b of a plain layer, Wc | bc then
 *  Wd | bd of a tool layer, then W | b of the output layer when there is one. Weights use the weightBits of the model. */
export function encodeDenseWeights(model) {
  validateDenseModel(model);
  const w = model.weightBits;
  return '0x' + [...model.layers.map(layer => (isTool(layer) ? regionHex(layer.Wc, layer.bc, w) + regionHex(layer.Wd, layer.bd, w) : regionHex(layer.W, layer.b, w))),
    model.output ? regionHex(model.output.W, model.output.b, w) : ''].join('');
}
