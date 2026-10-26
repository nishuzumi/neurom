// core/kinds/network.js — the integer network (dense FF/LIF or threshold layers). It owns structure only: I is the
// declared `inputs` width (bits wired into `in` must have exactly that width), O comes from the unique readout
// consuming `scores`. Its weights are the artifact its own `artifact` names (a network no trainer trains, ADR 0010 §8)
// or the accepted artifact of the candidates wired into `weights`. core/loop.js acceptedModel decides which. `weights`
// is declared `loop`: net.structure → trainer → candidates → net.weights is the normal cycle (an earlier run's accepted
// weights). `structure` is the handle a trainer trains and `scores` is what the deployed module computes on chain.
// A dense network's `layers` may hold tool layers `{ tools: <port>, data? }` (ADR 0010). Each declares the call input
// `<port>`, which takes any number of tools `(bits) → bits`: a code export, or a readout's `run` (bits or argmax, ADR
// 0019; a frozen network of any kind, its own tool layers included, ADR 0014). Per tool layer the kind publishes
// `{ K, D, R }` in its refs (`tools.<port>`). K is the tools in wire order. D is the data bits: `data` when declared,
// else the widest network tool's input. Code tools are typed at bits[D]. R is the result bits (the widest tool result).
// When the last entry is a tool layer its R result bits are the network's output: the readout must be a bits readout
// of width R. Tools nest at most MAX_TOOL_DEPTH deep (toolDepth), the Factory's limit.
import { registerKind } from '../registry.js';
import { valueIn, valueOut, callIn } from './common.js';
import { vector, bits, binaryVector, handle, MAX_BITS } from '../types.js';
import { readoutSpec } from './readout.js';
import { readoutWidth } from '../readout.js';
import { HASH_PATTERN } from '../canonical.js';
import { regionBytes, WEIGHT_BITS } from '../../runtime/dense-policy.js';
import { t } from '../../i18n.js';

export const ENGINES = Object.freeze(['dense-policy', 'threshold-layers']);
/** On-chain limits: ports (ModuleFactory), layer widths / count, ticks (DensePolicyEngine / ThresholdLayersEngine).
 *  Ports and layer widths share the one bit-width limit MAX_BITS (ADR 0021). */
export const MAX_PORT = MAX_BITS, MAX_WIDTH = MAX_BITS, MAX_LAYERS = 8, MAX_TICKS = 64;
/** ModuleFactory.MAX_TOOL_DEPTH: how deep tools may nest (toolDepth), so a step's gas stays bounded. */
export const MAX_TOOL_DEPTH = 3;
/** The most int32 a module keeps per session (DensePolicyEngine MAX_STATE): its own LIF potentials and its tools' states. */
export const MAX_STATE = 256;
const PORT_NAME = '^[A-Za-z_][A-Za-z0-9_]*$';
/** Input ports a tool layer cannot take the name of. */
const RESERVED_PORTS = new Set(['in', 'weights']);

/** Is a `layers` entry a tool layer (`{ tools: <port> }`)? */
export const isToolLayer = layer => layer !== null && typeof layer === 'object' && layer.tools !== undefined && layer.tools !== null;

/** The call signature of a tool layer's port with D data bits (ADR 0012 contract texts in raw Chinese, translated where
 *  shown). A tool reads the first bits it needs. Its result is zero-extended to the widest tool's. */
export function toolSignature(D) {
  return { params: [D ? bits(D) : binaryVector(1, MAX_BITS)], names: ['data'], docs: ['工具层这一步交给工具的数据位（工具只读它需要的前几位）'],
    result: binaryVector(1, MAX_BITS), returns: '工具的结果位。比最宽的工具的结果短时，在后面补 0', stub: 'return data;' };
}
const TOOL_WHEN = '网络每一步算到这个工具层时，只调用它选中的那个工具一次';

/** Structure the trainers and executors consume: `{ engine, kind, inputs, outputs, weightBits, layers, ticks, … }`.
 *  `layers` is `[{ hidden } | { tools, K, D, R }, …]` for a dense network (the output layer is implicit unless the last
 *  entry is a tool layer) and `[width, …]` for threshold layers. `tools` is the network's refs `tools`
 *  (`{ <port>: { K, D, R } }`). There is no scale: the trainer picks one per layer (ADR 0015). */
export function networkStructure(config, inputs, outputs, tools = {}) {
  const base = { engine: config.engine, kind: config.kind, inputs, outputs, weightBits: config.weightBits };
  if (config.engine === 'threshold-layers') return { ...base, layers: [...config.layers] };
  const layer = L => (isToolLayer(L) ? { tools: L.tools, K: tools?.[L.tools]?.K ?? null, D: tools?.[L.tools]?.D ?? null, R: tools?.[L.tools]?.R ?? null } : { hidden: L.hidden });
  return { ...base, layers: config.layers.map(layer), ticks: config.ticks, leak_shift: config.leak_shift, reset: config.reset };
}
/** The network config fields of a structure (networkStructure's inverse, for example to give a network an artifact's
 *  trained structure): without the widths the wires decide, and a tool layer as its port and its data width. */
export function structureConfig(structure) {
  const { inputs, outputs, ...config } = structure;
  if (config.engine === 'threshold-layers') return config;
  return { ...config, layers: config.layers.map(L => (isToolLayer(L) ? { tools: L.tools, data: L.D } : { hidden: L.hidden })) };
}

/** `32/16` — the hidden widths of a network's `layers` (dense `{ hidden }` or threshold widths) for display. A tool
 *  layer shows its port name. */
export const layersNotation = layers => (layers ?? []).map(L => (typeof L === 'number' ? L : L?.hidden ?? L?.tools)).join('/');

/** Weight bytes of a dense network (structure `layers`) on chain (DensePolicyEngine) at `weightBits`. A plain layer
 *  takes a region (`hidden` rows). A tool layer takes two (K choice rows and D data rows on the width before it,
 *  `R ‖ before` after it). Then the output layer takes one, unless the last entry is a tool layer (ADR 0010 §5). They
 *  span as many chunks as needed. */
export function denseWeightBytes(I, layers, O, weightBits) {
  let bytes = 0, width = I;
  for (const layer of layers) {
    if (isToolLayer(layer)) { bytes += regionBytes(layer.K, width, weightBits) + regionBytes(layer.D, width, weightBits); width += layer.R; }
    else { bytes += regionBytes(layer.hidden, width, weightBits); width = layer.hidden; }
  }
  return bytes + (isToolLayer(layers[layers.length - 1]) ? 0 : regionBytes(O, width, weightBits));
}

/** On-chain weight bytes (ThresholdLayersEngine) for width_0 (inputs) .. width_L (outputs) at `weightBits`. */
export function thresholdWeightBytes(widths, weightBits) {
  let total = 0;
  for (let l = 1; l < widths.length; l++) total += regionBytes(widths[l], widths[l - 1], weightBits);
  return total;
}

/** The Tool entries a network calls itself — a bundle network node or a network Tool entry (core/loop.js), both
 *  `{ structure, tools }` — in layer then wire order. */
export const ownTools = net => (net.structure.layers ?? []).filter(isToolLayer).flatMap(L => net.tools?.[L.tools] ?? []);
/** How deep a network calling Tool entries `tools` nests (ModuleFactory depthOf): 0 without tools, else 1 + its deepest
 *  network tool's (a code tool counts 0). */
export const toolEntriesDepth = tools => (tools.length ? 1 + Math.max(0, ...tools.filter(x => x.kind === 'net').map(x => toolEntriesDepth(ownTools(x)))) : 0);
/** The int32 a module of `spec` calling Tool entries `tools` keeps per session (its descriptor's stateWidth): its own LIF
 *  potentials, then each network tool's state, recursively. */
export function moduleStateWidth(spec, tools = []) {
  const own = spec.engine === 'dense-policy' && spec.kind === 'lif' ? spec.layers.reduce((s, L) => s + (isToolLayer(L) ? 0 : L.hidden), 0) : 0;
  return tools.reduce((s, x) => s + (x.kind === 'net' ? moduleStateWidth(x.structure, ownTools(x)) : 0), own);
}

/**
 * Why a derived spec (core/store.js artifactSpec, or networkStructure) cannot be deployed under the on-chain limits,
 * or null when the Factory would accept it. It mirrors ModuleFactory.deploy and the engines' checks. Ports: 1..65535.
 * Dense: 1..8 layers, plain hidden and tool K / D / R 1..65535, at most 256 int32 of state per session (its LIF potentials and
 * its tools' states), tools nested at most MAX_TOOL_DEPTH deep. Threshold: layers ≤ 8 including the output layer. The
 * weights have no size limit: they span as many chunks as they need. `spec.layers` are the hidden layers (dense
 * `{ hidden }` / `{ tools, K, D, R }` entries, threshold widths). `tools` = the trained network's Tool entries (core/
 * loop.js trainedTools): a code tool cannot be deployed. A network tool must be deployable itself with its own tools,
 * and read through a bits readout: on chain a tool layer reads its tool's scores as bits (score ≥ 0), not as argmax.
 */
export function deploymentProblem(spec, tools = []) {
  const port = (v, name) => Number.isInteger(v) && v >= 1 && v <= MAX_PORT ? null : t('链上模块 {name} 必须是 1..{max} 位，当前 {value}', { name, max: MAX_PORT, value: v });
  const width = v => Number.isInteger(v) && v >= 1 && v <= MAX_WIDTH;
  if (spec.engine === 'dense-policy') {
    const layers = Array.isArray(spec.layers) ? spec.layers : [];
    const p = port(spec.inputs, 'inputs') ?? port(spec.outputs, 'outputs');
    if (p) return p;
    if (layers.length < 1 || layers.length > MAX_LAYERS) return t('链上 DensePolicyEngine 的层数必须是 1..{max}，当前 {value}', { max: MAX_LAYERS, value: layers.length });
    for (const [l, L] of layers.entries()) {
      if (isToolLayer(L)) { if (![L.K, L.D, L.R].every(width)) return t('链上工具层 {index} 的 K / D / R 必须是 1..{max}', { index: l + 1, max: MAX_WIDTH }); }
      else if (!width(L?.hidden)) return t('链上 DensePolicyEngine 的 hidden 必须是 1..{max}，当前 {value}', { max: MAX_WIDTH, value: L?.hidden });
    }
    const depth = toolEntriesDepth(tools);
    if (depth > MAX_TOOL_DEPTH) return t('工具嵌套 {depth} 层，超过上限 {max} 层：链上 Factory 拒绝部署（限制一步的 gas）', { depth, max: MAX_TOOL_DEPTH });
    const state = moduleStateWidth(spec, tools);
    if (state > MAX_STATE) return t('链上模块每个会话的状态共 {value} 个 int32（自己的 LIF 电位加工具的状态），超过上限 {max}', { value: state, max: MAX_STATE });
    for (const [k, tool] of tools.entries()) {
      if (tool.kind !== 'net') return t('代码工具不能部署');
      if (tool.readout?.mode === 'argmax') return t('工具 {index}：argmax 读出的网络工具不能部署（链上工具层按位读出工具的分数）', { index: k + 1 });
      const own = deploymentProblem(tool.structure, ownTools(tool));
      if (own) return t('工具 {index}：{problem}', { index: k + 1, problem: own });
    }
    return null;
  }
  if (spec.engine === 'threshold-layers') {
    const hidden = Array.isArray(spec.layers) ? spec.layers : [];
    if (hidden.length + 1 > MAX_LAYERS) return t('链上 ThresholdLayersEngine 的层数必须是 1..{max}，当前 {value}', { max: MAX_LAYERS, value: hidden.length + 1 });
    const widths = [spec.inputs, ...hidden, spec.outputs];
    for (let l = 0; l < widths.length; l++) { const p = port(widths[l], l === 0 ? 'inputs' : l === widths.length - 1 ? 'outputs' : `layers[${l - 1}]`); if (p) return p; }
    return null;
  }
  return t('链上暂不支持引擎：{engine}', { engine: spec.engine });
}

/** Why the entries of a dense `layers` list are malformed: one message per bad entry (a plain layer is `{ hidden }`,
 *  a tool layer `{ tools, data? }`), then every tool port that repeats or takes a reserved name. */
function denseLayerProblems(layers) {
  const out = layers.flatMap((layer, i) => {
    const index = i + 1;
    if (layer === null || typeof layer !== 'object') return [t('第 {index} 层必须是带 hidden 宽度的普通层', { index })];
    if (isToolLayer(layer)) return Number.isInteger(layer.hidden) ? [t('第 {index} 层不能同时有 hidden 和 tools', { index })] : [];
    if (layer.data !== undefined && layer.data !== null) return [t('第 {index} 层：data 只属于工具层', { index })];
    if (!Number.isInteger(layer.hidden)) return [t('第 {index} 层必须是带 hidden 宽度的普通层', { index })];
    return [];
  });
  const seen = new Set();
  for (const layer of layers.filter(isToolLayer)) {
    if (RESERVED_PORTS.has(layer.tools)) out.push(t('工具层端口不能叫 {port}', { port: layer.tools }));
    else if (seen.has(layer.tools)) out.push(t('工具层端口 {port} 重复声明', { port: layer.tools }));
    seen.add(layer.tools);
  }
  return out;
}

/** The tool layers a config declares as ports: dense only, first occurrence of each valid, unreserved port. */
export function toolLayers(config) {
  if (config.engine !== 'dense-policy') return [];
  const seen = new Set();
  return config.layers.filter(L => {
    if (!isToolLayer(L) || typeof L.tools !== 'string' || RESERVED_PORTS.has(L.tools) || seen.has(L.tools)) return false;
    seen.add(L.tools); return true;
  });
}

/** D of a tool layer: its `data` when declared, else the widest input a tool wired into it reads (a network tool's
 *  input width — code tools are typed by their arguments), or null when neither exists. */
function dataWidth(node, layer, ctx) {
  if (Number.isInteger(layer.data)) return layer.data;
  const widths = ctx.callWidths(node.id, layer.tools);
  return widths.length ? Math.max(...widths) : null;
}
/** Why network `net` cannot be called as a tool by network `caller` (a readout's `run`, kinds/readout.js). `title`
 *  names the tool. A tool is a frozen network of any kind: not in training, not its caller. '' when it can. */
export function toolNetworkProblem(net, caller, title, ctx) {
  if (net.id === caller) return t('网络不能把自己当工具');
  if (ctx.consumers(net.id, 'structure').some(x => ctx.node(x.node).kind === 'trainer')) return t('训练器在训练工具 {title} 的网络，所以它不能当工具', { title });
  return '';
}
/** How deep network `node`'s tools nest on the canvas (ModuleFactory depthOf): 0 without tool layers, else 1 + its
 *  deepest network tool's. A network tool is the network behind a readout whose `run` is wired into a tool port. A
 *  code tool counts 0. It stops counting past MAX_TOOL_DEPTH + 1 (enough to report it). */
function toolDepth(node, ctx, level = 0) {
  const layers = toolLayers(node.config);
  if (!layers.length || level > MAX_TOOL_DEPTH) return layers.length ? 1 : 0;
  let deepest = 0;
  for (const L of layers) for (const p of ctx.producers(node.id, L.tools)) {
    const src = ctx.node(p.node), net = src.kind === 'readout' ? ctx.producers(src.id, 'scores')[0] : null;
    if (net && ctx.node(net.node).kind === 'network') deepest = Math.max(deepest, toolDepth(ctx.node(net.node), ctx, level + 1));
  }
  return 1 + deepest;
}
/** `{ K, D, R, calls }` of a tool layer: every wired tool called with bits[D], with R null while a result is untyped. */
function toolWidths(node, layer, ctx) {
  const K = ctx.producers(node.id, layer.tools).length, D = dataWidth(node, layer, ctx);
  if (!K || !D) return { K, D, R: null, calls: [] };
  const calls = ctx.callAll(node.id, layer.tools, [bits(D)]);
  const R = calls.every(c => !c.error && c.result?.type === 'vector') ? Math.max(...calls.map(c => c.result.width)) : null;
  return { K, D, R, calls };
}

/** The readout consuming `scores`, or null when there is none or more than one. */
export function readoutOf(node, ctx) {
  const readouts = ctx.consumers(node.id, 'scores').map(c => ctx.node(c.node)).filter(n => n.kind === 'readout');
  return readouts.length === 1 ? readouts[0] : null;
}

registerKind({
  kind: 'network',
  label: '网络',
  config: {
    defaults: { engine: 'dense-policy', kind: 'lif', inputs: 8, weightBits: 8, layers: [{ hidden: 32 }], ticks: 2, leak_shift: 2, reset: 0, artifact: null },
    schema: {
      engine: { type: 'enum', values: ENGINES }, kind: { type: 'enum', values: ['feedforward', 'lif'] }, inputs: { type: 'int', min: 1, max: MAX_BITS },
      weightBits: { type: 'enum', values: WEIGHT_BITS },
      layers: { type: 'list', min: 1, max: 8, of: { type: 'oneOf', of: [
        { type: 'int', min: 1, max: MAX_WIDTH },
        { type: 'object', fields: {
          hidden: { type: 'int', min: 1, max: MAX_WIDTH, optional: true }, tools: { type: 'string', pattern: PORT_NAME, max: 32, optional: true },
          data: { type: 'int', min: 1, max: MAX_BITS, optional: true },
        } },
      ] } },
      ticks: { type: 'int', min: 1, max: 64 }, leak_shift: { type: 'int', min: 0, max: 10 }, reset: { type: 'int', min: -32768, max: 32767 },
      artifact: { type: 'string', pattern: HASH_PATTERN, optional: true },
    },
  },
  ports(node, ctx) {
    const O = outputsOf(node, ctx);
    return {
      inputs: [
        valueIn('in', binaryVector(1, MAX_BITS)), valueIn('weights', handle('weights'), { loop: true }),
        ...toolLayers(node.config).map(L => callIn(L.tools, toolSignature(dataWidth(node, L, ctx)), { required: true, many: true, when: TOOL_WHEN })),
      ],
      outputs: [valueOut('scores', O ? vector(O) : null), valueOut('structure', handle('structure'))],
    };
  },
  infer(node, inTypes, ctx) {
    const O = outputsOf(node, ctx), layers = toolLayers(node.config);
    const tools = Object.fromEntries(layers.map(L => { const { K, D, R } = toolWidths(node, L, ctx); return [L.tools, { K, D, R }]; }));
    ctx.setRefs(node.id, { I: node.config.inputs, O, ...(layers.length ? { tools } : {}) });
    return { scores: O ? vector(O) : null, structure: handle('structure') };
  },
  problems(node, ctx) {
    const out = [], c = node.config;
    const readouts = ctx.consumers(node.id, 'scores').filter(x => ctx.node(x.node).kind === 'readout');
    if (readouts.length > 1) out.push({ port: 'scores', message: t('scores 只能接一个读出模块（O 由它决定）') });
    if (readouts.length === 0) out.push({ port: 'scores', incomplete: true, message: t('scores 需要接一个读出模块以确定 O') });
    if (c.engine === 'threshold-layers' && c.kind !== 'feedforward') out.push({ message: t('threshold-layers 引擎仅支持 FF') });
    if (c.engine === 'threshold-layers' && c.layers.some(isToolLayer)) out.push({ message: t('threshold-layers 不支持工具层（它只用监督训练，只能当工具）') });
    else if (c.engine === 'threshold-layers' && !c.layers.every(Number.isInteger)) out.push({ message: t('threshold-layers 的每一层是一个宽度（整数）') });
    if (c.engine === 'dense-policy') for (const message of denseLayerProblems(c.layers)) out.push({ message });
    if (c.kind === 'feedforward' && c.engine === 'dense-policy' && (c.ticks !== 1 || c.leak_shift !== 0 || c.reset !== 0)) out.push({ message: t('FF 不使用 LIF 的时间步或状态参数') });
    const In = ctx.producers(node.id, 'in').length ? ctx.inType(node.id, 'in') : null;
    if (In?.type === 'vector' && In.width !== c.inputs) out.push({ port: 'in', message: t('接入 {width} 位，网络声明输入 {inputs} 位', { width: In.width, inputs: c.inputs }) });
    if (c.artifact && ctx.producers(node.id, 'weights').length) out.push({ port: 'weights', message: t('网络已选定产物，所以不能再接 weights：二选一') });
    if (c.artifact && ctx.consumers(node.id, 'structure').some(x => ctx.node(x.node).kind === 'trainer')) out.push({ port: 'structure', message: t('网络已选定产物，所以训练器不能训练它：训练器训练的网络从候选取权重') });
    const { I, O, tools = {} } = ctx.refs(node.id);
    for (const L of toolLayers(c)) out.push(...toolProblems(node, L, ctx));
    const depth = toolDepth(node, ctx);
    if (depth > MAX_TOOL_DEPTH) out.push({ message: t('工具嵌套 {depth} 层，超过上限 {max} 层：链上 Factory 拒绝部署（限制一步的 gas）', { depth, max: MAX_TOOL_DEPTH }) });
    const last = c.layers[c.layers.length - 1];
    if (c.engine === 'dense-policy' && isToolLayer(last) && readouts.length === 1) {
      const r = ctx.node(readouts[0].node), R = tools[last.tools]?.R ?? null;
      if (r.config.mode !== 'bits') out.push({ port: 'scores', message: t('最后一层是工具层：它的结果位就是输出，读出必须是位读出') });
      // wider than R: a wider tool still to be wired can make it fit, so wiring the tools in any order is allowed
      else if (R !== null && O !== R) out.push({ port: 'scores', incomplete: O > R, message: t('最后一层是工具层：读出宽度 {O} 必须等于工具结果的 {R} 位', { O, R }) });
    }
    return out;
  },
});

/** Problems of one tool layer: D undetermined, and per wire a tool that cannot be called with bits[D]. */
function toolProblems(node, layer, ctx) {
  const out = [], port = layer.tools, { K, D, calls } = toolWidths(node, layer, ctx);
  if (K && !D) out.push({ port, incomplete: true, message: t('工具层 {port} 的数据宽度未定：设置 data，或接一个网络工具', { port }) });
  for (const call of calls) if (call.error && !call.error.incomplete) out.push({ port, wire: call.wire.id, error: call.error });
  return out;
}

/** O of a network: the width of the readout consuming its `scores`, or null. */
export function outputsOf(node, ctx) {
  const r = readoutOf(node, ctx);
  return r ? readoutWidth(readoutSpec(r.config)) : null;
}
