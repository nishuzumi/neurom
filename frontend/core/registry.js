// core/registry.js — the module-kind registry and the config schema every kind declares.
//
// A kind is `{ kind, label, config:{defaults, schema, derive?}, ports(node, ctx), infer(node, inTypes, ctx), problems(node, ctx) }`.
// `derive(config)` (optional) returns fields computed from the rest of a validated config (for example, a code module's
// export list from its source), merged over it. null keeps the stored ones (when the source does not parse).
// `callee(node, port, ctx)` (optional, kinds with call outputs) answers for a call wire out of output `port`. It
// returns null when that output is not callable, else `{ width, call(argTypes, { exact, caller }) }`. width: the bits
// the callee reads (null: typed by its arguments alone). call → `{ result, error, paramTypes, carries }`: the result
// type or why the call does not type, the program's params and what a bundle carries for it (core/resolve.js
// describes the Call).
// `schema` is a flat map field → descriptor used to validate configs here and to render forms in the editor:
//   {type:'int'|'number', min?, max?}  {type:'string', pattern?}  {type:'enum', values:[…]}
//   {type:'list', of:descriptor, min?, max?}  {type:'object', fields:{…}}  {type:'map', of:descriptor}  {type:'json'}
//   {type:'oneOf', of:[descriptor, …]} (the first that accepts the value. The `object` variant judges a plain object,
//   and the first other variant judges anything else.)
// Every descriptor may carry `label` (a Chinese message key) and `optional:true` (null/undefined allowed).
import { t } from '../i18n.js';

const registry = new Map();

/** A config that does not fit its schema. `path`: where in the config it fails. */
export class ConfigError extends Error {
  constructor(message, path) { super(message); this.name = 'ConfigError'; this.path = path; }
}

export function registerKind(def) {
  for (const key of ['kind', 'label', 'config', 'ports', 'infer', 'problems']) if (!(key in def)) throw new Error(t('模块种类缺少字段：{key}', { key }));
  if (registry.has(def.kind)) throw new Error(t('模块种类已注册：{kind}', { kind: def.kind }));
  registry.set(def.kind, Object.freeze(def));
  return def;
}
export function kindOf(name) {
  const def = registry.get(name);
  if (!def) throw new Error(t('未知模块种类：{kind}', { kind: String(name) }));
  return def;
}
export const hasKind = name => registry.has(name);
export function kinds() { return [...registry.values()]; }

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, path) => { throw new ConfigError(path.length ? t('配置 {path}：{message}', { path: path.join('.'), message }) : message, path); };

function checkField(desc, value, path) {
  if (value === undefined || (value === null && desc.type !== 'json')) {   // a `json` field may hold null (for example, a readout map's invalid action)
    if (desc.optional) return null;
    if (desc.type === 'object') return checkField(desc, {}, path);
    fail(t('缺少必填项'), path);
  }
  switch (desc.type) {
    case 'int':
      if (!Number.isSafeInteger(value)) fail(t('必须是整数'), path);
      if ((desc.min !== undefined && value < desc.min) || (desc.max !== undefined && value > desc.max)) fail(t('必须在 {min}..{max} 之间', { min: desc.min ?? '-∞', max: desc.max ?? '∞' }), path);
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(t('必须是有限数'), path);
      if ((desc.min !== undefined && value < desc.min) || (desc.max !== undefined && value > desc.max)) fail(t('必须在 {min}..{max} 之间', { min: desc.min ?? '-∞', max: desc.max ?? '∞' }), path);
      return value;
    case 'string':
      if (typeof value !== 'string') fail(t('必须是字符串'), path);
      if (desc.pattern && !new RegExp(desc.pattern).test(value)) fail(t('格式不正确'), path);
      if (desc.max !== undefined && value.length > desc.max) fail(t('长度不能超过 {max}', { max: desc.max }), path);
      return value;
    case 'enum': if (!desc.values.includes(value)) fail(t('必须是 {values} 之一', { values: desc.values.join(' / ') }), path); return value;
    case 'list': {
      if (!Array.isArray(value)) fail(t('必须是数组'), path);
      if ((desc.min !== undefined && value.length < desc.min) || (desc.max !== undefined && value.length > desc.max)) fail(t('数组长度必须在 {min}..{max} 之间', { min: desc.min ?? 0, max: desc.max ?? '∞' }), path);
      return value.map((item, i) => checkField(desc.of, item, [...path, i]));
    }
    case 'object': return checkObject(desc.fields, value, path);
    case 'map': {
      if (!plain(value)) fail(t('必须是对象'), path);
      const out = {};
      for (const key of Object.keys(value)) { if (!/^\w+$/.test(key)) fail(t('键名 {key} 不合法', { key }), path); out[key] = checkField(desc.of, value[key], [...path, key]); }
      return out;
    }
    case 'json': { try { JSON.stringify(value); } catch { fail(t('必须是 JSON 数据'), path); } return value; }
    case 'oneOf': {
      for (const variant of desc.of) { try { return checkField(variant, value, path); } catch (e) { if (!(e instanceof ConfigError)) throw e; } }
      const judge = desc.of.find(variant => (variant.type === 'object') === plain(value)) ?? desc.of[0];
      return checkField(judge, value, path);
    }
    default: throw new Error(t('未知配置描述类型：{type}', { type: String(desc.type) }));
  }
}
function checkObject(fields, value, path) {
  if (!plain(value)) fail(t('必须是对象'), path);
  for (const key of Object.keys(value)) if (!Object.hasOwn(fields, key)) fail(t('未知配置项 {key}', { key }), path);
  const out = {};
  for (const [key, desc] of Object.entries(fields)) {
    const checked = checkField(desc, value[key], [...path, key]);
    if (checked !== null || Object.hasOwn(value, key)) out[key] = checked;
  }
  return out;
}

function merge(defaults, config) {
  if (!plain(defaults) || !plain(config)) return config === undefined ? structuredClone(defaults) : config;
  const out = structuredClone(defaults);
  for (const key of Object.keys(config)) out[key] = key in defaults && plain(defaults[key]) && plain(config[key]) ? merge(defaults[key], config[key]) : config[key];
  return out;
}

/** Defaults deep-merged under `config`, then validated against the kind's schema, then the kind's derived fields.
 *  Throws ConfigError. */
export function validateConfig(kind, config) {
  const def = typeof kind === 'string' ? kindOf(kind) : kind;
  if (!plain(config)) throw new ConfigError(t('配置必须是对象'), []);
  const out = checkObject(def.config.schema, merge(def.config.defaults, config), []);
  const derived = def.config.derive?.(out);
  return derived ? checkObject(def.config.schema, { ...out, ...derived }, []) : out;
}
