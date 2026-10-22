// core/resolve.js — whole-graph type inference and problems. Types flow along value wires from producers to
// consumers. The kind of the module a call site calls types that call site (its `callee` hook, core/registry.js — a
// code module's export, a readout's `run`). The kind gets the caller's argument types and the exactness of the
// caller's signature. This file does only the kind-free part: the call's result against the signature, the uses of
// each callee and the typed calls a bundle reads (res.calls). Kinds only see the `ctx` API below. Iteration to a
// fixpoint lives here.
//
//   ctx.node(id)
//   ctx.producers(nodeId, port) / ctx.consumers(nodeId, port) → [{wire, node, port}]   (consumers include field paths `port.a.b`)
//   ctx.inType(nodeId, port) → Type|null
//   ctx.portsOf(nodeId) → { inputs, outputs }            declared ports (a port's `loop` flag: next-step input)
//   ctx.boxes(loopId) → [{ id, title, members }]          groups marked as that loop's box (members: node ids, nested)
//   ctx.refs(nodeId) · ctx.setRefs(nodeId, refs)          named types a node publishes (State, Transition, O…)
//   ctx.call(nodeId, port, argTypes) → null | Call        (first call wire)
//   ctx.callAll(nodeId, port, argTypes) → [Call…]          (every call wire)
//   ctx.callWidths(nodeId, port) → [number…]              the bits each callee wired into `port` reads (callees typed
//                                                         by their arguments alone omitted)
//   ctx.callUses(nodeId) → [{k, signature, from, caller, port, wire, error}]   call sites of a module's call outputs
//   ctx.callees(nodeId, port) → [{node, fn, wire, callee}]  every call wire into `port` with its kind's callee hook
//                                                         answer (null: not callable), untyped. res.callees is the same
//                                                         after the resolution, for a caller that types its calls at
//                                                         run time (a script module, core/script-calls.js)
// A Call is `{ result, error, paramTypes, exact, carries, node, wire, k, fn, caller, port }`: node / fn the callee
// module and output, paramTypes the program's params (the k arguments, then what the callee binds), carries what a
// bundle takes from the callee — `{ kind:'program', program, bound }` or `{ kind:'net', network, readout }` (null on
// error). Calls without error are kept in res.calls by wire id.
import { kindOf } from './registry.js';
import { assignable, mismatch, resolveSignature, typeName, unresolvedRefs } from './types.js';
import { canonicalJSON } from './canonical.js';
import { t } from '../i18n.js';

const MAX_ITERATIONS = 24;

class Resolution {
  constructor() {
    this.types = new Map();      // nodeId → { inputs:{port: Type|Type[]}, outputs:{port: Type} }
    this.ports = new Map();      // nodeId → { inputs:[port…], outputs:[port…] } (declared ports, field paths via outputPort)
    this.refs = new Map();
    this.problems = [];
    this.calls = new Map();      // wire id → typed Call (for bundles)
  }
  portsOf(nodeId) { return this.ports.get(nodeId) ?? { inputs: [], outputs: [] }; }
  /** Output type of `port`. A field path `port.a.b` walks the record fields of a value output. */
  typeOf(nodeId, port) {
    const outputs = this.types.get(nodeId)?.outputs ?? {};
    if (Object.hasOwn(outputs, port)) return outputs[port] ?? null;
    const [root, ...path] = port.split('.');
    return path.length ? fieldType(outputs[root] ?? null, path) : null;
  }
  /** The output port `port` of `nodeId`: a declared port, or a field path `root.a.b` into a record-typed value output
   *  (synthesised: `{ id, wire:'value', type, root, path }`). null when neither exists. */
  outputPort(nodeId, port) {
    const outputs = this.portsOf(nodeId).outputs, own = outputs.find(p => p.id === port);
    if (own) return own;
    const [root, ...path] = port.split('.');
    const base = path.length ? outputs.find(p => p.id === root && p.wire === 'value') : null;
    const type = base ? fieldType(base.type ?? null, path) : null;
    return type ? { id: port, wire: 'value', type, root, path } : null;
  }
  inTypeOf(nodeId, port) { const T = this.types.get(nodeId)?.inputs?.[port]; return Array.isArray(T) ? T[0] ?? null : T ?? null; }
  refsOf(nodeId) { return this.refs.get(nodeId) ?? {}; }
  problemsOf(nodeId) { return this.problems.filter(p => p.node === nodeId); }
  /** The typed call site feeding `port` of `nodeId`, as recorded during inference/problems. */
  callSite(nodeId, port) { return this.callSites(nodeId, port)[0] ?? null; }
  callSites(nodeId, port) { return [...this.calls.values()].filter(c => c.caller === nodeId && c.port === port); }
}

/** Type of the field at `path` inside record type `T`, or null. Only records have fields. */
function fieldType(T, path) {
  let at = T;
  for (const key of path) { if (at?.type !== 'record' || !Object.hasOwn(at.fields, key)) return null; at = at.fields[key]; }
  return at ?? null;
}

/**
 * The nearest training module around `nodeId` (the nearest group carrying a prefab record), or null. `members` are its
 * member nodes, then the scenario module of each of its loops when that module sits outside it. Such a scenario is an
 * environment that several training modules share.
 * @returns {{ id: string, title: string, members: string[] } | null}
 */
export function trainingModuleOf(graph, nodeId) {
  let group = graph.parentOf(nodeId);
  while (group && !group.prefab) group = graph.parentOf(group.id);
  if (!group) return null;
  const members = graph.memberNodes(group.id), inside = new Set(members);
  const shared = members.filter(id => graph.node(id).kind === 'loop').flatMap(id => graph.producers(id, 'scenario').map(p => p.node)).filter(id => !inside.has(id));
  return { id: group.id, title: group.title, members: [...members, ...new Set(shared)] };
}

export function resolve(graph) {
  const res = new Resolution();
  const nodes = [...graph.nodes.values()];
  const uses = new Map();

  const ctx = {
    node: id => graph.node(id),
    producers: (nodeId, port) => graph.producers(nodeId, port),
    consumers: (nodeId, port) => graph.consumers(nodeId, port),
    inType: (nodeId, port) => { const p = graph.producers(nodeId, port)[0]; return p ? res.typeOf(p.node, p.port) : null; },
    portsOf: nodeId => res.portsOf(nodeId),
    boxes: loopId => [...graph.groups.values()].filter(g => g.loop === loopId).map(g => ({ id: g.id, title: g.title, members: graph.memberNodes(g.id) })),
    /** the nearest training module around `nodeId` with its member nodes and the environment it shares (trainingModuleOf) */
    trainingModuleOf: nodeId => trainingModuleOf(graph, nodeId),
    refs: nodeId => res.refsOf(nodeId),
    setRefs: (nodeId, refs) => { res.refs.set(nodeId, { ...refs }); },
    callAll: (nodeId, port, argTypes) => graph.producers(nodeId, port).map(p => callOne(nodeId, port, p, argTypes)),
    call: (nodeId, port, argTypes) => { const p = graph.producers(nodeId, port)[0]; return p ? callOne(nodeId, port, p, argTypes) : null; },
    callWidths: (nodeId, port) => graph.producers(nodeId, port).map(p => calleeOf(p)?.width ?? null).filter(Number.isInteger),
    callUses: nodeId => [...(uses.get(nodeId)?.values() ?? [])],
    callees: (nodeId, port) => graph.producers(nodeId, port).map(p => ({ node: graph.node(p.node), fn: p.port, wire: p.wire, callee: calleeOf(p) })),
  };
  res.callees = ctx.callees;

  /** The callee behind the call wire from producer `p`: its kind's answer for that output. null when not callable. */
  function calleeOf(p) {
    const source = graph.node(p.node);
    return kindOf(source.kind).callee?.(source, p.port, ctx) ?? null;
  }
  function callOne(callerId, port, producer, argTypes) {
    const wire = producer.wire, source = graph.node(producer.node), k = argTypes.length;
    const portDef = res.portsOf(callerId).inputs.find(p => p.id === port);
    const record = { k, signature: null, from: producer.port, caller: callerId, port, wire: wire.id, error: null };
    if (!uses.has(source.id)) uses.set(source.id, new Map());
    uses.get(source.id).set(wire.id, record);
    const info = { result: null, error: null, paramTypes: argTypes, exact: false, carries: null, node: source, wire, k, fn: producer.port, caller: callerId, port };
    const settle = error => { info.error = record.error = error; if (!error) res.calls.set(wire.id, info); return info; };
    if (!portDef || portDef.wire !== 'call' || !portDef.signature) return settle(new Error(t('{port} 不是函数调用端口', { port })));
    const callee = calleeOf(producer);
    if (!callee) return settle(new Error(t('调用端口 {port} 需要接代码模块导出的函数或读出的 run', { port })));
    const signature = resolveSignature(portDef.signature, res.refsOf(callerId)), exact = signature.exact === true;
    record.signature = { params: argTypes, result: signature.result, exact };
    const r = callee.call(argTypes, { exact, caller: callerId });
    Object.assign(info, { result: r.result, paramTypes: r.paramTypes, exact, carries: r.error ? null : r.carries });
    if (r.error) return settle(r.error);
    if (unresolvedRefs({ params: [], result: signature.result }).length) return settle(Object.assign(new Error(t('调用 {port} 的返回类型尚未确定', { port })), { incomplete: true }));
    if (!assignable(r.result, signature.result)) return settle(new Error(t('调用 {port} 的返回值{problem}', { port, problem: mismatch(r.result, signature.result) })));
    return settle(null);
  }

  // 1. ports (structure only, output types are filled after inference)
  for (const node of nodes) res.ports.set(node.id, kindOf(node.kind).ports(node, ctx));
  // 2. fixpoint over infer
  for (const node of nodes) res.types.set(node.id, { inputs: {}, outputs: {} });
  // Iterate until neither outputs nor published refs change: a node's refs (State, Transition…) may settle after its
  // outputs did, and downstream kinds read refs, not outputs.
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let changed = false;
    for (const node of nodes) {
      const ports = res.ports.get(node.id), inputs = {};
      for (const p of ports.inputs) {
        const producers = graph.producers(node.id, p.id).map(x => res.typeOf(x.node, x.port));
        inputs[p.id] = p.many ? producers : producers[0] ?? null;
      }
      const refsBefore = canonicalJSON(res.refsOf(node.id));
      const outputs = kindOf(node.kind).infer(node, inputs, ctx) ?? {};
      const entry = res.types.get(node.id);
      if (canonicalJSON(outputs) !== canonicalJSON(entry.outputs) || canonicalJSON(res.refsOf(node.id)) !== refsBefore) changed = true;
      entry.inputs = inputs; entry.outputs = outputs;
    }
    if (!changed) break;
  }
  // 3. ports again (signatures may depend on inferred types, for example a trainer's objective on the readout width),
  //    with the inferred output types. A record output is one port. Consumers read its fields themselves.
  for (const node of nodes) {
    const ports = kindOf(node.kind).ports(node, ctx), outputs = res.types.get(node.id).outputs;
    ports.outputs = ports.outputs.map(p => (p.wire === 'value' ? { ...p, type: outputs[p.id] ?? p.type ?? null } : p));
    res.ports.set(node.id, ports);
  }
  // 4. problems
  for (const wire of graph.wires.values()) {
    const from = res.outputPort(wire.from.node, wire.from.port);
    const to = res.portsOf(wire.to.node).inputs.find(p => p.id === wire.to.port);
    if (!from) res.problems.push({ node: wire.from.node, wire: wire.id, message: t('输出端口 {port} 不存在', { port: wire.from.port }) });
    if (!to) res.problems.push({ node: wire.to.node, wire: wire.id, message: t('输入端口 {port} 不存在', { port: wire.to.port }) });
    if (!from || !to) continue;
    if (wire.kind === 'value' && from.type && to.type && !assignable(from.type, to.type)) {
      res.problems.push({ node: wire.to.node, port: to.id, wire: wire.id, message: t('{port}：需要 {expected}，得到 {actual}', { port: to.id, expected: typeName(to.type), actual: typeName(from.type) }) });
    }
  }
  for (const node of nodes) {
    for (const p of res.portsOf(node.id).inputs) if (p.required && !graph.producers(node.id, p.id).length) res.problems.push({ node: node.id, port: p.id, incomplete: true, message: t('必需输入 {port} 尚未连接', { port: p.id }) });
    for (const problem of kindOf(node.kind).problems(node, ctx)) res.problems.push(normalise(node.id, problem));
  }
  return res;
}

/** Problems are `{ node, port?, wire?, message, incomplete }`. Kinds may hand in an `error` instead of a message.
 *  `incomplete` marks a missing connection (something still to wire) as opposed to a type error. */
function normalise(nodeId, problem) {
  const { error, ...rest } = problem;
  const out = { node: nodeId, ...rest, message: problem.message ?? error?.message ?? '' };
  out.incomplete = problem.incomplete === true || error?.incomplete === true;
  if (error && !problem.wire && error.wire) out.wire = error.wire;
  return out;
}
