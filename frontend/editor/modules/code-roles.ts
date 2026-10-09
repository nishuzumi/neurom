// code-roles.ts — the roles of a code module, as its tabs show them (CodeTabs / CodeModule, ADR 0012).
// core/roles.js defines what a role is: who calls it and when, the contract of the first caller, types and named types,
// and what each argument means. For a scenario module it also gives the live loop context with the stub text of each
// scenario role. This file puts that information over the text that the user edits. Per role it gives:
// - Its range (a tab shows only that range).
// - Its header decorations (code-contract.ts). The header is locked except for its parameter names, which the file
//   chooses. The count and types come from the protocol. A grey type follows each parameter and `)`, then the `?`.
// - Its help (the `?` window). The help has the signature with the caller's names for types (State, Transition…). It
//   has who calls the role and when, and each parameter (a record opens into its fields). It also has what to return, an
//   example from a real episode (core/sample.js) and the actions. The actions rewrite a parameter list of the wrong
//   length or delete an optional role.
// For a scenario module, it also gives the roles that the file does not export yet, each with the text that adds it.
import { named, rolesOf, type Role } from '../../core/roles.js';
import { exampleOf } from '../../core/sample.js';
import { t } from '../../i18n.js';
import { formatValue } from './common';
import type { Workbench } from '../workbench-context';
import type { RoleHead } from './code-contract';
import type { DocTree } from './code-hover';

/** the parts of parseModule's units the cards read (ir/parse.js: offsets into the text) */
interface Span { start: number; end: number }
interface RoleUnit { params?: string[]; head?: Span; docStart?: number; end?: number; paramSpans?: Span[] }
export interface CardField { name: string; type: string; doc: string | null; fields?: CardField[] }
interface CardAction { label: string; title?: string; run: () => void }
/** what a role's `?` window says */
export interface Card {
  key: string;
  /** `step(state: State, action: number) → {…}` / `budget: number` */
  signature: string;
  /** one line per caller: `策略训练 · 训练时每走一步调用一次…` */
  callers: string[];
  params: CardField[];
  /** `返回` for a function, `值` for a const */
  returns: { label: string; type: string; doc: string | null };
  example: { label: string; text: string; full: string } | { error: string } | null;
  /** the header does not follow the protocol (parameter names) */
  problem: string | null;
  /** the header is locked */
  locked: boolean;
  actions: CardAction[];
}
export interface RoleAnalysis {
  module: {
    error: unknown; consts: (RoleUnit & { name: string; exported: boolean })[]; functions: Record<string, RoleUnit | undefined>;
    helpers: { name: string; loc: { line: number; column: number } }[];
  };
  types: Record<string, unknown>;
}

const MAX_EXAMPLE = 160;

/** a parameter / field line: its type by name, its doc, a record's fields (their docs from `tree`) */
function fieldOf(name: string, T: unknown, label: string, doc: string | null, tree: DocTree | null, refs: Record<string, unknown>, depth: number): CardField {
  const R = T as { type?: string; fields?: Record<string, unknown> } | null;
  const f: CardField = { name, type: label, doc };
  if (R?.type === 'record' && R.fields && depth < 3) f.fields = Object.entries(R.fields).map(([k, F]) => fieldOf(k, F, named(F, refs), tree?.fields?.[k]?.text ?? null, tree?.fields?.[k] ?? null, refs, depth + 1));
  return f;
}

/** `a = 1, b = {…} → 3`: short (for the line) and full (for the hover) */
function exampleText(names: readonly string[], args: readonly unknown[], result: unknown, hasResult: boolean) {
  const part = (fmt: (v: unknown) => string) => [names.map((n, i) => `${n} = ${fmt(args[i])}`).join(', '), ...(hasResult ? [fmt(result)] : [])].join(' → ');
  const text = part(v => formatValue(v, 12));
  return { text: text.length > MAX_EXAMPLE ? `${text.slice(0, MAX_EXAMPLE)}…` : text, full: part(v => JSON.stringify(v)) };
}

/** a scenario role the file does not export. `preview` is what `add` writes. `declared`: the file declares that name
 *  but does not export it (`add` exports it) */
export interface MissingRole { name: string; required: boolean; declared: boolean; preview: string; add: () => void }
/** the edits a role's actions make, on the text as it is when the action runs */
interface RoleEditor { text(): string; analyse(text: string): RoleAnalysis | null; apply(from: number, to: number, insert: string): void }
/** a tab of the strip: a role of the file, how many located errors it has, whether its header is off-protocol */
export interface RoleTab { key: string; kind: 'function' | 'const'; errors: number; bad: boolean }

/** one role of the file, for the tab strip and the tab's focus: its range (doc comment through its end) */
export interface RoleEntry { key: string; kind: 'function' | 'const'; range: { from: number; to: number }; bad: boolean }

/**
 * The roles of the code module `nodeId` in `text` (its analysis `a`, which parsed): the editor's header decorations,
 * one entry per role (file order), each role's help, and the scenario roles the file does not export yet.
 * `resultOf(name)` is the type the export returns at its caller (null when unknown).
 */
export function contractOf(wb: Workbench, nodeId: string, text: string, a: RoleAnalysis, resultOf: (name: string) => unknown, ed: RoleEditor): { heads: RoleHead[]; roles: RoleEntry[]; help: Map<string, Card>; missing: MissingRole[] } {
  const res = wb.resolution(), heads: RoleHead[] = [], roles: RoleEntry[] = [], help = new Map<string, Card>(), R = rolesOf(wb.graph, res, nodeId);
  const callerLines = (role: Role) => [...new Set(role.callers.map(u => (u.when ? `${u.title} · ${t(u.when)}` : u.title)))];
  /** the unit named `name` in the text as it is now (actions run later than the roles were built) */
  const now = (name: string, fn: boolean) => { const b = ed.analyse(ed.text()); return b ? (fn ? b.module.functions[name] : b.module.consts.find(c => c.exported && c.name === name)) ?? null : null; };
  const remove = (name: string, fn: boolean): CardAction => ({
    label: t('删除 {name}', { name }), title: t('删除可选的 {name}', { name }),
    run: () => { const u = now(name, fn), s = ed.text(); if (u?.docStart === undefined || u.end === undefined) return; let to = u.end; while (s[to] === '\n' && to - u.end < 2) to++; ed.apply(u.docStart, to, ''); },
  });

  for (const [name, fn] of Object.entries(a.module.functions)) {
    const role = fn?.head ? R.role(name) : null;
    if (!fn?.head || fn.end === undefined || role?.kind !== 'function' || !role.signature) continue;
    const sig = role.signature, refs = role.refs, labels = role.params.map(p => p.label);
    // the parameters are the file's own names. Only their count and types come from the protocol (the defaults name a stub).
    const own = fn.params ?? [], counted = own.length === sig.params.length, names = counted ? own : sig.names;
    const actual = resultOf(name) as { type?: string; width?: number } | null, declared = role.result as { anyRecord?: boolean; binaryVector?: unknown } | null;
    // the program's type cannot say that its elements are 0 / 1, but the protocol can. A vector where the protocol
    // expects bits reads as bits.
    const ret = actual ? (declared?.binaryVector && actual.type === 'vector' ? `bits[${actual.width}]` : named(actual, refs)) : declared && !declared.anyRecord ? named(declared, refs) : '?';
    // on the header a record reads by its field names (a named one — State — by its name). The help window shows it whole.
    const D = declared as { recordWith?: Record<string, unknown> } | null, A = actual as { type?: string; fields?: Record<string, unknown> } | null;
    const keys = D?.recordWith ? Object.keys(D.recordWith) : A?.type === 'record' && A.fields ? Object.keys(A.fields) : null;
    const short = keys && !/^[A-Z]\w*$/.test(ret) ? `{ ${keys.join(', ')} }` : ret;
    const params = names.map((n, i) => { const doc = role.argDoc(i) as DocTree | null; return fieldOf(n, role.params[i].type, labels[i], doc?.text ?? null, doc, refs, 0); });
    const problem = counted ? null : t('{name} 需要 {n} 个参数（{types}），现在是 {k} 个', { name, n: sig.params.length, k: own.length, types: labels.join(', ') }), actions: CardAction[] = [];
    if (problem) actions.push({
      label: t('改成 ({names})', { names: sig.names.join(', ') }), title: t('这只改函数头。函数体里用到的名字，你要自己改'),
      run: () => { const u = now(name, true), s = ed.text(); if (!u?.head) return; const h = s.slice(u.head.start, u.head.end); ed.apply(u.head.start + h.indexOf('(') + 1, u.head.start + h.lastIndexOf(')'), sig.names.join(', ')); },
    });
    if (!role.required) actions.push(remove(name, true));
    const ex = exampleOf(wb.graph, res, nodeId, name, { artifacts: (id: string) => wb.workspace.artifact(id) }) as { label: string; args: unknown[]; result?: unknown; error?: string } | null;
    help.set(name, {
      key: name, signature: `${name}(${names.map((n, i) => `${n}: ${labels[i]}`).join(', ')}) → ${ret}`,
      callers: callerLines(role),
      params, returns: { label: t('返回'), type: ret, doc: role.returns ? t(role.returns) : null },
      example: !ex ? null : ex.error !== undefined ? { error: ex.error } : { label: ex.label, ...exampleText(names, ex.args, ex.result, 'result' in ex) },
      problem, locked: !problem, actions,
    });
    const h = text.slice(fn.head.start, fn.head.end), spans = fn.paramSpans ?? [];
    // locked: the header except the parameter names. The file chooses those names.
    const locks: { from: number; to: number }[] = [];
    if (counted) { let at = fn.head.start; for (const s of spans) { if (s.start > at) locks.push({ from: at, to: s.start }); at = s.end; } locks.push({ from: at, to: fn.head.end }); }
    heads.push({
      key: name, locks, help: { at: fn.head.end, bad: !!problem },
      hints: counted ? [...spans.map((s, i) => ({ at: s.end, text: `: ${labels[i]}` })), { at: fn.head.start + h.lastIndexOf(')') + 1, text: ` → ${short}` }] : [],
    });
    roles.push({ key: name, kind: 'function', range: { from: fn.docStart ?? fn.head.start, to: fn.end }, bad: !!problem });
  }
  for (const c of a.module.consts) {
    const role = c.exported ? R.role(c.name) : null;
    if (role?.kind !== 'const' || !c.head || c.end === undefined) continue;
    const type = named(a.types[c.name] ?? null, role.refs), h = text.slice(c.head.start, c.head.end);
    help.set(c.name, {
      key: c.name, signature: `${c.name}: ${type}`, callers: callerLines(role), params: [],
      returns: { label: t('值'), type, doc: role.returns ? t(role.returns) : null }, example: null, problem: null, locked: true, actions: role.required ? [] : [remove(c.name, false)],
    });
    heads.push({ key: c.name, locks: [{ from: c.head.start, to: c.head.end }], help: { at: c.end, bad: false }, hints: [{ at: c.head.start + h.indexOf(c.name) + c.name.length, text: `: ${type}` }] });
    roles.push({ key: c.name, kind: 'const', range: { from: c.docStart ?? c.head.start, to: c.end }, bad: false });
  }
  roles.sort((x, y) => x.range.from - y.range.from);

  const missing: MissingRole[] = [];
  const scenario = R.scenario;
  if (scenario) {
    const has = (n: string) => !!a.module.functions[n] || a.module.consts.some(c => c.exported && c.name === n);
    /** where the file declares `n` without exporting it (a helper or a plain const), in `b`'s text `s` */
    const privateAt = (b: RoleAnalysis, s: string, n: string): number | null => {
      const c = b.module.consts.find(x => !x.exported && x.name === n);
      if (c?.head) return c.head.start;
      const h = b.module.helpers.find(x => x.name === n);
      if (!h) return null;
      const lines = s.split('\n'), at = lines.slice(0, h.loc.line - 1).reduce((k, l) => k + l.length + 1, 0) + h.loc.column;
      const kw = s.lastIndexOf('function', at);
      return kw >= 0 ? kw : null;
    };
    for (const [k, { name, required, text: body }] of scenario.roles.entries()) {
      if (has(name)) continue;
      const own = privateAt(a, text, name);
      missing.push({ name, required, declared: own !== null, preview: own !== null ? t('给已有的 {name} 加上 export', { name }) : body, add: () => {
        const s = ed.text(), b = ed.analyse(s);
        if (!b) return;
        // declared but not exported: export it (a second declaration would not parse)
        const own = privateAt(b, s, name);
        if (own !== null) { ed.apply(own, own, 'export '); return; }
        const later = scenario.roles.slice(k + 1).map(r => r.name);
        const next = later.map(n => b.module.functions[n] ?? b.module.consts.find(c => c.exported && c.name === n)).find(u => u?.docStart !== undefined);
        if (next?.docStart !== undefined) ed.apply(next.docStart, next.docStart, `${body}\n`);
        else ed.apply(s.length, s.length, `${s.length && !s.endsWith('\n') ? '\n' : ''}${s.trim() ? '\n' : ''}${body}`);
      } });
    }
  }
  return { heads, roles, help, missing };
}
