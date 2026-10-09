// code-hover.ts — what a code module shows when the pointer rests on a name (VS Code style). It shows a code line (the
// kind and static type of the name) over its doc text and a few muted notes.
// The targets are the hover spans of parseModule. Types come from typeNodes (best effort: nodes typed before a failure
// still show).
// Doc text comes from these places:
// - Where the value comes from (core/roles.js, core/docs.js + flowDocs). These are the docs of the caller or producer,
//   under the own `@param name` / `@param name.field` of the module. Examples are the field labels of a params module
//   and the JSDoc on the keys of the record literal that built the value.
// - The `/** … */` block above a `const` or a record key.
// - A built-in table for the helpers.
import { typeName } from '../../core/types.js';
import { t } from '../../i18n.js';

export interface HoverSpan {
  start: number; end: number;
  kind: 'param' | 'const' | 'fn' | 'arg' | 'field' | 'key' | 'helper' | 'method';
  name: string; id: string | null; path: string | null;
  doc?: string | null; of?: string; role?: 'elem' | 'index' | 'acc';
}
export interface Hover { code: string; doc: string | null; meta: string[] }
/** ir/docs.js doc tree: what a value means, and its parts (record fields, array elements) */
export interface DocTree { text?: string | null; fields?: Record<string, DocTree>; of?: DocTree }
export interface HoverContext {
  /** node id → static type (typeNodes) */
  types: Map<string, unknown>;
  /** node id → doc tree (flowDocs): what the value of that node means */
  docs: Map<string, DocTree>;
  /** a function parameter: its type (call site / wire / doc), where that type comes from, its doc text */
  param(name: string): { type: unknown | null; source: string; doc: string | null } | undefined;
}

/** The innermost span containing `offset` (spans sorted by start, outer before inner at the same start). */
export function spanAt(spans: readonly HoverSpan[], offset: number): HoverSpan | null {
  let best: HoverSpan | null = null;
  for (const s of spans) {
    if (s.start > offset) break;
    if (offset < s.end && (!best || s.end - s.start <= best.end - best.start)) best = s;
  }
  return best;
}

/** One-line type, or one field per line for a record that would not fit one line (nested types stay on their line). */
function prettyType(T: unknown): string {
  const line = typeName(T);
  const R = T as { type?: string; fields?: Record<string, unknown> } | null;
  if (line.length <= 56 || R?.type !== 'record' || !R.fields) return line;
  return `{\n${Object.entries(R.fields).map(([k, F]) => `  ${k}: ${typeName(F)};`).join('\n')}\n}`;
}

// ------------------------------------------------------------------ built-ins: [params, result, description key]
type Builtin = readonly [string, string, string];
const NUM1: readonly [string, string] = ['x: number', 'number'], NUM2: readonly [string, string] = ['a: number, b: number', 'number'];
const REDUCE: readonly [string, string] = ['v: vector[n] | number[n]', 'number'];
export const HELPERS: Record<string, Builtin> = {
  concat: ['...parts: vector[·] | number[·] | vector[·][·]', 'vector[Σ]', '按顺序拼接向量与数值数组（向量数组逐个展开），得到一个向量'],
  bits: ['n: number, width: number', 'bits[width]', '整数 n 的二进制位，低位在前。width 必须是数值字面量'],
  oneHot: ['n: number, width: number', 'bits[width]', '第 n 位为 1、其余为 0 的独热向量。width 必须是数值字面量'],
  at: ['v: vector[n], i: number', 'number', '向量 v 的第 i 个元素（从 0 开始）'],
  slice: ['v: vector[n], start: number, end: number', 'vector[end - start]', '向量 v 的 [start, end) 段。start、end 必须是数值字面量'],
  clamp: ['x: number, lo: number, hi: number', 'number', '把 x 限制在 [lo, hi] 内'],
  u32: [...NUM1, '把安全整数按 2^32 取模，得到 32 位无符号整数'],
  imul32: [...NUM2, '32 位无符号乘法，保留低 32 位'],
  add32: [...NUM2, '32 位无符号加法（模 2^32）'],
  sub32: [...NUM2, '32 位无符号减法（模 2^32）'],
  xor32: [...NUM2, '32 位无符号按位异或'],
  and32: [...NUM2, '32 位无符号按位与'],
  or32: [...NUM2, '32 位无符号按位或'],
  shl32: ['a: number, s: number', 'number', '左移 s 位（0..31），保留低 32 位'],
  shr32: ['a: number, s: number', 'number', '逻辑右移 s 位（0..31）'],
  rand: ['key: number, counter: number', 'number', '由 key 与 counter 决定的伪随机数，范围 [0, 1)。同样的输入总是得到同样的结果'],
  array: ['...items: T', 'T[n]', '由同类型元素组成的数组'],
  update: ['a: T[n], i: number, v: T', 'T[n]', '把数组 a 的第 i 个元素换成 v 后的新数组'],
  sum: [...REDUCE, '所有元素之和'],
  minOf: [...REDUCE, '最小的元素'],
  maxOf: [...REDUCE, '最大的元素'],
  argminFirst: [...REDUCE, '最小元素的下标（并列时取最前一个）'],
  argmaxFirst: [...REDUCE, '最大元素的下标（并列时取最前一个）'],
  any: ['b: boolean[n]', 'boolean', '是否至少有一个为 true'],
  all: ['b: boolean[n]', 'boolean', '是否全部为 true'],
  count: ['b: boolean[n]', 'number', '为 true 的个数'],
  range: ['n: number', 'number[n]', '数组 [0, 1, …, n - 1]。n 必须是整数字面量'],
  bucket: ['x: number, edges: number[]', 'number', 'x 所在区间的序号，也就是不大于 x 的分界点个数。edges 必须是数值字面量数组'],
  thermometer: ['x: number, edges: number[]', 'bits[edges.length]', '温度计编码：第 i 位表示 x ≥ edges[i]。edges 必须是数值字面量数组'],
  scan: ['a: T[n], init: A, (acc: A, elem: T, index: number) => A', 'A[n]', '从 init 开始依次累加，返回每一步之后的累加值'],
  min: [...NUM2, '两者中较小的一个'],
  max: [...NUM2, '两者中较大的一个'],
  abs: [...NUM1, '绝对值'],
  floor: [...NUM1, '向下取整'],
  ceil: [...NUM1, '向上取整'],
  round: [...NUM1, '四舍五入到整数（.5 向上）'],
  sqrt: [...NUM1, '平方根（输入不能为负）'],
  log: [...NUM1, '自然对数（输入必须为正）。这是近似运算，精确层不可用'],
  exp: [...NUM1, 'e 的 x 次方。这是近似运算，精确层不可用'],
};
export const METHODS: Record<string, readonly [string, string]> = {
  map: ['a.map((elem: T, index: number) => U): U[n]', '对每个元素求回调，返回同样长度的数组'],
  some: ['a.some((elem: T, index: number) => boolean): boolean', '是否至少有一个元素让回调返回 true'],
  every: ['a.every((elem: T, index: number) => boolean): boolean', '是否每个元素都让回调返回 true'],
  reduce: ['a.reduce((acc: A, elem: T, index: number) => A, init: A): A', '从 init 开始依次累加，返回最终的累加值'],
  at: ["table.at(row: number, column: 'name'): number", '数据表第 row 行、column 列的值（行必须在视图内）'],
  window: ["table.window(end: number, k: number, column: 'name'): vector[k]", '数据表 column 列以第 end 行结尾的连续 k 行。k 必须是整数字面量'],
};
const ROLES = { elem: '{of} 回调的当前元素', index: '{of} 回调的当前下标', acc: '{of} 回调的累加值' } as const;

/** The hover of one span. */
export function describe(span: HoverSpan, ctx: HoverContext): Hover {
  const typed = span.id != null ? ctx.types.get(span.id) : undefined;
  const at = (fallback: unknown = null) => prettyType(typed ?? fallback);
  const flowed = (span.id != null ? ctx.docs.get(span.id)?.text : null) || null;
  switch (span.kind) {
    case 'param': {
      const p = ctx.param(span.name);
      return { code: `(parameter) ${span.name}: ${at(p?.type)}`, doc: p?.doc || null, meta: p ? [p.source] : [] };
    }
    case 'const': return { code: `const ${span.name}: ${at()}`, doc: span.doc || flowed, meta: [] };
    case 'fn': return { code: `const ${span.name}: () => ${at()}`, doc: span.doc || flowed, meta: [] };
    case 'arg': return { code: `(parameter) ${span.name}: ${at()}`, doc: flowed, meta: span.role ? [t(ROLES[span.role], { of: span.of ?? '' })] : [] };
    case 'field': return { code: `(property) ${span.path ?? span.name}: ${at()}`, doc: flowed, meta: [] };
    case 'key': return { code: `(property) ${span.name}: ${at()}`, doc: span.doc || flowed, meta: [] };
    case 'helper': {
      const h = HELPERS[span.name.replace(/^Math\./, '')];
      const meta = typed ? [t('此处返回 {type}', { type: typeName(typed) })] : [];
      return h ? { code: `${span.name}(${h[0]}): ${h[1]}`, doc: t(h[2]), meta } : { code: `${span.name}(…)`, doc: null, meta };
    }
    case 'method': {
      const m = METHODS[span.name];
      const meta = typed ? [t('此处返回 {type}', { type: typeName(typed) })] : [];
      return m ? { code: m[0], doc: t(m[1]), meta } : { code: `.${span.name}(…)`, doc: null, meta };
    }
  }
}

// ------------------------------------------------------------------ placement
/** Where a hover box goes for an anchor rect: under it, or above it when too close to the bottom of the window. */
export function hoverPlace(anchor: { left: number; top: number; bottom: number }): Record<string, string> {
  const left = `${Math.max(4, Math.min(anchor.left, window.innerWidth - 444))}px`;
  return anchor.bottom + 180 < window.innerHeight ? { left, top: `${anchor.bottom + 4}px` } : { left, bottom: `${window.innerHeight - anchor.top + 4}px` };
}
