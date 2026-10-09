// ir/compile.js — compile a checked neurom-program into closures. One closure per node. A shared node is memoised
// through per-scope frames (slots + generation counter). Lazy select/and/or evaluate only the taken branch.
// map/fold/scan run their body scope once per element in a reused child frame. training/ir.py mirrors these runtime
// rules bit for bit.
import { t } from '../i18n.js';
import { ProgramError, checkValue, typeName } from './types.js';
import { analyze, LAZY_INPUTS } from './check.js';

const TWO32 = 2 ** 32;
const fail = (node, message) => new ProgramError(message, node.id, node.op);
const checkNumber = (v, node) => { if (!Number.isFinite(v)) throw fail(node, t('{op} 结果不是有限数', { op: node.op })); return v; };
const isU32 = v => Number.isInteger(v) && v >= 0 && v < TWO32;
const u32Input = (v, node, index) => { if (!isU32(v)) throw fail(node, t('{op} 的第 {index} 个输入 {value} 不是 0..2^32-1 的整数', { op: node.op, index, value: v })); return v; };
const ARITH = new Set(['add', 'sub', 'mul']);
const intIndex = (i, node, length) => { if (!Number.isInteger(i) || i < 0 || i >= length) throw fail(node, t('下标 {index} 超出范围 0..{max}', { index: i, max: length - 1 })); return i; };

/** The mixing hash shared with Python: key ^ counter·golden, xorshift-multiply twice, /2^32. */
function randHash(key, counter) {
  let h = (key ^ Math.imul(counter, 0x9e3779b9)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0; h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0; h = Math.imul(h, 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / TWO32;
}

/** frame = { a: args, s: memo slots, g: slot generations, c: current generation, p: parent frame, o: prefetched outer values } */
function newFrame(slots) { return { a: null, s: new Array(slots).fill(undefined), g: new Array(slots).fill(-1), c: 0, p: null, o: null }; }
const hopsBetween = (from, scope) => { let hops = 0; for (let s = from; s !== scope; s = s.parent) hops++; return hops; };
const inFrame = (fn, hops) => (hops === 0 ? fn : hops === 1 ? f => fn(f.p) : hops === 2 ? f => fn(f.p.p) : f => { let g = f; for (let k = 0; k < hops; k++) g = g.p; return fn(g); });

/** Build the evaluator for `info` (from analyze). `checkArgs` / `checkResult` toggle the structural value checks (skip
 *  them when the caller already guarantees shapes). */
function buildEvaluator(info, checkArgs, checkResult) {
  const { nodes, types, root, paramRefs } = info;
  // Consumer counts: a reference from a deeper scope repeats per element, so it always forces memoisation. Alongside:
  // the nodes a same-scope add/sub/mul reads with nothing that can throw evaluated after them (fusion candidates below).
  const consumers = new Map(), chained = new Set();
  for (const { node, scope } of nodes.values()) {
    const arith = ARITH.has(node.op);
    node.inputs.forEach((input, i) => {
      const same = nodes.get(input).scope === scope;
      consumers.set(input, (consumers.get(input) ?? 0) + (same ? 1 : 2));
      if (arith && same && (i === 1 || cheap(nodes.get(node.inputs[1]).node))) chained.add(input);
    });
  }
  const built = new Map(), slotCount = new Map(), frameOf = new Map(), prefetch = new Map();
  // Per scope: nodes evaluated on every run of that scope (reachable from its output without crossing a lazy input).
  const eager = new Map();
  for (const scope of info.scopes) {
    const set = new Set(), stack = [scope.output];
    while (stack.length) {
      const id = stack.pop();
      if (set.has(id)) continue;
      set.add(id);
      const { node } = nodes.get(id), lazy = LAZY_INPUTS[node.op];
      node.inputs.forEach((input, i) => { if (!lazy || !lazy.includes(i)) stack.push(input); });
    }
    eager.set(scope, set);
  }
  /** The closure of `id` as seen from node `by` in scope `from`. A body that references an enclosing node evaluates it in
   *  the enclosing frame. When the referencing node runs on every element, the value is prefetched once per body invocation. */
  const ref = (id, from, by = null) => {
    const fn = built.get(id), { scope } = nodes.get(id), hops = hopsBetween(from, scope);
    if (hops === 0) return fn;
    if (by !== null && eager.get(from).has(by)) {
      let list = prefetch.get(from);
      if (!list) prefetch.set(from, (list = []));
      const slot = list.length;
      list.push(inFrame(fn, hops - 1));   // evaluated in the frame that invokes the body (= body frame's parent)
      const read = f => f.o[slot]; read.slot = slot;
      return read;
    }
    return inFrame(fn, hops);
  };
  // A scope's frame is created once its slot count is final: bodies are fully built before their owner node.
  const frames = scope => { let fr = frameOf.get(scope); if (!fr) { fr = newFrame(slotCount.get(scope) ?? 0); frameOf.set(scope, fr); } return fr; };
  // Arithmetic fusion: some add/sub/mul nodes skip their own finiteness check. This applies when the only consumer is
  // another add/sub/mul in the same scope, and nothing that can throw is evaluated in between. A non-finite intermediate
  // always propagates to the end of the chain (IEEE: inf/NaN through +,-,* stay non-finite). There, the check runs the
  // chain again step by step to name the node that first went non-finite. A scope output is read directly, so it always
  // checks itself.
  const outputs = new Set(info.scopes.map(s => s.output)), fusible = new Set();
  for (const [id, { node }] of nodes) if (ARITH.has(node.op) && consumers.get(id) === 1 && chained.has(id) && !outputs.has(id)) fusible.add(id);
  // Global topological order: every input and body output is built before its consumer, so no recursion is needed.
  for (const id of info.order) {
    const entry = nodes.get(id), { node, scope } = entry;
    let fn = raw(node, entry, types, i => ref(node.inputs[i], scope, id), nodes, paramRefs, built, ref, frames, prefetch, fusible);
    if ((consumers.get(id) ?? 0) > 1 && !cheap(node)) {
      // Shared: computed on first demand within an activation, then a memo read. The order is dependency post-order, so
      // the first failing node is the one that the Python schedule reaches first.
      const slot = slotCount.get(scope) ?? 0; slotCount.set(scope, slot + 1);
      const inner = fn;
      fn = f => { if (f.g[slot] === f.c) return f.s[slot]; const v = inner(f); f.s[slot] = v; f.g[slot] = f.c; return v; };
    }
    built.set(id, fn);
  }
  const top = built.get(root.output), frame = frames(root), resultType = info.result;
  const finish = checkResult ? v => { const problem = checkValue(resultType, v); if (problem) throw new ProgramError(t('结果不符合类型 {type}：{problem}', { type: typeName(resultType), problem }), root.output); return v; } : v => v;
  const nParams = root.params.length, paramTypes = info.paramTypes;
  return args => {
    if (args.length !== nParams) throw new ProgramError(t('需要 {expected} 个参数，收到 {given}', { expected: nParams, given: args.length }));
    if (checkArgs) for (let i = 0; i < nParams; i++) { const problem = checkValue(paramTypes[i], args[i]); if (problem) throw new ProgramError(t('参数 {name} 不符合类型 {type}：{problem}', { name: root.params[i], type: typeName(paramTypes[i]), problem })); }
    frame.a = args; frame.c++;
    return finish(top(frame));
  };
}

/** Body scope: its output closure, one child frame reused across elements (evaluation never enters a body again), and
 *  the outer values to prefetch into `bf.o` at each invocation. */
function bodyOf(entry, ref, frames, prefetch) {
  const scope = entry.body, out = ref(scope.output, scope), bf = frames(scope), pre = prefetch.get(scope) ?? [];
  bf.a = new Array(scope.params.length); bf.o = new Array(pre.length).fill(undefined);
  const n = pre.length, o = bf.o;
  const enter = n === 0 ? f => { bf.p = f; } : f => { bf.p = f; for (let k = 0; k < n; k++) o[k] = pre[k](f); };
  return { out, bf, enter };
}

/** The numeric value of a constant node, else null. */
function constantOf(id, nodes) { const n = nodes.get(id).node; return n.op === 'constant' && typeof n.value === 'number' ? n.value : null; }
/** Nodes whose recomputation is no dearer than a memo lookup. */
function cheap(node) { return node.op === 'constant' || node.op === 'param'; }

/** A constant index input that is statically within 0..length-1, else -1. */
function staticIndex(node, nodes, length) {
  const ref = nodes.get(node.inputs[1]).node;
  return ref.op === 'constant' && Number.isInteger(ref.value) && ref.value >= 0 && ref.value < length ? ref.value : -1;
}
/** Whether the index input is a body parameter known to stay within 0..length-1. This is true for the element index of
 *  any map/fold/scan over an array no longer than `length`. It is also true for the element itself when that array is
 *  `range(n)` with n ≤ length. */
function boundedIndex(node, nodes, types, paramRefs, length) {
  const ref = nodes.get(node.inputs[1]).node;
  if (ref.op !== 'param') return false;
  const { scope, index } = paramRefs.get(ref.id), owner = scope.owner;
  if (!owner) return false;
  const array = nodes.get(owner.inputs[0]).node, n = types.get(owner.inputs[0]).length;
  const elem = owner.op === 'map' ? 0 : 1;
  if (index === elem + 1) return n <= length;
  return index === elem && array.op === 'range' && array.value <= length;
}

/** Which node of an unchecked add/sub/mul chain ending at `node` first produced a non-finite value: recompute stepwise. */
function blameChain(node, nodes, fusible, f, built) {
  for (const input of node.inputs) {
    if (!fusible.has(input)) continue;
    if (!Number.isFinite(built.get(input)(f))) return blameChain(nodes.get(input).node, nodes, fusible, f, built);
  }
  return node;
}

function raw(node, entry, types, input, nodes, paramRefs, built, ref, frames, prefetch, fusible) {
  const { op, id } = node, chk = v => checkNumber(v, node), type = types.get(id);
  const a = node.inputs.length > 0 ? input(0) : null, b = node.inputs.length > 1 ? input(1) : null, c = node.inputs.length > 2 ? input(2) : null;
  switch (op) {
    case 'constant': { const { value } = node; return () => value; }
    case 'param': {
      const { scope, index } = paramRefs.get(id), hops = hopsBetween(entry.scope, scope), read = f => f.a[index];
      if (hops === 0) read.pi = index;
      return inFrame(read, hops);
    }
    case 'add': case 'sub': case 'mul': {
      const ka = constantOf(node.inputs[0], nodes), kb = constantOf(node.inputs[1], nodes);
      let fn;
      if (op === 'add') fn = kb !== null ? f => a(f) + kb : ka !== null ? f => ka + b(f) : f => a(f) + b(f);
      else if (op === 'sub') fn = kb !== null ? f => a(f) - kb : ka !== null ? f => ka - b(f) : f => a(f) - b(f);
      else fn = kb !== null ? f => a(f) * kb : ka !== null ? f => ka * b(f) : f => a(f) * b(f);
      if (fusible.has(id)) return fn;                        // checked by the chain's last node
      if (!node.inputs.some(i => fusible.has(i))) return f => chk(fn(f));
      return f => { const v = fn(f); if (Number.isFinite(v)) return v; const culprit = blameChain(node, nodes, fusible, f, built); throw fail(culprit, t('{op} 结果不是有限数', { op: culprit.op })); };
    }
    case 'div': return f => { const n = a(f), d = b(f); if (d === 0) throw fail(node, t('除数为零')); return chk(n / d); };
    case 'mod': return f => { const n = a(f), d = b(f); if (d === 0) throw fail(node, t('取余的除数为零')); return chk(n % d); };
    case 'neg': return f => -a(f);
    case 'min': { const kb = constantOf(node.inputs[1], nodes); return kb !== null ? f => Math.min(a(f), kb) : f => Math.min(a(f), b(f)); }
    case 'max': { const kb = constantOf(node.inputs[1], nodes); return kb !== null ? f => Math.max(a(f), kb) : f => Math.max(a(f), b(f)); }
    case 'abs': return f => Math.abs(a(f));
    case 'floor': return f => Math.floor(a(f));
    case 'ceil': return f => Math.ceil(a(f));
    case 'round': return f => Math.round(a(f));
    case 'clamp': return f => { const v = a(f), lo = b(f), hi = c(f); if (lo > hi) throw fail(node, t('clamp 下限 {lo} 大于上限 {hi}', { lo, hi })); return v < lo ? lo : v > hi ? hi : v; };
    case 'sqrt': return f => { const v = a(f); if (v < 0) throw fail(node, t('sqrt 的输入 {value} 为负', { value: v })); return Math.sqrt(v); };
    case 'ln': return f => { const v = a(f); if (v <= 0) throw fail(node, t('ln 的输入 {value} 不是正数', { value: v })); return Math.log(v); };
    case 'exp': return f => chk(Math.exp(a(f)));
    case 'lt': return f => a(f) < b(f);
    case 'lte': return f => a(f) <= b(f);
    case 'gt': return f => a(f) > b(f);
    case 'gte': return f => a(f) >= b(f);
    case 'eq': return f => a(f) === b(f);
    case 'neq': return f => a(f) !== b(f);
    case 'and': return f => a(f) && b(f);
    case 'or': return f => a(f) || b(f);
    case 'not': return f => !a(f);
    case 'select': return f => (a(f) ? b(f) : c(f));
    case 'vector': case 'array': { const ins = node.inputs.map((_, i) => input(i)); return f => { const out = new Array(ins.length); for (let i = 0; i < ins.length; i++) out[i] = ins[i](f); return out; }; }
    case 'concat': {
      // Static layout: every input is a vector, an array of numbers or an array of vectors. Fill a preallocated output.
      const ins = node.inputs.map((_, i) => input(i)), nested = node.inputs.map(x => types.get(x).type === 'array' && types.get(x).of.type === 'vector'), width = type.width;
      return f => {
        const out = new Array(width); let k = 0;
        for (let i = 0; i < ins.length; i++) {
          const v = ins[i](f);
          if (nested[i]) { for (let j = 0; j < v.length; j++) { const w = v[j]; for (let m = 0; m < w.length; m++) out[k++] = w[m]; } }
          else for (let j = 0; j < v.length; j++) out[k++] = v[j];
        }
        return out;
      };
    }
    case 'bits': {
      const width = nodes.get(node.inputs[1]).node.value, limit = 2 ** width;
      return f => {
        const n = a(f);
        if (!Number.isSafeInteger(n) || n < 0 || n >= limit) throw fail(node, t('bits 的输入 {value} 不是 0..{max} 的整数', { value: n, max: limit - 1 }));
        const out = new Array(width); let v = n;
        for (let i = 0; i < width; i++) { out[i] = v % 2; v = Math.floor(v / 2); }
        return out;
      };
    }
    case 'oneHot': {
      const width = nodes.get(node.inputs[1]).node.value;
      return f => { const n = a(f); if (!Number.isInteger(n) || n < 0 || n >= width) throw fail(node, t('oneHot 的输入 {value} 不是 0..{max} 的整数', { value: n, max: width - 1 })); const out = new Array(width).fill(0); out[n] = 1; return out; };
    }
    case 'at': case 'index': {
      const source = types.get(node.inputs[0]), length = source.type === 'vector' ? source.width : source.length, k = staticIndex(node, nodes, length);
      if (k >= 0) return f => a(f)[k];
      if (boundedIndex(node, nodes, types, paramRefs, length)) {
        // Hot body pattern: outer array (prefetched slot) indexed by a body parameter — one closure, two field reads.
        const slot = a.slot, pi = b.pi;
        if (slot !== undefined && pi !== undefined) return f => f.o[slot][f.a[pi]];
        return f => a(f)[b(f)];
      }
      return f => { const v = a(f); return v[intIndex(b(f), node, v.length)]; };
    }
    case 'slice': { const start = nodes.get(node.inputs[1]).node.value, end = nodes.get(node.inputs[2]).node.value; return f => a(f).slice(start, end); }
    case 'get': { const { name } = node; return f => a(f)[name]; }
    case 'record': { const keys = node.value, ins = node.inputs.map((_, i) => input(i)); return f => { const out = {}; for (let i = 0; i < keys.length; i++) out[keys[i]] = ins[i](f); return out; }; }
    case 'set': { const { name } = node; return f => { const out = { ...a(f) }; out[name] = b(f); return out; }; }
    case 'update': {
      const k = staticIndex(node, nodes, types.get(node.inputs[0]).length);
      if (k >= 0) return f => { const out = a(f).slice(); out[k] = c(f); return out; };
      return f => { const v = a(f), i = intIndex(b(f), node, v.length), out = v.slice(); out[i] = c(f); return out; };
    }
    case 'range': { const n = node.value, out = new Array(n); for (let i = 0; i < n; i++) out[i] = i; return () => out; }   // values are never mutated in place (update copies)
    case 'map': { const { out, bf, enter } = bodyOf(entry, ref, frames, prefetch); return f => { const arr = a(f), n = arr.length, res = new Array(n); enter(f); for (let i = 0; i < n; i++) { bf.c++; bf.a[0] = arr[i]; bf.a[1] = i; res[i] = out(bf); } return res; }; }
    case 'fold': { const { out, bf, enter } = bodyOf(entry, ref, frames, prefetch); return f => { const arr = a(f), n = arr.length; let acc = b(f); enter(f); for (let i = 0; i < n; i++) { bf.c++; bf.a[0] = acc; bf.a[1] = arr[i]; bf.a[2] = i; acc = out(bf); } return acc; }; }
    case 'scan': { const { out, bf, enter } = bodyOf(entry, ref, frames, prefetch); return f => { const arr = a(f), n = arr.length, res = new Array(n); let acc = b(f); enter(f); for (let i = 0; i < n; i++) { bf.c++; bf.a[0] = acc; bf.a[1] = arr[i]; bf.a[2] = i; acc = out(bf); res[i] = acc; } return res; }; }
    case 'u32': return f => { const v = a(f); if (!Number.isSafeInteger(v)) throw fail(node, t('u32 的输入 {value} 不是安全整数', { value: v })); return v >>> 0; };
    case 'imul32': return f => Math.imul(u32Input(a(f), node, 1), u32Input(b(f), node, 2)) >>> 0;
    case 'add32': return f => (u32Input(a(f), node, 1) + u32Input(b(f), node, 2)) % TWO32;
    case 'sub32': return f => (u32Input(a(f), node, 1) - u32Input(b(f), node, 2) + TWO32) % TWO32;
    case 'xor32': return f => (u32Input(a(f), node, 1) ^ u32Input(b(f), node, 2)) >>> 0;
    case 'and32': return f => (u32Input(a(f), node, 1) & u32Input(b(f), node, 2)) >>> 0;
    case 'or32': return f => (u32Input(a(f), node, 1) | u32Input(b(f), node, 2)) >>> 0;
    case 'shl32': return f => (u32Input(a(f), node, 1) << shift(b(f), node)) >>> 0;
    case 'shr32': return f => u32Input(a(f), node, 1) >>> shift(b(f), node);
    case 'rand': return f => randHash(u32Input(a(f), node, 1), u32Input(b(f), node, 2));
    // Reductions over the element axis. Inputs are statically non-empty (lengths ≥ 1). sum is left-to-right sequential.
    case 'sum': return f => { const v = a(f); let s = v[0]; for (let i = 1; i < v.length; i++) s += v[i]; return chk(s); };
    case 'minOf': return f => { const v = a(f); let m = v[0]; for (let i = 1; i < v.length; i++) if (v[i] < m) m = v[i]; return m; };
    case 'maxOf': return f => { const v = a(f); let m = v[0]; for (let i = 1; i < v.length; i++) if (v[i] > m) m = v[i]; return m; };
    case 'argminFirst': return f => { const v = a(f); let k = 0; for (let i = 1; i < v.length; i++) if (v[i] < v[k]) k = i; return k; };
    case 'argmaxFirst': return f => { const v = a(f); let k = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[k]) k = i; return k; };
    case 'any': return f => { const v = a(f); for (let i = 0; i < v.length; i++) if (v[i]) return true; return false; };
    case 'all': return f => { const v = a(f); for (let i = 0; i < v.length; i++) if (!v[i]) return false; return true; };
    case 'count': return f => { const v = a(f); let n = 0; for (let i = 0; i < v.length; i++) if (v[i]) n++; return n; };
    case 'bucket': { const edges = node.value; return f => { const x = a(f); let k = 0; while (k < edges.length && edges[k] <= x) k++; return k; }; }
    case 'thermometer': { const edges = node.value; return f => { const x = a(f), out = new Array(edges.length); for (let i = 0; i < edges.length; i++) out[i] = x >= edges[i] ? 1 : 0; return out; }; }
    case 'tableAt': {
      const { name } = node;
      return f => { const table = a(f), i = b(f); if (!Number.isInteger(i) || i < table.lo || i > table.hi) throw fail(node, t('行 {row} 超出数据表视图 [{lo}, {hi}]', { row: i, lo: table.lo, hi: table.hi })); return cell(table.columns[name][i], node); };
    }
    case 'tableWindow': {
      const { name, value: k } = node;
      return f => {
        const table = a(f), end = b(f);
        if (!Number.isInteger(end) || end - k + 1 < table.lo || end > table.hi) throw fail(node, t('窗口 [{start}, {end}] 超出数据表视图 [{lo}, {hi}]', { start: end - k + 1, end, lo: table.lo, hi: table.hi }));
        const col = table.columns[name], out = new Array(k);
        for (let i = 0; i < k; i++) out[i] = cell(col[end - k + 1 + i], node);
        return out;
      };
    }
    default: throw fail(node, t('未知操作：{op}', { op }));
  }
}
function shift(s, node) { if (!Number.isInteger(s) || s < 0 || s > 31) throw fail(node, t('位移量 {value} 不是 0..31 的整数', { value: s })); return s; }
function cell(v, node) { if (!Number.isFinite(v)) throw fail(node, t('数据表单元不是有限数：{value}', { value: v })); return v; }

/** Check + compile once. `run(...args)` returns the checked result. Options: `exact` (tier), `checkArgs` / `checkResult`
 *  (default true). false skips the structural value checks. Use it only when the caller guarantees the shapes, for
 *  example values that are checked IR results. The semantics are otherwise identical. */
export function compile(program, paramTypes, options = {}) {
  const info = analyze(program, paramTypes, options), { checkArgs = true, checkResult = true } = options;
  let runner = null;
  return Object.freeze({
    result: info.result,
    cost: info.cost,
    run(...args) { return (runner ??= buildEvaluator(info, checkArgs, checkResult))(args); },
  });
}
