// training/quantize.js — the per-layer quantiser of ADR 0015. Every trainer (dense-core.js, hinge.js) uses it.
// training/bundle_train.py quantize_region mirrors it exactly. The parity cases in training/fixtures/bundle-env.json
// `quantizations` hold both to the same numbers. One region = one affine map: a weight matrix and its biases.
//   scale s = Q / max|w| (Q = 127 for 8-bit weights, 32767 for 16-bit. Q when every weight is 0). The largest weight
//           maps to the largest code, so no weight is ever clipped.
//   codes   W = round(w·s) (round half up). Biases b = round(b·s·2^k) as int16 in the accumulator unit 1 / (s·2^k).
//   k       the largest of 0..MAX_SHIFT whose biases fit (and, for a LIF layer, whose threshold fits int32). The engine
//           shifts the weighted sum of each neuron left by k before it adds the bias.
//   LIF     threshold = round(s·2^k): 1.0 in real units, in that unit.
// `gain` = s·2^k is the value of one real unit in accumulator integers. It is the STE derivative of the trainers.

const MAX_SHIFT = 20;
const INT16_MIN = -32768, INT16_MAX = 32767, INT32_MAX = 2147483647;
/** Bias code range by role: a threshold layer exports th = 1 − b, which must fit int16 too. */
const BIAS_RANGE = Object.freeze({ ff: [INT16_MIN, INT16_MAX], lif: [INT16_MIN, INT16_MAX], threshold: [1 - INT16_MAX, INT16_MAX] });

/** The largest weight code of a width: 127 or 32767. */
const weightMax = bits => 2 ** (bits - 1) - 1;
/** Round half up — the one rounding both backends use. */
const code = x => Math.floor(x + 0.5);

/**
 * Quantise one region. `W`: Float64Array (row-major, rows = b.length) or number[][]. `b`: real biases. `bits`: 8 | 16.
 * `role`: 'ff' (any dense region but a LIF plain layer), 'lif' or 'threshold'. Returns `{ W: Int32Array codes
 * (row-major), b: Int32Array codes, scale, k, gain, threshold (lif, else null), clippedWeights, clippedBiases }`.
 */
export function quantizeRegion(W, b, bits, role) {
  const flat = Array.isArray(W) ? W.flat() : W, Q = weightMax(bits), [lo, hi] = BIAS_RANGE[role];
  let m = 0; for (let i = 0; i < flat.length; i++) m = Math.max(m, Math.abs(flat[i]));
  const s = m > 0 ? Q / m : Q;
  const qW = new Int32Array(flat.length); let clippedWeights = 0;
  for (let i = 0; i < flat.length; i++) { const c = code(flat[i] * s); if (c > Q || c < -Q) clippedWeights++; qW[i] = Math.max(-Q, Math.min(Q, c)); }
  const fits = k => {
    const g = s * 2 ** k;
    if (role === 'lif' && code(g) > INT32_MAX) return false;
    for (let j = 0; j < b.length; j++) { const c = code(b[j] * g); if (c < lo || c > hi) return false; }
    return true;
  };
  let k = MAX_SHIFT; while (k > 0 && !fits(k)) k--;
  const gain = s * 2 ** k, qb = new Int32Array(b.length); let clippedBiases = 0;
  for (let j = 0; j < b.length; j++) { const c = code(b[j] * gain); if (c < lo || c > hi) clippedBiases++; qb[j] = Math.max(lo, Math.min(hi, c)); }
  const threshold = role === 'lif' ? Math.max(1, Math.min(INT32_MAX, code(gain))) : null;
  return { W: qW, b: qb, scale: s, k, gain, threshold, clippedWeights, clippedBiases };
}
