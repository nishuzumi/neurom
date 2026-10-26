// core/docs.js — doc provenance across the graph: what a value's parts mean, taken from where the value comes from.
// This works the way TS shows a property's JSDoc wherever the property is read. Trees are ir/docs.js doc trees.
//   · what the value wire into a port carries: its producer's output doc.
//   · everything asks the node's kind: `docs.output(node, port, d)` for a value output, `docs.ref(node, name, d)`
//     for a named type it publishes (State, Transition…). The i-th arg of a call port is the ref that signature
//     param names.
// What a code module's function params mean — its first caller's args under its own Doc Comment — is core/roles.js.
// Memoised per resolution. A cycle (a doc that would depend on itself) resolves to null.
import { docAt } from '../ir/index.js';
import { kindOf } from './registry.js';
import { isRef } from './types.js';

const cache = new WeakMap();

/** The doc provenance of `res` (a resolution of `graph`): `{ node, producers, consumers, portsOf, output, input, ref, arg }`. */
export function docsOf(graph, res) {
  let d = cache.get(res);
  if (!d) cache.set(res, (d = build(graph, res)));
  return d;
}

function build(graph, res) {
  const memo = new Map(), busy = new Set();
  const once = (key, compute) => {
    if (memo.has(key)) return memo.get(key);
    if (busy.has(key)) return null;
    busy.add(key);
    try { const value = compute(); memo.set(key, value); return value; } finally { busy.delete(key); }
  };
  const hook = (nodeId, name, ...args) => {
    const node = graph.nodes.get(nodeId), fn = node ? kindOf(node.kind).docs?.[name] : null;
    return fn ? fn(node, ...args, d) ?? null : null;
  };
  const d = {
    node: id => graph.nodes.get(id),
    producers: (nodeId, port) => graph.producers(nodeId, port),
    consumers: (nodeId, port) => graph.consumers(nodeId, port),
    portsOf: nodeId => res.portsOf(nodeId),
    /** a value output of `nodeId`. A field path `port.a.b` reads into it. */
    output: (nodeId, port) => once(`o\u0000${nodeId}\u0000${port}`, () => { const [root, ...path] = port.split('.'); return docAt(hook(nodeId, 'output', root), path); }),
    /** what the value wire into `port` of `nodeId` carries */
    input: (nodeId, port) => { const p = graph.producers(nodeId, port)[0]; return p ? d.output(p.node, p.port) : null; },
    ref: (nodeId, name) => once(`r\u0000${nodeId}\u0000${name}`, () => hook(nodeId, 'ref', name)),
    arg: (callerId, port, i) => once(`a\u0000${callerId}\u0000${port}\u0000${i}`, () => {
      const P = res.portsOf(callerId).inputs.find(p => p.id === port)?.signature?.params?.[i];
      return isRef(P) ? d.ref(callerId, P.slice(1, -1)) : null;
    }),
  };
  return d;
}

