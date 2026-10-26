// core/script-calls.js — the page side of a script module's inputs (ADR 0019). The script in the sandbox asks for a
// call of a function input. The page runs the call here, outside the sandbox, and sends back only the result.
// - A code function runs its IR program with the values of the file-level names it reads (bundle.js functionEntry),
//   as a bundle runs it.
// - A network runs through its readout's `run` as a tool of a tool layer runs (loop.js netTool), on its accepted
//   weights. Each call starts from zero potentials, so the network keeps no memory across calls.
// The arguments have no static type: a call is typed from its values each time, with the same callee hook as a call
// wire (core/resolve.js res.callees). A JavaScript array of numbers can be an IR array or a vector. A code function
// tries the array first and then the vector. A network reads one bit vector.
import { functionEntry, staticValue } from './bundle.js';
import { netTool, statelessTool } from './loop.js';
import { compileEntry } from './sessions/common.js';
import { canonicalJSON } from './canonical.js';
import { NUMBER, BOOLEAN, STRING, array, bits, checkValue, record, sameType, vector } from './types.js';
import { t } from '../i18n.js';

const plain = v => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const typedArray = v => ArrayBuffer.isView(v) && !(v instanceof DataView);

/** The type of a value the script passes, or null when no IR type fits. `numbers`: 'array' reads a JavaScript array of
 *  numbers as array(n, number), 'vector' reads it as a vector. A typed array is always a vector. */
function typeOfValue(v, numbers) {
  if (typeof v === 'number') return Number.isFinite(v) ? NUMBER : null;
  if (typeof v === 'boolean') return BOOLEAN;
  if (typeof v === 'string') return STRING;
  if (typedArray(v)) return v.length ? vector(v.length) : null;
  if (Array.isArray(v)) {
    if (!v.length) return null;
    if (numbers === 'vector' && v.every(x => typeof x === 'number' && Number.isFinite(x))) return vector(v.length);
    const of = typeOfValue(v[0], numbers);
    return of && v.every((x, i) => i === 0 || sameType(typeOfValue(x, numbers), of)) ? array(v.length, of) : null;
  }
  if (plain(v)) {
    const fields = {};
    for (const [key, x] of Object.entries(v)) { const T = typeOfValue(x, numbers); if (!T) return null; fields[key] = T; }
    return record(fields);
  }
  return null;
}

/**
 * The function and value inputs of script module `scriptId` in the graph `res` resolves. `artifacts(id)` looks up an
 * artifact (the accepted weights of a network).
 * → `{ functions, call(name, args) → result, values() → { <name>: { value } | { error } } }`. `functions`: the declared
 * function inputs. `call` throws an Error with the reason when the call cannot run. Each typed call is compiled one time.
 * @param {any} graph
 * @param {any} res
 * @param {string} scriptId
 * @param {{ artifacts: (id: string) => any }} options
 */
export function scriptCalls(graph, res, scriptId, { artifacts }) {
  const ports = res.portsOf(scriptId).inputs;
  const functions = ports.filter(p => p.wire === 'call').map(p => p.id), inputs = ports.filter(p => p.wire === 'value').map(p => p.id);
  const runners = new Map();

  /** the runner of a call of `site` (a res.callees entry) with argument types `types` → (args) → result */
  function runnerOf(name, site, types) {
    const key = `${name}\n${canonicalJSON(types)}`;
    if (runners.has(key)) return runners.get(key);
    const r = site.callee.call(types, { exact: false, caller: scriptId });
    if (r.error) throw r.error;
    let run;
    if (r.carries.kind === 'net') {
      const tool = statelessTool(netTool(graph, res, r.carries, artifacts), `${graph.node(scriptId).title}.${name}`);
      run = ([data]) => {
        const problem = checkValue(bits(data.length), data);
        if (problem) throw new Error(problem);
        return tool(Array.from(data));
      };
    } else {
      const entry = functionEntry(graph, res, site.node.id, site.fn, r.carries.bound, false);
      const program = compileEntry(entry, types, `${site.node.title}.${site.fn}`);
      run = args => program(...args);
    }
    runners.set(key, run);
    return run;
  }

  function call(name, args) {
    if (!functions.includes(name)) throw new Error(t('脚本模块没有声明函数输入 {name}', { name }));
    const [site] = res.callees(scriptId, name);
    if (!site) throw new Error(t('必需输入 {port} 尚未连接', { port: name }));
    if (!site.callee) throw new Error(t('调用端口 {port} 需要接代码模块导出的函数或读出的 run', { port: name }));
    const readings = Number.isInteger(site.callee.width) ? ['vector'] : ['array', 'vector'];
    let first = null;
    for (const numbers of readings) {
      const types = args.map(a => typeOfValue(a, numbers)), bad = types.indexOf(null);
      if (bad >= 0) { first ??= new Error(t('{name} 的第 {i} 个参数不是程序能用的值：数、布尔值、字符串、数组、向量或记录', { name, i: bad + 1 })); continue; }
      let run;
      try { run = runnerOf(name, site, types); }
      catch (e) { first ??= e; continue; }
      return run(args);
    }
    throw first;
  }

  /** @returns {Record<string, { value: unknown } | { error: string }>} */
  function values() {
    /** @type {Record<string, { value: unknown } | { error: string }>} */
    const out = {};
    for (const name of inputs) {
      const p = graph.producers(scriptId, name)[0];
      if (!p) { out[name] = { error: t('值输入 {name} 尚未连接', { name }) }; continue; }
      try { out[name] = { value: staticValue(graph, res, p.node, p.port) }; }
      catch (e) { out[name] = { error: e.message }; }
    }
    return out;
  }

  return { functions, call, values };
}

/**
 * The page side of the call messages of one frame. `handle(message, call)` runs `call(name, args)` for a
 * `{ type:'call', id, name, args }` message and posts `{ type:'reply', id, result }` or `{ type:'reply', id, error }`.
 * `reset()` starts a new run: a reply of a call from before it is dropped.
 */
export function callBridge(post) {
  let run = 0;
  return {
    handle({ id, name, args }, call) {
      const own = run;
      Promise.resolve().then(() => call(name, args)).then(
        result => { if (own === run) post({ type: 'reply', id, result }); },
        error => { if (own === run) post({ type: 'reply', id, error: String(error?.message ?? error) }); });
    },
    reset() { run++; },
  };
}
