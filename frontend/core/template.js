// core/template.js — `neurom-template`: a set of modules, their configs and wires, plus exposed
// ports. YAML is the authoring/import/export format. Templates are stored as canonical JSON. Parsing validates
// against the registry by instantiating into a scratch graph, so every connect rule applies to templates.
//
//   modules:  { localId: { kind, title?, config } }      code: config { inputs: [a, b], source: "export function f(x) { … }" }
//   wires:    { value: ["a.port→b.port"…], call: ["reward→trainer.objective"…] }   ("->" is also accepted. A source
//             without a port means a code module's only exported function (call) / const (value), else the module's
//             first output.) Stored alphabetically, except that call wires into the same port keep their written
//             order (a tool layer numbers its tools by it)
//   expose:   ["module.port"…]     layout: { localId: {x, y} }
//   groups:   { localId: { title?, members: [moduleLocalId | groupLocalId…], expose: ["module.port"…], loop? } }
//             nested composites inside the template's own group. Modules not listed stay directly in the top group.
//             `loop: moduleLocalId` marks the group as that loop module's box
//   slots:    [{ id, title?, port: "module.port", create?: [{ kind, title?, config?, ports?: { newPort: slotId } }] }]
//             a prefab (core/prefab.js). Each slot is a declared port of a member the task fills. `create` lists the
//             modules a click adds for it. `ports` names which of the new module's ports go to which slot (default:
//             its one matching port → this slot). A code entry without config is written when it is added, from the
//             slot port's contract (prefab.js stubSource). The instance's group records the slots. It also records,
//             as expected wires, every template wire that is not slot content (into an input slot, or out of an
//             output slot into a module of a kind the slot creates)
//   preset:   { label, accept?: { candidatesLocalId: builtinArtifactName } }   the palette's example (graph_app.js): the
//             template placed with those builtin artifacts accepted
import YAML from 'yaml';
import { ModuleGraph, GraphError, freshId } from './graph.js';
import { stubSource } from './prefab.js';
import { kindOf, hasKind, validateConfig } from './registry.js';
import { canonicalize } from './canonical.js';
import { t } from '../i18n.js';

const TEMPLATE_FORMAT = 'neurom-template';
const TEMPLATE_KINDS = Object.freeze(['module', 'composite', 'canvas']);
const LOCAL_ID = /^[A-Za-z_][\w-]*$/;
const TEMPLATE_ID = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const ARROW = /\s*(?:→|->)\s*/;
const GRID = { columns: 4, dx: 280, dy: 220 };

export class TemplateError extends Error {
  constructor(message, where = null) { super(message); this.name = 'TemplateError'; this.where = where; }
}
const fail = (message, where) => { throw new TemplateError(message, where); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Parse `module.port` (port optional) → { module, port|null }. */
function endpointOf(text, where) {
  const dot = text.indexOf('.');
  const module = dot < 0 ? text : text.slice(0, dot), port = dot < 0 ? null : text.slice(dot + 1);
  if (!LOCAL_ID.test(module) || (port !== null && !port)) fail(t('连线端点 {text} 不合法', { text }), where);
  return { module, port };
}
function parseWire(text, kind, modules, where) {
  if (typeof text !== 'string') fail(t('连线必须是 "a.port→b.port" 字符串'), where);
  const parts = text.split(ARROW);
  if (parts.length !== 2) fail(t('连线 {text} 需要恰好一个箭头', { text }), where);
  const from = endpointOf(parts[0].trim(), where), to = endpointOf(parts[1].trim(), where);
  for (const e of [from, to]) if (!Object.hasOwn(modules, e.module)) fail(t('连线 {text} 引用了不存在的模块 {module}', { text, module: e.module }), where);
  if (!to.port) fail(t('连线 {text} 的目标必须写明端口', { text }), where);
  if (!from.port) from.port = defaultOutput(modules[from.module], kind);
  return { kind, from, to };
}
function defaultOutput(module, wireKind) {
  if (module.kind === 'code') {
    const exports = module.config.exports.filter(e => e.kind === (wireKind === 'call' ? 'function' : 'const'));
    if (exports.length !== 1) fail(t('代码模块导出了 {n} 个{what}，连线需要写明端口', { n: exports.length, what: wireKind === 'call' ? t('函数') : t('常量') }));
    return exports[0].name;
  }
  const outputs = scratchPorts(module).outputs.filter(p => p.wire === wireKind);
  if (!outputs.length) fail(t('模块种类 {kind} 没有 {wire} 输出端口', { kind: module.kind, wire: wireKind }));
  return outputs[0].id;
}
const SCRATCH_CTX = { producers: () => [], consumers: () => [], inType: () => null, refs: () => ({}) };
/** A template module's ports, from its kind with a blank context: a code module's from its exports. */
const scratchPorts = module => kindOf(module.kind).ports({ id: '_', kind: module.kind, config: module.config }, SCRATCH_CTX);

/** Normalise `modules` entries: config validated with defaults filled. */
function parseModules(raw) {
  if (!plain(raw) || !Object.keys(raw).length) fail(t('模板需要至少一个模块'));
  const modules = {};
  for (const [localId, entry] of Object.entries(raw)) {
    if (!LOCAL_ID.test(localId)) fail(t('模块本地 id {id} 不合法', { id: localId }), localId);
    if (!plain(entry) || typeof entry.kind !== 'string') fail(t('模块 {id} 需要 kind', { id: localId }), localId);
    if (!hasKind(entry.kind)) fail(t('未知模块种类：{kind}', { kind: entry.kind }), localId);
    for (const key of Object.keys(entry)) if (!['kind', 'title', 'config'].includes(key)) fail(t('模块 {id} 含未知字段 {key}', { id: localId, key }), localId);
    let config = entry.config ?? {};
    try { config = validateConfig(entry.kind, config); }
    catch (error) { fail(t('模块 {id}：{message}', { id: localId, message: error.message }), localId); }
    modules[localId] = { kind: entry.kind, ...(entry.title ? { title: String(entry.title) } : {}), config };
  }
  return modules;
}

/** Parse an `expose` list against `modules` → sorted "module.port" strings. */
function parseExpose(list, modules, where) {
  if (!Array.isArray(list)) fail(t('expose 必须是 "module.port" 数组'), where);
  const out = [];
  for (const [i, text] of list.entries()) {
    if (typeof text !== 'string') fail(t('expose 项必须是 "module.port"'), `${where}[${i}]`);
    const e = endpointOf(text, `${where}[${i}]`);
    if (!e.port || !Object.hasOwn(modules, e.module)) fail(t('expose 项 {text} 引用了不存在的模块或缺少端口', { text }), `${where}[${i}]`);
    out.push(`${e.module}.${e.port}`);
  }
  return out.sort();
}

/** The declared port `port` of a template module: { wire, dir, decl }, or null. */
function declaredPort(module, port) {
  const ports = scratchPorts(module);
  const out = ports.outputs.find(p => p.id === port), inp = ports.inputs.find(p => p.id === port);
  return out ? { wire: out.wire, dir: 'out', decl: out } : inp ? { wire: inp.wire, dir: 'in', decl: inp } : null;
}

/** Normalise `slots`: ids unique, each on a declared port of a template module. Each create entry is a valid module
 *  whose `ports` (defaulted) are its own declared ports and name slots of this template. A code entry without config
 *  stays without (checked against the stub its slot port gives it). */
function parseSlots(raw, modules) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(t('slots 必须是槽位数组'), 'slots');
  const ids = new Set();
  for (const [i, entry] of raw.entries()) {
    if (!plain(entry) || typeof entry.id !== 'string' || !LOCAL_ID.test(entry.id)) fail(t('槽位需要合法的 id'), `slots[${i}]`);
    if (ids.has(entry.id)) fail(t('槽位 id 重复：{id}', { id: entry.id }), `slots[${i}]`);
    ids.add(entry.id);
  }
  return raw.map((entry, i) => {
    const where = `slots[${i}]`;
    for (const key of Object.keys(entry)) if (!['id', 'title', 'port', 'create'].includes(key)) fail(t('槽位 {id} 含未知字段 {key}', { id: entry.id, key }), where);
    const title = entry.title === undefined ? entry.id : String(entry.title);
    if (!title.trim()) fail(t('槽位 {id} 的 title 不能为空', { id: entry.id }), where);
    if (typeof entry.port !== 'string') fail(t('槽位 {id} 需要 port："module.port"', { id: entry.id }), where);
    const e = endpointOf(entry.port, where);
    if (!e.port || !Object.hasOwn(modules, e.module)) fail(t('槽位 {id} 的端口 {port} 引用了不存在的模块或缺少端口', { id: entry.id, port: entry.port }), where);
    const decl = declaredPort(modules[e.module], e.port);
    if (!decl) fail(t('槽位 {id}：模块 {module} 没有端口 {port}', { id: entry.id, module: e.module, port: e.port }), where);
    if (!Array.isArray(entry.create ?? [])) fail(t('槽位 {id} 的 create 必须是数组', { id: entry.id }), where);
    const create = (entry.create ?? []).map((c, j) => {
      const at = `${where}.create[${j}]`;
      if (!plain(c)) fail(t('槽位 {id} 的新建项必须是对象', { id: entry.id }), at);
      for (const key of Object.keys(c)) if (!['kind', 'title', 'config', 'ports'].includes(key)) fail(t('槽位 {id} 的新建项含未知字段 {key}', { id: entry.id, key }), at);
      // a code entry without config: its ports are those of the stub the slot's contract writes (prefab.js stubSource)
      const stubbed = c.kind === 'code' && c.config === undefined;
      const stub = stubbed && decl.dir === 'in' ? stubSource(decl.decl) : null;
      if (stubbed && stub === null) fail(t('槽位 {id} 的端口没有可生成代码的协议。代码新建项需要写明 config', { id: entry.id }), at);
      const config = stubbed ? { source: stub } : c.config;
      const module = parseModules({ [entry.id]: { kind: c.kind, ...(c.title ? { title: c.title } : {}), ...(config ? { config } : {}) } })[entry.id];
      let ports = c.ports;
      if (ports === undefined) {
        const own = decl.dir === 'in' ? defaultOutput(module, decl.wire) : scratchPorts(module).inputs.find(p => p.wire === decl.wire)?.id;
        if (!own) fail(t('槽位 {id}：{kind} 没有能接上的端口，需要写明 ports', { id: entry.id, kind: module.kind }), at);
        ports = { [own]: entry.id };
      }
      if (!plain(ports) || !Object.keys(ports).length) fail(t('槽位 {id} 的新建项 ports 必须是 { 端口: 槽位 }', { id: entry.id }), at);
      for (const [port, slot] of Object.entries(ports)) {
        if (!declaredPort(module, port)) fail(t('槽位 {id}：{kind} 没有端口 {port}', { id: entry.id, kind: module.kind, port }), at);
        if (!ids.has(slot)) fail(t('槽位 {id} 的新建项接到了不存在的槽位 {target}', { id: entry.id, target: String(slot) }), at);
      }
      if (!Object.values(ports).includes(entry.id)) fail(t('槽位 {id} 的新建项必须接到槽位自己', { id: entry.id }), at);
      if (stubbed) delete module.config;
      return { ...module, ports: { ...ports } };
    });
    return { id: entry.id, title, port: `${e.module}.${e.port}`, create };
  });
}

/** Is template wire `text` the content of a slot: into an input slot, or out of an output slot into a module of a kind
 *  the slot creates (any kind when it creates none)? Everything else the template wires is expected. */
function slotContent(template, text) {
  const { from, to } = wireEnds(text);
  return template.slots.some(s => s.port === `${to.module}.${to.port}`
    || (s.port === `${from.module}.${from.port}` && (!s.create.length || s.create.some(c => c.kind === template.modules[to.module].kind))));
}

/** Normalise `groups`: every member a module or another group, listed once. No group inside itself. Exposes on
 *  (transitive) member modules. Group ids live in their own namespace: a group `rules` may hold the module `rules`. A
 *  member name that is both resolves to the module, so such a group can only sit directly in the template's top group. */
function parseGroups(raw, modules) {
  if (raw === undefined) return {};
  if (!plain(raw)) fail(t('groups 必须是 { 组合: { title, members, expose } }'));
  const groups = {}, moduleParent = new Map(), groupParent = new Map();
  for (const [localId, entry] of Object.entries(raw)) {
    const where = `groups.${localId}`;
    if (!LOCAL_ID.test(localId)) fail(t('组合本地 id {id} 不合法', { id: localId }), where);
    if (!plain(entry)) fail(t('组合 {id} 必须是对象', { id: localId }), where);
    for (const key of Object.keys(entry)) if (!['title', 'members', 'expose', 'loop'].includes(key)) fail(t('组合 {id} 含未知字段 {key}', { id: localId, key }), where);
    if (!Array.isArray(entry.members) || !entry.members.length) fail(t('组合 {id} 需要至少一个成员', { id: localId }), where);
    const title = entry.title === undefined ? localId : String(entry.title);
    if (!title.trim()) fail(t('组合 {id} 的 title 不能为空', { id: localId }), where);
    if (entry.loop !== undefined && !(typeof entry.loop === 'string' && Object.hasOwn(modules, entry.loop) && modules[entry.loop].kind === 'loop')) fail(t('组合 {id} 的 loop 必须是模板里的回路模块', { id: localId }), where);
    groups[localId] = { title, members: [...entry.members], expose: entry.expose ?? [], ...(entry.loop !== undefined ? { loop: entry.loop } : {}) };
  }
  for (const [localId, group] of Object.entries(groups)) {
    const where = `groups.${localId}`;
    for (const member of group.members) {
      const isModule = typeof member === 'string' && Object.hasOwn(modules, member), isGroup = !isModule && typeof member === 'string' && Object.hasOwn(groups, member);
      if (!isModule && !isGroup) fail(t('组合 {id} 的成员 {member} 不是模板里的模块或组合', { id: localId, member: String(member) }), where);
      const parent = isModule ? moduleParent : groupParent;
      if (parent.has(member)) fail(t('{member} 同时属于组合 {a} 和 {b}', { member, a: parent.get(member), b: localId }), where);
      parent.set(member, localId);
    }
    group.members.sort();
  }
  for (const localId of Object.keys(groups)) for (let g = groupParent.get(localId); g; g = groupParent.get(g)) if (g === localId) fail(t('组合 {id} 包含了自己', { id: localId }), `groups.${localId}`);
  const inside = g => groups[g].members.flatMap(m => (Object.hasOwn(modules, m) ? [m] : inside(m)));
  for (const [localId, group] of Object.entries(groups)) {
    const members = new Set(inside(localId));
    group.expose = parseExpose(group.expose, modules, `groups.${localId}.expose`);
    for (const text of group.expose) if (!members.has(endpointOf(text).module)) fail(t('组合 {id} 暴露的 {text} 不属于它的成员', { id: localId, text }), `groups.${localId}.expose`);
  }
  return groups;
}

/** Canonical order of call wires: alphabetical, but the wires into one port keep their written order among the
 *  positions they take. That order is meaningful (a tool layer's tools, ADR 0010 §2). */
function sortCallWires(list) {
  const target = text => text.split('→')[1], written = new Map();
  for (const text of list) { if (!written.has(target(text))) written.set(target(text), []); written.get(target(text)).push(text); }
  return [...list].sort().map(text => written.get(target(text)).shift());
}

/** Normalise `preset`: its label, and `accept` (a candidates module of the template → the name of the builtin artifact
 *  it accepts). null without one. */
function parsePreset(raw, modules) {
  if (raw === undefined) return null;
  if (!plain(raw) || typeof raw.label !== 'string' || !raw.label.trim()) fail(t('preset 必须是 { label, accept? }'), 'preset');
  for (const key of Object.keys(raw)) if (key !== 'label' && key !== 'accept') fail(t('preset 含未知字段 {key}', { key }), 'preset');
  const accept = raw.accept ?? {};
  if (!plain(accept)) fail(t('preset 必须是 { label, accept? }'), 'preset');
  for (const [local, name] of Object.entries(accept)) if (modules[local]?.kind !== 'candidates' || typeof name !== 'string' || !name.trim()) fail(t('preset.accept.{id} 必须是模板里的候选模块，值是内置产物名', { id: local }), 'preset');
  return { label: raw.label, accept: { ...accept } };
}

/** Parse YAML text or a plain object into a validated, canonical template. Throws TemplateError. */
export function parseTemplate(input) {
  let raw = input;
  if (typeof input === 'string') { try { raw = YAML.parse(input); } catch (error) { fail(t('YAML 解析失败：{message}', { message: error.message })); } }
  if (!plain(raw)) fail(t('模板必须是对象'));
  if (raw.format !== TEMPLATE_FORMAT) fail(t('需要 {format} 模板', { format: TEMPLATE_FORMAT }));
  for (const key of Object.keys(raw)) if (!['format', 'id', 'revision', 'name', 'kind', 'modules', 'wires', 'expose', 'layout', 'description', 'groups', 'slots', 'preset'].includes(key)) fail(t('模板含未知字段 {key}', { key }));
  if (typeof raw.id !== 'string' || !TEMPLATE_ID.test(raw.id)) fail(t('模板 id 必须是小写字母、数字、- 或 _'));
  const revision = raw.revision ?? 1;
  if (!Number.isInteger(revision) || revision < 1) fail(t('模板 revision 必须是正整数'));
  const name = raw.name ?? raw.id;
  if (typeof name !== 'string' || !name.trim()) fail(t('模板 name 不能为空'));
  const kind = raw.kind ?? 'composite';
  if (!TEMPLATE_KINDS.includes(kind)) fail(t('模板 kind 必须是 module / composite / canvas'));
  const modules = parseModules(raw.modules);
  if (kind === 'module' && Object.keys(modules).length !== 1) fail(t('单模块模板必须恰好包含一个模块'));
  const wiresRaw = raw.wires ?? {};
  if (!plain(wiresRaw)) fail(t('wires 必须是 { value, call }'));
  for (const key of Object.keys(wiresRaw)) if (key !== 'value' && key !== 'call') fail(t('wires 只能有 value 和 call'));
  const wires = [];
  for (const wireKind of ['value', 'call']) {
    const list = wiresRaw[wireKind] ?? [];
    if (!Array.isArray(list)) fail(t('wires.{kind} 必须是数组', { kind: wireKind }));
    list.forEach((text, i) => wires.push(parseWire(text, wireKind, modules, `wires.${wireKind}[${i}]`)));
  }
  const expose = parseExpose(raw.expose ?? [], modules, 'expose');
  const groups = parseGroups(raw.groups, modules);
  if (kind === 'module' && Object.keys(groups).length) fail(t('单模块模板不能有组合'));
  const slots = parseSlots(raw.slots, modules);
  if (kind === 'module' && slots.length) fail(t('单模块模板不能有槽位'));
  const preset = parsePreset(raw.preset, modules);
  const layout = {};
  if (raw.layout !== undefined) {
    if (!plain(raw.layout)) fail(t('layout 必须是 { 模块: {x, y} }'));
    for (const [localId, pos] of Object.entries(raw.layout)) {
      if (!Object.hasOwn(modules, localId) || !plain(pos) || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) fail(t('layout.{id} 必须是 {x, y}', { id: localId }), 'layout');
      layout[localId] = { x: pos.x, y: pos.y };
    }
  }
  const template = { format: TEMPLATE_FORMAT, id: raw.id, revision, name, kind, ...(raw.description ? { description: String(raw.description) } : {}), ...(preset ? { preset } : {}), modules, wires: { value: [], call: [] }, expose, groups, slots, layout };
  for (const w of wires) template.wires[w.kind].push(`${w.from.module}.${w.from.port}→${w.to.module}.${w.to.port}`);
  template.wires.value.sort(); template.wires.call = sortCallWires(template.wires.call);
  // Full validation: instantiate into a scratch graph so port existence, types, signatures and cycles are all checked.
  // Connecting checks each wire against its own ends. A wire can also type something further away (the scenario
  // wire types the Transition every objective receives). So the finished instance must carry no error either. Only
  // what is still to be wired (incomplete) may remain.
  const scratch = new ModuleGraph();
  try { instantiateInto(scratch, template, { x: 0, y: 0 }); }
  catch (error) { if (error instanceof GraphError || error instanceof TemplateError) fail(t('模板 {id} 无效：{message}', { id: raw.id, message: error.message })); throw error; }
  const error = scratch.problems().find(p => !p.incomplete);
  if (error) fail(t('模板 {id} 无效：{title}：{message}', { id: raw.id, title: scratch.node(error.node).title, message: error.message }));
  return canonicalize(template);
}

/** YAML for authoring/export. Fields a kind derives from the rest of its config (a code module's `exports`) are left
 *  out: parsing derives them again. */
export function templateToYAML(template) {
  const out = parseTemplate(template);
  for (const m of Object.values(out.modules)) if (m.kind === 'code') delete m.config.exports;
  for (const s of out.slots) for (const c of s.create) if (c.kind === 'code' && c.config) delete c.config.exports;
  if (!Object.keys(out.layout).length) delete out.layout;
  if (!Object.keys(out.groups).length) delete out.groups;
  if (!out.slots.length) delete out.slots;
  return YAML.stringify(out, { lineWidth: 0, blockQuote: 'literal' });
}

/** Each module's position relative to the template's origin: its layout entry, else a grid slot. */
function positions(template) {
  const ids = Object.keys(template.modules), out = {};
  ids.forEach((id, i) => {
    const pos = template.layout[id];
    out[id] = pos ? { x: pos.x, y: pos.y } : { x: (i % GRID.columns) * GRID.dx, y: Math.floor(i / GRID.columns) * GRID.dy };
  });
  return out;
}
const wireEnds = text => { const [a, b] = text.split('→'); return { from: endpointOf(a), to: endpointOf(b) }; };

const bbox = (nodes) => {
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + GRID.dx, h: Math.max(...ys) - Math.min(...ys) + GRID.dy };
};

/** Add a copy of the template to `graph` at (x, y) with fresh ids. Composite/canvas templates get a collapsed group
 *  that records `{ template:{id, revision} }`. The template's `groups` nest inside it (collapsed too). When the
 *  template declares slots, the group also gets its prefab record. The template becomes a graph description in its
 *  local ids that the graph admits strictly (fresh ids, all or nothing). Returns `{ nodes, group, ids, groupIds }`
 *  (ids: localId → node id, groupIds: group localId → group id). */
export function instantiateInto(graph, template, { x = 0, y = 0 } = {}) {
  const pos = positions(template), at = text => { const e = endpointOf(text); return { node: e.module, port: e.port }; };
  const nodes = Object.entries(template.modules).map(([localId, m]) => ({ id: localId, kind: m.kind, title: m.title ?? localId, ...pos[localId], config: m.config }));
  const wireOf = (kind, text) => { const { from, to } = wireEnds(text); return { kind, from: { node: from.module, port: from.port }, to: { node: to.module, port: to.port } }; };
  const wires = ['value', 'call'].flatMap(kind => template.wires[kind].map(text => wireOf(kind, text)));
  // Group local ids have their own namespace (a group `rules` may hold the module `rules`): in the description they
  // are `g:<localId>`, and `g:` alone is the template's own group (no module local id contains a colon).
  const groupId = localId => `g:${localId}`, TOP = 'g:';
  const groups = [];
  if (template.kind !== 'module') {
    const memberId = m => (Object.hasOwn(template.modules, m) ? m : groupId(m));
    const inside = localId => template.groups[localId].members.flatMap(m => (Object.hasOwn(template.modules, m) ? [m] : inside(m)));
    for (const [localId, g] of Object.entries(template.groups)) {
      groups.push({ id: groupId(localId), title: g.title, collapsed: true, ...bbox(inside(localId).map(m => pos[m])), members: g.members.map(memberId), expose: g.expose.map(at), ...(g.loop ? { loop: g.loop } : {}) });
    }
    const nested = new Set(Object.values(template.groups).flatMap(g => g.members.map(memberId)));
    const top = [...Object.keys(template.modules), ...Object.keys(template.groups).map(groupId)].filter(id => !nested.has(id));
    const prefab = template.slots.length ? {
      slots: template.slots.map(s => ({ id: s.id, title: s.title, ...at(s.port), create: s.create })),
      expect: ['value', 'call'].flatMap(kind => template.wires[kind].filter(text => !slotContent(template, text)).map(text => wireOf(kind, text))),
    } : null;
    groups.push({ id: TOP, title: template.name, template: { id: template.id, revision: template.revision }, collapsed: true, ...bbox(Object.values(pos)), members: top, expose: template.expose.map(at), ...(prefab ? { prefab } : {}) });
  }
  const admitted = graph.admit({ nodes, wires, groups }, { fresh: true, dx: x, dy: y }).ids;
  const ids = Object.fromEntries(Object.keys(template.modules).map(localId => [localId, admitted.get(localId)]));
  const groupIds = Object.fromEntries(Object.keys(template.groups).map(localId => [localId, admitted.get(groupId(localId))]));
  return { nodes: Object.values(ids).map(id => graph.node(id)), group: admitted.has(TOP) ? graph.group(admitted.get(TOP)) : null, ids, groupIds };
}

const slug = text => text.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1');

/** Turn a selection of nodes into a template: inner wires are kept, wires crossing the boundary become exposed ports
 *  (plus the exposes of any group covering the whole selection). Groups strictly inside the selection are recorded as
 *  the template's nested `groups`. */
export function fromSelection(graph, nodeIds, { id = freshId('tpl').toLowerCase().replace(/[^a-z0-9_-]/g, ''), name = id, revision = 1, kind = null, description } = {}) {
  const selected = [...new Set(nodeIds)];
  if (!selected.length) fail(t('请选择至少一个模块'));
  const set = new Set(selected), local = {}, used = new Set();
  const localId = (title, fallback) => {
    let base = slug(title) || fallback, candidate = base, n = 2;
    if (!LOCAL_ID.test(candidate)) candidate = base = fallback;
    while (used.has(candidate)) candidate = `${base}_${n++}`;
    used.add(candidate);
    return candidate;
  };
  const modules = {};
  const origin = { x: Math.min(...selected.map(n => graph.node(n).x)), y: Math.min(...selected.map(n => graph.node(n).y)) };
  const layout = {};
  for (const nodeId of selected) {
    const node = graph.node(nodeId);
    local[nodeId] = localId(node.title, node.kind);
    modules[local[nodeId]] = { kind: node.kind, title: node.title, config: structuredClone(node.config) };
    layout[local[nodeId]] = { x: node.x - origin.x, y: node.y - origin.y };
  }
  const wires = { value: [], call: [] }, expose = new Set();
  for (const wire of graph.wires.values()) {
    const fromIn = set.has(wire.from.node), toIn = set.has(wire.to.node);
    if (fromIn && toIn) wires[wire.kind].push(`${local[wire.from.node]}.${wire.from.port}→${local[wire.to.node]}.${wire.to.port}`);
    else if (fromIn) expose.add(`${local[wire.from.node]}.${wire.from.port}`);
    else if (toIn) expose.add(`${local[wire.to.node]}.${wire.to.port}`);
  }
  // A group whose nodes are exactly the selection is the composite being saved: its exposes become the template's.
  // A smaller group entirely inside the selection becomes a nested group of the template.
  const inside = [...graph.groups.values()].filter(g => { const m = graph.memberNodes(g.id); return m.length > 0 && m.every(n => set.has(n)); });
  const whole = inside.filter(g => graph.memberNodes(g.id).length === selected.length);
  for (const g of whole) for (const e of g.expose) expose.add(`${local[e.node]}.${e.port}`);
  const nested = inside.filter(g => !whole.includes(g)), groups = {};
  for (const g of nested) local[g.id] = localId(g.title, 'group');
  for (const g of nested) {
    groups[local[g.id]] = {
      title: g.title || local[g.id],
      members: g.members.filter(m => local[m] !== undefined).map(m => local[m]),
      expose: g.expose.map(e => `${local[e.node]}.${e.port}`),
      ...(g.loop && local[g.loop] ? { loop: local[g.loop] } : {}),
    };
  }
  // a prefab saved whole keeps its slots (its expected wires are the saved wires again: instantiation derives them)
  const prefab = whole.find(g => g.prefab)?.prefab ?? null;
  const slots = prefab ? prefab.slots.filter(s => local[s.node]).map(s => ({ id: s.id, title: s.title, port: `${local[s.node]}.${s.port}`, create: s.create })) : [];
  const template = { format: TEMPLATE_FORMAT, id, revision, name, kind: kind ?? (selected.length === 1 ? 'module' : 'composite'), ...(description ? { description } : {}), modules, wires, expose: [...expose], groups, ...(slots.length ? { slots } : {}), layout };
  return parseTemplate(template);
}
