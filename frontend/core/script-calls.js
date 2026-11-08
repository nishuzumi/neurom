// core/script-calls.js — the page side of a script module's inputs (ADR 0019). The script in the sandbox asks for a
// call of a function input. The page runs the call here, outside the sandbox, and sends back only the result.
// - A code function runs its IR program with the values of the file-level names it reads (bundle.js functionEntry),
//   as a bundle runs it.
// - A network runs through its readout's `run` as a tool of a tool layer runs (loop.js netTool), on its accepted
//   weights. Each call starts from zero potentials, so the network keeps no memory across calls.
// - A chain node (ADR 0028) takes one EIP-1193 request `{ method, params }`. The page sends it through `request`, the
//   injected connection, after the node's method allowlist (core/kinds/chain-node.js) accepts it. The sandbox never
//   decides that.
// The arguments have no static type: a call is typed from its values each time, with the same callee hook as a call
// wire (core/resolve.js res.callees). A JavaScript array of numbers can be an IR array or a vector. A code function
// tries the array first and then the vector. A network reads one bit vector.
import { functionEntry, staticValue } from './bundle.js';
import { netTool, statelessTool } from './loop.js';
import { compileEntry } from './sessions/common.js';
import { canonicalJSON } from './canonical.js';
import { NUMBER, BOOLEAN, STRING, array, bits, checkValue, record, sameType, vector } from './types.js';
import { chainMethodProblem, chainNetwork } from './kinds/chain-node.js';
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
 * artifact (the accepted weights of a network). `request(chainId, { method, params })` sends a request of a chain node
 * to the chain and resolves its result.
 * → `{ functions, call(name, args) → result, values() → { <name>: { value } | { error } }, chains() → { <name>: network } }`.
 * `functions`: the declared function inputs. `call` throws an Error with the reason when the call cannot run. Each
 * typed call is compiled one time. `chains`: the function inputs wired to a chain node, with what the sandbox knows of
 * the chain (chainNetwork).
 * @param {any} graph
 * @param {any} res
 * @param {string} scriptId
 * @param {{ artifacts: (id: string) => any, request?: (chainId: number, req: { method: string, params: unknown[] }) => Promise<unknown> }} options
 */
export function scriptCalls(graph, res, scriptId, { artifacts, request }) {
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

  /** a call of a chain node: one `{ method, params }`, sent when the node allows the method */
  function chainRequest(name, site, args) {
    const r = site.callee.call([], { exact: false, caller: scriptId });
    if (r.error) throw r.error;
    const [req] = args;
    if (args.length !== 1 || !plain(req) || typeof req.method !== 'string' || (req.params !== undefined && !Array.isArray(req.params))) throw new Error(t('{name} 接的是链节点：一次调用传一个 { method, params }', { name }));
    const problem = chainMethodProblem(req.method, r.carries.write);
    if (problem) throw new Error(problem);
    if (!request) throw new Error(t('这个页面不能连接链'));
    return request(r.carries.chainId, { method: req.method, params: req.params ?? [] }).catch(e => { throw chainError(e); });
  }
  function call(name, args) {
    if (!functions.includes(name)) throw new Error(t('脚本模块没有声明函数输入 {name}', { name }));
    const [site] = res.callees(scriptId, name);
    if (!site) throw new Error(t('必需输入 {port} 尚未连接', { port: name }));
    if (!site.callee) throw new Error(t('调用端口 {port} 需要接代码模块导出的函数、读出的 run 或链节点', { port: name }));
    if (site.node.kind === 'chain') return chainRequest(name, site, args);
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

  return { functions, call, values, chains };

  /** @returns {Record<string, ReturnType<typeof chainNetwork>>} */
  function chains() {
    const out = {};
    for (const name of functions) {
      const [site] = res.callees(scriptId, name);
      if (site?.node.kind === 'chain') out[name] = chainNetwork(site.node.config);
    }
    return out;
  }
}

/** the revert data of a failed request, as ethers reports it: on the error, or on the RPC error inside it */
const revertData = e => [e?.data, e?.info?.error?.data, e?.error?.data].find(d => typeof d === 'string' && /^0x[0-9a-fA-F]*$/.test(d)) ?? null;
/** The error of a failed request with its revert data on `data` and in the message, so a script can decode it. */
export function chainError(e) {
  const data = revertData(e), message = String(e?.shortMessage ?? e?.message ?? e);
  const out = new Error(data && !message.includes(data) ? `${message} data=${data}` : message);
  if (data) out.data = data;
  return out;
}

/**
 * The page side of the call messages of one frame. `handle(message, call)` runs `call(name, args)` for a
 * `{ type:'call', id, name, args }` message and posts `{ type:'reply', id, result }` or `{ type:'reply', id, error }`.
 * An error with revert `data` (chainError) carries it as `data`, so a script can decode it.
 * `reset()` starts a new run: a reply of a call from before it is dropped.
 */
export function callBridge(post) {
  let run = 0;
  return {
    handle({ id, name, args }, call) {
      const own = run;
      Promise.resolve().then(() => call(name, args)).then(
        result => { if (own === run) post({ type: 'reply', id, result }); },
        error => { if (own === run) post({ type: 'reply', id, error: String(error?.message ?? error), ...(typeof error?.data === 'string' ? { data: error.data } : {}) }); });
    },
    reset() { run++; },
  };
}
