// ir/parse.js — the restricted JavaScript subset → neurom-program. @babel/parser produces the AST (never eval). This
// module lowers it into the flat IR with structural CSE per scope. It hoists body-independent nodes to the outermost
// scope that can see their inputs. TypeScript-only syntax (annotations, generics, assertions, type declarations) is
// rejected with its location. Types come from the call site (check/compile), never from the source.
import { parse as babelParse } from '@babel/parser';
import { t } from '../i18n.js';
import { LIMITS, ProgramError } from './types.js';
import { PROGRAM_FORMAT, OPS, analyzeStructure } from './check.js';

const MAX_SOURCE_CHARS = 256 * 1024;

/** Source-level failure: `loc` / `end` are { line (1-based), column (0-based) } into the parsed text. */
export class ProgramSourceError extends Error {
  constructor(message, loc, end = loc) {
    super(t('第{line}行第{column}列：{message}', { line: loc.line, column: loc.column + 1, message })); this.name = 'ProgramSourceError'; this.loc = { line: loc.line, column: loc.column }; this.end = { line: end.line, column: end.column }; this.detail = message;
  }
}

export const MATH_OPS = Object.freeze({ min: 'min', max: 'max', abs: 'abs', floor: 'floor', ceil: 'ceil', round: 'round', sqrt: 'sqrt', log: 'ln', exp: 'exp' });
const PLAIN_HELPERS = new Set(['concat', 'bits', 'oneHot', 'at', 'slice', 'clamp', 'u32', 'imul32', 'add32', 'sub32', 'xor32', 'and32', 'or32', 'shl32', 'shr32', 'rand', 'array', 'update', 'sum', 'minOf', 'maxOf', 'argminFirst', 'argmaxFirst', 'any', 'all', 'count']);
export const HELPERS = new Set([...PLAIN_HELPERS, 'range', 'bucket', 'thermometer', 'scan', ...Object.keys(MATH_OPS)]);
const CONSTANT_ARGS = { bits: [1], oneHot: [1], slice: [1, 2] };
const BINARY = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte', '===': 'eq', '!==': 'neq' };
export const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await', 'undefined', 'NaN', 'Infinity', 'Math', 'eval', 'arguments', 'implements', 'interface', 'package', 'private', 'protected', 'public']);
const NON_NUMERIC_LITERALS = new Set(['StringLiteral', 'TemplateLiteral', 'BooleanLiteral', 'ObjectExpression', 'ArrayExpression']);
const BODY_PARAMS = { map: ['elem', 'index'], fold: ['acc', 'elem', 'index'], scan: ['acc', 'elem', 'index'] };

function locOf(node) { return node.loc ? { line: node.loc.start.line, column: node.loc.start.column } : { line: 1, column: 0 }; }
function endOf(node) { return node.loc ? { line: node.loc.end.line, column: node.loc.end.column } : locOf(node); }
function fail(node, message) { return new ProgramSourceError(message, locOf(node), endOf(node)); }

/** One IR scope under construction (the program or a map/fold/scan body). */
class IrScope {
  constructor(parent, params) { this.parent = parent; this.params = params; this.depth = parent ? parent.depth + 1 : 0; this.nodes = []; this.keys = new Map(); }
}

/** Lowering state: the IR under construction with structural CSE and outward hoisting. Next to it, the builder keeps
 *  data that only parseModule reads:
 *   - hover spans (a source range → what it names and the IR node that holds its value)
 *   - field paths (node id → [root param, field…] for every param and every `get` chain on a param)
 *   - key docs (record / set node id → {key: JSDoc}). */
class Builder {
  constructor() { this.root = new IrScope(null, []); this.scope = this.root; this.counter = 0; this.locs = new Map(); this.depthOf = new Map(); this.spans = []; this.paths = new Map(); this.keyDocs = Object.create(null); }
  /** Create (or reuse) a node whose inputs are already lowered. It is in the outermost scope that sees all inputs. */
  node(op, inputs, extra, src, body = null) {
    let depth = 0;
    for (const id of inputs) depth = Math.max(depth, this.depthOf.get(id));
    if (body || op === 'param') depth = this.scope.depth;
    let scope = this.scope;
    while (scope.depth > depth) scope = scope.parent;
    const key = body ? null : op + '\u0000' + inputs.join('\u0001') + '\u0000' + JSON.stringify([extra.value, extra.name]);
    let id = key === null ? undefined : scope.keys.get(key);
    if (id === undefined) {
      if (this.counter >= LIMITS.maxNodes) throw fail(src, t('程序最多 {max} 个节点', { max: LIMITS.maxNodes }));
      id = `${op}_${++this.counter}`;
      const node = { id, op, inputs, ...extra };
      if (body) node.body = body;
      scope.nodes.push(node);
      if (key !== null) scope.keys.set(key, id);
      this.locs.set(id, src); this.depthOf.set(id, depth);
      if (op === 'param' && scope === this.root) this.paths.set(id, [extra.name]);
      else if (op === 'get' && this.paths.has(inputs[0])) this.paths.set(id, [...this.paths.get(inputs[0]), extra.name]);
    }
    return { kind: 'node', id };
  }
  /** Hover span over `src` (`info` = { kind, name, … }). `id` can be filled in when the value is lowered. */
  span(src, info, id = null) { const s = { start: src.start, end: src.end, ...info, id }; this.spans.push(s); return s; }
  /** `key` of the record / set node `id` is documented by `doc` (CSE-shared literals keep the first doc per key). */
  keyDoc(id, key, doc) { const docs = (this.keyDocs[id] ??= Object.create(null)); docs[key] ??= doc; }
  constant(value, src) { return this.node('constant', [], { value }, src); }
  param(scope, name, src) {
    const saved = this.scope; this.scope = scope;
    try { return this.node('param', [], { name }, src); } finally { this.scope = saved; }
  }
  /** Lower `fn` inside a fresh body scope with the given parameter names. Returns the body JSON. */
  body(names, lower) {
    const inner = new IrScope(this.scope, names), saved = this.scope;
    this.scope = inner;
    try { const output = lower(inner); return { params: names, nodes: inner.nodes, output }; } finally { this.scope = saved; }
  }
}

/** A lowered value is one of these: a node, a zero-argument pure expression helper used for lazy sharing, a helper
 *  function of a scenario (inlined where it is called), or a scenario name that this unit must not read (`denied`, with
 *  the reason). */
function asNode(ref, src) {
  if (ref.kind === 'deferred') throw fail(src, t('表达式辅助函数必须通过 () 调用'));
  if (ref.kind === 'function') throw fail(src, t('{name} 是函数，必须调用', { name: ref.name }));
  if (ref.kind === 'denied') throw fail(src, ref.message);
  return ref;
}

/** Name → lowered value, plus what each name is for hovers (`info`: { kind: 'param' | 'const' | 'fn' | 'arg', name, … }).
 *  A scenario's file scope has `resolve(name)`: file-level names (inputs, top-level consts, functions) are declared
 *  there on first use. */
class Scope {
  constructor(parent = null) { this.parent = parent; this.names = new Map(); this.infos = new Map(); this.resolve = null; }
  lookup(name) {
    for (let s = this; s; s = s.parent) {
      if (s.names.has(name)) return s.names.get(name);
      if (s.resolve) { const ref = s.resolve(name); if (ref !== undefined) return ref; }
    }
    return undefined;
  }
  infoOf(name) { for (let s = this; s; s = s.parent) if (s.infos.has(name)) return s.infos.get(name); return undefined; }
  declare(name, ref, src, info) {
    if (this.names.has(name)) throw fail(src, t('重复声明：{name}', { name }));
    if (RESERVED.has(name) || HELPERS.has(name)) throw fail(src, t('不能使用保留名称 {name}', { name }));
    this.names.set(name, ref); this.infos.set(name, { ...info, name });
  }
  get root() { let s = this; while (s.parent) s = s.parent; return s; }
}

function propertyKey(prop) {
  if (prop.computed) throw fail(prop, t('不支持计算属性名'));
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'StringLiteral') return prop.key.value;
  throw fail(prop.key, t('属性名必须是标识符或字符串'));
}
/** A field access `x.name` / `x['name']`: hover span on the key, valued by the `get` node. */
function fieldSpan(builder, key, ref, name) { builder.span(key, { kind: 'field', name }, ref.id); return ref; }

/** Bind a `const` pattern. `doc` is the JSDoc of the declaration. Every bound name and destructured key gets a hover span. */
function bindPattern(builder, scope, pattern, ref, doc) {
  if (pattern.type === 'Identifier') {
    scope.declare(pattern.name, ref, pattern, { kind: 'const', doc });
    if (ref.kind === 'node') builder.span(pattern, scope.infoOf(pattern.name), ref.id);
    return;
  }
  if (pattern.type !== 'ObjectPattern') throw fail(pattern, t('只支持标识符或对象解构'));
  const record = asNode(ref, pattern);
  for (const prop of pattern.properties) {
    if (prop.type !== 'ObjectProperty') throw fail(prop, t('解构只支持 { 名称 } 或 { 名称: 别名 } 形式'));
    const key = propertyKey(prop), value = prop.value;
    if (value.type === 'AssignmentPattern') throw fail(value, t('解构不支持默认值'));
    const field = builder.node('get', [record.id], { name: key }, prop);
    if (!prop.shorthand) builder.span(prop.key, { kind: 'field', name: key }, field.id);   // shorthand: the name's own span says it
    bindPattern(builder, scope, value, field, doc);
  }
}

function numericLiteral(expr) {
  if (expr.type === 'NumericLiteral') return expr.value;
  if (expr.type === 'UnaryExpression' && expr.operator === '-' && expr.argument.type === 'NumericLiteral') return -expr.argument.value;
  return null;
}
function stringLiteral(expr) {
  if (expr.type === 'StringLiteral') return expr.value;
  if (expr.type === 'TemplateLiteral' && expr.expressions.length === 0) return expr.quasis[0].value.cooked;
  return null;
}

function lowerExpression(builder, scope, expr) {
  switch (expr.type) {
    case 'NumericLiteral':
      if (!Number.isFinite(expr.value)) throw fail(expr, t('数值必须有限'));
      return builder.constant(expr.value, expr);
    case 'BooleanLiteral': return builder.constant(expr.value, expr);
    case 'StringLiteral': return builder.constant(expr.value, expr);
    case 'TemplateLiteral': {
      const value = stringLiteral(expr);
      if (value === null) throw fail(expr, t('模板字符串不能包含表达式'));
      return builder.constant(value, expr);
    }
    case 'Identifier': {
      const ref = scope.lookup(expr.name);
      if (ref === undefined) throw fail(expr, HELPERS.has(expr.name) ? t('{name} 是函数，必须调用', { name: expr.name }) : t('未定义的名称 {name}', { name: expr.name }));
      if (ref.kind === 'denied') throw fail(expr, ref.message);
      if (ref.kind === 'node') builder.span(expr, scope.infoOf(expr.name), ref.id);
      return ref;
    }
    case 'MemberExpression': {
      if (expr.optional) throw fail(expr, t('不支持可选链'));
      const object = asNode(lowerExpression(builder, scope, expr.object), expr.object);
      if (!expr.computed) {
        if (expr.property.type !== 'Identifier') throw fail(expr.property, t('属性名必须是标识符'));
        return fieldSpan(builder, expr.property, builder.node('get', [object.id], { name: expr.property.name }, expr), expr.property.name);
      }
      const key = stringLiteral(expr.property);
      if (key !== null) return fieldSpan(builder, expr.property, builder.node('get', [object.id], { name: key }, expr), key);
      const index = asNode(lowerExpression(builder, scope, expr.property), expr.property);
      return builder.node('index', [object.id, index.id], {}, expr);
    }
    case 'UnaryExpression': {
      const arg = expr.argument;
      if (expr.operator === '-' && arg.type === 'NumericLiteral') return builder.constant(-arg.value, expr);
      if (expr.operator === '-') return builder.node('neg', [asNode(lowerExpression(builder, scope, arg), arg).id], {}, expr);
      if (expr.operator === '!') return builder.node('not', [asNode(lowerExpression(builder, scope, arg), arg).id], {}, expr);
      throw fail(expr, t('不支持的一元运算符 {operator}', { operator: expr.operator }));
    }
    case 'BinaryExpression': {
      const op = BINARY[expr.operator];
      if (!op) throw fail(expr, expr.operator === '==' || expr.operator === '!=' ? t('请使用 {operator}= 进行严格比较', { operator: expr.operator }) : t('不支持的运算符 {operator}', { operator: expr.operator }));
      const left = asNode(lowerExpression(builder, scope, expr.left), expr.left), right = asNode(lowerExpression(builder, scope, expr.right), expr.right);
      return builder.node(op, [left.id, right.id], {}, expr);
    }
    case 'LogicalExpression': {
      if (expr.operator !== '&&' && expr.operator !== '||') throw fail(expr, t('不支持的运算符 {operator}', { operator: expr.operator }));
      const left = asNode(lowerExpression(builder, scope, expr.left), expr.left), right = asNode(lowerExpression(builder, scope, expr.right), expr.right);
      return builder.node(expr.operator === '&&' ? 'and' : 'or', [left.id, right.id], {}, expr);
    }
    case 'ConditionalExpression': {
      const test = asNode(lowerExpression(builder, scope, expr.test), expr.test);
      const yes = asNode(lowerExpression(builder, scope, expr.consequent), expr.consequent), no = asNode(lowerExpression(builder, scope, expr.alternate), expr.alternate);
      return builder.node('select', [test.id, yes.id, no.id], {}, expr);
    }
    case 'ArrayExpression': {
      if (expr.elements.length === 0) throw fail(expr, t('向量不能为空'));
      // `[…]` is a vector unless an element is visibly not a number (string / boolean / record / nested literal): then an array.
      if (expr.elements.every(el => el && el.type !== 'SpreadElement') && expr.elements.some(el => NON_NUMERIC_LITERALS.has(el.type))) {
        return builder.node('array', expr.elements.map(el => asNode(lowerExpression(builder, scope, el), el).id), {}, expr);
      }
      const parts = []; let scalars = []; let hasSpread = false;
      const flush = () => { if (scalars.length) { parts.push(builder.node('vector', scalars.map(n => n.id), {}, expr).id); scalars = []; } };
      for (const element of expr.elements) {
        if (element === null) throw fail(expr, t('向量不能有空位'));
        if (element.type === 'SpreadElement') { hasSpread = true; flush(); parts.push(asNode(lowerExpression(builder, scope, element.argument), element.argument).id); }
        else scalars.push(asNode(lowerExpression(builder, scope, element), element));
      }
      flush();
      return !hasSpread && parts.length === 1 ? { kind: 'node', id: parts[0] } : builder.node('concat', parts, {}, expr);
    }
    case 'ObjectExpression': return lowerObject(builder, scope, expr);
    case 'CallExpression': return lowerCall(builder, scope, expr);
    case 'NullLiteral': throw fail(expr, t('程序不支持 null'));
    case 'ArrowFunctionExpression': case 'FunctionExpression': throw fail(expr, t('函数只能作为 map/reduce/scan 的参数内联出现'));
    case 'OptionalMemberExpression': case 'OptionalCallExpression': throw fail(expr, t('不支持可选链'));
    case 'AssignmentExpression': case 'UpdateExpression': throw fail(expr, t('不支持赋值。用 const 声明一个新名称。'));
    default: throw fail(expr, t('不支持的表达式：{type}', { type: expr.type }));
  }
}

/** `{ a, b: e }` → record. `{ ...base, k: v }` → chained set (one leading spread). A `/** … *\/` before a key documents
 *  that field of the record (builder.keyDocs), as TS does for object literal properties. */
function lowerObject(builder, scope, expr) {
  const props = expr.properties;
  if (props.length === 0) throw fail(expr, t('记录不能为空'));
  let base = null, start = 0;
  if (props[0].type === 'SpreadElement') { base = asNode(lowerExpression(builder, scope, props[0].argument), props[0].argument); start = 1; }
  const entries = new Map(), docs = new Map();
  for (let i = start; i < props.length; i++) {
    const prop = props[i];
    if (prop.type === 'SpreadElement') throw fail(prop, t('展开只能出现在记录字面量开头，且只能有一个'));
    if (prop.type !== 'ObjectProperty') throw fail(prop, t('记录字面量只支持 键: 值 或简写属性'));
    const key = propertyKey(prop);
    if (key === '__proto__' || key.length === 0) throw fail(prop, t('字段名 {key} 不合法', { key }));
    if (entries.has(key)) throw fail(prop, t('字段 {key} 重复', { key }));
    const value = asNode(lowerExpression(builder, scope, prop.value), prop.value), doc = jsdocOf(prop);
    if (!prop.shorthand) builder.span(prop.key, { kind: 'key', name: key, doc }, value.id);
    entries.set(key, value);
    if (doc) docs.set(key, doc);
  }
  if (base === null) {
    const keys = [...entries.keys()].sort();
    const record = builder.node('record', keys.map(k => entries.get(k).id), { value: keys }, expr);
    for (const [key, doc] of docs) builder.keyDoc(record.id, key, doc);
    return record;
  }
  if (entries.size === 0) return base;
  let current = base;
  for (const [key, value] of entries) {
    current = builder.node('set', [current.id, value.id], { name: key }, expr);
    if (docs.has(key)) builder.keyDoc(current.id, key, docs.get(key));
  }
  return current;
}

function callArgs(builder, scope, expr) {
  const args = [];
  for (const arg of expr.arguments) {
    if (arg.type === 'SpreadElement') throw fail(arg, t('调用不支持展开参数'));
    args.push(asNode(lowerExpression(builder, scope, arg), arg));
  }
  return args;
}
function expectArgs(expr, name, count) {
  if (expr.arguments.length !== count) throw fail(expr, t('{name} 需要 {arity} 个参数，收到 {count}', { name, arity: count, count: expr.arguments.length }));
}
function edgesLiteral(arg, name) {
  if (arg.type !== 'ArrayExpression' || arg.elements.length === 0) throw fail(arg, t('{name} 的分界点必须是数值字面量数组', { name }));
  return arg.elements.map(el => { const v = el && numericLiteral(el); if (v === null || v === undefined) throw fail(el ?? arg, t('{name} 的分界点必须是数值字面量数组', { name })); return v; });
}

/** Inline arrow body for map/reduce/scan: identifier parameters (≤ the count of the op), expression or block body. `src`
 *  is the call. On hover, its callee names the owner of the callback (`map`, `some`, `reduce`, `scan`…). */
function lowerBodyFunction(builder, scope, fn, op, src) {
  if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') throw fail(src, t('{op} 的回调必须是内联箭头函数', { op }));
  if (fn.async || fn.generator) throw fail(fn, t('回调不能是 async 或生成器'));
  const expected = BODY_PARAMS[op];
  if (fn.params.length > expected.length) throw fail(fn.params[expected.length], t('{op} 的回调最多接受 {count} 个参数', { op, count: expected.length }));
  const names = [];
  fn.params.forEach(param => { if (param.type !== 'Identifier') throw fail(param, t('参数必须是标识符。请在函数体内用 const 解构')); names.push(param.name); });
  for (let i = names.length; i < expected.length; i++) { let name = `_${expected[i]}`; while (names.includes(name)) name = '_' + name; names.push(name); }
  return builder.body(names, irScope => {
    const inner = new Scope(scope);
    const callee = src.callee, of = callee.type === 'Identifier' ? callee.name : callee.property.name;
    fn.params.forEach((param, i) => {
      const ref = builder.param(irScope, names[i], param);
      inner.declare(param.name, ref, param, { kind: 'arg', of, role: expected[i] });
      builder.span(param, inner.infoOf(param.name), ref.id);
    });
    return lowerFunctionBody(builder, inner, fn.body).id;
  });
}

/** A call, with a hover span on what it calls: a helper (`sum`, `Math.max`), a method (`.map`) or an expression helper. */
function lowerCall(builder, scope, expr) {
  const callee = expr.callee;
  let span = null;
  if (callee.type === 'Identifier') {
    const local = scope.lookup(callee.name);
    if (local?.kind === 'deferred') span = builder.span(callee, scope.infoOf(callee.name));
    else if (local?.kind === 'function') span = builder.span(callee, { kind: 'fn', name: callee.name, doc: local.doc ?? null });
    else if (local === undefined && HELPERS.has(callee.name)) span = builder.span(callee, { kind: 'helper', name: callee.name });
  } else if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    const object = callee.object;
    span = object.type === 'Identifier' && object.name === 'Math' && scope.lookup('Math') === undefined
      ? builder.span(callee, { kind: 'helper', name: `Math.${callee.property.name}` })
      : builder.span(callee.property, { kind: 'method', name: callee.property.name });
  }
  const ref = lowerCallee(builder, scope, expr);
  if (span) span.id = ref.id;
  return ref;
}

function lowerCallee(builder, scope, expr) {
  if (expr.optional) throw fail(expr, t('不支持可选调用'));
  const callee = expr.callee;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    const object = callee.object, method = callee.property.name;
    if (object.type === 'Identifier' && object.name === 'Math' && scope.lookup('Math') === undefined) {
      if (!Object.hasOwn(MATH_OPS, method)) throw fail(callee, t('不支持 Math.{name}。可用：{available}', { name: method, available: Object.keys(MATH_OPS).map(m => 'Math.' + m).join(', ') }));
      return helperCall(builder, scope, expr, MATH_OPS[method], method);
    }
    const target = asNode(lowerExpression(builder, scope, object), object);
    switch (method) {
      case 'map': { expectArgs(expr, 'map', 1); return builder.node('map', [target.id], {}, expr, lowerBodyFunction(builder, scope, expr.arguments[0], 'map', expr)); }
      case 'some': case 'every': { expectArgs(expr, method, 1); const mapped = builder.node('map', [target.id], {}, expr, lowerBodyFunction(builder, scope, expr.arguments[0], 'map', expr)); return builder.node(method === 'some' ? 'any' : 'all', [mapped.id], {}, expr); }
      case 'reduce': { expectArgs(expr, 'reduce', 2); const init = asNode(lowerExpression(builder, scope, expr.arguments[1]), expr.arguments[1]); return builder.node('fold', [target.id, init.id], {}, expr, lowerBodyFunction(builder, scope, expr.arguments[0], 'fold', expr)); }
      case 'at': {
        expectArgs(expr, 'at', 2);
        const column = stringLiteral(expr.arguments[1]);
        if (column === null) throw fail(expr.arguments[1], t('列名必须是字符串字面量'));
        const row = asNode(lowerExpression(builder, scope, expr.arguments[0]), expr.arguments[0]);
        return builder.node('tableAt', [target.id, row.id], { name: column }, expr);
      }
      case 'window': {
        expectArgs(expr, 'window', 3);
        const k = numericLiteral(expr.arguments[1]), column = stringLiteral(expr.arguments[2]);
        if (k === null || !Number.isSafeInteger(k) || k < 1 || k > LIMITS.maxVectorWidth) throw fail(expr.arguments[1], t('窗口长度必须是 1..{max} 的整数字面量', { max: LIMITS.maxVectorWidth }));
        if (column === null) throw fail(expr.arguments[2], t('列名必须是字符串字面量'));
        const end = asNode(lowerExpression(builder, scope, expr.arguments[0]), expr.arguments[0]);
        return builder.node('tableWindow', [target.id, end.id], { name: column, value: k }, expr);
      }
      default: throw fail(callee, t('不支持方法 .{name}。可用的方法：.map、.reduce、.some、.every、.at、.window', { name: method }));
    }
  }
  if (callee.type !== 'Identifier') throw fail(callee, t('只能调用内置函数或表达式辅助函数'));
  const local = scope.lookup(callee.name);
  if (local?.kind === 'deferred') {
    if (expr.arguments.length) throw fail(expr, t('表达式辅助函数不接受参数'));
    return { kind: 'node', id: local.id };
  }
  if (local?.kind === 'function') return inlineCall(builder, scope, expr, local);
  if (local?.kind === 'denied') throw fail(callee, local.message);
  if (local !== undefined) throw fail(callee, t('{name} 不是函数', { name: callee.name }));
  if (!HELPERS.has(callee.name)) throw fail(callee, t('未知函数 {name}。可用：{available}', { name: callee.name, available: [...HELPERS].join(', ') }));
  const { name } = callee;
  switch (name) {
    case 'range': {
      expectArgs(expr, name, 1);
      const n = numericLiteral(expr.arguments[0]);
      if (n === null || !Number.isSafeInteger(n) || n < 1 || n > LIMITS.maxArrayLength) throw fail(expr.arguments[0], t('range 的长度必须是 1..{max} 的整数字面量', { max: LIMITS.maxArrayLength }));
      return builder.node('range', [], { value: n }, expr);
    }
    case 'bucket': case 'thermometer': {
      expectArgs(expr, name, 2);
      const x = asNode(lowerExpression(builder, scope, expr.arguments[0]), expr.arguments[0]);
      return builder.node(name, [x.id], { value: edgesLiteral(expr.arguments[1], name) }, expr);
    }
    case 'scan': {
      expectArgs(expr, name, 3);
      const array = asNode(lowerExpression(builder, scope, expr.arguments[0]), expr.arguments[0]), init = asNode(lowerExpression(builder, scope, expr.arguments[1]), expr.arguments[1]);
      return builder.node('scan', [array.id, init.id], {}, expr, lowerBodyFunction(builder, scope, expr.arguments[2], 'scan', expr));
    }
    default: return helperCall(builder, scope, expr, Object.hasOwn(MATH_OPS, name) ? MATH_OPS[name] : name, name);
  }
}

function helperCall(builder, scope, expr, op, name) {
  const args = callArgs(builder, scope, expr), { arity } = OPS[op];
  if (arity === 'variadic') { if (args.length === 0) throw fail(expr, t('{name} 至少需要一个参数', { name })); }
  else if (args.length !== arity) throw fail(expr, t('{name} 需要 {arity} 个参数，收到 {count}', { name, arity, count: args.length }));
  for (const index of CONSTANT_ARGS[name] ?? []) {
    if (numericLiteral(expr.arguments[index]) === null) throw fail(expr.arguments[index], t('{name} 的第 {index} 个参数必须是数值字面量', { name, index: index + 1 }));
  }
  return builder.node(op, args.map(a => a.id), {}, expr);
}

/** A statement list that must end in a return on every path. Returns the result node. */
function lowerStatements(builder, scope, statements, container) {
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    switch (stmt.type) {
      case 'EmptyStatement': continue;
      case 'VariableDeclaration': {
        if (stmt.kind !== 'const') throw fail(stmt, t('只支持 const 声明，不支持 {kind}', { kind: stmt.kind }));
        const doc = jsdocOf(stmt);
        for (const decl of stmt.declarations) {
          if (!decl.init) throw fail(decl, t('const 必须有初始值'));
          const init = decl.init;
          if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
            if (decl.id.type !== 'Identifier' || init.async || init.params.length || init.body.type === 'BlockStatement') throw fail(init, t('辅助函数只支持 const 名称 = () => 纯表达式'));
            const value = asNode(lowerExpression(builder, scope, init.body), init.body);
            scope.declare(decl.id.name, { kind: 'deferred', id: value.id }, decl.id, { kind: 'fn', doc });
            builder.span(decl.id, scope.infoOf(decl.id.name), value.id);
          } else bindPattern(builder, scope, decl.id, lowerExpression(builder, scope, init), doc);
        }
        continue;
      }
      case 'ReturnStatement': {
        if (!stmt.argument) throw fail(stmt, t('return 必须带值'));
        if (i + 1 < statements.length) throw fail(statements[i + 1], t('return 之后的语句不可达'));
        return asNode(lowerExpression(builder, scope, stmt.argument), stmt.argument);
      }
      case 'IfStatement': {
        const test = asNode(lowerExpression(builder, scope, stmt.test), stmt.test);
        const yes = lowerStatements(builder, new Scope(scope), blockOf(stmt.consequent), stmt.consequent);
        let no;
        if (stmt.alternate) {
          if (i + 1 < statements.length) throw fail(statements[i + 1], t('if/else 两个分支都已 return，之后的语句不可达'));
          no = lowerStatements(builder, new Scope(scope), blockOf(stmt.alternate), stmt.alternate);
        } else {
          if (i + 1 >= statements.length) throw fail(stmt, t('if 之后缺少 else 或 return：所有路径都必须 return'));
          no = lowerStatements(builder, new Scope(scope), statements.slice(i + 1), container);
        }
        return builder.node('select', [test.id, yes.id, no.id], {}, stmt);
      }
      case 'BlockStatement': throw fail(stmt, t('不支持独立的语句块'));
      case 'ExpressionStatement': throw fail(stmt, t('表达式语句没有效果。请使用 const 或 return'));
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': case 'WhileStatement': case 'DoWhileStatement': throw fail(stmt, t('程序不支持循环'));
      case 'ImportDeclaration': case 'ExportNamedDeclaration': case 'ExportDefaultDeclaration': case 'ExportAllDeclaration': throw fail(stmt, t('程序不支持 import/export'));
      case 'FunctionDeclaration': case 'ClassDeclaration': throw fail(stmt, t('不支持嵌套函数或类'));
      default: throw fail(stmt, t('不支持的语句：{type}', { type: stmt.type }));
    }
  }
  throw fail(container, t('缺少 return：所有路径都必须返回值'));
}
function blockOf(stmt) { return stmt.type === 'BlockStatement' ? stmt.body : [stmt]; }
/** The `/** … *\/` comment right before a statement, or null. */
function jsdocComment(stmt) {
  const c = stmt.leadingComments?.at(-1);
  return c?.type === 'CommentBlock' && c.value.startsWith('*') ? c : null;
}
/** The text of the JSDoc block right before a statement (shown on hover of the names it declares), or null. */
function jsdocOf(stmt) {
  const c = jsdocComment(stmt);
  if (!c) return null;
  return c.value.slice(1).split('\n').map(line => line.replace(/^\s*\* ?/, '')).join('\n').trim() || null;
}
function lowerFunctionBody(builder, scope, body) {
  return body.type === 'BlockStatement' ? lowerStatements(builder, scope, body.body, body) : asNode(lowerExpression(builder, scope, body), body);
}

const TS_ASSERTIONS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSNonNullExpression']);
const TS_DECLARATIONS = new Set(['TSTypeAliasDeclaration', 'TSInterfaceDeclaration', 'TSDeclareFunction']);
/** Keys under which babel hangs a type annotation / type parameter list off an ordinary node. */
const TS_TYPE_KEYS = ['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments'];
const NOT_CHILDREN = new Set(['loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments', ...TS_TYPE_KEYS]);

/** The first (in source order) TypeScript-only construct under `root` as a located error, or null. The typescript
 *  plugin only parses them so the error can point at the node instead of reading as a bare syntax error. */
function typeSyntaxError(root) {
  let first = null;
  const offend = (node, kind) => { if (!first || node.start < first.node.start) first = { node, kind }; };
  const visit = node => {
    if (TS_DECLARATIONS.has(node.type) || node.declare) { offend(node, 'declaration'); return; }
    if (TS_ASSERTIONS.has(node.type)) offend(node, 'assertion');
    for (const key of TS_TYPE_KEYS) if (node[key]) offend(node[key], 'annotation');
    for (const key in node) {
      if (NOT_CHILDREN.has(key)) continue;
      const child = node[key];
      if (Array.isArray(child)) { for (const c of child) if (typeof c?.type === 'string') visit(c); }
      else if (typeof child?.type === 'string') visit(child);
    }
  };
  visit(root);
  if (!first) return null;
  const { node, kind } = first;
  return fail(node, kind === 'declaration' ? t('不支持 type / interface 声明：类型由调用方决定') : kind === 'assertion' ? t('不支持类型断言（as、satisfies、!）') : t('这里不写类型标注：类型由调用方决定'));
}

function parseSource(source) {
  if (typeof source !== 'string') throw new ProgramSourceError(t('源代码必须是字符串'), { line: 1, column: 0 });
  if (source.length > MAX_SOURCE_CHARS) throw new ProgramSourceError(t('源代码超过 256 KiB 限制'), { line: 1, column: 0 });
  let ast;
  try {
    ast = babelParse(source, { sourceType: 'module', plugins: ['typescript'], allowReturnOutsideFunction: true, errorRecovery: false, attachComment: true, ranges: false });
  } catch (error) {
    const loc = error.loc ? { line: error.loc.line, column: error.loc.column } : { line: 1, column: 0 };
    throw new ProgramSourceError(t('语法错误：{message}', { message: String(error.message).replace(/\s*\(\d+:\d+\)\s*$/, '') }), loc);
  }
  const typeError = typeSyntaxError(ast.program);
  if (typeError) throw typeError;
  const body = ast.program.body.filter(stmt => stmt.type !== 'EmptyStatement');
  if (body.length === 0) throw new ProgramSourceError(t('程序为空'), { line: 1, column: 0 });
  return { ast, body };
}

/** The single top-level function the source declares, if any: `function f(a, b) {}`, `(a) => …`, `const f = a => …`. */
function programFunction(body) {
  if (body.length !== 1) return null;
  const [stmt] = body;
  if (stmt.type === 'FunctionDeclaration') return stmt;
  if (stmt.type === 'ExpressionStatement') { const e = stmt.expression; return e.type === 'ArrowFunctionExpression' || e.type === 'FunctionExpression' ? e : null; }
  if (stmt.type === 'VariableDeclaration' && stmt.declarations.length === 1 && stmt.declarations[0].init) { const e = stmt.declarations[0].init; return e.type === 'ArrowFunctionExpression' || e.type === 'FunctionExpression' ? e : null; }
  return null;
}

/** Lower one source into the root scope of the builder. Function parameters become program params. Returns the output node id. */
function lowerSource(source, builder) {
  const { ast, body } = parseSource(source), scope = new Scope();
  const fn = programFunction(body);
  if (!fn) {
    if (body.length === 1 && body[0].type === 'ExpressionStatement') return asNode(lowerExpression(builder, scope, body[0].expression), body[0].expression).id;
    return lowerStatements(builder, scope, body, ast.program).id;
  }
  if (fn.async || fn.generator) throw fail(fn, t('程序函数不能是 async 或生成器'));
  for (const param of fn.params) {
    if (param.type !== 'Identifier') throw fail(param, t('参数必须是标识符。请在函数体内用 const 解构'));
    if (param.optional) throw fail(param, t('参数不能是可选的'));
    const { name } = param;
    builder.root.params.push(name);
    scope.declare(name, builder.param(builder.root, name, param), param, { kind: 'param' });
  }
  return lowerFunctionBody(builder, scope, fn.body).id;
}

function sourceError(builder, error) {
  if (error instanceof ProgramError && error.nodeId !== null && builder.locs.has(error.nodeId)) {
    const src = builder.locs.get(error.nodeId);
    return new ProgramSourceError(error.message, locOf(src), endOf(src));
  }
  return error;
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}

/** Parse the supported JavaScript subset into the runtime IR. Unsupported constructs never execute. */
export function parseFunction(source) {
  const builder = new Builder();
  const output = lowerSource(source, builder);
  const program = { format: PROGRAM_FORMAT, params: builder.root.params, nodes: builder.root.nodes, output };
  try { analyzeStructure(program); } catch (error) { throw sourceError(builder, error); }
  return deepFreeze(program);
}

/** One function body over positional params (Params constraint expressions): its program. */
export function parseCode(params, body) { return parseFunction(`function main(${params.join(', ')}) {\n${body}\n}`); }

/** A function of the file called from a unit. Its body is lowered in place, with its params bound to the arguments, in
 *  the file scope (it sees file-level names, not the locals of the caller). No recursion. */
function inlineCall(builder, scope, expr, fn) {
  const root = scope.root, unit = root.unit;
  if (unit.stack.includes(fn.name)) throw fail(expr, t('函数 {name} 不能递归调用', { name: fn.name }));
  const { decl } = fn;
  if (expr.arguments.length !== decl.params.length) throw fail(expr, t('{name} 需要 {arity} 个参数，收到 {count}', { name: fn.name, arity: decl.params.length, count: expr.arguments.length }));
  const args = callArgs(builder, scope, expr), inner = new Scope(root);
  decl.params.forEach((param, i) => { inner.declare(param.name, args[i], param, { kind: 'const' }); builder.span(param, inner.infoOf(param.name), args[i].id); });
  unit.stack.push(fn.name); unit.used.add(fn.name);
  try { return asNode(lowerFunctionBody(builder, inner, decl.body), decl.body); } finally { unit.stack.pop(); }
}

/** A lowered unit as parseModule reports it: program, absolute `locs`, `spans` and `keyDocs`, the bound names. */
function unitResult(builder, output, bound) {
  const program = { format: PROGRAM_FORMAT, params: builder.root.params, nodes: builder.root.nodes, output };
  try { analyzeStructure(program); } catch (error) { throw sourceError(builder, error); }
  const locs = Object.create(null);
  for (const [id, src] of builder.locs) if (src.loc) locs[id] = { loc: locOf(src), end: endOf(src) };
  const spans = builder.spans.map(s => ({ ...s, path: s.kind === 'field' ? builder.paths.get(s.id)?.join('.') ?? null : null }));
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  return { program: deepFreeze(program), error: null, locs, spans, keyDocs: builder.keyDocs, bound: [...bound] };
}
const failedUnit = error => ({ program: null, error, locs: null, spans: [], keyDocs: {}, bound: [] });

/**
 * Compile a code module file: top-level `const`s and `function`s. The file declares itself what it exposes, with
 * `export function name(…)` and `export const name = …`. Nothing is recognised by its name alone.
 *  · `inputs` are the file-level names bound from outside (the input ports of the module).
 *  · Each top-level const compiles to a program of its own over the file-level names that it reads (inputs and earlier
 *    consts: `deps`). This program is evaluated once. The const is `pure` when it reads no input, directly or through
 *    other consts or functions.
 *  · Each exported function compiles to a program of its own. Its params are its own params (what a caller passes),
 *    then every file-level name that it reads, in order of first use (`bound`, supplied from outside). `pure` as for a const.
 *  · Every function can also be called inside the file. The call is inlined (no recursion). Functions that are not
 *    exported are only helpers.
 * Returns `{ consts: [{ name, doc, loc, exported, head, docStart, end, deps, pure, program, error, locs, spans,
 * keyDocs }], functions: { name: { params, doc, loc, head, docStart, end, paramSpans, bound, pure, program, error, locs,
 * spans, keyDocs } } (the exported ones, in file order), helpers: [{ name, doc, loc, used }] }`. When one unit fails,
 * the others stay compiled. Locations and span offsets are absolute in `source`.
 * Source layout (char offsets into `source`, present also when the unit did not lower). The editor locks and anchors
 * to these offsets:
 *  · The `head` of a function runs from `export` to just after the `{` of the body. `paramSpans` cover each parameter
 *    name. `end` is just after the closing `}`.
 *  · The `head` of a const runs from its first keyword to the first char of the initializer. The first keyword is
 *    `export` / `const`, or the name for a later declarator of the same statement. `end` is after the declarator
 *    (including the `;` for the last one).
 *  · `docStart` is where the JSDoc directly above the statement starts (= head.start when there is none).
 * Throws ProgramSourceError when the file itself is malformed: syntax, TypeScript-only syntax anywhere, a statement
 * that is not a const or a function, a name declared twice, or an unsupported export form.
 */
export function parseModule(source, { inputs = [] } = {}) {
  const { body } = parseSource(source);
  const consts = [], functions = new Map(), claimed = new Set();
  const claim = (name, node) => {
    if (RESERVED.has(name) || HELPERS.has(name)) throw fail(node, t('不能使用保留名称 {name}', { name }));
    if (inputs.includes(name)) throw fail(node, t('{name} 是外面传进来的名称，不能再声明', { name }));
    if (claimed.has(name)) throw fail(node, t('重复声明：{name}', { name }));
    claimed.add(name);
  };
  for (const top of body) {
    let stmt = top, exported = false;
    if (top.type === 'ExportNamedDeclaration' && top.declaration && !top.specifiers.length && (top.declaration.type === 'FunctionDeclaration' || top.declaration.type === 'VariableDeclaration')) { stmt = top.declaration; exported = true; }
    else if (/^(Import|Export)/.test(top.type)) throw fail(top, t('只支持 export function 名称(…) 和 export const 名称 = …，不支持其他 import / export'));
    const doc = jsdocOf(top), docStart = jsdocComment(top)?.start ?? top.start;
    if (stmt.type === 'FunctionDeclaration') {
      if (stmt.async || stmt.generator) throw fail(stmt, t('程序函数不能是 async 或生成器'));
      claim(stmt.id.name, stmt.id);
      const seen = new Set();
      for (const p of stmt.params) {
        if (p.type !== 'Identifier') throw fail(p, t('参数必须是标识符。请在函数体内用 const 解构'));
        if (p.optional) throw fail(p, t('参数不能是可选的'));
        if (RESERVED.has(p.name) || HELPERS.has(p.name)) throw fail(p, t('不能使用保留名称 {name}', { name: p.name }));
        if (seen.has(p.name)) throw fail(p, t('重复声明：{name}', { name: p.name }));
        seen.add(p.name);
      }
      const layout = { head: { start: top.start, end: stmt.body.start + 1 }, docStart, end: top.end, paramSpans: stmt.params.map(p => ({ start: p.start, end: p.end })) };
      functions.set(stmt.id.name, { name: stmt.id.name, decl: stmt, doc, exported, layout });
      continue;
    }
    if (stmt.type === 'VariableDeclaration') {
      if (stmt.kind !== 'const') throw fail(stmt, t('只支持 const 声明，不支持 {kind}', { kind: stmt.kind }));
      stmt.declarations.forEach((decl, i) => {
        if (decl.id.type !== 'Identifier') throw fail(decl.id, t('顶层常量只能声明一个名称。不支持解构'));
        if (!decl.init) throw fail(decl, t('const 必须有初始值'));
        const init = decl.init;
        if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') throw fail(init, t('顶层函数请写成 function 名称(参数) { … }'));
        claim(decl.id.name, decl.id);
        const start = i === 0 ? top.start : decl.id.start, last = i === stmt.declarations.length - 1;
        const layout = { head: { start, end: init.start }, docStart: i === 0 ? docStart : start, end: last ? top.end : decl.end };
        consts.push({ name: decl.id.name, decl, doc, exported, layout });
      });
      continue;
    }
    throw fail(stmt, t('文件顶层只能写 const 常量和 function 函数'));
  }
  const constIndex = new Map(consts.map((c, i) => [c.name, i])), pure = new Map(), used = new Set();
  /** Lower one unit (a const or an exported function) with its own builder. File-level names resolve on first use. */
  const lowerUnit = (lower, until = consts.length) => {
    const builder = new Builder(), root = new Scope(), bound = [];
    root.unit = { stack: [], used };
    root.resolve = name => {
      if (functions.has(name)) {
        const fn = functions.get(name), ref = { kind: 'function', ...fn };
        root.names.set(name, ref); root.infos.set(name, { kind: 'fn', name, doc: fn.doc });
        return ref;
      }
      const ci = constIndex.get(name);
      if (ci === undefined && !inputs.includes(name)) return undefined;
      if (ci !== undefined && ci >= until) return { kind: 'denied', message: t('常量 {name} 在这里还没有算出来：常量只能读前面声明的常量', { name }) };
      const src = ci !== undefined ? consts[ci].decl.id : { start: 0, end: 0 };
      builder.root.params.push(name); bound.push(name);
      const ref = builder.param(builder.root, name, src);
      root.names.set(name, ref); root.infos.set(name, { kind: ci !== undefined ? 'const' : 'param', name, doc: ci !== undefined ? consts[ci].doc : null });
      return ref;
    };
    try { return unitResult(builder, lower(builder, root), bound); } catch (error) { if (error instanceof ProgramSourceError || error instanceof ProgramError) return failedUnit(error); throw error; }
  };
  const isPure = unit => !unit.error && unit.bound.every(n => constIndex.has(n) && pure.get(n));
  const constsOut = consts.map((c, i) => {
    const unit = lowerUnit((builder, root) => {
      const value = asNode(lowerExpression(builder, root, c.decl.init), c.decl.init);
      builder.span(c.decl.id, { kind: 'const', name: c.name, doc: c.doc }, value.id);
      return value.id;
    }, i);
    pure.set(c.name, isPure(unit));
    return { name: c.name, doc: c.doc, loc: locOf(c.decl.id), exported: c.exported, ...c.layout, deps: unit.bound, pure: pure.get(c.name), ...unit };
  });
  const functionsOut = {};
  for (const fn of functions.values()) {
    if (!fn.exported) continue;
    const unit = lowerUnit((builder, root) => {
      const scope = new Scope(root);
      for (const p of fn.decl.params) {
        builder.root.params.push(p.name);
        const ref = builder.param(builder.root, p.name, p);
        scope.declare(p.name, ref, p, { kind: 'param' });
        builder.span(p, scope.infoOf(p.name), ref.id);
      }
      return lowerFunctionBody(builder, scope, fn.decl.body).id;
    });
    functionsOut[fn.name] = { params: fn.decl.params.map(p => p.name), doc: fn.doc, loc: locOf(fn.decl.id), ...fn.layout, pure: isPure(unit), ...unit };
  }
  const helpers = [...functions.values()].filter(f => !f.exported).map(f => ({ name: f.name, doc: f.doc, loc: locOf(f.decl.id), used: used.has(f.name) }));
  return { consts: constsOut, functions: functionsOut, helpers };
}
