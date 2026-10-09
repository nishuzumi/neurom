// code-complete.ts — what completes at the caret of a restricted-JS file (CodeEditor's autocompletion). CodeModule gives
// the names in scope with their static types. There are two shapes:
// - A member chain `a.b.` / `a.b.pa`: the fields of the record type of the chain, the methods of an array or table, the
//   `Math.` helpers.
// - A bare name prefix: the names in scope, the helpers, the keywords of the subset.
// At that moment the text rarely compiles (`transition.`). So `repaired` is the text without the dangling access, and
// its analysis types the chain.
import type { Completion } from '@codemirror/autocomplete';
import { MATH_OPS } from '../../ir/parse.js';
import { typeName } from '../../core/types.js';
import { t } from '../../i18n.js';
import { HELPERS, METHODS } from './code-hover';

/** a name readable at the caret and its static type (null while nothing types it) */
export interface Named { type: unknown | null; kind: 'param' | 'local' | 'const' | 'input' | 'function' }
/** `chain` empty → a bare name. `repaired` = the text without the access that the user types (and the rest of its word) */
interface Query { from: number; chain: string[]; partial: string; repaired: string }

const ID = '[\\p{L}_$][\\p{L}\\p{N}_$]*';
const MEMBER = new RegExp(`(${ID}(?:\\s*\\.\\s*${ID})*)\\s*\\.\\s*(${ID})?$`, 'u');
const NAME = new RegExp(`${ID}$`, 'u');
/** a name in a declaration, not a name that the text reads */
const DECLARING = new RegExp(`\\b(?:const|let|function)\\s+(?:${ID})?$`, 'u');
/** top-level declarations (column 0): the unit a caret is in */
const TOP = new RegExp(`^(?:export\\s+)?(?:function\\s+(${ID})|const\\s+(${ID}))`, 'gmu');
const KEYWORDS = ['const', 'return', 'if', 'else', 'export', 'function', 'true', 'false'];
const METHODS_OF = { array: ['map', 'some', 'every', 'reduce'], table: ['at', 'window'] } as const;

/** What to complete at `pos`, or null (a name in a declaration, or nothing typed yet unless `explicit`). queryAt reads
 *  only the line of the caret, because in practice a chain does not span lines. */
export function queryAt(text: string, pos: number, explicit: boolean): Query | null {
  const start = text.lastIndexOf('\n', pos - 1) + 1, line = text.slice(start, pos);
  const rest = pos + (/^[\p{L}\p{N}_$]*/u.exec(text.slice(pos))?.[0].length ?? 0);   // the word the caret is inside
  const m = MEMBER.exec(line);
  if (m) {
    if (/\.\s*$|[\p{N}\])]$/u.test(line.slice(0, m.index))) return null;          // `f().a.`, `x[0].a.`: no static root
    const partial = m[2] ?? '', end = start + m.index + m[1].length;
    return { from: pos - partial.length, chain: m[1].split(/\s*\.\s*/), partial, repaired: text.slice(0, end) + text.slice(rest) };
  }
  const partial = NAME.exec(line)?.[0] ?? '';
  if ((!partial && !explicit) || DECLARING.test(line)) return null;
  return { from: pos - partial.length, chain: [], partial, repaired: text.slice(0, pos - partial.length) + text.slice(rest) };
}

/** The top-level const / function whose declaration is the last one before `pos` (null before the first). */
export function unitAt(text: string, pos: number): string | null {
  let name: string | null = null;
  for (const m of text.matchAll(TOP)) { if (m.index >= pos) break; name = m[1] ?? m[2]; }
  return name;
}

const helper = (name: string): Completion => {
  const h = HELPERS[name];
  return { label: name, type: 'function', detail: h ? `(${h[0]}): ${h[1]}` : undefined, info: h ? t(h[2]) : undefined };
};
const method = (name: string): Completion => ({ label: name, type: 'method', detail: METHODS[name][0], info: t(METHODS[name][1]) });

/** the fields of a record type (an open record's known ones), else null */
function fieldsOf(T: unknown): Record<string, unknown> | null {
  const R = T as { type?: string; fields?: Record<string, unknown>; recordWith?: Record<string, unknown> } | null;
  return R?.type === 'record' ? R.fields ?? null : R?.recordWith ?? null;
}
function membersOf(T: unknown): Completion[] {
  const fields = fieldsOf(T);
  if (fields) return Object.entries(fields).map(([k, F]) => ({ label: k, type: 'property', detail: typeName(F) }));
  const R = T as { type?: string; anyTable?: boolean } | null;
  if (R?.type === 'array') return METHODS_OF.array.map(method);
  if (R?.type === 'table' || R?.anyTable) return METHODS_OF.table.map(method);
  return [];
}

/** The completions of `q` over the names in scope. */
export function optionsFor(q: Query, scope: ReadonlyMap<string, Named>): Completion[] {
  if (!q.chain.length) {
    const own = [...scope].map(([label, n]): Completion => ({
      label, boost: 2,
      type: n.kind === 'function' ? 'function' : n.kind === 'const' ? 'constant' : 'variable',
      detail: n.kind === 'function' ? 'ƒ' : n.type == null ? undefined : typeName(n.type),
    }));
    return [...own, ...Object.keys(HELPERS).filter(k => !scope.has(k)).map(helper), { label: 'Math', type: 'namespace' },
      ...KEYWORDS.map((label): Completion => ({ label, type: 'keyword', boost: -1 }))];
  }
  const [root, ...path] = q.chain;
  if (root === 'Math') return path.length ? [] : Object.keys(MATH_OPS).map(helper);
  let T = scope.get(root)?.type ?? null;
  for (const k of path) T = fieldsOf(T)?.[k] ?? null;
  return membersOf(T);
}
