// core/sessions/executor.js — the greedy integer executor every loop network runs its model on: dense
// models through runtime/dense-policy.js, threshold models through runtime/threshold-layers.js. One executor owns the
// state of one network: its LIF membrane potentials, then the states of its network tools (core/loop.js toolCaller,
// ADR 0014). This is the module contract's state of one session. reset() returns it to the rest state.
import { DENSE_FORMAT, validateDenseModel, integerStep, denseStateWidth, isTool } from '../../runtime/dense-policy.js';
import { THRESHOLD_FORMAT, validateThresholdModel, layersStep } from '../../runtime/threshold-layers.js';
import { t } from '../../i18n.js';

/** Why a model cannot run (format, shapes). '' when it is executable. `structure` (a loop network's) pins the widths. */
export function modelProblem(model, structure = null) {
  if (!model || typeof model !== 'object') return t('模型必须是对象');
  if (model.format === DENSE_FORMAT) {
    try { validateDenseModel(model); } catch (e) { return e.message; }
    const shape = layers => JSON.stringify(Array.isArray(layers) ? layers.map(L => (L && isTool(L) ? [L.tools, L.K, L.D, L.R] : L?.hidden ?? null)) : null);
    if (structure && (structure.engine !== 'dense-policy' || structure.inputs !== model.inputs || structure.outputs !== model.outputs || shape(structure.layers) !== shape(model.layers) || structure.kind !== model.kind)) return t('稠密模型宽度与训练快照的网络结构不符');
    if (structure && structure.weightBits !== model.weightBits) return t('模型权重是 {a} 位，但是网络声明 {b} 位', { a: model.weightBits, b: String(structure.weightBits) });
    return '';
  }
  if (model.format === THRESHOLD_FORMAT) {
    try { validateThresholdModel(model); } catch (e) { return e.message; }
    if (structure && (structure.engine !== 'threshold-layers' || structure.inputs !== model.inputs || structure.outputs !== model.outputs || JSON.stringify([...structure.layers, structure.outputs]) !== JSON.stringify(model.layers.map(L => L.W.length)))) return t('阈值层模型层宽与训练快照的网络结构不符');
    if (structure && structure.weightBits !== model.weightBits) return t('模型权重是 {a} 位，但是网络声明 {b} 位', { a: model.weightBits, b: String(structure.weightBits) });
    return '';
  }
  return t('未知模型格式');
}

/** Length of a model's own state: its LIF potentials (every plain dense layer's). None for FF and threshold models. */
const ownStateWidth = model => (model.format === DENSE_FORMAT && model.kind === 'lif' ? denseStateWidth(model) : 0);
/** Length of the state of `model` with tools `tools` (core/loop.js toolCaller, or null): its own potentials followed by
 *  its tools' states — the module contract's stateWidth. */
export const stateWidthOf = (model, tools = null) => ownStateWidth(model) + (tools?.width ?? 0);

/** One decision of a validated `model` on binary `bits` from `state[at .. at + stateWidthOf(model, tools))`. The
 *  decision updates that state in place: its own potentials first, then each tool's slice
 *  (`tools.call(port, choice, data, state, at)` runs the chosen tool on its own slice). → `{ scores, counts, tools }`
 *  (the tool layer records, or null without tool layers). Validation-free: this is the hot path of nested tools.
 *  createExecutor checks its input. */
export function stepFrom(model, tools, bits, state, at = 0) {
  if (model.format !== DENSE_FORMAT) { const r = layersStep(model, bits); return { scores: r.scores, counts: r.acts.slice(0, -1).flat(), tools: null }; }
  const own = ownStateWidth(model), v = own ? state.slice(at, at + own) : [];
  const r = integerStep(model, bits, v, tools ? (port, choice, data) => tools.call(port, choice, data, state, at + own) : null);
  for (let j = 0; j < own; j++) state[at + j] = v[j];
  return { scores: r.scores, counts: r.count, tools: r.tools };
}

/**
 * One model, one session's state. `step(bits)` → the decision `{ scores, counts, voltages, tools }` that the module
 * contract reports for the same model:
 *   - counts: the spikes of every plain dense layer / the activations of every hidden threshold layer, one layer after
 *     another.
 *   - voltages: the whole state after the step (LIF potentials of every plain layer, then each network tool's state),
 *     [] when there is none.
 *   - tools: a dense model's `{ choice, data, result }` per tool layer port, null without tool layers.
 * `peek(bits)` is the decision the next step would make, and the state stays where it is (the contract's peek). `tools`
 * (core/loop.js toolCaller) runs a tool layer's chosen tool on its slice of the state. A step that throws leaves the
 * state as it was (the contract reverts).
 */
export function createExecutor(model, structure = null, { tools = null } = {}) {
  const problem = modelProblem(model, structure);
  if (problem) throw new Error(problem);
  const state = new Array(stateWidthOf(model, tools)).fill(0);
  const check = bits => {
    if ((!Array.isArray(bits) && !ArrayBuffer.isView(bits)) || bits.length !== model.inputs) throw new Error(t('输入位必须包含 {inputs} 个 0/1', { inputs: model.inputs }));
    for (const b of bits) if (b !== 0 && b !== 1) throw new Error(t('输入位必须包含 {inputs} 个 0/1', { inputs: model.inputs }));
  };
  const decide = (bits, s) => {
    check(bits);
    const r = stepFrom(model, tools, bits, s);
    return { scores: r.scores, counts: r.counts, voltages: s.slice(), tools: r.tools };
  };
  return {
    model, inputs: model.inputs, outputs: model.outputs, stateful: state.length > 0,
    reset() { state.fill(0); },
    voltages() { return state.slice(); },
    step(bits) { const next = state.slice(), r = decide(bits, next); for (let j = 0; j < next.length; j++) state[j] = next[j]; return r; },
    peek(bits) { return decide(bits, state.slice()); },
  };
}
