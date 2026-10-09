// core/kinds/params.js — declared, typed parameters with ranges and defaults. The editor renders a form from
// `fields`. `values` holds the user's choices. The output `params` is one record. A value wire may start at any field
// path of it (`params.steps`, resolve.js outputPort), carrying that field's type.
// A field's `min` / `max` (a number) and `values` (a string list) may instead be a constraint expression (ADR 0007):
// a restricted-JS expression string over the fields' current values, for example `max: grid - 1`. Expressions compile
// to IR once per (fields, text) and are evaluated here. So an out-of-range value is a problem of this module. It blocks
// every bundle that reads it (bundle.js staticValue), not only a red form row.
// `functions` declares the function inputs (ADR 0006): one call port per name, each `fn(params) → record`, computing
// derived values such as the action table. Their results merge by key. A key two inputs both return is a problem.
import { registerKind } from '../registry.js';
import { callIn, valueOut } from './common.js';
import { NUMBER, BOOLEAN, STRING, record, ANY_RECORD, ref } from '../types.js';
import { parseCode, compile, HELPERS, RESERVED } from '../../ir/index.js';
import { t } from '../../i18n.js';

export const FUNCTION_INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_FUNCTION_INPUTS = 16;
const OPTIONS_SIGNATURE = Object.freeze({ params: [ref('params')], names: ['params'], docs: ['当前的参数取值'], result: ANY_RECORD, returns: '派生值：工作台把每个键并入参数', stub: 'return { size: 1 };' });
const OPTIONS_WHEN = '参数取值变化时调用。工作台把结果按键并入参数';
const MAX_EXPRESSION = 2000;

/** `min` / `max`: a number or an expression. `values`: a string list or an expression (shapes checked by fieldConstraints). */
const FIELD = {
  type: 'object',
  fields: {
    type: { type: 'enum', values: ['int', 'number', 'boolean', 'enum', 'string'] },
    label: { type: 'string', optional: true },
    min: { type: 'json', optional: true }, max: { type: 'json', optional: true },
    values: { type: 'json', optional: true },
    default: { type: 'json' },
  },
};

function fieldType(field) {
  return field.type === 'boolean' ? BOOLEAN : field.type === 'enum' || field.type === 'string' ? STRING : NUMBER;
}
function paramsType(config) {
  const fields = {};
  for (const [name, field] of Object.entries(config.fields)) fields[name] = fieldType(field);
  return record(fields);
}
/** Effective values: defaults overlaid by `values`. */
export function paramsValue(config) {
  const out = {};
  for (const [name, field] of Object.entries(config.fields)) out[name] = Object.hasOwn(config.values, name) ? config.values[name] : field.default;
  return out;
}
/** Merge the results of the function inputs (`[[port, record], …]`, declaration order) by key. A key returned by
 *  more than one of them is left out of `result` and listed in `conflicts` with every port that returned it. */
export function mergeOptions(entries) {
  const owners = new Map();
  for (const [port, out] of entries) for (const key of Object.keys(out ?? {})) owners.set(key, [...(owners.get(key) ?? []), port]);
  const result = {}, conflicts = [];
  for (const [port, out] of entries) for (const [key, v] of Object.entries(out ?? {})) {
    const ports = owners.get(key);
    if (ports.length === 1) result[key] = v;
    else if (ports[0] === port) conflicts.push({ key, ports });
  }
  return { result, conflicts };
}

const exprCache = new Map();
/** A constraint expression compiled over every field whose name the IR does not reserve (helpers like `range`,
 *  keywords): the fields are the positional params, typed by their declarations. Memoised on (fields, text). */
function compiled(config, expr) {
  const names = Object.keys(config.fields).filter(n => !HELPERS.has(n) && !RESERVED.has(n));
  const types = names.map(n => fieldType(config.fields[n]));
  const key = `${names.map((n, i) => `${n}:${types[i].type}`).join(',')}\u0000${expr}`;
  let entry = exprCache.get(key);
  if (!entry) {
    if (exprCache.size > 512) exprCache.clear();
    try {
      if (!expr.trim() || expr.length > MAX_EXPRESSION) throw new Error(t('表达式不能为空，也不能超过 {max} 个字符', { max: MAX_EXPRESSION }));
      const program = parseCode(names, `return (${expr});`);
      entry = { names, fn: compile(program, types, { exact: true }) };
      exprCache.set(key, entry);
    } catch (error) { return { error: error.detail ?? error.message }; }   // not cached: the message follows the locale. A location would point into the `return (…)` wrapper
  }
  return entry;
}
const CONSTRAINT_KEYS = ['min', 'max', 'values'];
const isStringList = v => Array.isArray(v) && v.every(x => typeof x === 'string');
/**
 * Effective constraints of every field over the current values: `{ [field]: { min?, max?, values?, errors: [] } }`.
 * A number / string list is taken as written. A string is an expression, evaluated now. An expression that does not
 * compile, throws, or returns the wrong kind of value adds an error and constrains nothing for that key.
 */
export function fieldConstraints(config) {
  const values = paramsValue(config), out = {};
  for (const [name, field] of Object.entries(config.fields)) {
    const c = { errors: [] };
    for (const key of CONSTRAINT_KEYS) {
      const spec = field[key];
      if (spec === undefined) continue;
      let v = spec;
      if (typeof spec === 'string') {
        const e = compiled(config, spec);
        try { if (e.error) throw new Error(e.error); v = e.fn.run(...e.names.map(n => values[n])); }
        catch (error) { c.errors.push(t('{key} 表达式 {expr}：{error}', { key, expr: spec, error: error.message })); continue; }
      }
      const ok = key === 'values' ? isStringList(v) : typeof v === 'number' && Number.isFinite(v);
      if (!ok) { c.errors.push(key === 'values' ? t('values 必须是字符串列表或结果为字符串列表的表达式') : t('{key} 必须是数或结果为数的表达式', { key })); continue; }
      c[key] = v;
    }
    out[name] = c;
  }
  return out;
}
/** Why `value` is not acceptable for `field` under its effective constraint `c` (fieldConstraints), or '' when it is. */
export function fieldProblem(field, value, c = {}) {
  switch (field.type) {
    case 'int': if (!Number.isSafeInteger(value)) return t('必须是整数'); break;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) return t('必须是有限数'); break;
    case 'boolean': return typeof value === 'boolean' ? '' : t('必须是布尔值');
    case 'string': return typeof value === 'string' ? '' : t('必须是字符串');
    case 'enum': return c.values?.includes(value) ? '' : t('必须是 {values} 之一', { values: (c.values ?? []).join(' / ') });
  }
  if ((c.min !== undefined && value < c.min) || (c.max !== undefined && value > c.max)) return t('必须在 {min}..{max} 之间', { min: c.min ?? '-∞', max: c.max ?? '∞' });
  return '';
}
/** A field's doc text: its label over `type · min..max | values · default` (constraint expressions as written). */
function fieldDoc(field) {
  const parts = [field.type];
  if (field.min !== undefined || field.max !== undefined) parts.push(`${field.min ?? '…'}..${field.max ?? '…'}`);
  if (field.values !== undefined) parts.push(Array.isArray(field.values) ? field.values.join(' | ') : String(field.values));
  parts.push(t('默认 {value}', { value: JSON.stringify(field.default) }));
  return [field.label, parts.join(' · ')].filter(Boolean).join('\n');
}

registerKind({
  kind: 'params',
  label: '参数',
  config: {
    defaults: { fields: {}, values: {}, functions: ['options'] },
    schema: {
      fields: { type: 'map', of: FIELD },
      values: { type: 'map', of: { type: 'json' } },
      functions: { type: 'list', of: { type: 'string', pattern: FUNCTION_INPUT_NAME.source, max: 64 }, max: MAX_FUNCTION_INPUTS },
    },
  },
  ports(node) {
    const T = paramsType(node.config);
    return { inputs: [...new Set(node.config.functions)].map(name => callIn(name, OPTIONS_SIGNATURE, { when: OPTIONS_WHEN })), outputs: [valueOut('params', T)] };
  },
  /** Each field of `params` is documented by its declaration: the label, then type · range / values · default. */
  docs: {
    output: (node, port) => (port === 'params' ? { fields: Object.fromEntries(Object.entries(node.config.fields).map(([name, field]) => [name, { text: fieldDoc(field) }])) } : null),
    ref: (node, name, d) => (name === 'params' ? d.output(node.id, 'params') : null),
  },
  infer(node, inTypes, ctx) {
    const T = paramsType(node.config);
    ctx.setRefs(node.id, { params: T });
    return { params: T };
  },
  problems(node, ctx) {
    const out = [];
    const constraints = fieldConstraints(node.config), values = paramsValue(node.config);
    for (const [name, field] of Object.entries(node.config.fields)) {
      if (field.type === 'enum' && (field.values === undefined || (Array.isArray(field.values) && !field.values.length))) out.push({ message: t('参数 {name} 是枚举，需要 values', { name }) });
      for (const problem of constraints[name].errors) out.push({ message: t('参数 {name}：{problem}', { name, problem }) });
      const problem = fieldProblem(field, values[name], constraints[name]);
      if (problem) out.push({ message: t('参数 {name}：{problem}', { name, problem }) });
    }
    for (const name of Object.keys(node.config.values)) if (!Object.hasOwn(node.config.fields, name)) out.push({ message: t('值 {name} 没有对应的参数声明', { name }) });
    const functions = node.config.functions;
    for (const [i, name] of functions.entries()) if (functions.indexOf(name) !== i) out.push({ message: t('函数输入 {name} 重复声明', { name }) });
    const results = [];
    for (const port of new Set(functions)) {
      const called = ctx.call(node.id, port, [paramsType(node.config)]);
      if (called?.error) out.push({ port, error: called.error });
      else if (called?.result?.type === 'record') results.push([port, called.result.fields]);
    }
    for (const { key, ports } of mergeOptions(results).conflicts) out.push({ message: t('函数输入 {ports} 都返回了 {key}。同一个键只能有一个来源', { ports: ports.join(' / '), key }) });
    return out;
  },
});
