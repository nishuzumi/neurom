// core/kinds/readout.js — the readout module: scores[O] → action (number) + bits[O] for downstream modules. The bundle's
// loop section carries its spec (core/loop.js). See core/readout.js for the runtime semantics. A bits
// readout also offers the function `run` (ADR 0010 §3): `(bits[I]) → bits[width]`, its network's forward pass then
// this readout — how a frozen network becomes a tool of a tool layer (core/kinds/network.js). Its call sites are
// typed here (`callee`): one bit vector at least I wide, the network fit to be a tool. A bundle carries the network
// (frozen on its accepted weights, core/loop.js) and this readout's spec.
import { registerKind } from '../registry.js';
import { valueIn, valueOut, fnOut } from './common.js';
import { NUMBER, vector, bits, typeName } from '../types.js';
import { readoutProblem, readoutWidth } from '../readout.js';
import { toolNetworkProblem } from './network.js';
import { t } from '../../i18n.js';

/** The spec the runtime consumes, from a node's config. */
export function readoutSpec(config) {
  return config.mode === 'argmax' ? { mode: 'argmax', map: [...config.map] } : { mode: 'bits', width: config.width, decode: config.decode };
}
/** The spec with its width: the readout record a bundle's loop section and tools carry. */
export const readoutEntry = config => { const spec = readoutSpec(config); return { ...spec, width: readoutWidth(spec) }; };
/** The network node feeding a readout's `scores`, or null. */
function networkOf(node, ctx) {
  const p = ctx.producers(node.id, 'scores')[0], net = p ? ctx.node(p.node) : null;
  return net?.kind === 'network' ? net : null;
}

registerKind({
  kind: 'readout',
  label: '读出',
  config: {
    defaults: { mode: 'argmax', map: [0, 1, 2, 3], width: 4, decode: 'lsb-int' },
    schema: {
      mode: { type: 'enum', values: ['argmax', 'bits'] },
      map: { type: 'list', of: { type: 'json' }, min: 1, max: 256 },
      width: { type: 'int', min: 1, max: 256 }, decode: { type: 'enum', values: ['lsb-int'] },
    },
  },
  ports(node) {
    const spec = readoutSpec(node.config), O = readoutWidth(spec);
    return {
      inputs: [valueIn('scores', vector(O), { required: true }), valueIn('actions', null)],
      outputs: [valueOut('action', NUMBER), valueOut('bits', bits(O)),
        ...(spec.mode === 'bits' ? [{ ...fnOut('run'), doc: t('函数 (bits[I]) → bits[width]：它的网络前向，再按位读出。它可以作为工具层的工具') }] : [])],
    };
  },
  infer(node) {
    const spec = readoutSpec(node.config);
    return { action: NUMBER, bits: bits(readoutWidth(spec)) };
  },
  /** `run` of a bits readout: reads the first I bits of its one bit-vector argument (I: its network's inputs). */
  callee(node, port, ctx) {
    if (port !== 'run' || node.config.mode !== 'bits') return null;
    const net = networkOf(node, ctx);
    return {
      width: net ? net.config.inputs : null,
      call(argTypes, { caller }) {
        const fail = message => ({ result: null, error: new Error(message), paramTypes: argTypes, carries: null });
        if (!net) return fail(t('{title} 的 run 需要它的 scores 接一个网络', { title: node.title }));
        const problem = toolNetworkProblem(net, caller, node.title, ctx);
        if (problem) return fail(problem);
        const [arg] = argTypes, I = net.config.inputs;
        if (argTypes.length !== 1 || arg?.type !== 'vector') return fail(t('{title} 的 run 只收一个位向量参数', { title: node.title }));
        if (arg.width < I) return fail(t('{title} 的 run 需要 {width} 位输入，调用方只给 {given} 位', { title: node.title, width: I, given: arg.width }));
        return { result: bits(node.config.width), error: null, paramTypes: [bits(I)], carries: { kind: 'net', network: net, readout: readoutEntry(node.config) } };
      },
    };
  },
  problems(node, ctx) {
    const out = [], spec = readoutSpec(node.config);
    const actions = ctx.inType(node.id, 'actions');
    if (actions && !(actions.type === 'array' && actions.of.type === 'string')) out.push({ port: 'actions', message: t('actions 需要字符串数组，得到 {type}', { type: typeName(actions) }) });
    const problem = readoutProblem(spec, actions?.type === 'array' ? actions.length : null);
    if (problem) out.push({ message: problem });
    return out;
  },
});
