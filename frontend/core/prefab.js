// core/prefab.js — a prefab: a group instantiated whole from a template that declares slots (template.js `slots`).
// Its group carries `prefab = { slots, expect }` (graph.js validates it):
//   slots   { id, title, node, port, create: [{ kind, title?, config?, ports: { newPort: slotId } }] } — a declared port
//           of a member that the task fills, and the modules a click adds for it. A click creates them inside the
//           group and wires them to the slots that `ports` names. A code entry without config starts from its slot's
//           contract (stubSource).
//   expect  { kind, from, to } — the template's wires outside the slots.
// What fills a slot is read from the wires, never stored. Nothing here executes: runs read wires only, so a graph with
// every prefab record removed trains and evaluates the same. The kinds keep validating their ports as always.
import { GraphError } from './graph.js';
import { roleText, scenarioStub } from './kinds/scenario.js';
import { scenarioOf } from './roles.js';
import { t } from '../i18n.js';

const wireKey = w => `${w.kind}|${w.from.node}.${w.from.port}|${w.to.node}.${w.to.port}`;

/** The slot's port declaration on its node: { dir: 'in'|'out', decl }, or null when the node no longer declares it. */
function slotPort(res, slot) {
  const out = res.outputPort(slot.node, slot.port);
  if (out) return { dir: 'out', decl: out };
  const inp = res.portsOf(slot.node).inputs.find(p => p.id === slot.port);
  return inp ? { dir: 'in', decl: inp } : null;
}

/**
 * The source a code module created for input slot port `decl` starts from: the stub of the port's contract. A call
 * port's signature names the function (`signature.name`, else the port's id), its parameters and its body. A module
 * port (a loop's `scenario`) takes the scenario roles. They are written against `scenario` (roles.js scenarioOf: the
 * loop's live context, or null for no table and a one-bit input). null for any other port.
 */
export function stubSource(decl, scenario = null) {
  if (decl.wire === 'call' && decl.signature) return roleText(decl.signature.name ?? decl.id, decl.signature);
  if (decl.handle === 'module') return scenario?.stub ?? scenarioStub(false);
  return null;
}

/**
 * The prefab `groupId` is, read against the live wires, or null when the group has no prefab record.
 *  slots    each slot with `dir`, `wire` (value/call), `required` (a required input), `many` (an output, or an input
 *           declared many), `filled` (the nodes wired to the port by a wire that is not expected — for an output slot,
 *           only nodes of a kind it creates, when it creates any) and `open` (it can take one more).
 *  missing  the expected wires not present, each with its `index` in `prefab.expect`.
 */
export function prefabState(graph, groupId) {
  const group = graph.group(groupId), P = group.prefab;
  if (!P) return null;
  const res = graph.resolved(), expected = new Set(P.expect.map(wireKey)), live = new Set([...graph.wires.values()].map(wireKey));
  const slots = P.slots.map(slot => {
    const at = slotPort(res, slot);
    if (!at) return { ...slot, dir: null, wire: null, required: false, many: false, filled: [], open: false };
    const kinds = new Set(slot.create.map(c => c.kind));
    const ends = at.dir === 'in' ? graph.producers(slot.node, slot.port) : graph.consumers(slot.node, slot.port).filter(c => c.wire.from.port === slot.port);
    const filled = ends.filter(e => !expected.has(wireKey(e.wire)) && (at.dir === 'in' || !kinds.size || kinds.has(graph.node(e.node).kind))).map(e => e.node);
    const many = at.dir === 'out' || !!at.decl.many;
    return { ...slot, dir: at.dir, wire: at.decl.wire, required: at.dir === 'in' && !!at.decl.required, many, filled: [...new Set(filled)], open: many || !ends.length };
  });
  const missing = P.expect.map((w, index) => ({ ...w, index })).filter(w => !live.has(wireKey(w)));
  return { slots, missing };
}

/**
 * Add create entry `index` of slot `slotId` into the prefab at (x, y) and wire it. Each of its `ports` goes to the slot
 * it names: into an input slot's port, or from an output slot's port. A code entry without config gets its slot port's
 * stub (stubSource), read against the graph as it is now. A slot other than `slotId` that is already taken (a single
 * input with a wire) stays as it is. All or nothing: a rejected wire removes the new module again.
 * @returns the new node
 */
export function fillSlot(graph, groupId, slotId, index, { x = 0, y = 0 } = {}) {
  const state = prefabState(graph, groupId);
  if (!state) throw new GraphError(t('组合 {id} 不是预制模块', { id: groupId }));
  const slot = state.slots.find(s => s.id === slotId);
  if (!slot) throw new GraphError(t('槽位不存在：{id}', { id: String(slotId) }));
  const spec = slot.create[index];
  if (!spec) throw new GraphError(t('槽位 {slot} 没有第 {n} 个新建项', { slot: slot.title, n: String(index + 1) }));
  if (!slot.open) throw new GraphError(t('槽位 {slot} 已经接好了', { slot: slot.title }));
  const res = graph.resolved(), at = spec.config ? null : slotPort(res, slot);
  const source = at?.dir === 'in' ? stubSource(at.decl, at.decl.handle === 'module' ? scenarioOf(graph, res, slot.node) : null) : null;
  const node = graph.addNode({ kind: spec.kind, ...(spec.title ? { title: spec.title } : {}), config: spec.config ?? { source }, x, y });
  try {
    graph.addToGroup(groupId, node.id);
    for (const [port, target] of Object.entries(spec.ports)) {
      const s = state.slots.find(x => x.id === target);
      if (!s?.dir || (s.id !== slotId && !s.open)) continue;
      graph.connect(s.dir === 'in'
        ? { kind: s.wire, from: { node: node.id, port }, to: { node: s.node, port: s.port } }
        : { kind: s.wire, from: { node: s.node, port: s.port }, to: { node: node.id, port } });
    }
  } catch (error) { graph.removeNode(node.id); throw error; }
  return node;
}

/**
 * Put expected wire `index` back. When its input takes one wire and holds another, that one is replaced. All or
 * nothing: when the expected wire is refused, the replaced wire is connected again.
 */
export function restoreWire(graph, groupId, index) {
  const P = graph.group(groupId).prefab, w = P?.expect[index];
  if (!w) throw new GraphError(t('预期连线不存在'));
  const res = graph.resolved(), decl = res.portsOf(w.to.node).inputs.find(p => p.id === w.to.port);
  const replaced = decl && !decl.many ? graph.producers(w.to.node, w.to.port).map(p => p.wire) : [];
  for (const old of replaced) graph.disconnect(old.id);
  try { return graph.connect({ kind: w.kind, from: w.from, to: w.to }); }
  catch (error) { for (const old of replaced) graph.connect(old); throw error; }
}
