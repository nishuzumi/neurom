// core/canonical.js — canonical JSON (sorted keys, no lossy values) and SHA-256 identities. Every hash in the module
// system (bundles, env identity, artifacts, templates) is sha256 over this serialisation. So two agents that build
// the same object in a different key order get the same id.
import { t } from '../i18n.js';

/** Deterministic JSON text. Rejects NaN/Infinity, functions, class instances and other non-JSON values. */
export function canonicalJSON(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error(t('规范 JSON 不能包含 NaN/Infinity')); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return canonicalJSON(Array.from(value));
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
  }
  throw new Error(t('规范 JSON 必须是纯 JSON 数据'));
}

/** Deep copy with canonical key order (what canonicalJSON would emit, as an object). */
export function canonicalize(value) { return JSON.parse(canonicalJSON(value)); }

const hex = bytes => '0x' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/** sha256 of a UTF-8 string → '0x' + 64 hex chars. */
async function sha256(text) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

/** Identity of a JSON value: sha256(canonicalJSON(value)). */
export function hashOf(value) { return sha256(canonicalJSON(value)); }

/** A content hash as text: sha256 hex with `0x` prefix (used by config schemas that pin hashes). */
export const HASH_PATTERN = '^0x[0-9a-f]{64}$';
export const isHash = value => typeof value === 'string' && new RegExp(HASH_PATTERN).test(value);

/** Recursively freeze plain data (arrays and plain objects). Returns `value`. */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
