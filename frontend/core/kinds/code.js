// core/kinds/code.js — the code module: one restricted-JS file (ir parseModule) of top-level consts and functions.
// The file declares what it exposes. Every `export function name(…)` is a call output `name`, handed to call ports. A
// caller passes the function's own params. Every `export const name = …` is a value output `name`, computed once from
// the file's inputs. `inputs` (config) are the file-level names wired in from outside, one value input each, readable
// anywhere in the file. A function reads them — and top-level consts — as bound values. Functions not exported are
// helpers, inlined where they are called. The output `module` hands the whole file to a kind that calls several of its
// functions by role (a loop runs its `scenario` module, kinds/scenario.js).
// Ports come from the config, so they stay while the user edits the source: `exports` is derived from the source
// whenever it parses (registry `derive`) and kept as it was while it does not.
// A function's JSDoc (summary, `@param name text`, `@param name.field text`, `@returns text`) documents it. The texts
// travel on the ports and through docs (core/docs.js). Types come from the call sites and the wires, never from docs.
import { registerKind } from '../registry.js';
import { valueIn, valueOut, fnOut, moduleOut, single } from './common.js';
import { isRef, sameSignature, typeName } from '../types.js';
import { canonicalJSON } from '../canonical.js';
import * as ir from '../../ir/index.js';
import { t } from '../../i18n.js';

export const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_INPUTS = 32, MAX_EXPORTS = 64;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
/** A new code module: one exported function, to be rewritten. */
const DEFAULT_SOURCE = `export function f(x) {
  return x;
}
`;

const validInput = name => INPUT_NAME.test(name) && !FORBIDDEN.has(name) && !ir.RESERVED.has(name) && !ir.HELPERS.has(name);
/** Declared input names that can be ports (valid identifiers, first occurrence, not reserved). */
const inputNames = config => [...new Set(config.inputs)].filter(validInput);

// ------------------------------------------------------------------ the compiled file (memoised on the source)
const moduleCache = new Map();
/** parseModule's result for a config, or `{ error }` when the file itself does not compile. The cache keeps the last 128. */
export function moduleOf(config) {
  const key = canonicalJSON([config.source, inputNames(config)]);
  let hit = moduleCache.get(key);
  if (hit) { moduleCache.delete(key); moduleCache.set(key, hit); return hit; }
  try { hit = { error: null, ...ir.parseModule(config.source, { inputs: inputNames(config) }) }; }
  catch (error) { hit = { error, consts: [], functions: {}, helpers: [] }; }
  moduleCache.set(key, hit);
  if (moduleCache.size > 128) moduleCache.delete(moduleCache.keys().next().value);
  return hit;
}
/** The exports of a compiled file in source order: `[{ name, kind: 'function' | 'const' }]`. */
function exportsOf(mod) {
  const list = [...Object.entries(mod.functions).map(([name, f]) => ({ name, kind: 'function', loc: f.loc })), ...mod.consts.filter(c => c.exported).map(c => ({ name: c.name, kind: 'const', loc: c.loc }))];
  return list.sort((a, b) => a.loc.line - b.loc.line || a.loc.column - b.loc.column).map(({ name, kind }) => ({ name, kind }));
}

// ------------------------------------------------------------------ JSDoc of an exported function
/**
 * Parse a function's JSDoc → `{ summary, params: {name: {text}}, fields: {'name.key…': {text}}, returns: {text} | null }`.
 * `@param name.a.b text` documents a field of a param over the doc the field brings from its source (core/docs.js).
 * Continuation lines extend the text of the tag above them. `{Type}` groups are allowed and ignored.
 */
function parseDoc(doc) {
  const out = { summary: '', params: {}, fields: {}, returns: null };
  const summary = [];
  let current = null;
  for (const raw of (doc ?? '').split('\n')) {
    const line = raw.trim(), tag = /^@(\w+)\s*(?:\{[^}]*\}\s*)?(.*)$/.exec(line);
    if (!tag) { if (current) current.text = current.text ? `${current.text}\n${line}`.trim() : line; else summary.push(line); continue; }
    const [, name, rest] = tag;
    if (name === 'param') {
      const m = /^([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)*)\s*(?:-\s*)?(.*)$/.exec(rest);
      current = !m ? null : m[2] ? (out.fields[m[1] + m[2]] = { text: m[3] }) : (out.params[m[1]] = { text: m[3] });
    } else if (name === 'returns' || name === 'return') current = out.returns = { text: rest };
    else current = null;
  }
  out.summary = summary.join('\n').trim();
  return out;
}
const docCache = new Map();
/** parseDoc memoised on the text. */
export function docOf(doc) {
  const key = doc ?? '';
  let parsed = docCache.get(key);
  if (!parsed) { if (docCache.size > 512) docCache.clear(); parsed = parseDoc(key); docCache.set(key, parsed); }
  return parsed;
}

// ------------------------------------------------------------------ typing
const checks = new WeakMap();
/** ir.check memoised per program and argument types → `{ result, error }` (never throws). */
function checked(program, types, exact) {
  let byTypes = checks.get(program);
  if (!byTypes) checks.set(program, (byTypes = new Map()));
  const key = exact + canonicalJSON(types);
  if (!byTypes.has(key)) {
    try { byTypes.set(key, { result: ir.check(program, types, { exact }).result, error: null }); }
    catch (error) { byTypes.set(key, { result: null, error }); }
  }
  return byTypes.get(key);
}
export const incomplete = message => Object.assign(new Error(message), { incomplete: true });

/** The file of a code module typed against its input ports: the compiled file, the type of every file-level name
 *  (inputs, then consts in order, null while unknown) and each const's check error. `inType(name)` types an input. */
export function analyseModule(node, inType) {
  const mod = moduleOf(node.config), types = {}, constErrors = {};
  for (const name of inputNames(node.config)) types[name] = inType(name);
  for (const c of mod.consts) {
    const deps = c.deps.map(n => types[n] ?? null);
    const r = c.program && deps.every(Boolean) ? checked(c.program, deps, false) : null;
    types[c.name] = r?.result ?? null;
    if (r?.error) constErrors[c.name] = r.error;
  }
  return { module: mod, types, constErrors };
}
/**
 * Type a call of the exported function `name` with the caller's argument types (the function's own params) →
 * `{ program, result, error, bound: {fileName: Type} }`. `error.incomplete` is set while something it needs is untyped.
 * The program's params are the caller's arguments, then the bound file-level names (bundle programs).
 */
export function callFunction(analysis, name, argTypes, { exact }) {
  const fn = analysis.module.functions[name];
  if (!fn) return { program: null, result: null, bound: null, error: new Error(t('代码没有导出函数 {name}', { name })) };
  if (fn.error) return { program: null, result: null, bound: null, error: fn.error };
  if (fn.params.length !== argTypes.length) return { program: null, result: null, bound: null, error: new Error(t('{name} 有 {n} 个参数，调用方传入 {k} 个', { name, n: fn.params.length, k: argTypes.length })) };
  if (argTypes.some(T => !T || isRef(T))) return { program: fn.program, result: null, bound: null, error: incomplete(t('调用 {name} 的参数类型尚未确定', { name })) };
  const bound = Object.fromEntries(fn.bound.map(n => [n, analysis.types[n] ?? null]));
  const missing = fn.bound.filter(n => !bound[n]);
  if (missing.length) return { program: fn.program, result: null, bound, error: incomplete(t('{name} 读的 {names} 类型尚未确定', { name, names: missing.join(', ') })) };
  const c = checked(fn.program, [...argTypes, ...Object.values(bound)], exact);
  return { program: fn.program, result: c.result, bound, error: c.error };
}

// ------------------------------------------------------------------ docs
/** Doc trees of a unit's bound names: an input means what its wire carries, a const its own result tree. */
function boundDocs(node, mod, names, d) {
  const out = {};
  for (const name of names) { const c = mod.consts.find(x => x.name === name); out[name] = c ? constDoc(node, mod, c, d) : d.input(node.id, name); }
  return out;
}
export function constDoc(node, mod, c, d) {
  if (!c.program) return null;
  const flow = ir.flowDocs(c.program, boundDocs(node, mod, c.deps, d), c.keyDocs);
  return ir.mergeDocs(c.doc ? { text: c.doc } : null, flow.get(c.program.output) ?? null);
}
/** `@param name` text and every `@param name.a.b` text of a function's doc, as one tree for `name`. */
function localTree(doc, name) {
  let tree = doc.params[name]?.text ? { text: doc.params[name].text } : null;
  for (const [path, entry] of Object.entries(doc.fields)) {
    const [root, ...keys] = path.split('.');
    if (root !== name || !entry.text) continue;
    tree = ir.mergeDocs(tree, keys.reduceRight((inner, key) => ({ fields: { [key]: inner } }), { text: entry.text }));
  }
  return tree;
}
/** Doc tree of every param of the exported function `name` (in program order). Its own params mean what its first
 *  caller passes (`argDoc(i)`) under the function's own `@param` text. Bound names are as in boundDocs. */
export function functionParamDocs(node, name, argDoc, d) {
  const mod = moduleOf(node.config), fn = mod.functions[name];
  if (!fn?.program) return null;
  const doc = docOf(fn.doc), out = boundDocs(node, mod, fn.bound, d);
  fn.params.forEach((p, i) => { out[p] = ir.mergeDocs(localTree(doc, p), argDoc(i)); });
  return out;
}
/** Doc tree of what the exported function `name` returns. */
export function functionResultDoc(node, name, argDoc, d) {
  const fn = moduleOf(node.config).functions[name], params = functionParamDocs(node, name, argDoc, d);
  if (!fn?.program || !params) return null;
  const doc = docOf(fn.doc), text = doc.returns?.text || doc.summary;
  return ir.mergeDocs(text ? { text } : null, ir.flowDocs(fn.program, params, fn.keyDocs).get(fn.program.output) ?? null);
}

const describeSig = s => `(${s.params.map(typeName).join(', ')}) → ${typeName(s.result)}`;

registerKind({
  kind: 'code',
  label: '代码',
  config: {
    defaults: { inputs: [], source: DEFAULT_SOURCE, exports: [{ name: 'f', kind: 'function' }] },
    schema: {
      inputs: { type: 'list', of: { type: 'string', pattern: INPUT_NAME.source, max: 64 }, max: MAX_INPUTS },
      source: { type: 'string', max: 256 * 1024 },
      exports: { type: 'list', of: { type: 'object', fields: { name: { type: 'string', pattern: INPUT_NAME.source, max: 64 }, kind: { type: 'enum', values: ['function', 'const'] } } }, max: MAX_EXPORTS },
    },
    /** the export list follows the source whenever the file parses */
    derive(config) { const mod = moduleOf(config); return mod.error ? null : { exports: exportsOf(mod) }; },
  },
  ports(node) {
    const mod = moduleOf(node.config);
    const docOfExport = e => (e.kind === 'function' ? docOf(mod.functions[e.name]?.doc).summary || null : mod.consts.find(c => c.name === e.name)?.doc ?? null);
    return {
      inputs: inputNames(node.config).map(name => valueIn(name, null, { required: true })),
      outputs: [
        { ...moduleOut('module'), doc: t('整个文件：交给按角色调用其中函数的模块（例如训练器运行的场景）') },
        ...node.config.exports.filter(e => e.name !== 'module').map(e => ({ ...(e.kind === 'function' ? fnOut(e.name) : valueOut(e.name, null)), doc: docOfExport(e) })),
      ],
    };
  },
  docs: {
    output: (node, port, d) => {
      const mod = moduleOf(node.config), c = mod.consts.find(x => x.exported && x.name === port);
      return c ? constDoc(node, mod, c, d) : null;
    },
  },
  /** Each exported const is typed from the input wires. Functions are typed at their call sites. */
  infer(node, inTypes) {
    const { module: mod, types } = analyseModule(node, name => single(inTypes, name));
    return Object.fromEntries(mod.consts.filter(c => c.exported).map(c => [c.name, types[c.name] ?? null]));
  },
  /** A call wire out of an exported function: callFunction with the caller's arguments, the file's names typed from
   *  the input wires. A bundle carries the function's program and the types of the names it binds. */
  callee(node, port, ctx) {
    if (!node.config.exports.some(e => e.kind === 'function' && e.name === port)) return null;
    return {
      width: null,
      call(argTypes, { exact }) {
        const r = callFunction(analyseModule(node, name => ctx.inType(node.id, name)), port, argTypes, { exact });
        return { result: r.result, error: r.error, paramTypes: [...argTypes, ...Object.values(r.bound ?? {})], carries: { kind: 'program', program: r.program, bound: r.bound } };
      },
    };
  },
  problems(node, ctx) {
    const out = [], seen = new Set();
    for (const name of node.config.inputs) {
      if (!validInput(name)) out.push({ message: t('输入名 {name} 不合法或是保留名称', { name }) });
      else if (seen.has(name)) out.push({ message: t('输入 {name} 重复声明', { name }) });
      seen.add(name);
    }
    const { module: mod, constErrors } = analyseModule(node, name => ctx.inType(node.id, name));
    if (mod.error) return [...out, { message: t('代码无法编译：{error}', { error: mod.error.message }) }];
    if (node.config.exports.some(e => e.name === 'module')) out.push({ message: t('module 是整个文件的输出端口。不能再导出同名的函数或常量') });
    for (const c of mod.consts) { const error = c.error ?? constErrors[c.name]; if (error) out.push({ port: c.exported ? c.name : undefined, message: t('常量 {name}：{error}', { name: c.name, error: error.message }) }); }
    for (const [name, fn] of Object.entries(mod.functions)) if (fn.error) out.push({ port: name, message: t('函数 {name}：{error}', { name, error: fn.error.message }) });
    // every call site of an exported function: its error, and one signature per function
    const byPort = new Map();
    for (const use of ctx.callUses(node.id)) {
      if (use.error && !use.error.incomplete && !mod.functions[use.from]?.error) out.push({ port: use.from, wire: use.wire, error: use.error });
      if (use.signature) { if (!byPort.has(use.from)) byPort.set(use.from, []); byPort.get(use.from).push(use.signature); }
    }
    for (const [name, sigs] of byPort) {
      const other = sigs.find(s => !sameSignature(sigs[0], s));
      if (other) out.push({ port: name, message: t('{name} 同时接到签名不同的调用端口：{a} 与 {b}', { name, a: describeSig(sigs[0]), b: describeSig(other) }) });
    }
    return out;
  },
});
