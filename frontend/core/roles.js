// core/roles.js — a code module's Roles as the graph's consumers use them (CONTEXT Role, ADR 0012). This module reads
// them once for every reader: the editor's types, Role Tabs, help windows, hovers and completion, core/sample.js
// (where an example runs) and core/prefab.js (the stub a new scenario starts from). The consumer kinds stay the
// authority for the protocol (their call ports' signatures, and kinds/scenario.js for a loop's scenario). The exports
// stay the authority for the ports. This module only says how those meet one file:
//   callers    every caller of an export by protocol — call wires into call ports in wire order, then, for a scenario
//              role, the loops whose `scenario` the file's `module` output feeds. callers[0] types and documents it.
//   args       what callers[0] passes: the argument types its checked call recorded, else its signature over its
//              named types (null where one is not known yet).
//   argDoc(i)  what argument i means: the protocol's line for it over where the value comes from (core/docs.js).
//   docs(fn)   every program param of exported function fn: its Doc Comment (`@param`) over argDoc.
//   scenario   the live context of the loop a Scenario Module feeds — whether its drivers read a table, the input
//              width the loop's body expects (what the modules reading the loop's `input` declare) — and each
//              scenario role's stub text written against it.
// Memoised per resolution.
import { mergeDocs } from '../ir/index.js';
import { canonicalJSON } from './canonical.js';
import { docsOf } from './docs.js';
import { isRef, resolveSignature, typeName } from './types.js';
import { functionParamDocs } from './kinds/code.js';
import { REQUIRED_CALLS, SCENARIO_CALLS, SCENARIO_CONSTS, SCENARIO_ORDER, roleText, scenarioSignatures, scenarioStub } from './kinds/scenario.js';
import { t } from '../i18n.js';

/**
 * @typedef {{ node: string, port: string, wire: string, via: 'call' | 'scenario', title: string, when: string | null, label: string }} Caller
 *   one caller: the consumer node and its port, the wire the role reaches it by (`call`: a call wire from the export,
 *   `scenario`: the `module` wire into a loop's `scenario`), its title, when it calls (raw text) and how a type's
 *   source names it (`训练器.objective`, `回路 的 input`)
 * @typedef {{ type: unknown, label: string }} RoleParam
 *   a parameter as callers[0] declares it: its type over callers[0]'s named types (null while unknown) and that type
 *   by the name callers[0] gives it
 * @typedef {{
 *   name: string, kind: 'function' | 'const', required: boolean, callers: Caller[], refs: Record<string, unknown>,
 *   signature: { params: unknown[], names: string[], docs?: string[], result: unknown, returns?: string, stub?: string } | null,
 *   params: RoleParam[], result: unknown, args: unknown[], exact: boolean, returns: string | null,
 *   argDoc: (i: number) => unknown
 * }} Role
 *   `required`: false for a scenario role that the protocol lets the file leave out, true for a role reached by a call
 *   wire. `refs`: callers[0]'s named types (State, Transition…). `signature`: callers[0]'s contract with its `<ref>`s
 *   (null for a const role). `result`: what the protocol declares it returns, over refs. `returns`: what the result
 *   means (raw text)
 * @typedef {{ name: string, kind: 'function' | 'const', required: boolean, text: string }} ScenarioRole
 * @typedef {{ loop: string, title: string, withTable: boolean, I: number | null, roles: ScenarioRole[], stub: string }} Scenario
 *   `roles` in file order, each with the text that adds it. `stub` the scenario a new module starts from
 */

/** A type by the name its caller gives it (one of `refs`: State, Transition…), a record field by field, else typeName. */
export function named(T, refs) {
  if (T == null) return '?';
  if (isRef(T)) return T.slice(1, -1);
  const key = canonicalJSON(T), hit = Object.entries(refs ?? {}).find(([, R]) => R && typeof R === 'object' && canonicalJSON(R) === key);
  if (hit) return hit[0];
  if (T.type === 'record' && T.fields && Object.keys(refs ?? {}).length) return `{ ${Object.entries(T.fields).map(([k, F]) => `${k}: ${named(F, refs)}`).join(', ')} }`;
  return typeName(T);
}

const sceneMemo = new WeakMap(), rolesMemo = new WeakMap();
const memoIn = (memo, res) => { let m = memo.get(res); if (!m) memo.set(res, (m = new Map())); return m; };

/** The context loop `loopId` writes its scenario against, with its signatures (kinds/scenario.js) for that context. */
function sceneOf(graph, res, loopId) {
  const memo = memoIn(sceneMemo, res);
  if (memo.has(loopId)) return memo.get(loopId);
  const refs = res.refsOf(loopId), withTable = refs.Table != null;
  const I = graph.consumers(loopId, 'input').map(c => res.refsOf(c.node).I).find(Number.isInteger) ?? null;
  const signatures = scenarioSignatures(withTable, I);
  const roles = SCENARIO_ORDER.map(name => {
    const fn = SCENARIO_CALLS.includes(name);
    return { name, kind: fn ? 'function' : 'const', required: fn ? REQUIRED_CALLS.includes(name) : SCENARIO_CONSTS[name].required, text: roleText(name, fn ? signatures[name] : null) };
  });
  const scene = { refs, signatures, scenario: { loop: loopId, title: graph.nodes.get(loopId)?.title ?? loopId, withTable, I, roles, stub: scenarioStub(withTable, I) } };
  memo.set(loopId, scene);
  return scene;
}

/** @returns {Scenario} the Scenario Module context of loop `loopId`: what a scenario wired into it is written against */
export function scenarioOf(graph, res, loopId) {
  return sceneOf(graph, res, loopId).scenario;
}

/**
 * The Roles of code module `codeId` in the graph `res` resolves.
 * @returns {{ scenario: Scenario | null, role: (name: string) => Role | null, docs: (fn: string) => Record<string, unknown> | null }}
 *   `scenario`: the first loop the file is the scenario of (null when none). `role(name)`: the export `name` as its
 *   callers use it (null when nothing calls it by protocol). A scenario role is a role as soon as the file feeds a
 *   loop, exported or not. `docs(fn)`: the doc tree of every program param of the exported function `fn` (null when
 *   the committed file has no such function)
 */
export function rolesOf(graph, res, codeId) {
  const memo = memoIn(rolesMemo, res);
  if (!memo.has(codeId)) memo.set(codeId, build(graph, res, codeId));
  return memo.get(codeId);
}

function build(graph, res, codeId) {
  const d = docsOf(graph, res), title = id => graph.nodes.get(id)?.title ?? id;
  const loops = graph.consumers(codeId, 'module').filter(c => c.port === 'scenario' && graph.nodes.get(c.node)?.kind === 'loop');
  const scenes = loops.map(c => ({ wire: c.wire.id, loop: c.node, ...sceneOf(graph, res, c.node) }));
  const line = (sig, i) => (sig.docs?.[i] ? { text: t(sig.docs[i]) } : null);

  /** callers[0]'s reading of a function role: its contract over its refs, what it passes and what each argument means */
  const fnRole = (name, required, callers, sig, refs, recorded, exact, argOf) => {
    const resolved = resolveSignature({ params: sig.params, result: sig.result }, refs);
    const params = sig.params.map((P, i) => {
      const type = isRef(resolved.params[i]) ? null : resolved.params[i];
      return { type, label: isRef(P) ? named(P, refs) : named(type, refs) };
    });
    return {
      name, kind: 'function', required, callers, refs, signature: sig, params, result: resolved.result,
      args: recorded ?? params.map(p => p.type), exact, returns: sig.returns ?? null,
      argDoc: i => (i < sig.params.length ? mergeDocs(line(sig, i), argOf(i)) : null),
    };
  };

  const roleOf = name => {
    const calls = [];
    for (const c of graph.consumers(codeId, name)) {
      const port = res.portsOf(c.node).inputs.find(p => p.id === c.port);
      if (port?.signature) calls.push({ c, port });
    }
    const scenarioFn = SCENARIO_CALLS.includes(name) ? scenes : [], scenarioConst = name in SCENARIO_CONSTS && !calls.length ? scenes : [];
    const callers = [
      ...calls.map(({ c, port }) => ({ node: c.node, port: c.port, wire: c.wire.id, via: 'call', title: title(c.node), when: port.when ?? null, label: `${title(c.node)}.${c.port}` })),
      ...[...scenarioFn, ...scenarioConst].map(s => ({ node: s.loop, port: 'scenario', wire: s.wire, via: 'scenario', title: title(s.loop), when: scenarioConst.length ? SCENARIO_CONSTS[name].when : s.signatures[name].when, label: t('{consumer} 的 {role}', { consumer: title(s.loop), role: name }) })),
    ];
    if (!callers.length) return null;
    const required = scenarioConst.length ? SCENARIO_CONSTS[name].required : scenarioFn.length ? REQUIRED_CALLS.includes(name) : true;
    if (calls.length) {
      const [{ c, port }] = calls, refs = res.refsOf(c.node), rec = res.calls.get(c.wire.id);
      return fnRole(name, required, callers, port.signature, refs, rec ? rec.paramTypes.slice(0, rec.k) : null, rec ? rec.exact : port.signature.exact === true, i => d.arg(c.node, c.port, i));
    }
    const [s] = scenes;
    if (scenarioConst.length) {
      const spec = SCENARIO_CONSTS[name];
      return { name, kind: 'const', required, callers, refs: s.refs, signature: null, params: [], result: spec.type, args: [], exact: false, returns: spec.returns, argDoc: () => null };
    }
    const sig = s.signatures[name];
    return fnRole(name, required, callers, sig, s.refs, null, true, i => (isRef(sig.params[i]) ? d.ref(s.loop, sig.params[i].slice(1, -1)) : null));
  };

  const roles = new Map(), docs = new Map();
  const role = name => { if (!roles.has(name)) roles.set(name, roleOf(name)); return roles.get(name); };
  return {
    scenario: scenes[0]?.scenario ?? null,
    role,
    docs: fn => {
      if (!docs.has(fn)) {
        const node = graph.nodes.get(codeId), r = role(fn);
        docs.set(fn, node ? functionParamDocs(node, fn, i => r?.argDoc(i) ?? null, d) : null);
      }
      return docs.get(fn);
    },
  };
}
