// runtime/threshold-layers.js — the threshold-layers integer engine (`threshold-layers` models, engine
// `threshold-layers`). It does the exact arithmetic that ThresholdLayersEngine.sol does: per layer
// act = (Σ W·x)·2^k − th ≥ 0. The values of the last layer are the scores.
// Model: `{ format, inputs, outputs, weightBits, layers: [{ W, th, scale, k }] }` (ADR 0015). W are weightBits-wide
// codes. th is int16 in the accumulator unit of the layer. `scale` (codes per real unit) is only for information.
// Stateless. Sessions, trainers and export share it. Scenario-free.
import { regionHex, checkModelKeys, checkUnit } from './dense-policy.js';
import { t } from '../i18n.js';

export const THRESHOLD_FORMAT = 'threshold-layers';
const THRESHOLD_KEYS = Object.freeze(['format', 'inputs', 'outputs', 'weightBits', 'layers']);

const integerIn = (value, lo, hi) => Number.isInteger(value) && value >= lo && value <= hi;

/** Throws unless `model` is a well-formed threshold model (format, known keys, layer shapes chain from inputs to
 *  outputs, codes within weightBits, th int16, the scale and k of each layer). Returns it. */
export function validateThresholdModel(model) {
  if (!model || model.format !== THRESHOLD_FORMAT) throw new Error(t('需要 {format} 模型', { format: THRESHOLD_FORMAT }));
  checkModelKeys(model, THRESHOLD_KEYS);
  if (!Array.isArray(model.layers) || !model.layers.length) throw new Error(t('阈值层模型缺少 layers'));
  const wMax = 2 ** (model.weightBits - 1);
  let width = model.inputs;
  if (!Number.isInteger(width) || width < 1) throw new Error(t('阈值层模型缺少 inputs'));
  for (const [l, L] of model.layers.entries()) {
    if (!Array.isArray(L.W) || !Array.isArray(L.th) || L.W.length !== L.th.length || !L.W.length) throw new Error(t('阈值层模型第 {l} 层的 W / th 形状不符', { l }));
    if (L.W.some(row => !Array.isArray(row) || row.length !== width)) throw new Error(t('阈值层模型第 {l} 层的输入宽度应为 {width}', { l, width }));
    if (L.W.some(row => row.some(w => !integerIn(w, -wMax, wMax - 1)))) throw new Error(t('{name} 必须是 {min}..{max} 的整数', { name: `layers[${l}].W`, min: -wMax, max: wMax - 1 }));
    if (L.th.some(th => !integerIn(th, -32768, 32767))) throw new Error(t('{name} 必须是 int16', { name: `layers[${l}].th` }));
    checkUnit(L.scale, L.k, `layers[${l}]`);
    width = L.W.length;
  }
  if (width !== model.outputs) throw new Error(t('阈值层模型最后一层宽度 {width} 与 outputs {outputs} 不符', { width, outputs: model.outputs }));
  return model;
}

/** The threshold-layers blob (contracts ThresholdLayersEngine) as hex: one column-major region per layer, W in the
 *  weightBits of the model, with th as its int16 bias column. */
export function encodeThresholdWeights(model) {
  validateThresholdModel(model);
  return '0x' + model.layers.map(layer => regionHex(layer.W, layer.th, model.weightBits)).join('');
}

/** Every layer's activations plus the last layer's scores for binary `bits`. Validation-free like integerStep. */
export function layersStep(model, bits) {
  const acts = []; let h = bits, scores = null;
  for (const L of model.layers) {
    const z = new Array(L.W.length), shift = 2 ** L.k;
    for (let j = 0; j < L.W.length; j++) { const row = L.W[j]; let s = 0; for (let i = 0; i < row.length; i++) if (h[i]) s += row[i]; z[j] = s * shift - L.th[j]; }
    h = z.map(v => (v >= 0 ? 1 : 0)); acts.push(h); scores = z;
  }
  return { scores, acts };
}
