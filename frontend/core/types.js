// core/types.js — port types of the module system: the IR value types plus opaque handles.
// Types are plain JSON so they can live in templates, bundles and workspaces. Every function here is pure.
//
//   value types    {type:'number'} {type:'boolean'} {type:'string'} {type:'vector', width, binary?}
//                  {type:'array', length, of} {type:'record', fields} {type:'table', columns} {type:'handle', of, …meta}
//   constraints    a value type, or {anyRecord:true} | {anyTable:true} | {binaryVector:[min,max]}
//                  | {recordWith:{field: Constraint}} — what a call port demands of a callee's result
//   references     '<Name>' inside a call signature: a type resolved from the graph (State, Transition, Episode, …)
import { canonicalJSON } from './canonical.js';
import { t } from '../i18n.js';

const HANDLES = Object.freeze(['partition', 'structure', 'weights', 'run', 'artifact', 'report', 'execution', 'deployment', 'text', 'loop']);
export const MAX_BITS = 256;

export const NUMBER = Object.freeze({ type: 'number' });
export const BOOLEAN = Object.freeze({ type: 'boolean' });
export const STRING = Object.freeze({ type: 'string' });
export const ANY_RECORD = Object.freeze({ anyRecord: true });
export const ANY_TABLE = Object.freeze({ anyTable: true });

export function vector(width, binary = false) { return binary ? { type: 'vector', width, binary: true } : { type: 'vector', width }; }
export function bits(width) { return vector(width, true); }
export function array(length, of) { return { type: 'array', length, of }; }
export function record(fields) { return { type: 'record', fields: canonicalFields(fields) }; }
export function table(columns) { return { type: 'table', columns: [...columns] }; }
/** Opaque handle. `meta` (for example, a partition's episode kind) takes part in type equality. */
export function handle(of, meta = {}) {
  if (!HANDLES.includes(of)) throw new Error(t('未知句柄种类：{of}', { of: String(of) }));
  return { type: 'handle', of, ...meta };
}
export function binaryVector(min, max = min) { return { binaryVector: [min, max] }; }
export function recordWith(fields) { return { recordWith: fields }; }
export const ref = name => `<${name}>`;
export const isRef = value => typeof value === 'string' && /^<[A-Za-z_][\w]*>$/.test(value);
const refName = value => value.slice(1, -1);

function canonicalFields(fields) {
  const out = {};
  for (const key of Object.keys(fields).sort()) out[key] = fields[key];
  return out;
}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Canonical form: sorted record fields, `binary` only when true, no undefined. */
export function canonicalType(T) {
  switch (T.type) {
    case 'vector': return vector(T.width, T.binary === true);
    case 'array': return array(T.length, canonicalType(T.of));
    case 'record': { const fields = {}; for (const key of Object.keys(T.fields).sort()) fields[key] = canonicalType(T.fields[key]); return { type: 'record', fields }; }
    case 'table': return table(T.columns);
    case 'handle': return JSON.parse(canonicalJSON(T));
    default: return { type: T.type };
  }
}

export function sameType(a, b) {
  if (!a || !b) return false;
  return canonicalJSON(canonicalType(a)) === canonicalJSON(canonicalType(b));
}

/** Human-readable type: number · bits[8] · vector[8] · array[4] of number · {x: number, y: number} · table(a, b) · run */
export function typeName(T) {
  if (T == null) return '?';
  if (isRef(T)) return refName(T);
  if (T.anyRecord) return t('记录');
  if (T.anyTable) return t('数据表');
  if (T.binaryVector) { const [lo, hi] = T.binaryVector; return lo === hi ? `bits[${lo}]` : `bits[${lo}..${hi}]`; }
  if (T.recordWith) return '{' + Object.entries(T.recordWith).map(([k, F]) => `${k}: ${typeName(F)}`).join(', ') + ', …}';
  switch (T.type) {
    case 'vector': return T.binary ? `bits[${T.width}]` : `vector[${T.width}]`;
    case 'array': return `${typeName(T.of)}[${T.length}]`;
    case 'record': return '{' + Object.entries(T.fields).map(([k, F]) => `${k}: ${typeName(F)}`).join(', ') + '}';
    case 'table': return `table(${T.columns.join(', ')})`;
    case 'handle': return T.of;
    default: return T.type;
  }
}

/** Runtime check of a value against a value type. Returns a message or null. Vectors accept any array-like of finite
 *  numbers (binary: each 0 or 1). Tables and handles are checked by shape only. */
export function checkValue(T, v) {
  switch (T.type) {
    case 'number': return typeof v === 'number' && Number.isFinite(v) ? null : t('需要有限数，得到 {value}', { value: describe(v) });
    case 'boolean': return typeof v === 'boolean' ? null : t('需要布尔值，得到 {value}', { value: describe(v) });
    case 'string': return typeof v === 'string' ? null : t('需要字符串，得到 {value}', { value: describe(v) });
    case 'vector': {
      if (v == null || typeof v.length !== 'number') return t('需要 {type}，得到 {value}', { type: typeName(T), value: describe(v) });
      if (v.length !== T.width) return t('需要 {type}，得到宽度 {width}', { type: typeName(T), width: v.length });
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        if (typeof x !== 'number' || !Number.isFinite(x)) return t('向量第 {i} 项不是有限数', { i });
        if (T.binary && x !== 0 && x !== 1) return t('位向量第 {i} 项不是 0/1：{value}', { i, value: x });
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(v)) return t('需要 {type}，得到 {value}', { type: typeName(T), value: describe(v) });
      if (v.length !== T.length) return t('需要长度 {length} 的数组，得到 {actual}', { length: T.length, actual: v.length });
      for (let i = 0; i < v.length; i++) { const p = checkValue(T.of, v[i]); if (p) return t('数组第 {i} 项：{problem}', { i, problem: p }); }
      return null;
    }
    case 'record': {
      if (!plain(v)) return t('需要记录，得到 {value}', { value: describe(v) });
      const keys = Object.keys(T.fields);
      for (const key of keys) { if (!Object.hasOwn(v, key)) return t('记录缺少字段 {key}', { key }); const p = checkValue(T.fields[key], v[key]); if (p) return t('字段 {key}：{problem}', { key, problem: p }); }
      for (const key of Object.keys(v)) if (!Object.hasOwn(T.fields, key)) return t('记录含多余字段 {key}', { key });
      return null;
    }
    case 'table': return plain(v) && plain(v.columns) ? null : t('需要数据表，得到 {value}', { value: describe(v) });
    case 'handle': return plain(v) ? null : t('需要 {of} 句柄，得到 {value}', { of: T.of, value: describe(v) });
    default: return t('未知类型：{type}', { type: String(T.type) });
  }
}
function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v) || (v && typeof v.length === 'number' && typeof v !== 'string')) return `[${v.length}]`;
  if (typeof v === 'object') return '{…}';
  return String(v);
}

/** Can a value of type `from` flow into a port that demands `to` (a type or constraint)? Unresolved `<ref>` → false.
 *  A binary vector flows into a plain vector port of the same width. A plain vector does not flow into a port typed
 *  `{vector, binary:true}`. The `{binaryVector}` constraint (a code result the IR types as a plain vector) checks the
 *  width statically. 0/1-ness is a runtime check (checkValue). */
export function assignable(from, to) {
  if (!from || !to || isRef(from) || isRef(to)) return false;
  if (to.anyRecord) return from.type === 'record';
  if (to.anyTable) return from.type === 'table';
  if (to.binaryVector) return from.type === 'vector' && from.width >= to.binaryVector[0] && from.width <= to.binaryVector[1];
  if (to.recordWith) {
    if (from.type !== 'record') return false;
    for (const [key, C] of Object.entries(to.recordWith)) if (!Object.hasOwn(from.fields, key) || !assignable(from.fields[key], C)) return false;
    return true;
  }
  if (from.type !== to.type) return false;
  switch (to.type) {
    case 'vector': return from.width === to.width && (!to.binary || from.binary === true);
    case 'array': return from.length === to.length && assignable(from.of, to.of);
    case 'record': {
      const a = Object.keys(from.fields), b = Object.keys(to.fields);
      return a.length === b.length && b.every(key => Object.hasOwn(from.fields, key) && assignable(from.fields[key], to.fields[key]));
    }
    case 'number': case 'boolean': case 'string': return true;
    case 'table': return from.columns.length === to.columns.length && from.columns.every((c, i) => c === to.columns[i]);
    default: return sameType(from, to);
  }
}
/** Why `from` cannot flow into `to`. '' when it can. */
export function mismatch(from, to) {
  if (assignable(from, to)) return '';
  return t('类型不匹配：需要 {expected}，得到 {actual}', { expected: typeName(to), actual: typeName(from) });
}

/** Substitute `<ref>` entries of a call signature from `refs` ({Name: Type}). Unresolved refs stay as strings. */
export function resolveSignature(signature, refs = {}) {
  const sub = C => {
    if (isRef(C)) return refs[refName(C)] ?? C;
    if (C && C.recordWith) { const out = {}; for (const [k, F] of Object.entries(C.recordWith)) out[k] = sub(F); return { recordWith: out }; }
    return C;
  };
  return { ...signature, params: signature.params.map(sub), result: sub(signature.result) };
}
/** Names of the refs a signature still needs. */
export function unresolvedRefs(signature) {
  const out = new Set();
  const walk = C => { if (isRef(C)) out.add(refName(C)); else if (C && C.recordWith) Object.values(C.recordWith).forEach(walk); };
  signature.params.forEach(walk); walk(signature.result);
  return [...out];
}
export function sameSignature(a, b) {
  return canonicalJSON({ params: a.params, result: a.result, exact: a.exact === true }) === canonicalJSON({ params: b.params, result: b.result, exact: b.exact === true });
}
