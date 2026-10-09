// ir/check.js — structural analysis (ids, scopes, acyclicity, node budget) and static typing (types, tiers, worst-case
// cost) of a neurom-program. compile also uses `analyze`. `check` is the public entry.
import { t } from '../i18n.js';
import { LIMITS, NUMBER, BOOLEAN, SCALARS, ProgramError, plain, isInt, vectorType, arrayType, recordType, canonicalType, typeName, sameType, validKey, constantType } from './types.js';

export const PROGRAM_FORMAT = 'neurom-program';
const PROGRAM_KEYS = new Set(['format', 'params', 'nodes', 'output']);
const NODE_KEYS = new Set(['id', 'op', 'inputs', 'value', 'name', 'body']);
const BODY_KEYS = new Set(['params', 'nodes', 'output']);

/** op → arity ('variadic' = 1..n, 'variadic0' = 0..n) plus which node fields it carries (value / name / body param count). */
export const OPS = Object.freeze({
  constant: { arity: 0, value: true }, param: { arity: 0, name: true },
  add: { arity: 2 }, sub: { arity: 2 }, mul: { arity: 2 }, div: { arity: 2 }, mod: { arity: 2 }, neg: { arity: 1 },
  min: { arity: 2 }, max: { arity: 2 }, abs: { arity: 1 }, floor: { arity: 1 }, ceil: { arity: 1 }, round: { arity: 1 }, clamp: { arity: 3 },
  sqrt: { arity: 1 }, ln: { arity: 1, approx: true }, exp: { arity: 1, approx: true },
  lt: { arity: 2 }, lte: { arity: 2 }, gt: { arity: 2 }, gte: { arity: 2 }, eq: { arity: 2 }, neq: { arity: 2 },
  and: { arity: 2 }, or: { arity: 2 }, not: { arity: 1 }, select: { arity: 3 },
  vector: { arity: 'variadic' }, concat: { arity: 'variadic' }, bits: { arity: 2 }, oneHot: { arity: 2 }, at: { arity: 2 }, slice: { arity: 3 },
  get: { arity: 1, name: true }, record: { arity: 'variadic0', value: true }, set: { arity: 2, name: true },
  array: { arity: 'variadic' }, index: { arity: 2 }, update: { arity: 3 }, range: { arity: 0, value: true },
  map: { arity: 1, body: 2 }, fold: { arity: 2, body: 3 }, scan: { arity: 2, body: 3 },
  u32: { arity: 1 }, imul32: { arity: 2 }, add32: { arity: 2 }, sub32: { arity: 2 }, xor32: { arity: 2 }, and32: { arity: 2 }, or32: { arity: 2 }, shl32: { arity: 2 }, shr32: { arity: 2 },
  rand: { arity: 2 },
  bucket: { arity: 1, value: true }, thermometer: { arity: 1, value: true },
  tableAt: { arity: 2, name: true }, tableWindow: { arity: 2, name: true, value: true },
  sum: { arity: 1 }, minOf: { arity: 1 }, maxOf: { arity: 1 }, argminFirst: { arity: 1 }, argmaxFirst: { arity: 1 }, any: { arity: 1 }, all: { arity: 1 }, count: { arity: 1 },
});
/** Inputs evaluated only when taken (index into `inputs`). */
export const LAZY_INPUTS = Object.freeze({ select: [1, 2], and: [1], or: [1] });

const err = (message, node) => new ProgramError(message, node?.id ?? null, node?.op ?? null);

/**
 * Structure only (no types). Every node in every scope is registered once (ids are unique program-wide). Inputs resolve
 * to the same or an enclosing scope. Scopes are acyclic. Returns { scopes, nodes: Map id → { node, scope }, root }.
 * scope = { params, order: [id…], output, parent, owner (map/fold/scan node id or null) }. A body can have no nodes of
 * its own (then its output is an enclosing node, for example `arr.map(() => k)`). The program needs at least one node.
 */
export function analyzeStructure(program) {
  if (!plain(program)) throw new ProgramError(t('程序必须是纯 JSON 对象'));
  for (const key of Object.keys(program)) if (!PROGRAM_KEYS.has(key)) throw new ProgramError(t('程序含未知字段：{key}', { key }));
  if (program.format !== PROGRAM_FORMAT) throw new ProgramError(t('程序格式必须是 {format}', { format: PROGRAM_FORMAT }));
  if (!Array.isArray(program.params) || program.params.some(p => !validKey(p)) || new Set(program.params).size !== program.params.length) throw new ProgramError(t('params 必须是互不重复的参数名数组'));
  const nodes = new Map(), scopes = [];
  let count = 0;
  const register = (scope, list, output) => {
    if (!Array.isArray(list) || (list.length === 0 && scope.owner === null)) throw err(t('程序至少需要一个节点'), scope.owner);
    for (const node of list) {
      if (!plain(node)) throw err(t('节点必须是纯 JSON 对象'), scope.owner);
      const { id, op, inputs } = node;
      if (typeof id !== 'string' || id.length === 0 || id.length > LIMITS.maxIdLength) throw new ProgramError(t('节点 id 必须是 1..{max} 字符的字符串', { max: LIMITS.maxIdLength }));
      if (nodes.has(id)) throw new ProgramError(t('节点 id 重复：{id}', { id }), id);
      if (++count > LIMITS.maxNodes) throw new ProgramError(t('程序最多 {max} 个节点', { max: LIMITS.maxNodes }), id);
      for (const key of Object.keys(node)) if (!NODE_KEYS.has(key)) throw new ProgramError(t('节点含未知字段：{key}', { key }), id);
      if (typeof op !== 'string' || !Object.hasOwn(OPS, op)) throw new ProgramError(t('未知操作：{op}', { op: String(op) }), id);
      const spec = OPS[op];
      if (!Array.isArray(inputs) || inputs.some(x => typeof x !== 'string')) throw err(t('inputs 必须是节点 id 数组'), node);
      if (spec.arity === 'variadic') { if (inputs.length === 0) throw err(t('{op} 至少需要一个输入', { op }), node); }
      else if (spec.arity !== 'variadic0' && inputs.length !== spec.arity) throw err(t('{op} 需要 {arity} 个输入，收到 {count}', { op, arity: spec.arity, count: inputs.length }), node);
      if (spec.value ? !Object.hasOwn(node, 'value') : Object.hasOwn(node, 'value')) throw err(spec.value ? t('{op} 缺少 value', { op }) : t('{op} 不能带 value', { op }), node);
      if (spec.name ? typeof node.name !== 'string' : Object.hasOwn(node, 'name')) throw err(spec.name ? t('{op} 缺少 name', { op }) : t('{op} 不能带 name', { op }), node);
      if (spec.body ? !plain(node.body) : Object.hasOwn(node, 'body')) throw err(spec.body ? t('{op} 缺少 body', { op }) : t('{op} 不能带 body', { op }), node);
      const entry = { node, scope, body: null };
      nodes.set(id, entry);
      if (spec.body) {
        const { body } = node;
        for (const key of Object.keys(body)) if (!BODY_KEYS.has(key)) throw err(t('body 含未知字段：{key}', { key }), node);
        if (!Array.isArray(body.params) || body.params.length !== spec.body || body.params.some(p => !validKey(p)) || new Set(body.params).size !== spec.body) throw err(t('{op} 的 body 需要 {count} 个互不重复的参数名', { op, count: spec.body }), node);
        const inner = { params: body.params, order: [], output: body.output, parent: scope, owner: node };
        entry.body = inner;
        scopes.push(inner);
        register(inner, body.nodes, body.output);
      }
    }
    if (typeof output !== 'string') throw err(t('输出节点不存在：{output}', { output: String(output) }), scope.owner);
  };
  // A scope's output names one of its own nodes or (a body returning a closure value) a node of an enclosing scope.
  const visible = (scope, id) => { const target = nodes.get(id); for (let s = scope; s && target; s = s.parent) if (s === target.scope) return true; return false; };
  const checkOutput = scope => { if (!visible(scope, scope.output)) throw err(t('输出节点不存在：{output}', { output: String(scope.output) }), scope.owner); };
  const root = { params: program.params, order: [], output: program.output, parent: null, owner: null };
  scopes.push(root);
  register(root, program.nodes, program.output);
  for (const scope of scopes) checkOutput(scope);
  // Inputs resolve to the same or an enclosing scope. Bodies are private to their owner.
  for (const { node, scope } of nodes.values()) {
    for (const input of node.inputs) {
      const target = nodes.get(input);
      if (!target) throw err(t('节点 {id} 引用了不存在的节点 {input}', { id: node.id, input }), node);
      let s = scope;
      while (s && s !== target.scope) s = s.parent;
      if (!s) throw err(t('节点 {id} 引用了其他 body 内部的节点 {input}', { id: node.id, input }), node);
    }
  }
  // Iterative DFS over the dependency graph (inputs, and body outputs for body owners): per-scope and global topological order.
  const state = new Map(), order = [];
  const deps = node => (OPS[node.op].body ? [...node.inputs, node.body.output] : node.inputs);
  for (const rootId of nodes.keys()) {
    if (state.has(rootId)) continue;
    const stack = [[rootId, 0]]; state.set(rootId, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1], entry = nodes.get(frame[0]), d = deps(entry.node);
      if (frame[1] < d.length) {
        const next = d[frame[1]++], s = state.get(next);
        if (s === 1) throw new ProgramError(t('节点 {id} 形成环路', { id: next }), next, nodes.get(next).node.op);
        if (s === undefined) { state.set(next, 1); stack.push([next, 0]); }
      } else { state.set(frame[0], 2); entry.scope.order.push(frame[0]); order.push(frame[0]); stack.pop(); }
    }
  }
  return { scopes, nodes, root, order };
}

function constantInput(entry, nodes, index, what, [min, max]) {
  const ref = nodes.get(entry.node.inputs[index]).node, node = entry.node;
  if (ref.op !== 'constant' || typeof ref.value !== 'number') throw err(t('{op} 的{what}必须是数值常量节点', { op: node.op, what }), node);
  if (!isInt(ref.value, min, max)) throw err(t('{op} 的{what}必须是 {min}..{max} 的整数，收到 {value}', { op: node.op, what, min, max, value: ref.value }), node);
  return ref.value;
}
function edges(node) {
  const { value } = node;
  if (!Array.isArray(value) || value.length === 0 || value.length > LIMITS.maxVectorWidth || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw err(t('{op} 的分界点必须是非空有限数数组', { op: node.op }), node);
  for (let i = 1; i < value.length; i++) if (!(value[i] > value[i - 1])) throw err(t('{op} 的分界点必须严格递增', { op: node.op }), node);
  return value;
}

/** Type every node of every scope. `paramTypes` align with program.params. Returns the typing tables that compile uses.
 *  `types` (optional) is the node id → type map to fill. It keeps the types found before a later node throws. */
export function analyze(program, paramTypes, { exact = false, types = new Map() } = {}) {
  const structure = analyzeStructure(program), { nodes, root } = structure;
  if (!Array.isArray(paramTypes) || paramTypes.length !== root.params.length) throw new ProgramError(t('参数类型数量 {given} 与参数数量 {expected} 不一致', { given: Array.isArray(paramTypes) ? paramTypes.length : 0, expected: root.params.length }));
  const rootTypes = paramTypes.map((type, i) => canonicalType(type, t('参数 {name} 的类型', { name: root.params[i] })));
  const scopeParamTypes = new Map([[root, rootTypes]]), paramRefs = new Map();
  const typeScope = scope => {
    for (const id of scope.order) types.set(id, typeOf(nodes.get(id), nodes, types, scope, scopeParamTypes, paramRefs, typeScope, exact));
  };
  typeScope(root);
  // Worst-case cost: every node once per scope evaluation. Bodies run once per element.
  const costOf = scope => {
    let total = 0;
    for (const id of scope.order) { const entry = nodes.get(id); total += 1; if (entry.body) total += types.get(entry.node.inputs[0]).length * costOf(entry.body); }
    return total;
  };
  const cost = costOf(root);
  if (cost > LIMITS.maxCost) throw new ProgramError(t('程序最坏情况需要 {cost} 次节点求值，超过上限 {max}', { cost, max: LIMITS.maxCost }), root.output);
  return { ...structure, types, paramTypes: rootTypes, paramRefs, cost, result: types.get(root.output) };
}

function typeOf(entry, nodes, types, scope, scopeParamTypes, paramRefs, typeScope, exact) {
  const { node } = entry, { id, op, inputs } = node;
  const ty = i => types.get(inputs[i]);
  const expect = (i, type) => { if (ty(i).type !== type) throw err(t('{op} 的第 {index} 个输入必须是 {type}，实际是 {actual}', { op, index: i + 1, type, actual: typeName(ty(i)) }), node); return ty(i); };
  const same = (a, b, what) => { if (!sameType(a, b)) throw err(t('{op} 的{what}类型必须一致：{left} 与 {right}', { op, what, left: typeName(a), right: typeName(b) }), node); };
  const numbers = () => { for (let i = 0; i < inputs.length; i++) expect(i, 'number'); return NUMBER; };
  if (OPS[op].approx && exact) throw err(t('精确层不允许 {op}', { op }), node);
  switch (op) {
    case 'constant': { const type = constantType(node.value); if (!type) throw err(t('constant 的 value 必须是有限数、布尔值或字符串'), node); return type; }
    case 'param': {
      for (let s = scope; s; s = s.parent) {
        const index = s.params.indexOf(node.name);
        if (index >= 0) { paramRefs.set(id, { scope: s, index }); return scopeParamTypes.get(s)[index]; }
      }
      throw err(t('未定义的参数 {name}', { name: node.name }), node);
    }
    case 'add': case 'sub': case 'mul': case 'div': case 'mod': case 'min': case 'max': case 'neg': case 'abs': case 'floor': case 'ceil': case 'round': case 'clamp': case 'sqrt': case 'ln': case 'exp':
      return numbers();
    case 'lt': case 'lte': case 'gt': case 'gte': numbers(); return BOOLEAN;
    case 'eq': case 'neq':
      if (!SCALARS.includes(ty(0).type)) throw err(t('{op} 只比较数、布尔值或字符串，实际是 {actual}', { op, actual: typeName(ty(0)) }), node);
      same(ty(0), ty(1), t('两侧'));
      return BOOLEAN;
    case 'and': case 'or': expect(0, 'boolean'); expect(1, 'boolean'); return BOOLEAN;
    case 'not': expect(0, 'boolean'); return BOOLEAN;
    case 'select': expect(0, 'boolean'); same(ty(1), ty(2), t('两个分支')); return ty(1);
    case 'vector':
      numbers();
      if (inputs.length > LIMITS.maxVectorWidth) throw err(t('向量最多 {max} 个元素', { max: LIMITS.maxVectorWidth }), node);
      return vectorType(inputs.length);
    case 'concat': {
      let width = 0;
      for (let i = 0; i < inputs.length; i++) {
        const type = ty(i);
        if (type.type === 'vector') width += type.width;
        else if (type.type === 'array' && type.of.type === 'number') width += type.length;
        else if (type.type === 'array' && type.of.type === 'vector') width += type.length * type.of.width;
        else throw err(t('concat 的第 {index} 个输入必须是向量或数值数组，实际是 {actual}', { index: i + 1, actual: typeName(type) }), node);
      }
      if (width > LIMITS.maxVectorWidth) throw err(t('拼接后宽度 {width} 超过 {max}', { width, max: LIMITS.maxVectorWidth }), node);
      return vectorType(width);
    }
    case 'bits': expect(0, 'number'); return vectorType(constantInput(entry, nodes, 1, t('位宽'), [1, LIMITS.maxBitsWidth]));
    case 'oneHot': expect(0, 'number'); return vectorType(constantInput(entry, nodes, 1, t('宽度'), [1, LIMITS.maxVectorWidth]));
    case 'at': expect(0, 'vector'); expect(1, 'number'); return NUMBER;
    case 'slice': {
      const { width } = expect(0, 'vector'), start = constantInput(entry, nodes, 1, t('起点'), [0, width - 1]), end = constantInput(entry, nodes, 2, t('终点'), [start + 1, width]);
      return vectorType(end - start);
    }
    case 'get': {
      const { fields } = expect(0, 'record');
      if (!Object.hasOwn(fields, node.name)) throw err(t('记录 {record} 没有字段 {name}', { record: typeName(ty(0)), name: node.name }), node);
      return fields[node.name];
    }
    case 'record': {
      const keys = node.value;
      if (!Array.isArray(keys) || keys.length !== inputs.length || keys.some(k => !validKey(k)) || new Set(keys).size !== keys.length) throw err(t('record 的 value 必须是与输入一一对应、互不重复的字段名数组'), node);
      if (keys.length > LIMITS.maxRecordFields) throw err(t('记录最多 {max} 个字段', { max: LIMITS.maxRecordFields }), node);
      const fields = {};
      keys.forEach((key, i) => { fields[key] = ty(i); });
      return recordType(fields);
    }
    case 'set': {
      const type = expect(0, 'record');
      if (!Object.hasOwn(type.fields, node.name)) throw err(t('记录 {record} 没有字段 {name}', { record: typeName(type), name: node.name }), node);
      same(type.fields[node.name], ty(1), t('字段 {name} 的', { name: node.name }));
      return type;
    }
    case 'array':
      for (let i = 1; i < inputs.length; i++) same(ty(0), ty(i), t('元素'));
      if (inputs.length > LIMITS.maxArrayLength) throw err(t('数组最多 {max} 个元素', { max: LIMITS.maxArrayLength }), node);
      return arrayType(inputs.length, ty(0));
    case 'index': {
      const type = ty(0);
      if (type.type !== 'array' && type.type !== 'vector') throw err(t('index 的第 1 个输入必须是数组或向量，实际是 {actual}', { actual: typeName(type) }), node);
      expect(1, 'number');
      return type.type === 'array' ? type.of : NUMBER;
    }
    case 'update': { const type = expect(0, 'array'); expect(1, 'number'); same(type.of, ty(2), t('元素')); return type; }
    case 'range':
      if (!isInt(node.value, 1, LIMITS.maxArrayLength)) throw err(t('range 的 value 必须是 1..{max} 的整数', { max: LIMITS.maxArrayLength }), node);
      return arrayType(node.value, NUMBER);
    case 'map': case 'fold': case 'scan': {
      const array = expect(0, 'array'), inner = entry.body, init = op === 'map' ? null : ty(1);
      scopeParamTypes.set(inner, op === 'map' ? [array.of, NUMBER] : [init, array.of, NUMBER]);
      typeScope(inner);
      const result = types.get(inner.output);
      if (op === 'map') return arrayType(array.length, result);
      same(init, result, t('累加器与 body 结果'));
      return op === 'fold' ? init : arrayType(array.length, init);
    }
    case 'u32': case 'imul32': case 'add32': case 'sub32': case 'xor32': case 'and32': case 'or32': case 'shl32': case 'shr32': case 'rand': return numbers();
    case 'sum': case 'minOf': case 'maxOf': case 'argminFirst': case 'argmaxFirst': {
      const type = ty(0);
      if (type.type !== 'vector' && !(type.type === 'array' && type.of.type === 'number')) throw err(t('{op} 的输入必须是向量或数值数组，实际是 {actual}', { op, actual: typeName(type) }), node);
      return NUMBER;
    }
    case 'any': case 'all': case 'count': {
      const type = ty(0);
      if (type.type !== 'array' || type.of.type !== 'boolean') throw err(t('{op} 的输入必须是布尔数组，实际是 {actual}', { op, actual: typeName(type) }), node);
      return op === 'count' ? NUMBER : BOOLEAN;
    }
    case 'bucket': expect(0, 'number'); edges(node); return NUMBER;
    case 'thermometer': expect(0, 'number'); return vectorType(edges(node).length);
    case 'tableAt': case 'tableWindow': {
      const table = expect(0, 'table'); expect(1, 'number');
      if (!table.columns.includes(node.name)) throw err(t('数据表 {table} 没有列 {name}', { table: typeName(table), name: node.name }), node);
      if (op === 'tableAt') return NUMBER;
      if (!isInt(node.value, 1, LIMITS.maxVectorWidth)) throw err(t('tableWindow 的窗口长度必须是 1..{max} 的整数', { max: LIMITS.maxVectorWidth }), node);
      return vectorType(node.value);
    }
    default: throw err(t('未知操作：{op}', { op }), node);
  }
}

/** Public: type-check a program against its parameter types. Throws ProgramError. Returns { result, cost }. */
export function check(program, paramTypes, options) {
  const { result, cost } = analyze(program, paramTypes, options);
  return { result, cost };
}

/** Editor hovers: `types` (node id → type) of every node typed before the first failure, and that failure (null when
 *  the program checks). Never throws. */
export function typeNodes(program, paramTypes, options) {
  const types = new Map();
  try { analyze(program, paramTypes, { ...options, types }); return { types, error: null }; }
  catch (error) { return { types, error }; }
}
