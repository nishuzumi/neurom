// core/graph.js — the module graph: nodes of registered kinds, value/call wires, nested groups.
// Every mutation validates. connect checks port existence, wire kind, direction, single-producer inputs, type
// compatibility and acyclicity. The type check includes call signatures: connect resolves the graph with the wire in
// place. A value cycle may close only into a port declared `loop` (a loop's `action`, a network's `weights`). Call
// wires never form a cycle (no recursion). A group may be marked as a loop's box (`loop`: the loop node's id). It stays
// a view. A group instantiated from a template that declares slots carries a `prefab` record (core/prefab.js). The
// record holds the slots and the expected wires. A slot is a node's declared port the task fills, with the modules a
// click creates for it. Nothing executes the record.
import { ConfigError, hasKind, kindOf, validateConfig } from './registry.js';
import { resolve } from './resolve.js';
import { mismatch } from './types.js';
import { t } from '../i18n.js';

const GRAPH_FORMAT = 'neurom-graph';
const WIRE_KINDS = Object.freeze(['value', 'call']);

export class GraphError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'GraphError'; Object.assign(this, details); }
}

let counter = 0;
/** Fresh id: short, unique within a session, sortable by creation. */
export function freshId(prefix = 'n') {
  counter = (counter + 1) % 0xffffff;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(4, '0')}${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const endpoint = e => plain(e) && typeof e.node === 'string' && typeof e.port === 'string';

export class ModuleGraph {
  constructor() {
    this.nodes = new Map(); this.wires = new Map(); this.groups = new Map();
    this.version = 0;
    this._parent = new Map();     // member id (node or group) → group id
    this._listeners = new Set();
    this._resolved = null; this._resolvedVersion = -1;
  }

  subscribe(listener) { this._listeners.add(listener); return () => this._listeners.delete(listener); }
  _changed() { this.version++; for (const listener of this._listeners) listener(this); }

  // ------------------------------------------------------------------ nodes
  node(id) { const node = this.nodes.get(id); if (!node) throw new GraphError(t('模块不存在：{id}', { id: String(id) }), { node: id }); return node; }
  hasNode(id) { return this.nodes.has(id); }

  /** `uiSize`, `uiCollapsed` and `uiFolded` (the tool ports whose sub-canvas the card folds) are presentation only. */
  addNode({ kind, title, x = 0, y = 0, config = {}, id = freshId('n'), uiSize = null, uiCollapsed = false, uiFolded = [] }) {
    const def = kindOf(kind);
    if (this.nodes.has(id) || this.groups.has(id)) throw new GraphError(t('id 已存在：{id}', { id }));
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new GraphError(t('位置必须是有限数'));
    const node = { id, kind, title: typeof title === 'string' && title ? title : t(def.label), x, y, config: validateConfig(def, config), uiSize, uiCollapsed: uiCollapsed === true, uiFolded: [...uiFolded] };
    this.nodes.set(id, node);
    this._changed();
    return node;
  }
  setConfig(id, config) { const node = this.node(id); node.config = validateConfig(node.kind, config); this._changed(); return node; }
  patchConfig(id, patch) { const node = this.node(id); return this.setConfig(id, { ...node.config, ...patch }); }
  moveNode(id, x, y) { const node = this.node(id); if (!Number.isFinite(x) || !Number.isFinite(y)) throw new GraphError(t('位置必须是有限数')); node.x = x; node.y = y; this._changed(); return node; }
  setTitle(id, title) { const node = this.node(id); if (typeof title !== 'string' || !title.trim()) throw new GraphError(t('标题不能为空')); node.title = title; this._changed(); return node; }
  setUi(id, { uiSize, uiCollapsed, uiFolded } = {}) {
    const node = this.node(id);
    if (uiSize !== undefined) node.uiSize = uiSize;
    if (uiCollapsed !== undefined) node.uiCollapsed = uiCollapsed === true;
    if (uiFolded !== undefined) node.uiFolded = [...uiFolded];
    this._changed(); return node;
  }
  removeNode(id) {
    this.node(id);
    for (const wire of [...this.wires.values()]) if (wire.from.node === id || wire.to.node === id) this.wires.delete(wire.id);
    this._detach(id);
    for (const g of this.groups.values()) {
      if (g.loop === id) g.loop = null;
      if (g.prefab) g.prefab = { slots: g.prefab.slots.filter(s => s.node !== id), expect: g.prefab.expect.filter(w => w.from.node !== id && w.to.node !== id) };
    }
    this.nodes.delete(id);
    this._changed();
  }

  // ------------------------------------------------------------------ wires
  wire(id) { const wire = this.wires.get(id); if (!wire) throw new GraphError(t('连线不存在：{id}', { id: String(id) })); return wire; }
  /** Wires into `port` of `nodeId`. */
  producers(nodeId, port) { const out = []; for (const wire of this.wires.values()) if (wire.to.node === nodeId && wire.to.port === port) out.push({ wire, node: wire.from.node, port: wire.from.port }); return out; }
  /** Wires out of `port` of `nodeId`, including its field paths (`port.a.b`). */
  consumers(nodeId, port) { const out = []; for (const wire of this.wires.values()) if (wire.from.node === nodeId && (wire.from.port === port || wire.from.port.startsWith(port + '.'))) out.push({ wire, node: wire.to.node, port: wire.to.port }); return out; }
  wiresOf(nodeId) { return [...this.wires.values()].filter(w => w.from.node === nodeId || w.to.node === nodeId); }

  ports(nodeId) { this.node(nodeId); return this.resolved().portsOf(nodeId); }

  /** Would `connect(spec)` succeed? `{ ok, reason }`. */
  canConnect(spec) {
    try { this._checkWire(spec); return { ok: true, reason: '' }; }
    catch (error) { if (error instanceof GraphError) return { ok: false, reason: error.message }; throw error; }
  }

  /** Add a wire. Beyond the structural checks, the graph is re-resolved with the wire in place. A problem that the wire
   *  introduces rejects the connection. The problem can be on the wire itself, on the target module or on the source
   *  module. For example: a call signature the code cannot satisfy, or a param the caller now supplies. */
  connect({ kind, from, to, id = freshId('w') }) {
    const wire = this._checkWire({ kind, from, to, id });
    const before = new Set(this.resolved().problems.map(problemKey));
    this.wires.set(id, wire);
    this._resolved = null;
    const after = resolve(this);
    const caused = after.problems.filter(p => !p.incomplete && !before.has(problemKey(p)) && (p.wire === id || p.node === to.node || p.node === from.node));
    if (caused.length) { this.wires.delete(id); this._resolved = null; throw new GraphError(caused[0].message, { wire: id, problems: caused }); }
    this._resolved = after; this._resolvedVersion = this.version + 1;
    this._changed();
    return wire;
  }
  disconnect(id) { this.wire(id); this.wires.delete(id); this._changed(); }

  _checkWire({ kind, from, to, id }) {
    if (!WIRE_KINDS.includes(kind)) throw new GraphError(t('未知连线种类：{kind}', { kind: String(kind) }));
    if (!endpoint(from) || !endpoint(to)) throw new GraphError(t('连线两端必须是 {node, port}'));
    if (typeof id !== 'string' || !id) throw new GraphError(t('连线 id 必须是非空字符串'));
    if (this.wires.has(id)) throw new GraphError(t('连线 id 重复：{id}', { id }));
    const source = this.node(from.node), target = this.node(to.node);
    if (source === target) throw new GraphError(t('模块不能连接自己'));
    const res = this.resolved();
    const out = res.outputPort(source.id, from.port);
    if (!out) throw new GraphError(t('{title} 没有输出端口 {port}', { title: source.title, port: from.port }), { node: source.id });
    const inp = res.portsOf(target.id).inputs.find(p => p.id === to.port);
    if (!inp) throw new GraphError(t('{title} 没有输入端口 {port}', { title: target.title, port: to.port }), { node: target.id });
    if (out.wire !== kind || inp.wire !== kind) throw new GraphError(kind === 'value' ? t('值线只能连接值端口') : t('调用线只能连接调用端口'));
    if (kind === 'call' && (out.handle ?? null) !== (inp.handle ?? null)) {
      const needs = inp.handle ? t('{port} 需要 {handle} 句柄', { port: to.port, handle: inp.handle }) : t('{port} 需要函数', { port: to.port });
      throw new GraphError(t('{needs}，不能接{got}', { needs, got: out.handle ? t('{handle} 句柄', { handle: out.handle }) : t('函数') }));
    }
    if (!inp.many && this.producers(target.id, to.port).length) throw new GraphError(t('{title} 的输入 {port} 已经接了一条线', { title: target.title, port: to.port }), { node: target.id, port: to.port });
    if (kind === 'value' && inp.type) {
      const T = res.typeOf(source.id, from.port);
      const problem = T ? mismatch(T, inp.type) : '';
      if (problem) throw new GraphError(problem, { node: target.id, port: to.port });
    }
    if (!inp.loop && this._reaches(target.id, source.id, kind, res)) {
      throw new GraphError(kind === 'call' ? t('调用线不能形成环路（禁止递归）') : t('值线不能形成环路（只有回路的 action 与网络的 weights 可以闭合回路）'));
    }
    return { id, kind, from: { node: from.node, port: from.port }, to: { node: to.node, port: to.port } };
  }
  /** Is `to` reachable from `from` over wires of `kind`? Value and call wires form separate graphs. Take a value wire
   *  into a code module whose fn the value's producer calls (params → options → params.options). That wire is a
   *  function boundary, not an evaluation cycle. The check ignores wires into a `loop` port (next-step semantics). */
  _reaches(from, to, kind, res) {
    const seen = new Set([from]), stack = [from];
    while (stack.length) {
      const id = stack.pop();
      if (id === to) return true;
      for (const wire of this.wires.values()) {
        if (wire.from.node !== id || wire.kind !== kind || seen.has(wire.to.node)) continue;
        if (res.portsOf(wire.to.node).inputs.some(p => p.id === wire.to.port && p.loop)) continue;
        seen.add(wire.to.node); stack.push(wire.to.node);
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ groups
  group(id) { const group = this.groups.get(id); if (!group) throw new GraphError(t('组合不存在：{id}', { id: String(id) })); return group; }
  parentOf(id) { const p = this._parent.get(id); return p ? this.groups.get(p) : null; }

  createGroup({ title = '', members = [], expose = [], template = null, loop = null, columns = null, collapsed = true, x = 0, y = 0, w = 320, h = 200, id = freshId('g') }) {
    if (this.nodes.has(id) || this.groups.has(id)) throw new GraphError(t('id 已存在：{id}', { id }));
    if (template !== null && !(plain(template) && typeof template.id === 'string' && Number.isInteger(template.revision))) throw new GraphError(t('组合的 template 必须是 {id, revision}'));
    const group = { id, title: String(title), template: template ? { id: template.id, revision: template.revision } : null, loop: null, prefab: null, columns: checkColumns(columns), members: [], expose: [], collapsed: collapsed === true, x, y, w, h };
    this.groups.set(id, group);
    try { for (const member of members) this.addToGroup(id, member); this.setExpose(id, expose); this._setLoop(group, loop); }
    catch (error) { for (const member of group.members) this._parent.delete(member); this.groups.delete(id); throw error; }
    this._changed();
    return group;
  }
  addToGroup(groupId, memberId) {
    const group = this.group(groupId);
    if (!this.nodes.has(memberId) && !this.groups.has(memberId)) throw new GraphError(t('成员不存在：{id}', { id: String(memberId) }));
    if (this._parent.has(memberId)) throw new GraphError(t('{id} 已经属于另一个组合', { id: memberId }));
    for (let g = group; g; g = this.parentOf(g.id)) if (g.id === memberId) throw new GraphError(t('组合不能包含自己或自己的祖先'));
    group.members.push(memberId); this._parent.set(memberId, groupId);
    this._changed();
  }
  removeFromGroup(memberId) {
    const group = this.parentOf(memberId);
    if (!group) return;
    group.members.splice(group.members.indexOf(memberId), 1); this._parent.delete(memberId);
    const inside = new Set(this.memberNodes(group.id));
    group.expose = group.expose.filter(e => inside.has(e.node));
    this._changed();
  }
  _detach(id) { const group = this.parentOf(id); if (group) { group.members.splice(group.members.indexOf(id), 1); this._parent.delete(id); group.expose = group.expose.filter(e => e.node !== id); } }
  /** Delete the group. Members move to its parent (or the canvas). With `deleteMembers`, member nodes and subgroups go too. */
  removeGroup(groupId, { deleteMembers = false } = {}) {
    const group = this.group(groupId), parent = this.parentOf(groupId);
    for (const member of [...group.members]) {
      this.removeFromGroup(member);
      if (deleteMembers) { if (this.groups.has(member)) this.removeGroup(member, { deleteMembers: true }); else this.removeNode(member); }
      else if (parent) this.addToGroup(parent.id, member);
    }
    this._detach(groupId);
    this.groups.delete(groupId);
    this._changed();
  }
  /** Node ids inside a group, through nested groups. */
  memberNodes(groupId) {
    const out = [];
    const walk = id => { for (const m of this.group(id).members) { if (this.groups.has(m)) walk(m); else out.push(m); } };
    walk(groupId);
    return out;
  }
  setExpose(groupId, expose) {
    const group = this.group(groupId), inside = new Set(this.memberNodes(groupId));
    if (!Array.isArray(expose)) throw new GraphError(t('expose 必须是端口数组'));
    const res = this.resolved(), seen = new Set(), out = [];
    for (const e of expose) {
      if (!endpoint(e)) throw new GraphError(t('expose 项必须是 {node, port}'));
      if (!inside.has(e.node)) throw new GraphError(t('暴露的端口 {node}.{port} 不属于组合成员', { node: e.node, port: e.port }));
      const ports = res.portsOf(e.node);
      const direction = res.outputPort(e.node, e.port) ? 'output' : ports.inputs.some(p => p.id === e.port) ? 'input' : null;
      if (!direction) throw new GraphError(t('{title} 没有端口 {port}', { title: this.node(e.node).title, port: e.port }));
      const key = `${e.node}.${e.port}`;
      if (seen.has(key)) continue;
      seen.add(key); out.push({ node: e.node, port: e.port, direction });
    }
    group.expose = out;
    this._changed();
    return out;
  }
  /** Mark the group as the box of loop node `loopId` (null: an ordinary group). */
  setGroupLoop(groupId, loopId) { this._setLoop(this.group(groupId), loopId); this._changed(); return this.group(groupId); }
  _setLoop(group, loopId) {
    if (loopId !== null && !(this.nodes.has(loopId) && this.nodes.get(loopId).kind === 'loop')) throw new GraphError(t('分组的 loop 必须是回路模块：{id}', { id: String(loopId) }));
    group.loop = loopId;
  }
  /** Attach the prefab record (null: none). Every node it names must exist and every port be declared (validated). */
  setPrefab(groupId, prefab) { const group = this.group(groupId); group.prefab = prefab === null ? null : this._checkPrefab(prefab); this._changed(); return group; }
  _checkPrefab(prefab) {
    if (!plain(prefab) || !Array.isArray(prefab.slots) || !Array.isArray(prefab.expect)) throw new GraphError(t('预制记录需要 slots 和 expect 数组'));
    const res = this.resolved(), ids = new Set(prefab.slots.map(s => (plain(s) ? s.id : null)));
    const declared = (node, port) => !!res.outputPort(node, port) || res.portsOf(node).inputs.some(p => p.id === port);
    const slots = prefab.slots.map(s => {
      if (!plain(s) || typeof s.id !== 'string' || !s.id || typeof s.title !== 'string' || !s.title.trim() || !Array.isArray(s.create)) throw new GraphError(t('槽位需要 id、title、node、port、create'));
      const node = this.node(s.node);
      if (typeof s.port !== 'string' || !declared(node.id, s.port)) throw new GraphError(t('{title} 没有端口 {port}', { title: node.title, port: String(s.port) }));
      const create = s.create.map(c => {
        if (!plain(c) || !hasKind(c.kind) || !plain(c.ports) || !Object.keys(c.ports).length) throw new GraphError(t('槽位 {slot} 的新建项需要 kind 和 ports', { slot: s.id }));
        for (const target of Object.values(c.ports)) if (!ids.has(target)) throw new GraphError(t('槽位 {slot} 的新建项接到了不存在的槽位 {target}', { slot: s.id, target: String(target) }));
        // a code entry without config is written when it is added, from its slot's contract (prefab.js stubSource)
        const config = c.kind === 'code' && c.config === undefined ? {} : { config: validateConfig(kindOf(c.kind), c.config ?? {}) };
        return { kind: c.kind, ...(typeof c.title === 'string' && c.title ? { title: c.title } : {}), ...config, ports: { ...c.ports } };
      });
      return { id: s.id, title: s.title, node: node.id, port: s.port, create };
    });
    if (ids.size !== slots.length) throw new GraphError(t('槽位 id 重复'));
    const expect = prefab.expect.map(w => {
      if (!plain(w) || !WIRE_KINDS.includes(w.kind) || !endpoint(w.from) || !endpoint(w.to)) throw new GraphError(t('预期连线需要 kind、from、to'));
      this.node(w.from.node); this.node(w.to.node);
      return { kind: w.kind, from: { node: w.from.node, port: w.from.port }, to: { node: w.to.node, port: w.to.port } };
    });
    return { slots, expect };
  }
  exposedPorts(groupId) { return this.group(groupId).expose.map(e => ({ ...e })); }
  /** `columns`: a training module's section split that the user placed. It holds columns of section node ids, top to
   *  bottom. null: the frame's rule and shape place the sections (ADR 0011). It is a view preference like x/y. */
  setGroupLayout(groupId, { x, y, w, h, collapsed, title, columns } = {}) {
    const group = this.group(groupId);
    for (const [key, value] of Object.entries({ x, y, w, h })) if (value !== undefined) { if (!Number.isFinite(value)) throw new GraphError(t('位置必须是有限数')); group[key] = value; }
    if (collapsed !== undefined) group.collapsed = collapsed === true;
    if (title !== undefined) group.title = String(title);
    if (columns !== undefined) group.columns = checkColumns(columns);
    this._changed();
    return group;
  }

  // ------------------------------------------------------------------ resolution
  /** Whole-graph types and problems, cached per version. */
  resolved() {
    if (this._resolved && this._resolvedVersion === this.version) return this._resolved;
    this._resolved = resolve(this); this._resolvedVersion = this.version;
    return this._resolved;
  }
  problems() { return this.resolved().problems; }

  // ------------------------------------------------------------------ persistence
  toJSON() {
    return {
      format: GRAPH_FORMAT,
      nodes: [...this.nodes.values()].map(n => ({ id: n.id, kind: n.kind, title: n.title, x: n.x, y: n.y, config: structuredClone(n.config), ...(n.uiSize ? { uiSize: n.uiSize } : {}), ...(n.uiCollapsed ? { uiCollapsed: true } : {}), ...(n.uiFolded.length ? { uiFolded: [...n.uiFolded] } : {}) })),
      wires: [...this.wires.values()].map(w => ({ id: w.id, kind: w.kind, from: { ...w.from }, to: { ...w.to } })),
      groups: [...this.groups.values()].map(g => ({ id: g.id, title: g.title, ...(g.template ? { template: { ...g.template } } : {}), ...(g.loop ? { loop: g.loop } : {}), ...(g.prefab ? { prefab: structuredClone(g.prefab) } : {}), ...(g.columns ? { columns: g.columns.map(c => [...c]) } : {}), members: [...g.members], expose: g.expose.map(e => ({ node: e.node, port: e.port })), collapsed: g.collapsed, x: g.x, y: g.y, w: g.w, h: g.h })),
    };
  }
  /** Rebuild from JSON through `admit`, strict: unknown kinds, bad configs, illegal wires all throw. */
  static fromJSON(json) {
    if (!plain(json) || json.format !== GRAPH_FORMAT) throw new GraphError(t('需要 {format} 图', { format: GRAPH_FORMAT }));
    const graph = new ModuleGraph();
    graph.admit(json);
    return graph;
  }

  /** Admit a graph description through the validating mutators. The description is `{ nodes, wires, groups }`, the
   *  shape `toJSON` writes. The mutators run in the one order that works. First nodes. Then wires: refused wires are
   *  retried while any still connects (a field path `out.a` only exists once an earlier wire typed its record). Then
   *  groups, then their members, exposes, loop marks and prefab records. Loading, undo, paste and template
   *  instantiation all come through here.
   *  - `fresh`: every node, wire and group gets a new id. The description's references are translated. A reference
   *    that names nothing in the description is dropped (a pasted slice). Without `fresh`, ids are kept and references
   *    name the described items or the graph's own.
   *  - `dx`, `dy`: added to node and group positions.
   *  - `strict` (default): the first refusal throws and everything this call added is removed again. Lenient: each
   *    refusal is dropped and returned as a note, and a reference to a module the graph does not hold is dropped.
   *  A refusal's error carries `at`: where in the description it failed, as a JSON path (`['nodes', 2, 'config', 'x']`).
   *  A group's `columns` tolerate stale ids (a view preference): kept as written, only translated when fresh.
   *  Returns `{ ids, notes }`: ids maps each admitted node's and group's description id → its id in the graph. */
  admit(description, { fresh = false, dx = 0, dy = 0, strict = true } = {}) {
    const { nodes, wires, groups } = plain(description) ? description : {};
    if (!Array.isArray(nodes) || !Array.isArray(wires) || !Array.isArray(groups)) throw new GraphError(t('图需要 nodes、wires、groups 数组'));
    const ids = new Map(), notes = [], undo = [];
    const refuse = (error, note = error.message) => { if (strict) throw error; notes.push(note); };
    // the description's place of a refused item (`at`: its path, or a function of the error giving it)
    const located = (error, at) => { error.at ??= typeof at === 'function' ? at(error) : at; return error; };
    const attempt = (fn, at) => { try { fn(); } catch (error) { refuse(located(error, at)); } };
    // a reference → its id in the graph. null when it names nothing the graph holds (strict: refused)
    const lookup = (id, holds, missing) => {
      const at = fresh ? ids.get(id) : id;
      if (at !== undefined && holds(at)) return at;
      if (strict) throw new GraphError(missing());
      return null;
    };
    const nodeRef = id => lookup(id, at => this.nodes.has(at), () => t('模块不存在：{id}', { id: String(id) }));
    const memberRef = id => lookup(id, at => this.nodes.has(at) || this.groups.has(at), () => t('成员不存在：{id}', { id: String(id) }));
    // a {node, port} reference, translated. null: drop it. A malformed reference passes on, and the mutator refuses it.
    const end = e => { if (!endpoint(e)) return e; const node = nodeRef(e.node); return node ? { node, port: e.port } : null; };
    const columnsOf = columns => {
      if (!fresh || !Array.isArray(columns)) return columns ?? null;
      const out = columns.map(col => col.flatMap(id => ids.get(id) ?? [])).filter(col => col.length);
      return out.length ? out : null;
    };
    const prefabOf = p => {
      if (!plain(p) || !Array.isArray(p.slots) || !Array.isArray(p.expect)) return p;
      const slots = p.slots.flatMap(s => { if (!plain(s)) return [s]; const node = nodeRef(s.node); return node ? [{ ...s, node }] : []; });
      const expect = p.expect.flatMap(w => { if (!plain(w)) return [w]; const from = end(w.from), to = end(w.to); return from && to ? [{ ...w, from, to }] : []; });
      return { slots, expect };
    };
    try {
      nodes.forEach((n, i) => attempt(() => {
        const node = this.addNode({ id: fresh ? freshId('n') : n.id, kind: n.kind, title: n.title, x: (n.x ?? 0) + dx, y: (n.y ?? 0) + dy, config: n.config, uiSize: n.uiSize ?? null, uiCollapsed: n.uiCollapsed === true, uiFolded: n.uiFolded ?? [] });
        ids.set(n.id, node.id); undo.push(() => this.removeNode(node.id));
      }, error => error instanceof ConfigError ? ['nodes', i, 'config', ...error.path] : ['nodes', i]));
      let pending = [];
      wires.forEach((w, i) => {
        const at = ['wires', i];
        try {
          const from = end(w.from), to = end(w.to);
          if (from && to) pending.push({ at, wire: { id: fresh ? freshId('w') : w.id, kind: w.kind, from, to } });
        } catch (error) { throw located(error, at); }
      });
      while (pending.length) {
        const rest = [], errors = [];
        for (const p of pending) {
          try { const wire = this.connect(p.wire); undo.push(() => { if (this.wires.has(wire.id)) this.disconnect(wire.id); }); }
          catch (error) { rest.push(p); errors.push(located(error, p.at)); }
        }
        if (rest.length === pending.length) { for (const error of errors) refuse(error, t('丢弃一条现在不允许的连线：{reason}', { reason: error.message })); break; }
        pending = rest;
      }
      const admitted = [];
      groups.forEach((g, i) => attempt(() => {
        const group = this.createGroup({ id: fresh ? freshId('g') : g.id, title: g.title, template: g.template ?? null, columns: columnsOf(g.columns), collapsed: g.collapsed, x: (g.x ?? 0) + dx, y: (g.y ?? 0) + dy, w: g.w, h: g.h });
        ids.set(g.id, group.id); admitted.push([g, group.id, ['groups', i]]); undo.push(() => { if (this.groups.has(group.id)) this.removeGroup(group.id); });
      }, ['groups', i]));
      for (const [g, id, at] of admitted) for (const [j, m] of g.members.entries()) attempt(() => { const member = memberRef(m); if (member) this.addToGroup(id, member); }, [...at, 'members', j]);
      for (const [g, id, at] of admitted) attempt(() => this.setExpose(id, Array.isArray(g.expose) ? g.expose.map(end).filter(e => e !== null) : g.expose), [...at, 'expose']);
      for (const [g, id, at] of admitted) if (g.loop) attempt(() => { const loop = nodeRef(g.loop); if (loop) this.setGroupLoop(id, loop); }, [...at, 'loop']);
      for (const [g, id, at] of admitted) if (g.prefab) attempt(() => this.setPrefab(id, prefabOf(g.prefab)), [...at, 'prefab']);
    } catch (error) {
      for (const fn of undo.reverse()) fn();
      throw error;
    }
    return { ids, notes };
  }
}

/** The most section columns a training module's stored split holds (ADR 0011 §5). */
export const MAX_COLUMNS = 16;

/** A group's stored section split: null, or 1..MAX_COLUMNS non-empty columns of distinct node ids (members are not
 *  checked: a stale id is skipped where the frame is drawn). */
function checkColumns(columns) {
  if (columns === null) return null;
  const ok = Array.isArray(columns) && columns.length >= 1 && columns.length <= MAX_COLUMNS
    && columns.every(c => Array.isArray(c) && c.length > 0 && c.every(id => typeof id === 'string' && id.length > 0));
  if (!ok) throw new GraphError(t('分栏必须是 1 到 {max} 栏、每栏至少一个模块 id', { max: MAX_COLUMNS }));
  const ids = columns.flat();
  if (new Set(ids).size !== ids.length) throw new GraphError(t('分栏里的模块 id 重复'));
  return columns.map(c => [...c]);
}

const problemKey = p => `${p.node}\u0000${p.port ?? ''}\u0000${p.wire ?? ''}\u0000${p.message}`;
