// core/kinds/trainer.js — trains one network inside a loop (kinds/loop.js) with one of three methods. Every other
// network of the loop runs frozen with its accepted weights (ADR 0009 §2, whole-loop training):
//   reinforce      dense engine, reward objective fn(Transition)→number, argmax readout (bits when the last layer is a
//                  tool layer: its result bits are the action). The only method for a network with tool layers (ADR 0010 §6)
//   cross-entropy  dense engine, target objective fn(State[, table])→bits[O] (mask), argmax readout
//   hinge          threshold engine, target objective fn(State[, table])→bits[O] (exact bits), bits readout
// `structure` names the trained network (it must be in the loop body). Its readout is the one consuming its `scores`.
// Optional `metric: fn(Episode)→number` selects the best epoch on the validation partition (default: mean return for
// reward objectives, greedy-readout accuracy over labelled steps for target objectives).
// Its output is a `run` handle. The actual work happens on a bundle (core/bundle.js) in a worker or in Python.
import { registerKind } from '../registry.js';
import { valueIn, valueOut, callIn } from './common.js';
import { NUMBER, binaryVector, handle, ref, resolveSignature, unresolvedRefs } from '../types.js';
import { driverLoopIn, driverLoopProblems, loopOf, bodyIn } from './loop.js';
import { readoutOf, isToolLayer, outputsOf } from './network.js';
import { t } from '../../i18n.js';

/** What each training method requires of the graph and the objective kind it calls (training/train.js runs them),
 *  its display label, and the recipe fields it reads beyond COMMON_FIELDS. */
export const METHODS = Object.freeze({
  reinforce: Object.freeze({ label: '强化学习', engine: 'dense-policy', objective: 'reward', readout: 'argmax',
    fields: Object.freeze(['replicas', 'episodesPerEpoch', 'calibrationEpisodes', 'gamma', 'baselineDecay', 'entropy', 'surrogateWidth', 'gradClip', 'initCurrent']) }),
  'cross-entropy': Object.freeze({ label: '交叉熵', engine: 'dense-policy', objective: 'target', readout: 'argmax',
    fields: Object.freeze(['replicas', 'episodesPerEpoch', 'calibrationEpisodes', 'exploration', 'surrogateWidth', 'gradClip', 'initCurrent']) }),
  hinge: Object.freeze({ label: '铰链损失', engine: 'threshold-layers', objective: 'target', readout: 'bits', fields: Object.freeze(['margin', 'surrogateWidth', 'gradClip']) }),
});
/** The config fields every method reads. */
export const COMMON_FIELDS = Object.freeze(['method', 'backend', 'epochs', 'lr', 'seed', 'evalEvery']);
/** The readout mode `method` needs on a network with `layers`: a trailing tool layer's result bits are its output,
 *  read back by a bits readout (network.js checks that readout). */
export function requiredReadout(method, layers) {
  const need = METHODS[method].readout, last = layers?.[layers.length - 1];
  return need === 'argmax' && last && isToolLayer(last) ? 'bits' : need;
}
/** Why `method` cannot train a dense network with `layers`: only REINFORCE trains through tool layers. */
export function toolLayerProblem(method, layers) {
  return method !== 'reinforce' && Array.isArray(layers) && layers.some(isToolLayer) ? t('带工具层的网络只能用强化学习训练') : '';
}
export const METRIC_SIGNATURE = Object.freeze({ name: 'metric', params: [ref('Episode')], names: ['episode'], docs: ['一个回合的摘要'], result: NUMBER, exact: false, returns: '这个回合的指标值', stub: 'return episode.success ? 1 : 0;' });
export const REWARD_SIGNATURE = Object.freeze({ name: 'reward', params: [ref('Transition')], names: ['transition'], docs: ['这一步的转移'], result: NUMBER, exact: false, returns: '这一步的奖励', stub: 'return transition.success ? 1 : 0;' });
/** who calls the trainer's call ports, and when (raw texts, translated where shown) */
const WHEN = Object.freeze({ reward: '训练时每走一步调用一次。训练器按奖励更新网络', target: '训练时每一步调用一次。它给出网络这一步应输出的位', metric: '每轮训练后，在验证集的每个回合结束时调用。训练器选中平均值最高的一轮' });

/** Objective signature for `method`. `O` may be null while the readout is unknown (then the result stays a ref). */
function objectiveSignature(method, O, withTable) {
  if (METHODS[method].objective === 'reward') return REWARD_SIGNATURE;
  return { name: 'target', params: [ref('State'), ...(withTable ? [ref('Table')] : [])], names: ['state', ...(withTable ? ['table'] : [])], docs: ['当前状态', ...(withTable ? ['数据集（只读）'] : [])],
    result: O ? binaryVector(O) : ref('Target'), exact: false, returns: '网络这一步应输出的位', stub: `return bits(0, ${O ?? 1});` };
}

/** The network wired into a trainer's `structure`, or null. */
export function trainedOf(ctx, node) {
  const p = ctx.producers(node.id, 'structure')[0], net = p ? ctx.node(p.node) : null;
  return net?.kind === 'network' ? net : null;
}
/** Refs of a loop driver: the loop's (Start, State, Transition, Episode, I, Table), plus `extra`. */
export function driverRefs(node, ctx, extra = {}) {
  const L = loopOf(ctx, node);
  return { ...(L ? ctx.refs(L.id) : {}), ...extra };
}
/** Doc trees of a loop driver's refs (core/docs.js): the loop's. */
export function driverRefDoc(node, name, d) {
  const p = d.producers(node.id, 'loop')[0];
  return p ? d.ref(p.node, name) : null;
}
/** '' when the partition handle `T` is usable in `port`, else why not. */
export function partitionProblem(T, port) {
  return !T || (T.type === 'handle' && T.of === 'partition') ? '' : t('{role} 需要分区句柄', { role: port });
}
/** Problems of call port `port` against `base` (resolved with the driver's refs). Every wire is checked. */
export function callProblems(node, ctx, port, base) {
  if (!ctx.producers(node.id, port).length) return [];
  const sig = resolveSignature(base, ctx.refs(node.id)), missing = unresolvedRefs(sig);
  if (missing.length) return [{ port, incomplete: true, message: t('无法确定类型 {refs}，先修复上游调用', { refs: missing.join(', ') }) }];
  return ctx.callAll(node.id, port, sig.params).filter(use => use.error).map(use => ({ port, wire: use.wire, error: use.error }));
}

registerKind({
  kind: 'trainer',
  label: '训练器',
  config: {
    defaults: { method: 'reinforce', epochs: 300, lr: 0.01, replicas: 8, seed: 1, evalEvery: 10, backend: 'browser', entropy: 0, gamma: 1, margin: 1,
      exploration: 0.25, baselineDecay: 0.9, gradClip: 1, surrogateWidth: 1, initCurrent: 0.5, episodesPerEpoch: 32, calibrationEpisodes: 32 },
    schema: {
      method: { type: 'enum', values: Object.keys(METHODS) }, epochs: { type: 'int', min: 1, max: 100000 }, lr: { type: 'number', min: 0.000001, max: 1 },
      replicas: { type: 'int', min: 1, max: 64 }, seed: { type: 'int', min: 0, max: 0xffffffff }, evalEvery: { type: 'int', min: 1, max: 100000 },
      backend: { type: 'enum', values: ['browser', 'python'] },
      entropy: { type: 'number', min: 0, max: 10 }, gamma: { type: 'number', min: 0, max: 1 }, margin: { type: 'number', min: 0, max: 1e6 },
      exploration: { type: 'number', min: 0, max: 1 }, baselineDecay: { type: 'number', min: 0, max: 1 }, gradClip: { type: 'number', min: 0, max: 1e6 },
      surrogateWidth: { type: 'number', min: 0.000001, max: 1e6 }, initCurrent: { type: 'number', min: -1e6, max: 1e6 },
      episodesPerEpoch: { type: 'int', min: 1, max: 4096 }, calibrationEpisodes: { type: 'int', min: 1, max: 4096 },
    },
  },
  ports(node, ctx) {
    const refs = ctx.refs(node.id);
    return {
      inputs: [
        driverLoopIn(), valueIn('structure', handle('structure'), { required: true }),
        callIn('objective', objectiveSignature(node.config.method, refs.O ?? null, !!refs.Table), { required: true, when: WHEN[METHODS[node.config.method].objective] }), callIn('metric', METRIC_SIGNATURE, { when: WHEN.metric }),
        valueIn('training', null, { required: true }), valueIn('validation', null),
      ],
      outputs: [valueOut('run', handle('run'))],
    };
  },
  docs: { ref: driverRefDoc },
  infer(node, inTypes, ctx) {
    const net = trainedOf(ctx, node);
    ctx.setRefs(node.id, driverRefs(node, ctx, { O: net ? outputsOf(net, ctx) : null }));
    return { run: handle('run') };
  },
  problems(node, ctx) {
    const out = driverLoopProblems(node, ctx), c = node.config, need = METHODS[c.method], refs = ctx.refs(node.id);
    const net = trainedOf(ctx, node), L = loopOf(ctx, node);
    if (net) {
      if (net.config.engine !== need.engine) out.push({ port: 'structure', message: t('{method} 需要 {engine} 引擎', { method: c.method, engine: need.engine }) });
      if (L && !bodyIn(ctx, L.id).nodes.includes(net.id)) out.push({ port: 'structure', message: t('训练的网络 {title} 不在回路 {loop} 里', { title: net.title, loop: L.title }) });
      const r = readoutOf(net, ctx);
      const mode = requiredReadout(c.method, net.config.layers), tooled = toolLayerProblem(c.method, net.config.layers);
      if (tooled) out.push({ port: 'structure', message: tooled });
      else if (r && r.config.mode !== mode) out.push({ port: 'structure', message: t('{method} 需要 {mode} 读出', { method: c.method, mode }) });
    }
    for (const role of ['training', 'validation']) { const problem = partitionProblem(ctx.inType(node.id, role), role); if (problem) out.push({ port: role, message: problem }); }
    out.push(...callProblems(node, ctx, 'objective', objectiveSignature(c.method, refs.O ?? null, !!refs.Table)), ...callProblems(node, ctx, 'metric', METRIC_SIGNATURE));
    return out;
  },
});
