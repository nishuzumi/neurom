// core/readout.js — turns a network's scores into an action, with the on-chain modules' exact semantics:
//   argmax  bit k = (k == first index of the maximum score), action = map[k] (null → -1, an explicit invalid action)
//   bits    bit k = (score[k] ≥ 0), action = lsb-int decode of the bits
// Spec: { mode:'argmax', map:[actionIndex|null…] } (O = map.length) | { mode:'bits', width:O, decode:'lsb-int' }.
import { MAX_BITS } from './types.js';
import { t } from '../i18n.js';

export const INVALID_ACTION = -1;
/** lsb-int decoding yields a JS number, so a bits readout is at most Number.MAX_SAFE_INTEGER wide. */
const MAX_DECODE_BITS = 53;
export function readoutWidth(spec) { return spec.mode === 'argmax' ? spec.map.length : spec.width; }

/** Why a readout spec is malformed. '' when fine. `actions` (count) lets map entries be range-checked. */
export function readoutProblem(spec, actions = null) {
  if (spec.mode === 'argmax') {
    if (!Array.isArray(spec.map) || spec.map.length < 1 || spec.map.length > MAX_BITS) return t('argmax 映射表需要 1..{max} 项', { max: MAX_BITS });
    for (const [k, a] of spec.map.entries()) {
      if (a !== null && !(Number.isInteger(a) && a >= 0)) return t('映射表第 {k} 项必须是动作下标或 null', { k });
      if (a !== null && actions !== null && a >= actions) return t('映射表第 {k} 项指向不存在的动作 {a}（共 {n} 个）', { k, a, n: actions });
    }
    return '';
  }
  if (spec.mode === 'bits') {
    if (!Number.isInteger(spec.width) || spec.width < 1 || spec.width > MAX_BITS) return t('位读出宽度需要 1..{max}', { max: MAX_BITS });
    if (spec.decode !== 'lsb-int') return t('未知位解码方式：{decode}', { decode: String(spec.decode) });
    if (spec.width > MAX_DECODE_BITS) return t('lsb-int 解码最多 {max} 位', { max: MAX_DECODE_BITS });
    return '';
  }
  return t('未知读出模式：{mode}', { mode: String(spec.mode) });
}

/** First index of the maximum (ties → lowest index), exactly like the on-chain argmax. */
function argmaxFirst(scores) {
  let best = 0;
  for (let k = 1; k < scores.length; k++) if (scores[k] > scores[best]) best = k;
  return best;
}

/** Bits the on-chain readout emits for `scores`. */
export function readoutBits(spec, scores) {
  const width = readoutWidth(spec);
  if (scores.length !== width) throw new Error(t('读出需要 {width} 个分数，得到 {n}', { width, n: scores.length }));
  const out = new Array(width);
  if (spec.mode === 'argmax') { const a = argmaxFirst(scores); for (let k = 0; k < width; k++) out[k] = k === a ? 1 : 0; }
  else for (let k = 0; k < width; k++) out[k] = scores[k] >= 0 ? 1 : 0;
  return out;
}

/** Decode already-computed bits into an action index. */
export function decodeBits(spec, bitsValue) {
  if (spec.mode === 'argmax') { const k = bitsValue.indexOf(1); const a = spec.map[k]; return a === null || a === undefined ? INVALID_ACTION : a; }
  let value = 0;
  for (let k = bitsValue.length - 1; k >= 0; k--) value = value * 2 + (bitsValue[k] ? 1 : 0);
  return value;
}

/** `{ action, bits, slot }` for `scores`. `slot` is the argmax index (or null in bits mode). */
export function readout(spec, scores) {
  const b = readoutBits(spec, scores);
  return { action: decodeBits(spec, b), bits: b, slot: spec.mode === 'argmax' ? b.indexOf(1) : null };
}
