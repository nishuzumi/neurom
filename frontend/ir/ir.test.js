import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFunction, parseCode, parseModule, check, typeNodes, flowDocs, compile, tableView, ProgramError, ProgramSourceError } from './index.js';
import { checkValue, canonicalType, typeName, sameType, LIMITS } from './types.js';

const N = { type: 'number' }, B = { type: 'boolean' }, S = { type: 'string' };
const V = width => ({ type: 'vector', width }), A = (length, of) => ({ type: 'array', length, of }), R = fields => ({ type: 'record', fields }), T = (...columns) => ({ type: 'table', columns });
const fn = (source, types, options = { exact: true }) => compile(parseFunction(source), types, options);
const run = (source, types, ...args) => fn(source, types).run(...args);
const throws = (f, pattern) => assert.throws(f, e => (e instanceof ProgramError || e instanceof ProgramSourceError) && (!pattern || pattern.test(e.message)));

// ───────────────────────────── arithmetic / comparison / logic ─────────────────────────────
test('arithmetic follows IEEE with JS % and Math.round semantics; non-finite and zero divisors are errors', () => {
  assert.equal(run('(a, b) => a + b * 2 - a / b', [N, N], 7, 2), 7 + 4 - 3.5);
  assert.equal(run('(a, b) => a % b', [N, N], -7, 3), -1);
  assert.equal(run('a => Math.round(a)', [N], -2.5), -2);
  assert.equal(run('a => Math.round(a)', [N], 2.5), 3);
  assert.equal(run('a => -a', [N], 3), -3);
  assert.deepEqual(run('a => [Math.floor(a), Math.ceil(a), Math.abs(a), Math.min(a, 0), Math.max(a, 0)]', [N], -1.5), [-2, -1, 1.5, -1.5, 0]);
  assert.equal(run('a => clamp(a, 0, 5)', [N], 9), 5);
  assert.equal(run('a => Math.sqrt(a)', [N], 2), Math.SQRT2);
  throws(() => run('(a, b) => a / b', [N, N], 1, 0), /零|zero/);
  throws(() => run('(a, b) => a % b', [N, N], 1, 0));
  throws(() => run('a => a * a', [N], 1e200), /有限/);
  throws(() => run('a => clamp(a, 5, 0)', [N], 1), /clamp/);
  throws(() => run('a => Math.sqrt(a)', [N], -1), /sqrt/);
});

test('ln/exp are approx-tier only and reject bad domains', () => {
  const p = parseFunction('a => Math.log(a) + Math.exp(a)');
  throws(() => check(p, [N], { exact: true }), /精确层/);
  assert.equal(compile(p, [N], { exact: false }).run(1), Math.E);
  throws(() => compile(p, [N]).run(0), /ln/);
  throws(() => fn('a => Math.exp(a)', [N], {}).run(1000), /有限/);
});

test('comparison and lazy logic: untaken branches never evaluate', () => {
  assert.deepEqual(run('(a, b) => [a < b ? 1 : 0, a <= b ? 1 : 0, a > b ? 1 : 0, a >= b ? 1 : 0, a === b ? 1 : 0, a !== b ? 1 : 0]', [N, N], 1, 1), [0, 1, 0, 1, 1, 0]);
  assert.equal(run('(a, b) => a === 0 || 1 / a > b', [N, N], 0, 5), true);
  assert.equal(run('(a, b) => a !== 0 && 1 / a > b', [N, N], 0, 5), false);
  assert.equal(run('a => a === 0 ? 1 : 1 / a', [N], 0), 1);
  assert.equal(run('(p, q) => !p === q', [B, B], true, false), true);
  throws(() => parseFunction('(a, b) => a == b'), /===/);
});

test('eq/neq compare scalars of one static type, including strings', () => {
  assert.equal(run('(a, b) => a === b', [S, S], 'x', 'x'), true);
  assert.equal(run('(a, b) => a !== b', [S, S], 'x', 'y'), true);
  assert.equal(run('a => a === "left" ? 1 : 2', [S], 'left'), 1);
  throws(() => check(parseFunction('(a, b) => a === b'), [N, S]), /一致/);
  throws(() => check(parseFunction('(a, b) => a === b'), [V(2), V(2)]), /标量|字符串/);
  throws(() => check(parseFunction('(a, b) => a + b'), [S, S]), /number/);
});

// ───────────────────────────── vectors ─────────────────────────────
test('vector ops: literal, concat over vectors and arrays, bits, oneHot, index, slice', () => {
  assert.deepEqual(run('(a, v) => [a, ...v, 3]', [N, V(2)], 1, [7, 8]), [1, 7, 8, 3]);
  assert.deepEqual(run('a => bits(a, 4)', [N], 5), [1, 0, 1, 0]);
  assert.deepEqual(run('a => oneHot(a, 3)', [N], 2), [0, 0, 1]);
  assert.deepEqual(run('v => slice(v, 1, 3)', [V(4)], [1, 2, 3, 4]), [2, 3]);
  assert.equal(run('(v, i) => v[i]', [V(3), N], [4, 5, 6], 2), 6);
  assert.equal(run('(v, i) => at(v, i)', [V(3), N], [4, 5, 6], 0), 4);
  assert.deepEqual(run('arr => concat(arr, arr.map(x => [x, x]))', [A(2, N)], [1, 2]), [1, 2, 1, 1, 2, 2]);
  assert.deepEqual(run('arr => [...arr.map(x => x * 2)]', [A(2, N)], [1, 2]), [2, 4]);
  throws(() => run('a => bits(a, 4)', [N], 16), /bits/);
  throws(() => run('a => bits(a, 4)', [N], 1.5), /bits/);
  throws(() => run('a => oneHot(a, 3)', [N], 3), /oneHot/);
  throws(() => run('(v, i) => v[i]', [V(3), N], [4, 5, 6], 3), /下标/);
  throws(() => run('(v, i) => v[i]', [V(3), N], [4, 5, 6], 0.5), /下标/);
  throws(() => parseFunction('v => slice(v, 0, v)'), /字面量/);
  throws(() => check(parseFunction('v => slice(v, 2, 1)'), [V(4)]), /终点/);
  throws(() => check(parseFunction('a => bits(a, 54)'), [N]), /位宽/);
  throws(() => check(parseFunction('(a, s) => [a, s]'), [N, S]), /number/);
});

// ───────────────────────────── records / arrays ─────────────────────────────
test('records: literal, get, spread update, destructuring, canonical field order', () => {
  const State = R({ pos: N, hp: N });
  assert.deepEqual(run('s => ({ ...s, pos: s.pos + 1 })', [State], { pos: 1, hp: 3 }), { pos: 2, hp: 3 });
  assert.deepEqual(run('s => { const { pos, hp: h } = s; return { b: h, a: pos }; }', [State], { pos: 1, hp: 3 }), { a: 1, b: 3 });
  assert.deepEqual(run('s => s["pos"]', [State], { pos: 1, hp: 3 }), 1);
  const { result } = check(parseFunction('s => ({ z: 1, a: s })'), [State]);
  assert.equal(typeName(result), '{a: {hp: number, pos: number}, z: number}');
  throws(() => check(parseFunction('s => s.missing'), [State]), /字段/);
  throws(() => check(parseFunction('s => ({ ...s, pos: true })'), [State]), /一致/);
  throws(() => parseFunction('s => ({ ...s, ...s })'), /展开/);
  throws(() => parseFunction('s => ({ a: 1, a: 2 })'), /重复/);
  throws(() => parseFunction('s => ({ __proto__: 1 })'), /不合法/);
  throws(() => run('s => s', [State], { pos: 1 }), /缺少字段/);
  throws(() => run('s => s', [State], { pos: 1, hp: 2, extra: 0 }), /多出/);
});

test('arrays: literal, index, update, range, map/fold/scan with index and closures', () => {
  assert.deepEqual(run('(a, b) => array(a, b)', [N, N], 1, 2), [1, 2]);
  assert.deepEqual(check(parseFunction('() => ["stay", "up"]'), []).result, A(2, S));
  assert.deepEqual(fn('() => [{ a: 1 }, { a: 2 }]', []).run(), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(run('arr => update(arr, 1, 9)', [A(3, N)], [1, 2, 3]), [1, 9, 3]);
  assert.deepEqual(fn('() => range(4)', []).run(), [0, 1, 2, 3]);
  assert.deepEqual(run('(arr, k) => arr.map((x, i) => x * k + i)', [A(3, N), N], [1, 2, 3], 10), [10, 21, 32]);
  assert.equal(run('arr => arr.reduce((acc, x, i) => acc + x * i, 100)', [A(3, N)], [1, 2, 3]), 108);
  assert.deepEqual(run('arr => scan(arr, 0, (acc, x) => acc + x)', [A(3, N)], [1, 2, 3]), [1, 3, 6]);
  assert.deepEqual(run('cells => cells.map(c => ({ ...c, ore: c.ore * 2 }))', [A(2, R({ ore: N }))], [{ ore: 1 }, { ore: 2 }]), [{ ore: 2 }, { ore: 4 }]);
  // nested bodies referencing two enclosing scopes
  assert.deepEqual(run('(g, k) => g.map((row, r) => row.map((c, q) => c + r * 10 + q + k))', [A(2, A(2, N)), N], [[0, 0], [0, 0]], 100), [[100, 101], [110, 111]]);
  assert.equal(run('arr => arr.reduce((acc, x) => acc && x > 0, true)', [A(2, N)], [1, -1]), false);
  throws(() => run('(arr, i) => arr[i]', [A(3, N), N], [1, 2, 3], -1), /下标/);
  throws(() => run('(arr, i) => update(arr, i, 0)', [A(3, N), N], [1, 2, 3], 3), /下标/);
  throws(() => check(parseFunction('arr => arr.reduce((acc, x) => x > 0, 0)'), [A(2, N)]), /累加器/);
  throws(() => check(parseFunction('arr => update(arr, 0, true)'), [A(2, N)]), /一致/);
  throws(() => check(parseFunction('(a, b) => array(a, b)'), [N, B]), /一致/);
  throws(() => parseFunction('arr => arr.map(x => y => x)'), /函数/);
  throws(() => parseFunction('arr => arr.map(({ a }) => a)'), /标识符/);
  throws(() => parseFunction('() => range(0)'), /range/);
  throws(() => parseFunction('arr => arr.forEach(x => x)'), /方法/);
});

test('lazy branches inside bodies and body-independent nodes are hoisted without changing laziness', () => {
  const program = parseFunction('(arr, d) => arr.map(x => x === 0 ? 0 : x / d)');
  assert.deepEqual(compile(program, [A(2, N), N]).run([0, 0], 0), [0, 0]);
  throws(() => compile(program, [A(2, N), N]).run([0, 1], 0), /零/);
  assert.deepEqual(fn('(arr, d) => arr.map(x => d === 0 ? x : x / d)', [A(2, N), N]).run([1, 2], 0), [1, 2]);
});

// ───────────────────────────── u32 / rand ─────────────────────────────
test('u32 ops follow Math.imul / >>> semantics and reject non-u32 inputs', () => {
  assert.equal(run('a => u32(a)', [N], -1), 0xffffffff);
  assert.equal(run('a => u32(a)', [N], 2 ** 32 + 5), 5);
  assert.equal(run('(a, b) => imul32(a, b)', [N, N], 0xffffffff, 0xffffffff), 1);
  assert.equal(run('(a, b) => imul32(a, b)', [N, N], 0x9e3779b9, 7), Math.imul(0x9e3779b9, 7) >>> 0);
  assert.equal(run('(a, b) => add32(a, b)', [N, N], 0xffffffff, 2), 1);
  assert.equal(run('(a, b) => sub32(a, b)', [N, N], 0, 1), 0xffffffff);
  assert.equal(run('(a, b) => xor32(a, b)', [N, N], 0xf0f0f0f0, 0xffffffff), 0x0f0f0f0f);
  assert.equal(run('(a, b) => and32(a, b)', [N, N], 0xf0f0f0f0, 0xff), 0xf0);
  assert.equal(run('(a, b) => or32(a, b)', [N, N], 0xf0000000, 1), 0xf0000001);
  assert.equal(run('(a, b) => shl32(a, b)', [N, N], 1, 31), 0x80000000);
  assert.equal(run('(a, b) => shl32(a, b)', [N, N], 3, 31), 0x80000000);
  assert.equal(run('(a, b) => shr32(a, b)', [N, N], 0x80000000, 31), 1);
  throws(() => run('a => u32(a)', [N], 1.5), /u32/);
  throws(() => run('(a, b) => add32(a, b)', [N, N], -1, 1), /0\.\.2\^32-1/);
  throws(() => run('(a, b) => imul32(a, b)', [N, N], 2 ** 32, 1));
  throws(() => run('(a, b) => shl32(a, b)', [N, N], 1, 32), /位移/);
});

test('rand is the specified hash of (key, counter) in [0, 1)', () => {
  const hash = (key, counter) => {
    let h = (key ^ Math.imul(counter, 0x9e3779b9)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16;
    return (h >>> 0) / 2 ** 32;
  };
  for (const [k, c] of [[0, 0], [1, 0], [0, 1], [0xdeadbeef, 12345], [0xffffffff, 0xffffffff]]) {
    assert.equal(run('(k, c) => rand(k, c)', [N, N], k, c), hash(k, c));
  }
  assert.notEqual(run('(k, c) => rand(k, c)', [N, N], 1, 2), run('(k, c) => rand(k, c)', [N, N], 1, 3));
  throws(() => run('(k, c) => rand(k, c)', [N, N], -1, 0));
});

// ───────────────────────────── discretisation / tables ─────────────────────────────
test('bucket and thermometer use ascending constant edges', () => {
  assert.deepEqual([0, 1, 5, 7, 11].map(x => run('x => bucket(x, [1, 5, 10])', [N], x)), [0, 1, 2, 2, 3]);
  assert.deepEqual(run('x => thermometer(x, [-1, 0.5, 2])', [N], 0.5), [1, 1, 0]);
  throws(() => parseFunction('x => bucket(x, [1, x])'), /字面量/);
  throws(() => check(parseFunction('x => bucket(x, [2, 1])'), [N]), /递增/);
});

test('tables: at/window within the view bounds, errors outside or on non-finite cells', () => {
  const view = tableView({ price: new Float64Array([1, 2, 3, 4, 5]), vol: [10, 20, 30, 40, 50] }, 1, 3);
  assert.equal(run('(t, i) => t.at(i, "price")', [T('price', 'vol'), N], view, 3), 4);
  assert.deepEqual(run('(t, i) => t.window(i, 3, "vol")', [T('price', 'vol'), N], view, 3), [20, 30, 40]);
  throws(() => run('(t, i) => t.at(i, "price")', [T('price'), N], view, 4), /视图/);
  throws(() => run('(t, i) => t.at(i, "price")', [T('price'), N], view, 0), /视图/);
  throws(() => run('(t, i) => t.at(i, "price")', [T('price'), N], view, 1.5), /视图/);
  throws(() => run('(t, i) => t.window(i, 3, "vol")', [T('vol'), N], view, 2), /视图/);
  throws(() => check(parseFunction('t => t.at(0, "nope")'), [T('price')]), /列/);
  throws(() => parseFunction('(t, c) => t.at(0, c)'), /字面量/);
  const nan = tableView({ price: [1, NaN] }, 0, 1);
  throws(() => run('t => t.at(1, "price")', [T('price')], nan), /有限/);
  assert.equal(tableView({ a: [1, 2] }, 2, 1).hi, 1);
  throws(() => tableView({ a: [1, 2] }, 0, 2), /边界/);
  throws(() => tableView({ a: [1, 2], b: [1] }, 0, 1), /行数/);
  assert.equal(checkValue(T('price'), { columns: { price: [1], other: [2] }, lo: 0, hi: 0 }), null);
});

// ───────────────────────────── static rules / limits ─────────────────────────────
test('check reports result type and cost; cost counts bodies per element and enforces the ceiling', () => {
  const program = parseFunction('arr => arr.map(x => x + 1)'), { result, cost } = check(program, [A(100, N)]);
  assert.deepEqual(result, A(100, N));
  assert.equal(cost, 1 + 1 + 1 + 100 * 2);    // param, hoisted const, map. Body: param, add
  assert.equal(typeNodes(program, [A(100, N)]).types.size, 5);
  const grid = A(2000, A(1000, N));
  throws(() => check(parseFunction('g => g.map(r => r.map(x => x + 1))'), [grid]), /上限/);
});

test('node budget, unknown params, duplicate ids, cross-body references and cycles are rejected', () => {
  const p = (nodes, output, params = []) => ({ format: 'neurom-program', params, nodes, output });
  throws(() => check(p([{ id: 'a', op: 'param', inputs: [], name: 'x' }], 'a'), []), /未定义的参数/);
  throws(() => check(p([{ id: 'a', op: 'constant', inputs: [], value: 1 }, { id: 'a', op: 'constant', inputs: [], value: 2 }], 'a'), []), /重复/);
  throws(() => check(p([{ id: 'a', op: 'add', inputs: ['b', 'b'] }, { id: 'b', op: 'add', inputs: ['a', 'a'] }], 'a'), []), /环路/);
  throws(() => check(p([{ id: 'c', op: 'constant', inputs: [], value: 1 }, { id: 'arr', op: 'array', inputs: ['c'] },
    { id: 'm', op: 'map', inputs: ['arr'], body: { params: ['e', 'i'], nodes: [{ id: 'e', op: 'param', inputs: [], name: 'e' }], output: 'e' } },
    { id: 'leak', op: 'add', inputs: ['e', 'c'] }], 'leak'), []), /body 内部/);
  for (const name of ['x', 17]) throws(() => check(p([{ id: 'a', op: 'constant', inputs: [], value: 1, name }], 'a'), []), /不能带 name/);
  for (const body of [null, []]) throws(() => check(p([{ id: 'a', op: 'constant', inputs: [], value: 1, body }], 'a'), []), /不能带 body/);
  throws(() => check(p([], 'a'), []), /至少需要一个节点/);
  throws(() => check(p([{ id: 'a', op: 'constant', inputs: [], value: 1 }], 'a'), [N]), /数量/);
  const many = Array.from({ length: LIMITS.maxNodes + 1 }, (_, i) => ({ id: `n${i}`, op: 'constant', inputs: [], value: i }));
  throws(() => check(p(many, 'n0'), []), /最多/);
  const chain = [{ id: 'n0', op: 'param', inputs: [], name: 'x' }];
  for (let i = 1; i < LIMITS.maxNodes; i++) chain.push({ id: `n${i}`, op: 'add', inputs: [`n${i - 1}`, 'n0'] });
  assert.equal(compile(p(chain, `n${LIMITS.maxNodes - 1}`, ['x']), [N]).run(1), LIMITS.maxNodes);
});

test('types: canonical form, names, sameType and value checks', () => {
  assert.deepEqual(canonicalType(R({ b: N, a: V(2) })), { type: 'record', fields: { a: V(2), b: N } });
  assert.ok(sameType(R({ a: N, b: N }), R({ b: N, a: N })));
  assert.ok(!sameType(A(2, N), A(3, N)));
  throws(() => canonicalType(V(0)), /宽度/);
  throws(() => canonicalType(JSON.parse('{"type":"record","fields":{"__proto__":{"type":"number"}}}')), /不合法/);
  throws(() => canonicalType(T()), /列/);
  assert.equal(checkValue(V(2), new Float64Array([1, 2])), null);
  assert.match(checkValue(A(2, R({ a: N })), [{ a: 1 }, { a: 'x' }]), /\[1\]\.a/);
  assert.match(checkValue(N, NaN), /有限/);
});

// ───────────────────────────── source subset / blocks ─────────────────────────────
test('source subset: statements, deferred helpers, if/else, strings; TypeScript-only syntax and unsupported constructs fail with locations', () => {
  const src = `function f(s, k) {
    const double = () => s.pos * 2;
    if (k > 0) { return double() + k; }
    const label = k === 0 ? 'zero' : \`neg\`;
    return label === 'zero' ? double() : -double();
  }`;
  const c = fn(src, [R({ pos: N }), N]);
  assert.equal(c.run({ pos: 3 }, 2), 8);
  assert.equal(c.run({ pos: 3 }, 0), 6);
  assert.equal(c.run({ pos: 3 }, -1), -6);
  assert.deepEqual(parseFunction(src).params, ['s', 'k']);
  const ANNOTATION = /这里不写类型标注：类型由调用方决定/, ASSERTION = /不支持类型断言（as、satisfies、!）/, DECLARATION = /不支持 type \/ interface 声明/;
  for (const [bad, pattern, offender] of [
    ['function f(s: number) { return s; }', ANNOTATION, ': number'],
    ['function f(s): number { return s; }', ANNOTATION, ': number'],
    ['(s) => { const d: number = s; return d; }', ANNOTATION, ': number'],
    ['function f<T>(s) { return s; }', ANNOTATION, '<T>'],
    ['(s) => sum<number>([s])', ANNOTATION, '<number>'],
    ['(s) => s as number', ASSERTION, 's as number'],
    ['(s) => s satisfies number', ASSERTION, 's satisfies number'],
    ['(s) => <number>s', ASSERTION, '<number>s'],
    ['(s) => s!', ASSERTION, 's!'],
    ['type S = number;\nfunction f(s) { return s; }', DECLARATION, 'type S = number;'],
    ['interface S { a: number }\nfunction f(s) { return s; }', DECLARATION, 'interface S { a: number }'],
    ['declare function g(x): number;\nfunction f(s) { return s; }', DECLARATION, 'declare function g(x): number;'],
    ['(s) => { const a = s; const b: number = a as number; return b; }', ANNOTATION, ': number'],
  ]) {
    const error = (() => { try { parseFunction(bad); } catch (e) { return e; } })();
    assert.ok(error instanceof ProgramSourceError, bad);
    assert.match(error.message, pattern, bad);
    const lines = bad.split('\n'), offset = (p) => lines.slice(0, p.line - 1).reduce((n, l) => n + l.length + 1, 0) + p.column;
    assert.equal(bad.slice(offset(error.loc), offset(error.end)), offender, `${bad}: located at the offending node`);
  }
  assert.throws(() => parseCode(['s'], 'const d = s;\nreturn d as number;'), e => e instanceof ProgramSourceError && ASSERTION.test(e.message), 'parseCode rejects them too');
  assert.throws(() => parseModule('export function f(x: number) { return x; }'), e => e instanceof ProgramSourceError && e.loc.line === 1 && ANNOTATION.test(e.message), 'parseModule rejects them for the whole file');
  assert.equal(fn('1 + 2', []).run(), 3);
  for (const [bad, pattern] of [['(a) => { let x = a; return x; }', /const/], ['(a) => { for (;;) {} }', /循环/], ['(a) => { const b = (a = 1); return b; }', /赋值/], ['(a) => g(a)', /未知函数/], ['(a) => { return a; return a; }', /不可达/], ['(a) => { if (a > 0) return 1; }', /else|return/], ['(a, ...r) => a', /标识符|剩余/], ['({ a }) => a', /标识符/], ['(a) => null', /null/], ['(a) => `${a}`', /表达式/], ['(a) => a?.b', /可选/], ['(a) => Math.pow(a, 2)', /Math/], ['(a) => a +', /语法/]]) {
    const error = (() => { try { parseFunction(bad); } catch (e) { return e; } })();
    assert.ok(error instanceof ProgramSourceError, bad);
    assert.match(error.message, pattern, bad);
    assert.ok(error.loc.line >= 1);
  }
  const typeError = (() => { try { check(parseFunction('(a) => a.x'), [N]); } catch (e) { return e; } })();
  assert.equal(typeError.nodeId, 'get_2');
});

test('parseCode: positional params around a body', () => {
  const whole = 'function reward(state, k) {\n  const o = state.pos * 2;\n  return o + k;\n}';
  const program = parseCode(['state', 'k'], 'const o = state.pos * 2;\nreturn o + k;');
  assert.deepEqual(program, parseFunction(whole), 'same IR as the whole function');
  assert.equal(compile(program, [R({ pos: N }), N]).run({ pos: 3 }, 1), 7);
  assert.deepEqual(parseCode(['a'], 'return a;').params, ['a'], 'unused params are still params');
  assert.throws(() => parseCode(['x'], 'const y = 1;\nreturn x +;'), ProgramSourceError);
  assert.throws(() => parseCode(['range'], 'return 1;'), /range/, 'a reserved param name is rejected');
});

test('parseModule spans: every name, field and helper in a function, with its node, field path and JSDoc; typeNodes keeps partial types', () => {
  const source = 'export function f(state, k) {\n/** 距离 */\nconst d = state.pos * k;\nconst { vel, pos: p } = state;\nreturn range(2).map(e => e + d + state.pos).reduce((a, x) => a + Math.max(x, vel), sum([p, 1]));\n}';
  const { program, spans } = parseModule(source).functions.f;
  const at = (text, nth = 0) => { let i = source.indexOf('{'); for (let n = 0; n <= nth; n++) i = source.indexOf(text, i + 1); return spans.filter(s => s.start <= i && i < s.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]; };
  const pick = s => s && { text: source.slice(s.start, s.end), kind: s.kind, name: s.name, path: s.path };
  assert.deepEqual(pick(at('d =')), { text: 'd', kind: 'const', name: 'd', path: null });
  assert.equal(at('d + state').doc, '距离', 'the JSDoc above a const rides on every use');
  assert.deepEqual(pick(at('pos', 0)), { text: 'pos', kind: 'field', name: 'pos', path: 'state.pos' });
  assert.deepEqual(pick(at('pos', 2)), { text: 'pos', kind: 'field', name: 'pos', path: 'state.pos' }, 'a CSE-shared field still spans every occurrence');
  assert.equal(at('pos', 0).id, at('pos', 2).id);
  assert.deepEqual(pick(at('vel,')), { text: 'vel', kind: 'const', name: 'vel', path: null }, 'shorthand destructuring: one span, the const');
  assert.equal(at('p }').id, at('pos', 0).id, 'a destructured name holds the field it reads');
  assert.deepEqual(pick(at('k;')), { text: 'k', kind: 'param', name: 'k', path: null });
  assert.deepEqual({ ...pick(at('x,')), of: at('x,').of, role: at('x,').role }, { text: 'x', kind: 'arg', name: 'x', path: null, of: 'reduce', role: 'elem' });
  assert.deepEqual(pick(at('max')), { text: 'Math.max', kind: 'helper', name: 'Math.max', path: null });
  assert.deepEqual(pick(at('map')), { text: 'map', kind: 'method', name: 'map', path: null });
  assert.equal(at(' + d'), undefined, 'whitespace is not a span');

  const ok = typeNodes(program, [R({ pos: N, vel: N }), N]);
  assert.equal(ok.error, null);
  assert.deepEqual(ok.types.get(at('map').id), A(2, N));
  assert.deepEqual(ok.types.get(at('reduce').id), N);
  const partial = typeNodes(program, [R({ pos: N }), N]);
  assert.match(partial.error.message, /vel/);
  assert.deepEqual(partial.types.get(at('d =').id), N, 'nodes typed before the failure keep their types');
  assert.equal(partial.types.get(at('reduce').id), undefined);
});

test('flowDocs: record key JSDoc and param docs follow the value through get / spread / select / map, not through arithmetic', () => {
  const source = 'export function f(s, k) {\nconst o = { /** 位置 */ pos: s.pos, /** 两倍 */ twice: s.pos * 2 };\nconst moved = { ...o, pos: o.pos + 1 };\nconst pick = k > 0 ? o : moved;\nconst each = range(2).map(i => o);\nreturn { o, moved, pick, first: each[0], sum: o.pos + 1 };\n}';
  const { program, keyDocs } = parseModule(source).functions.f;
  const docs = flowDocs(program, { s: { text: '状态', fields: { pos: { text: '原始位置' }, vel: { text: '速度' } } } }, keyDocs);
  const out = docs.get(program.output).fields;
  assert.equal(out.o.fields.pos.text, '位置', "the key's own JSDoc wins over the value's doc");
  assert.equal(out.o.fields.twice.text, '两倍');
  assert.equal(out.moved.fields.pos.text, '位置', 'a replaced field keeps the doc of the field it replaces');
  assert.equal(out.moved.fields.twice.text, '两倍', 'spread keeps the other fields');
  assert.equal(out.pick.fields.twice.text, '两倍', 'select takes its branches’ docs');
  assert.equal(out.first.fields.pos.text, '位置', 'map elements and index carry the element doc');
  assert.equal(out.sum, undefined, 'a computed value carries no doc');
  const bare = parseModule('export function f(s) { return { v: s.vel }; }').functions.f.program;
  assert.equal(flowDocs(bare, { s: { fields: { vel: { text: '速度' } } } }).get(bare.output).fields.v.text, '速度', 'without a key doc, a field inherits its value’s doc');
});

test('run validates argument count and types', () => {
  const c = fn('(a, b) => a > 0 ? a : b / a', [N, N]);
  assert.equal(c.run(2, 5), 2);
  throws(() => c.run(1), /参数/);
  throws(() => c.run('x', 1), /参数 a/);
});

test('committed differential fixtures still reproduce under the JS interpreter (regenerate with fixtures/generate.mjs)', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/programs.json', import.meta.url), 'utf8'));
  const encode = v => JSON.stringify(v, (k, x) => (typeof x === 'number' && Object.is(x, -0) ? '-0' : x));
  assert.ok(fixtures.length >= 15);
  for (const fx of fixtures) {
    const compiled = compile(fx.program, fx.paramTypes, { exact: fx.exact });
    assert.deepEqual(compiled.result, fx.result, fx.name);
    assert.equal(compiled.cost, fx.cost, fx.name);
    for (const lane of fx.lanes) {
      const args = lane.args.map((a, i) => (fx.paramTypes[i].type === 'table' ? tableView(a.columns, a.lo, a.hi) : JSON.parse(encode(a), (k, x) => (x === '-0' ? -0 : x))));
      if ('result' in lane) assert.equal(encode(compiled.run(...args)), encode(lane.result), fx.name);
      else { const error = (() => { try { compiled.run(...args); } catch (e) { return e; } })(); assert.equal(error?.nodeId, lane.error.nodeId, fx.name); }
    }
  }
});

test('checkArgs/checkResult:false skip structural checks only; runtime rules and results are unchanged', () => {
  const program = parseFunction('(s, i) => ({ ...s, cells: update(s.cells, i, s.cells[i] + s.cells[1]) })');
  const types = [R({ cells: A(3, N) }), N];
  const strict = compile(program, types), fast = compile(program, types, { checkArgs: false, checkResult: false });
  assert.deepEqual(fast.run({ cells: [1, 2, 3] }, 0), strict.run({ cells: [1, 2, 3] }, 0));
  throws(() => fast.run({ cells: [1, 2, 3] }, 3), /下标/);
  throws(() => strict.run({ cells: [1, 2] }, 0), /参数 s/);
  assert.equal(fast.run({ cells: [1, 2] }, 0).cells.length, 2);   // caller's responsibility: no shape walk happened
  throws(() => fast.run({ cells: [1, 2, 3] }), /参数/);            // arity is still enforced
});

test('reductions: sum is left-to-right, min/max/argmin/argmax pick the first extreme, any/all/count over boolean arrays', () => {
  assert.equal(run('v => sum(v)', [V(3)], [1e16, 1, -1e16]), (1e16 + 1) - 1e16);   // sequential order, not pairwise
  assert.equal(run('a => sum(a)', [A(2, N)], [1.5, 2]), 3.5);
  assert.deepEqual(run('v => [minOf(v), maxOf(v), argminFirst(v), argmaxFirst(v)]', [V(4)], [2, 1, 1, 2]), [1, 2, 1, 0]);
  assert.deepEqual(run('f => [any(f) ? 1 : 0, all(f) ? 1 : 0, count(f)]', [A(3, B)], [true, false, true]), [1, 0, 2]);
  assert.equal(run('(a, k) => a.some(x => x > k)', [A(2, N), N], [1, 5], 3), true);
  assert.equal(run('(a, k) => a.every(x => x > k)', [A(2, N), N], [1, 5], 3), false);
  throws(() => run('a => sum(a)', [A(2, N)], [1e308, 1e308]), /有限/);
  throws(() => check(parseFunction('f => sum(f)'), [A(2, B)]), /数值/);
  throws(() => check(parseFunction('v => any(v)'), [V(2)]), /布尔/);
  assert.equal(run('(a, k) => a.some(x => x > k) ? count(a.map(x => x > 0)) : minOf(a)', [A(2, N), N], [1, -1], 0), 1);
});

test('a body whose result does not depend on its parameters returns the hoisted outer value', () => {
  const p = parseFunction('(k, arr) => range(3).map(c => ({ g: 1, d: k * 2 })).map(r => r.d + arr.reduce((a, x) => a + k, 0))');
  assert.deepEqual(compile(p, [N, A(2, N)]).run(5, [1, 2]), [20, 20, 20]);
  assert.deepEqual(fn('() => range(2).map(c => "x")', []).run(), ['x', 'x']);
  throws(() => check({ format: 'neurom-program', params: [], nodes: [{ id: 'a', op: 'constant', inputs: [], value: 1 }, { id: 'arr', op: 'array', inputs: ['a'] },
    { id: 'm', op: 'map', inputs: ['arr'], body: { params: ['e', 'i'], nodes: [{ id: 'e', op: 'param', inputs: [], name: 'e' }], output: 'nope' } }], output: 'm' }, []), /输出节点/);
});

// ───────────────────────────── parseModule ─────────────────────────────
// A code module file with the inputs `seed` and `cfg`.
const mod = source => parseModule(source, { inputs: ['seed', 'cfg'] });
/** The one failing unit's error (message and 1-based line), whichever const or function it is. */
const unitError = source => {
  const r = mod(source), e = [...r.consts, ...Object.values(r.functions)].find(u => u.error)?.error;
  return e && { message: e.message, line: e.loc.line };
};

test('module: exports decide the ports — exported functions and consts, in file order; the rest are helpers', () => {
  const r = mod("/** 标签 */\nexport const labels = ['a', 'b'];\nconst hidden = 1;\nfunction helper(v) { return v + hidden; }\n/** 显示 */\nexport function show(x) { return helper(x); }\nexport function step(s, a) { return s + a; }");
  assert.deepEqual(r.consts.map(c => [c.name, c.exported, c.doc]), [['labels', true, '标签'], ['hidden', false, null]]);
  assert.deepEqual(Object.keys(r.functions), ['show', 'step'], 'only exported functions are callable from outside');
  assert.equal(r.functions.show.doc, '显示', 'the JSDoc above an export travels with it');
  assert.deepEqual(r.helpers.map(h => [h.name, h.used]), [['helper', true]]);
  assert.deepEqual(mod('function step(s, a) { return s + a; }').functions, {}, 'a function is not exposed because of its name');
});

test('module: source layout of each export — locked head, JSDoc start, end and parameter spans', () => {
  const source = "/** 预算 */\nexport const budget = 16;\nexport const a = 1, b = 2;\n\n/**\n * 一步\n */\nexport function f(state, k) {\n  return state + k;\n}\nexport function g(x) { return x + nope; }";
  const r = parseModule(source), slice = s => source.slice(s.start, s.end);
  const [budget, a, b] = r.consts, { f, g } = r.functions;
  assert.equal(slice(budget.head), 'export const budget = ');
  assert.equal(source.slice(budget.docStart, budget.end), '/** 预算 */\nexport const budget = 16;');
  assert.deepEqual([slice(a.head), slice(b.head)], ['export const a = ', 'b = '], 'a later declarator of the same statement starts at its name');
  assert.equal(source.slice(a.head.start, a.end), 'export const a = 1');
  assert.equal(source.slice(b.docStart, b.end), 'b = 2;');
  assert.equal(slice(f.head), 'export function f(state, k) {');
  assert.equal(source.slice(f.docStart, f.end), '/**\n * 一步\n */\nexport function f(state, k) {\n  return state + k;\n}');
  assert.deepEqual(f.paramSpans.map(slice), ['state', 'k']);
  assert.ok(g.error, 'the layout is there even when the unit fails to lower');
  assert.deepEqual([slice(g.head), g.docStart === g.head.start, source.slice(g.head.start, g.end)], ['export function g(x) {', true, 'export function g(x) { return x + nope; }']);
});

test('module: each const is a program of its own, once, over the names it reads; pure when it reads no input', () => {
  const r = mod('const W = [1, 2];\nconst base = seed * 2;\nconst marks = range(3).map(i => base + i);\nexport const K = W[1] + 1;');
  assert.deepEqual(r.consts.map(c => [c.name, c.deps, c.pure]), [['W', [], true], ['base', ['seed'], false], ['marks', ['base'], false], ['K', ['W'], true]], 'a const reading an input (even through another const) is not pure');
  assert.equal(compile(r.consts[1].program, [N]).run(5), 10, 'a const evaluates over the names it reads');
  assert.deepEqual(r.consts[2].program.params, ['base'], 'a const reads earlier consts as values, not by re-evaluating them');
});

test('module: a function’s params are its own params, then the file-level names it reads in order of first use', () => {
  const r = mod(`const W = [1, 2];
const base = seed * 2;
const marks = range(3).map(i => base + i);
function twice(v) { return v * 2; }
function unused(v) { return v; }
export function tick(s) { return twice(s) + marks[1] + base + cfg.k; }
export function show(x) { return twice(x) + W[0]; }
export function both(x) { return show(x) + base; }`);
  const { tick, show, both } = r.functions;
  assert.deepEqual([tick.params, tick.program.params, tick.bound], [['s'], ['s', 'marks', 'base', 'cfg'], ['marks', 'base', 'cfg']]);
  assert.equal(compile(tick.program, [N, A(3, N), N, R({ k: N })]).run(1, [10, 11, 12], 10, { k: 100 }), 2 + 11 + 10 + 100);
  assert.deepEqual([tick.pure, show.pure], [false, true], 'pure: reads only its params and consts that read no input');
  assert.equal(compile(show.program, [N, A(2, N)]).run(3, [1, 2]), 7, 'a helper shared by two functions is inlined in each');
  assert.deepEqual(both.program.params, ['x', 'W', 'base'], 'calling an exported function inlines it: its bound names become the caller’s');
  assert.equal(compile(both.program, [N, A(2, N), N]).run(3, [1, 2], 10), 17);
  assert.equal(both.pure, false);
  assert.deepEqual(r.helpers.map(h => [h.name, h.used]), [['twice', true], ['unused', false]]);
  assert.deepEqual(mod('export function f(a) { return 1; }').functions.f.program.params, ['a'], 'an unused param is still a param');
});

test('module: name visibility and recursion; one failing unit leaves the others compiled', () => {
  assert.deepEqual(unitError('const a = b + 1;\nconst b = 2;'), { message: '第1行第11列：常量 b 在这里还没有算出来：常量只能读前面声明的常量', line: 1 });
  assert.match(unitError('export function f(x) { return x + nope; }').message, /nope/);
  assert.match(unitError('function h(a, b) { return a; }\nexport function f(x) { return h(x); }').message, /h 需要 2 个参数，收到 1/);
  assert.match(unitError('function f(v) { return f(v); }\nexport function show(x) { return f(x); }').message, /函数 f 不能递归调用/);
  assert.equal(unitError('function f(v) { return g(v); }\nfunction g(v) { return f(v); }\nexport function show(x) {\n  return g(x);\n}').line, 1, 'mutual recursion is located at the recursive call');
  assert.match(unitError('export function a(x) { return b(x); }\nexport function b(x) { return a(x); }').message, /不能递归调用/, 'exported functions calling each other recurse too');
  const r = mod('export const ok = 1;\nexport function good(x) { return x; }\nexport function bad(x) { return x + nope; }');
  assert.equal(r.consts[0].error, null);
  assert.equal(r.functions.good.error, null);
  assert.ok(r.functions.bad.error instanceof ProgramSourceError && r.functions.bad.error.loc.line === 3);
});

test('module: the file holds only consts and functions; other export forms and a malformed file throw a located ProgramSourceError', () => {
  const fails = (source, pattern, line) => assert.throws(() => mod(source), e => e instanceof ProgramSourceError && pattern.test(e.message) && e.loc.line === line);
  fails('const a = 1;\n\nif (a) {}', /文件顶层只能写 const 常量和 function 函数/, 3);
  fails('const a = 1;\nlet b = 2;', /只支持 const/, 2);
  fails('const a = 1;\nconst f = x => x;', /顶层函数请写成 function/, 2);
  fails('const a = 1;\nfunction a() { return 1; }', /重复声明：a|already been declared/, 2);
  fails('const seed = 1;', /外面传进来的名称/, 1);
  fails('export function range(x) { return x; }', /保留名称 range/, 1);
  fails('export const { a } = { a: 1 };', /不支持解构/, 1);
  fails('export function show(x) {\n  return x +;\n}', /语法错误/, 2);
  fails('const a = 1;\nexport { a };', /只支持 export function/, 2);
  fails('export default function show(x) { return x; }', /只支持 export function/, 1);
  fails('import x from "y";', /只支持 export function/, 1);
});
