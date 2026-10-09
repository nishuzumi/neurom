// ir/types.js — the IR type language that the checker and the compiler share. core/types.js uses the same JSON shapes
// for port types and adds handles / constraints on top. A type is plain JSON: number | boolean | string | vector(width) |
// array(length, of) | record{fields} | table{columns}. `checkValue` is the runtime shape check for program arguments and results.
import { t } from '../i18n.js';

export const LIMITS = Object.freeze({
  maxNodes: 4096,          // nodes in the whole program, bodies included
  maxCost: 2_000_000,      // static worst-case node evaluations per call
  maxVectorWidth: 4096,
  maxArrayLength: 4096,
  maxBitsWidth: 53,
  maxIdLength: 64,
  maxRecordFields: 256,
});

export const NUMBER = Object.freeze({ type: 'number' });
export const BOOLEAN = Object.freeze({ type: 'boolean' });
export const STRING = Object.freeze({ type: 'string' });
export const SCALARS = Object.freeze(['number', 'boolean', 'string']);

/** Graph-level failure (structure, typing, runtime): `nodeId` / `op` locate the offending node when known. */
export class ProgramError extends Error {
  constructor(message, nodeId = null, op = null) { super(message); this.name = 'ProgramError'; this.nodeId = nodeId; this.op = op; }
}

export function plain(value) { return value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
export const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

export const vectorType = width => ({ type: 'vector', width });
export const arrayType = (length, of) => ({ type: 'array', length, of });
export function recordType(fields) {
  const out = {};
  for (const key of Object.keys(fields).sort()) out[key] = fields[key];
  return { type: 'record', fields: out };
}
const tableType = columns => ({ type: 'table', columns: [...columns] });

/** Reject anything that is not a well-formed type. Returns the canonical form (record keys sorted, no extra keys). */
export function canonicalType(type, where = t('类型')) {
  const bad = why => new ProgramError(t('{where}不是合法类型：{why}', { where, why }));
  if (!plain(type) || typeof type.type !== 'string') throw bad(t('必须是带 type 字段的对象'));
  switch (type.type) {
    case 'number': return NUMBER;
    case 'boolean': return BOOLEAN;
    case 'string': return STRING;
    case 'vector':
      if (!isInt(type.width, 1, LIMITS.maxVectorWidth)) throw bad(t('向量宽度必须是 1..{max} 的整数', { max: LIMITS.maxVectorWidth }));
      return vectorType(type.width);
    case 'array':
      if (!isInt(type.length, 1, LIMITS.maxArrayLength)) throw bad(t('数组长度必须是 1..{max} 的整数', { max: LIMITS.maxArrayLength }));
      return arrayType(type.length, canonicalType(type.of, where));
    case 'record': {
      if (!plain(type.fields)) throw bad(t('记录必须带 fields 对象'));
      const keys = Object.keys(type.fields);
      if (keys.length > LIMITS.maxRecordFields) throw bad(t('记录最多 {max} 个字段', { max: LIMITS.maxRecordFields }));
      const fields = {};
      for (const key of keys) { if (!validKey(key)) throw bad(t('字段名 {key} 不合法', { key })); fields[key] = canonicalType(type.fields[key], where); }
      return recordType(fields);
    }
    case 'table': {
      if (!Array.isArray(type.columns) || type.columns.length === 0 || type.columns.some(c => !validKey(c))) throw bad(t('数据表必须声明至少一个列名'));
      if (new Set(type.columns).size !== type.columns.length) throw bad(t('数据表列名重复'));
      return tableType(type.columns);
    }
    default: throw bad(t('未知类型 {type}', { type: type.type }));
  }
}
export function validKey(key) { return typeof key === 'string' && key.length > 0 && key.length <= 64 && key !== '__proto__'; }

export function typeName(type) {
  switch (type.type) {
    case 'vector': return `vector(${type.width})`;
    case 'array': return `array(${type.length}, ${typeName(type.of)})`;
    case 'record': return `{${Object.keys(type.fields).sort().map(k => `${k}: ${typeName(type.fields[k])}`).join(', ')}}`;
    case 'table': return `table(${type.columns.join(', ')})`;
    default: return type.type;
  }
}

export function sameType(a, b) {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'vector': return a.width === b.width;
    case 'array': return a.length === b.length && sameType(a.of, b.of);
    case 'record': {
      const ka = Object.keys(a.fields).sort(), kb = Object.keys(b.fields).sort();
      return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameType(a.fields[k], b.fields[k]));
    }
    case 'table': return a.columns.length === b.columns.length && a.columns.every((c, i) => c === b.columns[i]);
    default: return true;
  }
}

const finite = v => typeof v === 'number' && Number.isFinite(v);
const numericList = v => Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView));

/** Structural runtime check of `value` against `type`: returns a problem string, or null when the value fits. */
export function checkValue(type, value, path = '') {
  const at = what => (path ? t('{path}：{what}', { path, what }) : what);
  switch (type.type) {
    case 'number': return finite(value) ? null : at(t('必须是有限数'));
    case 'boolean': return typeof value === 'boolean' ? null : at(t('必须是布尔值'));
    case 'string': return typeof value === 'string' ? null : at(t('必须是字符串'));
    case 'vector':
      if (!numericList(value) || value.length !== type.width) return at(t('必须是宽度 {width} 的向量', { width: type.width }));
      for (let i = 0; i < value.length; i++) if (!finite(value[i])) return at(t('第 {index} 个元素不是有限数', { index: i }));
      return null;
    case 'array':
      if (!Array.isArray(value) || value.length !== type.length) return at(t('必须是长度 {length} 的数组', { length: type.length }));
      if (type.of.type === 'number') { for (let i = 0; i < value.length; i++) if (!finite(value[i])) return checkValue(type.of, value[i], `${path}[${i}]`); return null; }
      if (type.of.type === 'boolean') { for (let i = 0; i < value.length; i++) if (typeof value[i] !== 'boolean') return checkValue(type.of, value[i], `${path}[${i}]`); return null; }
      for (let i = 0; i < value.length; i++) { const p = checkValue(type.of, value[i], `${path}[${i}]`); if (p) return p; }
      return null;
    case 'record': {
      if (!plain(value)) return at(t('必须是记录对象'));
      const keys = Object.keys(type.fields);
      for (const key of keys) {
        if (!Object.hasOwn(value, key)) return at(t('缺少字段 {key}', { key }));
        const p = checkValue(type.fields[key], value[key], path ? `${path}.${key}` : key); if (p) return p;
      }
      for (const key of Object.keys(value)) if (!Object.hasOwn(type.fields, key)) return at(t('多出字段 {key}', { key }));
      return null;
    }
    case 'table': {
      if (!plain(value) || !plain(value.columns)) return at(t('必须是 tableView 生成的数据表视图'));
      let rows = -1;
      for (const col of type.columns) {
        const data = value.columns[col];
        if (!numericList(data)) return at(t('缺少列 {col}', { col }));
        if (rows === -1) rows = data.length; else if (data.length !== rows) return at(t('列 {col} 的行数与其他列不同', { col }));
      }
      if (!Number.isSafeInteger(value.lo) || !Number.isSafeInteger(value.hi) || value.lo < 0 || value.hi >= rows || value.hi < value.lo - 1) return at(t('视图边界 [{lo}, {hi}] 超出 {rows} 行', { lo: value.lo, hi: value.hi, rows }));
      return null;
    }
    default: return at(t('未知类型 {type}', { type: type.type }));
  }
}

/** A table value: shared columns plus the inclusive row window [lo, hi] a program may read (hi = lo - 1 is empty). */
export function tableView(columns, lo, hi) {
  if (!plain(columns) || Object.keys(columns).length === 0) throw new ProgramError(t('tableView 的 columns 必须是列名到数值列的对象'));
  const view = Object.freeze({ columns, lo, hi });
  const problem = checkValue(tableType(Object.keys(columns)), view);
  if (problem) throw new ProgramError(problem);
  return view;
}

/** The static type of a JSON constant: number, boolean or string. */
export function constantType(value) {
  if (typeof value === 'boolean') return BOOLEAN;
  if (typeof value === 'string') return STRING;
  if (finite(value)) return NUMBER;
  return null;
}
