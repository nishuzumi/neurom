// core/kinds/loop.js — the loop (回路): an episode runner's per-step boundary (ADR 0009 §2). `scenario` takes the
// scenario module (kinds/scenario.js). `input` carries the bits its `input` returns. `action` takes the step's action
// back (declared `loop`: it takes effect on the next step). `loop` is the handle drivers (trainer, evaluator,
// execution) run it through. The loop has no partition: its `Start` is the episode kind of every partition its drivers
// run it on, and they must agree.
// The body is every module on a value path from `input` to `action`, derived from the wires (wires into `loop` ports —
// the next step's action, a network's weights — are not paths). Body modules are per-step: network, readout, bits.
// Static values wired into them from outside are fine. A group marked as the loop's box (group `loop` field) is only
// its view: the loop reports members that differ from its body.
// A loop whose body has networks with tool layers extends its Transition with `loop: { <network title>: { <tool port>:
// { choice, data, result } } }` (ADR 0010 §10): what each tool layer decided and got this step. The network titles of
// such a body must be unique. A duplicate is a problem on the loop.
// `config.roles` maps a function role (init / input / step) to another export of the scenario (ADR 0022), so one
// scenario file serves several loops in different modes. The bundle keys the programs by role, so the runner does not
// see the mapping.
import { registerKind } from '../registry.js';
import { valueIn, valueOut, moduleIn } from './common.js';
import { NUMBER, bits, handle, record } from '../types.js';
import { analyseScenario, scenarioProblems, scenarioRefDoc, roleExports, SCENARIO_CALLS } from './scenario.js';
import { INPUT_NAME } from './code.js';
import { toolLayers } from './network.js';
import { joinList, t } from '../../i18n.js';

/** Kinds a loop body may hold. */
const BODY_KINDS = Object.freeze(['network', 'readout', 'bits']);

const isLoopPort = (view, nodeId, port) => view.portsOf(nodeId).inputs.some(p => p.id === port && p.loop);
const valueInputs = (view, nodeId) => view.portsOf(nodeId).inputs.filter(p => p.wire === 'value' && !p.loop);

/**
 * The body of loop `loopId` in `view` (`{ node, producers, consumers, portsOf }`: a resolve ctx, or loopBody's graph
 * adapter) → `{ nodes, closed }`: body node ids in evaluation order (producers first) and whether `action` is fed
 * from a path that starts at `input`.
 */
export function bodyIn(view, loopId) {
  const forward = new Set(), stack = [];
  const reach = (nodeId, port) => { for (const c of view.consumers(nodeId, port)) if (c.wire.kind === 'value' && !isLoopPort(view, c.node, c.port) && !forward.has(c.node)) { forward.add(c.node); stack.push(c.node); } };
  reach(loopId, 'input');
  while (stack.length) { const id = stack.pop(); if (id === loopId) continue; for (const p of view.portsOf(id).outputs) if (p.wire === 'value') reach(id, p.id); }
  const action = view.producers(loopId, 'action')[0];
  const nodes = [], done = new Set();
  const visit = id => {
    if (done.has(id) || id === loopId || !forward.has(id)) return;
    done.add(id);
    for (const p of valueInputs(view, id)) for (const x of view.producers(id, p.id)) visit(x.node);
    nodes.push(id);
  };
  if (action) visit(action.node);
  return { nodes, closed: !!action && done.has(action.node) };
}

/** A read-only view of a ModuleGraph and its resolution `res` (`{ node, producers, consumers, portsOf, inType }`): what
 *  bodyIn, driversStart and loopAnalysis read outside a resolve ctx. */
export const graphView = (graph, res = graph.resolved()) => ({ node: id => graph.node(id), producers: (n, p) => graph.producers(n, p), consumers: (n, p) => graph.consumers(n, p), portsOf: id => res.portsOf(id), inType: (n, p) => res.inTypeOf(n, p) });
/** The body of loop `loopId` in a ModuleGraph: `{ nodes, closed }` (bodyIn). */
export const loopBody = (graph, loopId) => bodyIn(graphView(graph), loopId);
/** Consumers of a loop's `loop` handle: `[{ node, port }]`. */
export const loopDrivers = (graph, loopId) => graph.consumers(loopId, 'loop').map(c => ({ node: c.node, port: c.port }));
/** A driver's `loop` input (trainer, evaluator, execution): the loop it runs, whole, episode by episode. */
export const driverLoopIn = () => ({ ...valueIn('loop', handle('loop'), { required: true }), doc: t('运行的回路：按回合逐步运行') });

/** The loop node wired into `node.loop` (a driver), or null. */
export function loopOf(view, node) {
  const p = view.producers(node.id, 'loop')[0], L = p ? view.node(p.node) : null;
  return L?.kind === 'loop' ? L : null;
}
/** A driver's problem on `loop`: what is wired in is not a loop's handle. */
export const driverLoopProblems = (node, ctx) => (ctx.producers(node.id, 'loop').length && !loopOf(ctx, node) ? [{ port: 'loop', message: t('loop 需要回路模块的 loop 句柄') }] : []);

/** The networks of loop body `nodes` (ids, in body order) as `view.node` gives them → `{ tools, duplicates }`: the
 *  networks with tool layers, and — when there is any — every network title that appears more than once. */
export function loopNetworks(view, nodes) {
  const nets = nodes.map(id => view.node(id)).filter(n => n.kind === 'network');
  const tools = nets.filter(n => toolLayers(n.config).length > 0);
  if (!tools.length) return { tools, duplicates: [] };
  const count = new Map();
  for (const n of nets) count.set(n.title, (count.get(n.title) ?? 0) + 1);
  return { tools, duplicates: [...count].filter(([, k]) => k > 1).map(([title]) => title) };
}
/** The Transition's `loop` field type: `networks` = `[{ title, tools: { <port>: { D, R } } }]` → a record of each
 *  network's tool layers, each `{ choice: number, data: bits[D], result: bits[R] }`. */
function loopValuesType(networks) {
  const layer = ({ D, R }) => record({ choice: NUMBER, data: bits(D), result: bits(R) });
  return record(Object.fromEntries(networks.map(n => [n.title, record(Object.fromEntries(Object.entries(n.tools).map(([port, w]) => [port, layer(w)])))])));
}
/** `Transition` with the `loop` field of `networks` (loopValuesType), unchanged when there are none. */
export const withLoopValues = (Transition, networks) => (networks.length ? record({ ...Transition.fields, loop: loopValuesType(networks) }) : Transition);

/** The loop's Transition ref in a resolve ctx: the scenario's, with the tool layers of its body networks. It is null
 *  while a tool layer's widths are unknown or network titles repeat (a problem on the loop). */
function loopTransition(ctx, loopId, Transition) {
  const { tools, duplicates } = loopNetworks(ctx, bodyIn(ctx, loopId).nodes);
  if (!Transition || !tools.length) return Transition;
  if (duplicates.length) return null;
  const networks = [];
  for (const n of tools) {
    const refs = ctx.refs(n.id).tools ?? {}, layers = {};
    for (const { tools: port } of toolLayers(n.config)) {
      const { D = null, R = null } = refs[port] ?? {};
      if (!Number.isInteger(D) || !Number.isInteger(R)) return null;
      layers[port] = { D, R };
    }
    networks.push({ title: n.title, tools: layers });
  }
  return withLoopValues(Transition, networks);
}

/** Doc of the Transition's `loop` field on loop `node` (docs context `d`), or null without tool layers. */
function loopValuesDoc(node, d) {
  const { tools } = loopNetworks(d, bodyIn(d, node.id).nodes);
  if (!tools.length) return null;
  const text = zh => ({ text: t(zh) });
  const layer = port => ({ text: t('工具层 {port} 这一步的决定和结果', { port }), fields: {
    choice: text('选中的工具：按连线顺序的编号，从 0 开始'),
    data: text('交给工具的数据位'),
    result: text('工具返回的结果位（比最宽的工具短时在后面补 0）'),
  } });
  return { text: t('回路里带工具层的网络这一步的工具层记录，按网络标题'), fields: Object.fromEntries(tools.map(n => [n.title, {
    text: t('网络 {title} 的工具层', { title: n.title }),
    fields: Object.fromEntries(toolLayers(n.config).map(L => [L.tools, layer(L.tools)])),
  }])) };
}

/**
 * What the loop's drivers run it on: every partition handle wired into a driver's value inputs →
 * `{ tag, Table, tableNode, conflict }` (`tag` the common episode kind or null, `Table` the type of the dataset wired
 * into those partitions or null, `tableNode` that dataset's node id or null, `conflict` a message when they disagree).
 */
export function driversStart(ctx, loopId) {
  const seen = [];
  for (const d of ctx.consumers(loopId, 'loop')) for (const p of valueInputs(ctx, d.node)) {
    const w = ctx.producers(d.node, p.id)[0], T = w ? ctx.inType(d.node, p.id) : null;
    if (!(T?.type === 'handle' && T.of === 'partition')) continue;
    const table = ctx.producers(w.node, 'table')[0] ?? null;
    seen.push({ tag: T.episode, table: table ? `${table.node}.${table.port}` : null, tableNode: table?.node ?? null, Table: table ? ctx.inType(w.node, 'table') : null });
  }
  if (!seen.length) return { tag: null, Table: null, tableNode: null, conflict: '' };
  const key = s => JSON.stringify(s.tag);
  if (seen.some(s => key(s) !== key(seen[0]))) return { tag: null, Table: null, tableNode: null, conflict: t('驱动回路的分区回合种类不一致：{kinds}', { kinds: joinList([...new Set(seen.map(s => s.tag.kind))]) }) };
  if (seen.some(s => s.table !== seen[0].table)) return { tag: null, Table: null, tableNode: null, conflict: t('驱动回路的分区接了不同的数据表') };
  return { tag: seen[0].tag, Table: seen[0].Table, tableNode: seen[0].tableNode, conflict: '' };
}

/** The scenario of loop `node`, typed by its drivers' partitions and read through the loop's role exports. */
export function loopAnalysis(node, ctx) {
  const p = ctx.producers(node.id, 'scenario')[0], scene = p ? ctx.node(p.node) : null;
  return analyseScenario(scene, name => ctx.inType(scene.id, name), { ...driversStart(ctx, node.id), exports: roleExports(node) });
}

/** The first partition node a driver of loop `node` runs it on, in a docs context (Start's doc). */
function driverPartition(node, d) {
  for (const c of d.consumers(node.id, 'loop')) for (const p of d.portsOf(c.node).inputs) {
    const w = d.producers(c.node, p.id)[0], part = w ? d.node(w.node) : null;
    if (part?.kind === 'partition') return part;
  }
  return null;
}

registerKind({
  kind: 'loop',
  label: '回路',
  config: {
    defaults: {},
    schema: { roles: { type: 'object', optional: true, label: '角色对应的导出', fields: Object.fromEntries(SCENARIO_CALLS.map(role => [role, { type: 'string', pattern: INPUT_NAME.source, max: 64, optional: true }])) } },
  },
  ports(node, ctx) {
    const I = ctx.refs(node.id).I ?? null;
    return {
      inputs: [moduleIn('scenario'), valueIn('action', NUMBER, { required: true, loop: true })],
      outputs: [
        { ...valueOut('input', I ? bits(I) : null), doc: t('输入位：场景 input(state) 的返回值，每步一次') },
        { ...valueOut('loop', handle('loop')), doc: t('回路句柄：接到驱动者的 loop 输入') },
      ],
    };
  },
  docs: {
    ref(node, name, d) {
      const doc = scenarioRefDoc(node, name, d, driverPartition(node, d)), loop = name === 'Transition' && doc ? loopValuesDoc(node, d) : null;
      return loop ? { ...doc, fields: { ...doc.fields, loop } } : doc;
    },
  },
  infer(node, inTypes, ctx) {
    const { refs } = loopAnalysis(node, ctx);
    ctx.setRefs(node.id, { ...refs, Transition: loopTransition(ctx, node.id, refs.Transition) });
    return { input: refs.I ? bits(refs.I) : null, loop: handle('loop') };
  },
  problems(node, ctx) {
    const out = [...scenarioProblems(ctx, loopAnalysis(node, ctx))];
    const { conflict } = driversStart(ctx, node.id);
    if (conflict) out.push({ port: 'loop', message: conflict });
    const body = bodyIn(ctx, node.id), title = id => ctx.node(id).title;
    if (ctx.producers(node.id, 'action').length && !body.closed) out.push({ port: 'action', incomplete: true, message: t('回路未闭合：action 不在从 input 出发的值路径上') });
    for (const id of body.nodes) { const n = ctx.node(id); if (!BODY_KINDS.includes(n.kind)) out.push({ message: t('{title} 不能放在回路里：回路只能由网络、读出和位线组成', { title: n.title }) }); }
    const { duplicates } = loopNetworks(ctx, body.nodes);
    if (duplicates.length) out.push({ message: t('回路里的网络标题重复：{titles}。带工具层的回路按网络标题读工具层记录（transition.loop.标题），标题必须唯一', { titles: joinList(duplicates) }) });
    const want = new Set([node.id, ...body.nodes]);
    for (const box of ctx.boxes(node.id)) {
      const have = new Set(box.members), extra = box.members.filter(id => !want.has(id)), missing = [...want].filter(id => !have.has(id));
      if (extra.length || missing.length) out.push({ message: t('回路框 {box} 的成员与回路体不一致。多出的成员：{extra}。缺少的成员：{missing}', { box: box.title, extra: extra.length ? joinList(extra.map(title)) : '—', missing: missing.length ? joinList(missing.map(title)) : '—' }) });
    }
    return out;
  },
});
