// ir/fixtures/generate.mjs — JS → Python differential fixtures. Every case has these parts: a program (source), its
// parameter types, a list of per-lane argument tuples and, per lane, the JS result or the id/op of the node that raised. training/test_ir.py
// replays the same lanes batched (with masks) and requires identical results. Run: node frontend/ir/fixtures/generate.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFunction, compile, tableView } from '../index.js';

const N = { type: 'number' }, B = { type: 'boolean' }, S = { type: 'string' };
const V = width => ({ type: 'vector', width }), A = (length, of) => ({ type: 'array', length, of }), R = fields => ({ type: 'record', fields }), T = (...columns) => ({ type: 'table', columns });
const table = (columns, lo, hi) => ({ columns, lo, hi });
const price = { price: [1, 2.5, -3, 4, 5.75, 6, 7, 8], vol: [10, 20, 30, 40, 50, 60, 70, 80] };
const nanTable = { price: [1, NaN, 3], vol: [1, 2, 3] };

const cases = [
  { name: 'arithmetic', source: '(a, b) => ({ add: a + b, sub: a - b, mul: a * b, div: a / b, mod: a % b, neg: -a, min: Math.min(a, b), max: Math.max(a, b), abs: Math.abs(a), floor: Math.floor(a), ceil: Math.ceil(a), round: Math.round(a), clamp: clamp(a, -1, 1), sqrt: Math.sqrt(Math.abs(b)) })',
    types: [N, N], lanes: [[7, 2], [-7.5, 3], [2.5, -0.5], [-2.5, 0.1], [0.5, 4], [1e-300, 1e300], [1e308, 0], [3, 0], [-0, 1], [1.5, -0]] },
  { name: 'overflow', source: '(a) => a * a', types: [N], lanes: [[2], [1e200], [-3]] },
  { name: 'approx', exact: false, source: '(a) => ({ ln: Math.log(a), exp: Math.exp(a) })', types: [N], lanes: [[1], [2.5], [0], [-1], [1000], [0.001]] },
  { name: 'comparison-logic', source: '(a, b, p) => ({ lt: a < b, lte: a <= b, gt: a > b, gte: a >= b, eq: a === b, neq: a !== b, and: p && a / b > 1, or: p || a / b > 1, not: !p, sel: p ? a / b : b })',
    types: [N, N, B], lanes: [[1, 2, true], [2, 1, false], [1, 1, true], [1, 0, false], [1, 0, true], [-1, 0, false]] },
  { name: 'strings', source: '(s, k) => ({ eq: s === "left", neq: s !== "left", pick: k > 0 ? s : "none", arr: ["a", s, `b`], sel: s === "up" ? 1 : s === "down" ? 2 : 0 })',
    types: [S, N], lanes: [['left', 1], ['up', 0], ['down', -1], ['', 2]] },
  { name: 'vectors', source: '(n, v, i) => ({ bits: bits(n, 5), oneHot: oneHot(n, 6), at: at(v, i), idx: v[i], slice: slice(v, 1, 3), lit: [n, ...v, 1.5], cat: concat(v, [n]) })',
    types: [N, V(4), N], lanes: [[5, [1, 2, 3, 4], 0], [0, [0.5, -1, 2, 3], 3], [31, [1, 1, 1, 1], 1], [32, [1, 2, 3, 4], 0], [3, [1, 2, 3, 4], 4], [2.5, [1, 2, 3, 4], 0], [1, [1, 2, 3, 4], 1.5], [-1, [1, 2, 3, 4], 0], [6, [1, 2, 3, 4], 2]] },
  { name: 'records', source: '(s, k) => { const { pos, hp: h } = s; const next = { ...s, pos: pos + k, tag: h > 0 ? "alive" : "dead" }; return { next, hp2: next.hp * 2, keep: s, sub: { z: next["pos"], y: [pos, h] } }; }',
    types: [R({ pos: N, hp: N, tag: S }), N], lanes: [[{ pos: 1, hp: 3, tag: 'x' }, 2], [{ pos: -1, hp: 0, tag: 'y' }, 0.5]] },
  { name: 'arrays', source: '(arr, k, i) => ({ map: arr.map((x, j) => x * k + j), fold: arr.reduce((acc, x, j) => acc + x * j, 100), scan: scan(arr, 0, (acc, x) => acc + x), upd: update(arr, i, k), idx: arr[i], rg: range(3), lit: array(k, i), nested: arr.map(x => [x, k]), cat: concat(arr.map(x => [x, x])) })',
    types: [A(3, N), N, N], lanes: [[[1, 2, 3], 10, 0], [[0.5, -1, 2], -2, 2], [[1, 1, 1], 0, 3], [[1, 2, 3], 1, -1], [[1, 2, 3], 1, 1.5]] },
  { name: 'array-of-records', source: '(cells, k) => { const grown = cells.map((c, i) => ({ ...c, ore: c.ore + i * k })); const total = grown.reduce((acc, c) => acc + c.ore, 0); const first = cells[k]; const swapped = update(cells, 0, first); return { grown, total, first, swapped, hist: scan(cells, { n: 0, s: "" }, (acc, c) => ({ n: acc.n + c.ore, s: c.ore > 1 ? "big" : acc.s })) }; }',
    types: [A(3, R({ ore: N, name: S })), N], lanes: [[[{ ore: 1, name: 'a' }, { ore: 2, name: 'b' }, { ore: 3, name: 'c' }], 1], [[{ ore: 0, name: 'a' }, { ore: 0, name: 'b' }, { ore: 5, name: 'c' }], 2], [[{ ore: 0, name: 'a' }, { ore: 0, name: 'b' }, { ore: 5, name: 'c' }], 3]] },
  { name: 'nested-bodies-closures', source: '(g, k, d) => ({ grid: g.map((row, r) => row.map((c, q) => (c === 0 ? 0 : c / d) + r * 10 + q + k)), sums: g.map(row => row.reduce((acc, c) => acc + c, k)), lazy: g.map(row => row.map(c => d === 0 ? c : c / d)) })',
    types: [A(2, A(2, N)), N, N], lanes: [[[[0, 1], [2, 3]], 100, 2], [[[0, 0], [0, 0]], 5, 0], [[[1, 0], [0, 0]], 5, 0]] },
  { name: 'u32-rand', source: '(a, b, s) => ({ u: u32(a), imul: imul32(u32(a), u32(b)), add: add32(u32(a), u32(b)), sub: sub32(u32(a), u32(b)), xor: xor32(u32(a), u32(b)), and: and32(u32(a), u32(b)), or: or32(u32(a), u32(b)), shl: shl32(u32(a), s), shr: shr32(u32(a), s), rand: rand(u32(a), u32(b)), rand2: rand(u32(b), u32(a)) })',
    types: [N, N, N], lanes: [[0, 0, 0], [1, 2, 3], [-1, 1, 31], [0xdeadbeef, 0x9e3779b9, 7], [2 ** 32 + 5, 0xffffffff, 1], [123456789, 987654321, 16], [1.5, 1, 0], [1, 1, 32], [2 ** 53 + 2, 1, 0], [2 ** 53, 1, 0], [-(2 ** 53), 1, 0], [2 ** 53 - 1, 1, 0], [7, -1, 0]] },
  { name: 'rand-stream', source: '(seed) => range(8).map(i => rand(u32(seed), u32(i)))', types: [N], lanes: [[0], [42], [0xffffffff], [2024]] },
  { name: 'discretise', source: '(x) => ({ b: bucket(x, [-1, 0.5, 2, 10]), th: thermometer(x, [-1, 0.5, 2, 10]) })', types: [N], lanes: [[-5], [-1], [0], [0.5], [2], [3], [10], [11]] },
  { name: 'tables', source: '(t, i) => ({ at: t.at(i, "price"), vol: t.at(i, "vol"), win: t.window(i, 3, "price") })',
    types: [T('price', 'vol'), N], lanes: [[table(price, 2, 6), 4], [table(price, 2, 6), 6], [table(price, 2, 6), 2], [table(price, 2, 6), 3], [table(price, 2, 6), 7], [table(price, 2, 6), 1], [table(price, 2, 6), 4.5], [table(price, 0, 7), 0]] },
  { name: 'table-nan', source: '(t, i) => t.at(i, "price") + t.at(i, "vol")', types: [T('price', 'vol'), N], lanes: [[table(nanTable, 0, 2), 0], [table(nanTable, 0, 2), 1], [table(nanTable, 0, 2), 2]] },
  { name: 'lazy-errors', source: '(a, b, arr) => { const risky = () => 1 / a; return { s1: a === 0 ? b : risky(), s2: b > 0 && risky() > 0, s3: b > 0 || risky() > 0, m: arr.map(x => x === 0 ? 0 : 1 / x), f: arr.reduce((acc, x) => acc + (a === 0 ? 0 : x / a), 0) }; }',
    types: [N, N, A(3, N)], lanes: [[0, 1, [0, 0, 0]], [2, -1, [1, 2, 4]], [0, -1, [1, 0, 1]], [0, 1, [1, 0, 1]], [0, -1, [0, 0, 0]]] },
  { name: 'reductions', source: '(v, arr, flags, k) => ({ s: sum(v), sa: sum(arr), mn: minOf(v), mx: maxOf(arr), amn: argminFirst(v), amx: argmaxFirst(arr), any: any(flags), all: all(flags), cnt: count(flags), some: arr.some(x => x > k), every: arr.every(x => x > k), nearest: argminFirst(arr.map((x, i) => x === 0 ? 1000000 : Math.abs(i - k))) })',
    types: [V(4), A(4, N), A(3, B), N], lanes: [[[3, 1, 1, 2], [0, 5, 5, 2], [true, false, true], 1], [[0.1, 0.2, 0.3, 0.4], [1e308, 1e308, 0, 0], [false, false, false], 0], [[-0, 0, -1, -1], [1, 2, 3, 4], [true, true, true], 5], [[1e16, 1, 1, -1e16], [0, 0, 0, 0], [true, false, false], 2]] },
  { name: 'signed-zero-extremes', source: '(v, a, b) => ({ mn: minOf(v), mx: maxOf(v), amn: argminFirst(v), amx: argmaxFirst(v), min: Math.min(a, b), max: Math.max(a, b) })',
    types: [V(3), N, N], lanes: [[[0, -0, 1], 0, -0], [[-0, 0, -1], -0, 0], [[1, 0, -0], 1, -0], [[-1, -0, 0], -0, 1]] },
  { name: 'operand-error-order', source: '(a, b, c) => ({ d: (1 / a) / (1 / b), m: (1 % a) % (1 % b), s: c < 0 ? 0 : Math.sqrt(c) - 1 / a })',
    types: [N, N, N], lanes: [[1, 2, 4], [0, 0, 1], [1, 0, 1], [0, 1, 1], [2, 4, -1]] },
  { name: 'hoisted-body-output', source: '(k, arr) => ({ recs: range(3).map(c => ({ g: 1, d: k * 2 })), sums: arr.map(x => arr.reduce((a, y) => a + k, 0)), tag: range(2).map(c => "x") })',
    types: [N, A(2, N)], lanes: [[5, [1, 2]], [-1, [0, 0]], [1e308, [1, 1]]] },
  { name: 'arith-chain-blame', source: '(a, b) => (a * b + 1) * 2 - b', types: [N, N], lanes: [[2, 3], [1e200, 1e200], [1e308, 2], [1, -1e308]] },
  { name: 'arith-root-output-checked', source: '(a) => { const x = a * a; const u = x + 1; return x; }', types: [N], lanes: [[2], [1e200], [-3]] },
  { name: 'arith-body-output-checked', source: '(a, arr) => ({ r: maxOf(arr.map(v => { const y = v * v; const w = y + 1; return y; })), s: a })',
    types: [N, A(2, N)], lanes: [[1, [1, 2]], [1, [1e200, 1]]] },
  { name: 'arith-fused-before-throwing-operand', source: '(a, b) => { const x = a * a; return x + 1 / b; }', types: [N, N], lanes: [[2, 1], [1e200, 0], [1, 0], [1e200, 1]] },
  { name: 'shared-eager-error-order', source: '(x, y) => { const a = 1 / x; const b = 1 / y; return a + b + b; }', types: [N, N], lanes: [[1, 2], [0, 0], [1, 0], [0, 1]] },
  { name: 'zero-param-callbacks', source: '(k, arr) => ({ m: arr.map(() => k), s: arr.some(() => k > 0), f: arr.reduce(() => k, 0), d: arr.map(() => 1 / k) })',
    types: [N, A(2, N)], lanes: [[1, [1, 2]], [-1, [0, 0]], [0, [1, 2]]] },
  { name: 'grid-step', types: [R({ cells: A(16, R({ ore: N, seen: B })), pos: N, t: N, score: N }), N, R({ seed: N, grid: N })], lanes: [
    [{ cells: Array.from({ length: 16 }, (_, i) => ({ ore: i % 3, seen: i % 5 === 0 })), pos: 5, t: 0, score: 0 }, 1, { seed: 7, grid: 4 }],
    [{ cells: Array.from({ length: 16 }, (_, i) => ({ ore: (i * 7) % 4, seen: false })), pos: 15, t: 3, score: 2.5 }, 3, { seed: 99, grid: 4 }],
    [{ cells: Array.from({ length: 16 }, () => ({ ore: 0, seen: true })), pos: 0, t: 9, score: -1 }, 0, { seed: 0, grid: 4 }],
    [{ cells: Array.from({ length: 16 }, (_, i) => ({ ore: i, seen: i > 8 })), pos: 3, t: 1, score: 1 }, 2, { seed: 5, grid: 4 }]],
    source: `function step(state, action, params) {
      const g = params.grid;
      const x = state.pos % g, y = Math.floor(state.pos / g);
      const nx = clamp(x + (action === 1 ? 1 : action === 3 ? -1 : 0), 0, g - 1);
      const ny = clamp(y + (action === 2 ? 1 : action === 0 ? -1 : 0), 0, g - 1);
      const pos = ny * g + nx;
      const key = u32(params.seed);
      const cells = state.cells.map((c, i) => ({ ore: i === pos ? 0 : c.ore + (rand(key, u32(state.t * 16 + i)) < 0.1 ? 1 : 0), seen: c.seen || i === pos }));
      const mined = state.cells[pos].ore;
      const obs = concat(cells.map(c => c.seen ? 1 : 0), cells.map(c => c.ore > 0 ? 1 : 0), bits(pos, 4), thermometer(state.score + mined, [1, 3, 6]));
      const visible = cells.reduce((acc, c) => acc + (c.seen ? 1 : 0), 0);
      return { state: { ...state, cells, pos, t: state.t + 1, score: state.score + mined }, event: { mined, visible, obs, done: visible === 16 } };
    }` },
];

const fixtures = [];
for (const c of cases) {
  const program = parseFunction(c.source), exact = c.exact ?? true;
  const compiled = compile(program, c.types, { exact });
  const lanes = c.lanes.map(args => {
    const values = args.map((a, i) => (c.types[i].type === 'table' ? tableView(a.columns, a.lo, a.hi) : a));
    try { return { args, result: compiled.run(...values) }; }
    catch (error) { if (error.name !== 'ProgramError') throw error; return { args, error: { nodeId: error.nodeId, op: error.op } }; }
  });
  if (!lanes.some(l => 'result' in l)) throw new Error(`${c.name}: no lane succeeded`);
  fixtures.push({ name: c.name, program, paramTypes: c.types, exact, result: compiled.result, cost: compiled.cost, lanes });
}
const out = join(dirname(fileURLToPath(import.meta.url)), 'programs.json');
writeFileSync(out, JSON.stringify(fixtures, (k, v) => (typeof v === 'number' && Object.is(v, -0) ? '-0' : v), 1));
console.log(`${fixtures.length} fixtures, ${fixtures.reduce((n, f) => n + f.lanes.length, 0)} lanes → ${out}`);
