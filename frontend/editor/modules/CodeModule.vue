<script setup lang="ts">
// CodeModule.vue — one code module in its tabs (CodeTabs.vue).
// The module is one restricted-JS file (core/kinds/code.js) with top-level consts and functions. A CodeEditor edits it.
// `focus` is the role tab that shows (null: 全文, the whole file).
// A role tab shows only that role and the errors located in it. The header of the role is locked with its types. The
// header also has `?` when the role follows the protocol.
// 全文 shows these items:
// - The whole file under the `inputs` line. Each name is one required value port, readable everywhere in the file.
//   Renames carry the wires by position.
// - All located errors: the file's own, a const's, a function's and a call site's. A ProgramError shows at the loc of
//   the node that emitted it, through the locs of that unit.
// - The exports without a role (ƒ function / value const, signature, where it is wired).
// - The other problems.
// The exports of the file are its ports. The core derives `config.exports` from the source each time the source parses.
// A commit can make exports vanish while the same number of the same kind appear. Then the commit renamed them, and
// their wires move to the new names by position in the file. A refused move drops that wire. Any other vanished export
// (or changed kind) drops its wires in the same edit.
// Types: the own params of an exported function take the argument types that the first caller of its role passes
// (core/roles.js). That caller is a call wire from the export, else the loop that runs the file as its scenario. The
// file-level names that the function reads take the types from analyseModule (inputs from their wires, consts from
// their own).
// Hovers read the local buffer. The span under the pointer belongs to the unit (const or exported function) whose
// lowering produced it. The span is typed over those types (ir.typeNodes). Its docs come from core/roles.js (the params
// of a role) and core/docs.js (the file-level names).
// Roles (code-roles.ts, ADR 0012) follow the buffer. They are rebuilt shortly after the buffer parses again, and they go
// up as `roles` (the tabs of the strip). A tab whose role is no longer in the parsed text asks for 全文 (`full`). An undo
// that changed hidden text also asks for 全文. `?` opens the help window of the role (RoleHelp.vue). Several help windows
// can be open.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import * as ir from '../../ir/index.js';
import { isRef, typeName } from '../../core/types.js';
import { INPUT_NAME, analyseModule, callFunction, constDoc } from '../../core/kinds/code.js';
import { named, rolesOf, type Role } from '../../core/roles.js';
import { docsOf } from '../../core/docs.js';
import { t } from '../../i18n.js';
import { useWorkbench } from '../workbench-context';
import CodeEditor from './CodeEditor.vue';
import RoleHelp from './RoleHelp.vue';
import { useBuffered, useNameList, useNode } from './common';
import type { HoverModel, Loc } from './code-editor';
import { optionsFor, queryAt, unitAt, type Named } from './code-complete';
import { contractOf, type Card, type MissingRole, type RoleAnalysis, type RoleEntry, type RoleTab } from './code-roles';
import type { Contract, RoleHead } from './code-contract';
import type { DocTree, HoverContext, HoverSpan } from './code-hover';
import type { CompletionResult } from '@codemirror/autocomplete';
import './bodies-a.css';

type LocatedError = Error & { loc?: Loc; end?: Loc; nodeId?: string | null; incomplete?: boolean };
interface Unit { loc: Loc; program: { params: string[]; output: string } | null; error: LocatedError | null; locs: Record<string, { loc: Loc }> | null; spans: HoverSpan[]; keyDocs: Record<string, Record<string, string>>; bound: string[]; doc: string | null }
interface Const extends Unit { name: string; exported: boolean; deps: string[] }
interface Fn extends Unit { params: string[] }
interface Analysis { module: { error: LocatedError | null; consts: Const[]; functions: Record<string, Fn | undefined> }; types: Record<string, unknown>; constErrors: Record<string, LocatedError | undefined> }
interface Call { result: unknown; error: LocatedError | null }
interface Export { name: string; kind: 'function' | 'const' }

const props = defineProps<{ nodeId: string; focus: string | null }>();
const emit = defineEmits<{ roles: [tabs: RoleTab[], missing: MissingRole[], other: number]; full: [] }>();
const wb = useWorkbench();
const { node, problems } = useNode(wb, () => props.nodeId);
const title = computed(() => node.value?.title ?? '');
const inputs = computed(() => (node.value?.config.inputs as string[] | undefined) ?? []);
const exportsList = computed(() => (node.value?.config.exports as Export[] | undefined) ?? []);
const titleOf = (id: string) => wb.graph.nodes.get(id)?.title ?? id;

/** analyseModule of the node with `source` (the stored one, or the editor's buffer) against its input wires */
function analysisOf(source: string): Analysis | null {
  const n = node.value; if (!n) return null;
  const res = wb.resolution();
  return analyseModule({ ...n, config: { ...n.config, source } }, (name: string) => res.inTypeOf(props.nodeId, name)) as unknown as Analysis;
}
const stored = computed(() => { void wb.version.value; return analysisOf(String(node.value?.config.source ?? '')); });

// ------------------------------------------------------------------ roles: who calls each export, passing what
const fileRoles = computed(() => { void wb.version.value; return rolesOf(wb.graph, wb.resolution(), props.nodeId); });
/** the function role `name` (null while nothing calls it by protocol) */
function fnRole(name: string): Role | null { const r = fileRoles.value.role(name); return r?.kind === 'function' ? r : null; }
/** Each role's last reading whose argument types were all known. While a named type waits on a committed text that
 *  does not check, the buffer that the user types in (hovers, completion) keeps the types it had. */
const knownRoles = new Map<string, Role>();
function typedRole(name: string): Role | null {
  const r = fnRole(name);
  if (r && r.args.every(T => T != null)) { knownRoles.set(name, r); return r; }
  return knownRoles.get(name) ?? r;
}
/** each exported function called with its first caller's argument types (null while nobody calls it) */
function callsOf(a: Analysis): Record<string, Call | null> {
  const out: Record<string, Call | null> = {};
  for (const name of Object.keys(a.module.functions)) {
    const r = fnRole(name);
    out[name] = r ? (callFunction(a as never, name, r.args, { exact: r.exact }) as unknown as Call) : null;
  }
  return out;
}
const calls = computed(() => (stored.value ? callsOf(stored.value) : {}));

// ------------------------------------------------------------------ inputs and source
const { text: inputsText, error: inputsError, commit: commitInputs } = useNameList(wb, () => props.nodeId, {
  key: 'inputs', names: () => inputs.value, pattern: INPUT_NAME, label: () => t('修改代码输入 {title}', { title: title.value }),
  invalid: name => t('输入名不合法：{name}', { name }), duplicate: name => t('输入名重复：{name}', { name }),
});
const source = useBuffered(() => String(node.value?.config.source ?? ''), text => {
  if (!node.value) return false;
  const id = props.nodeId;
  wb.edit(t('编辑代码 {title}', { title: title.value }), () => {
    const before = wb.graph.node(id).config.exports as Export[];
    wb.graph.patchConfig(id, { source: text });
    const after = wb.graph.node(id).config.exports as Export[];
    const has = (list: Export[], e: Export) => list.some(x => x.name === e.name && x.kind === e.kind);
    for (const kind of ['function', 'const'] as const) {
      const gone = before.filter(e => e.kind === kind && !has(after, e)), added = after.filter(e => e.kind === kind && !has(before, e));
      gone.forEach((e, i) => {
        for (const c of wb.graph.consumers(id, e.name)) {
          const w = c.wire;
          wb.graph.disconnect(w.id);
          // renamed (as many vanished as appeared): the wire follows to the new name, if the graph takes it there
          if (gone.length === added.length) try { wb.graph.connect({ id: w.id, kind: w.kind, from: { node: id, port: added[i].name }, to: w.to }); } catch { /* refused: dropped */ }
        }
      });
    }
  });
});
const editor = ref<InstanceType<typeof CodeEditor> | null>(null);
/** put the caret on the export `name` (CodeTabs answers EditorRuntime.revealCode by showing its tab, then this) */
async function reveal(name: string) {
  const m = stored.value?.module, unit = m?.functions[name] ?? m?.consts.find(c => c.name === name);
  await nextTick();
  if (unit?.loc) editor.value?.locate(unit.loc);
}

// ------------------------------------------------------------------ roles: tabs, focus, locked headers, help
const heads = ref<RoleHead[]>([]), roleEntries = ref<RoleEntry[]>([]), help = ref(new Map<string, Card>()), missing = ref<MissingRole[]>([]);
/** the text the roles were built from (the editor applies them while its document is this text) */
const builtFor = ref('');
/** the edits a role's actions make, on the buffer as it is when the action runs */
const roleEditor = {
  text: () => source.text.value,
  analyse: (text: string) => { const a = analysisOf(text); return a && !a.module.error ? (a as unknown as RoleAnalysis) : null; },
  apply: (from: number, to: number, insert: string) => editor.value?.apply(from, to, insert),
};
/** rebuild the roles for the buffer when it parses. A text that does not parse keeps the last ones (mapped by the editor) */
function rebuildRoles() {
  const text = source.text.value, a = analysisOf(text);
  if (!a || a.module.error) return;
  const results = callsOf(a);
  const built = contractOf(wb, props.nodeId, text, a as unknown as RoleAnalysis, name => results[name]?.result ?? null, roleEditor);
  heads.value = built.heads; roleEntries.value = built.roles; help.value = built.help; missing.value = built.missing; builtFor.value = text;
  if (props.focus !== null && !built.roles.some(r => r.key === props.focus)) emit('full');
}
let rolesTimer: ReturnType<typeof setTimeout> | null = null;
watch([() => source.text.value, () => wb.version.value], () => { if (rolesTimer) clearTimeout(rolesTimer); rolesTimer = setTimeout(() => { rolesTimer = null; rebuildRoles(); }, 120); });
rebuildRoles();
onBeforeUnmount(() => { if (rolesTimer) clearTimeout(rolesTimer); });
/** what the editor draws: the headers, and the shown role's range (null on 全文) */
const contract = computed<Contract | null>(() => {
  if (!builtFor.value && !heads.value.length) return null;
  const r = props.focus === null ? null : roleEntries.value.find(x => x.key === props.focus) ?? null;
  return { text: builtFor.value, heads: heads.value, focus: r ? r.range : null };
});
/** nothing calls this file yet: say where its roles come from */
const unwired = computed(() => { void wb.version.value; return !roleEntries.value.length && !missing.value.length && [...exportsList.value.map(e => e.name), 'module'].every(p => !wb.graph.consumers(props.nodeId, p).length); });

/** the open help windows (by role), each where it was opened */
const windows = ref<{ key: string; x: number; y: number }[]>([]);
function openHelp(key: string, anchor: HTMLElement) {
  if (windows.value.some(w => w.key === key)) return;
  const r = anchor.getBoundingClientRect();
  windows.value = [...windows.value, { key, x: Math.min(r.right + 8, window.innerWidth - 380), y: Math.max(8, r.top - 8) }];
}
const closeHelp = (key: string) => { windows.value = windows.value.filter(w => w.key !== key); };
onBeforeUnmount(() => { windows.value = []; });

// ------------------------------------------------------------------ located errors
/** where an error of `unit` points: its own range (a source error), the node that emitted it, else the unit's name */
function entry(label: string, unit: string | null, error: LocatedError, u?: Unit) {
  const loc = error.loc ?? (error.nodeId != null ? u?.locs?.[error.nodeId]?.loc : undefined) ?? u?.loc ?? null;
  return { label, unit, message: error.message, loc, end: error.loc ? error.end ?? null : null };
}
/** every located error, with the unit it belongs to (null: the file itself — every tab shows it) */
const located = computed<{ label: string; unit: string | null; message: string; loc: Loc | null; end: Loc | null }[]>(() => {
  const a = stored.value; if (!a) return [];
  const m = a.module;
  if (m.error) return [entry(t('文件'), null, m.error)];
  const out = [];
  for (const c of m.consts) {
    const error = c.error ?? a.constErrors[c.name];
    if (error) out.push(entry(c.name, c.name, error, c));
  }
  for (const [name, fn] of Object.entries(m.functions)) {
    if (!fn) continue;
    if (fn.error) { out.push(entry(name, name, fn.error, fn)); continue; }
    const error = calls.value[name]?.error;
    if (error && !error.incomplete) out.push(entry(`${name} ← ${fnRole(name)!.callers[0].label}`, name, error, fn));
  }
  return out;
});
/** the errors this tab lists: a role's own and the file's (全文: all) */
const shown = computed(() => (props.focus === null ? located.value : located.value.filter(p => p.unit === null || p.unit === props.focus)));
/** the located errors the editor underlines */
const underlined = computed(() => located.value.flatMap(p => (p.loc ? [{ loc: p.loc, end: p.end, message: p.message }] : [])));
/** module problems not already shown under the editor */
const rest = computed(() => problems.value.filter(p => !located.value.some(l => p.message.endsWith(l.message))));
/** the strip's tabs: each role with its errors. `other`: what only 全文 shows (errors outside roles, other problems) */
watch([roleEntries, located, rest, missing], () => {
  const keys = new Set(roleEntries.value.map(r => r.key));
  const tabs = roleEntries.value.map(r => ({ key: r.key, kind: r.kind, bad: r.bad, errors: located.value.filter(p => p.unit === r.key || p.unit === null).length }));
  emit('roles', tabs, missing.value, located.value.filter(p => p.unit !== null && !keys.has(p.unit)).length + rest.value.length);
}, { immediate: true });
defineExpose({ reveal, refresh: () => editor.value?.refresh() });

// ------------------------------------------------------------------ the export list (全文): exports that are no role
const wiredTo = (port: string) => wb.graph.consumers(props.nodeId, port).map(c => `${titleOf(c.node)}.${c.port}`);
const moduleUses = computed(() => { void wb.version.value; return wiredTo('module'); });
const exportRows = computed(() => {
  void wb.version.value;
  const a = stored.value, roles = new Set(roleEntries.value.map(r => r.key));
  return exportsList.value.filter(e => !roles.has(e.name)).map(e => {
    let sig = '', full = '', doc: string | null = null, via = '';
    if (e.kind === 'function') {
      const fn = a?.module.functions[e.name], c = fnRole(e.name), r = calls.value[e.name];
      const own = (fn?.params ?? []).map((p, i) => [p, c?.args[i] ?? null] as const);
      sig = `(${own.map(([p, T]) => `${p}: ${named(T, c?.refs)}`).join(', ')}) → ${named(r?.result ?? null, c?.refs)}`;
      full = `function ${e.name}(${own.map(([p, T]) => `${p}: ${typeName(T)}`).join(', ')}) → ${typeName(r?.result ?? null)}`;
      doc = fn?.doc ?? null;
      if (c) via = t('调用自 {caller}', { caller: c.callers[0].label });
    } else {
      const c = a?.module.consts.find(x => x.name === e.name);
      sig = typeName(a?.types[e.name] ?? null);
      full = `const ${e.name}: ${sig}`;
      doc = c?.doc ?? null;
    }
    const direct = wiredTo(e.name);
    return { ...e, sig, wired: direct.length ? direct.join(', ') : t('未接'), title: [full, doc, via, direct.length ? t('接到 {list}', { list: direct.join(', ') }) : ''].filter(Boolean).join('\n') };
  });
});

// ------------------------------------------------------------------ hovers
interface Origin { type: unknown | null; source: string; doc: DocTree | null }
/** where each program param of a unit comes from: its own params from the caller, file-level names from the file */
function fileOrigin(a: Analysis, name: string, d: ReturnType<typeof docsOf>): Origin {
  const c = a.module.consts.find(x => x.name === name);
  if (c) return { type: a.types[name] ?? null, source: t('顶层常量'), doc: (node.value ? constDoc(node.value, a.module, c, d) : null) as DocTree | null };
  return { type: a.types[name] ?? null, source: t('由输入 {name} 的值线传入', { name }), doc: d.input(props.nodeId, name) as DocTree | null };
}
function unitContext(unit: Unit, origins: Origin[], exact: boolean): HoverContext {
  const program = unit.program!, types = origins.map(o => o.type);
  let nodeTypes = new Map<string, unknown>();
  if (types.every(T => T && !isRef(T))) try { nodeTypes = ir.typeNodes(program, types, { exact }).types as Map<string, unknown>; } catch { /* best effort: nothing typed */ }
  const docs = ir.flowDocs(program, Object.fromEntries(program.params.map((name, i) => [name, origins[i].doc])), unit.keyDocs) as Map<string, DocTree>;
  return {
    types: nodeTypes, docs,
    param: name => { const i = program.params.indexOf(name); return i < 0 ? undefined : { type: origins[i].type, source: origins[i].source, doc: origins[i].doc?.text || null }; },
  };
}
function functionContext(a: Analysis, name: string, fn: Fn): HoverContext {
  const d = docsOf(wb.graph, wb.resolution()), c = typedRole(name);
  // the committed function's params, each its Doc Comment over what the first caller passes there. A param renamed
  // in the buffer still means what the caller passes at its position.
  const own = (fileRoles.value.docs(name) ?? {}) as Record<string, DocTree | null>;
  const typed = c && c.args.length === fn.params.length;
  const origins: Origin[] = fn.params.map((p, i) => ({
    type: typed ? c.args[i] : null, source: c ? t('由 {caller} 传入', { caller: c.callers[0].label }) : t('还没有调用方'),
    doc: own[p] ?? (c?.argDoc(i) as DocTree | null | undefined) ?? null,
  }));
  for (const n of fn.bound) origins.push(fileOrigin(a, n, d));
  return unitContext(fn, origins, c?.exact ?? false);
}
/** the buffer's hover targets, each tied to the unit that lowered it (null while the file does not compile) */
const hoverModel = computed<HoverModel | null>(() => {
  const a = analysisOf(source.text.value);
  if (!a || a.module.error) return null;
  const units: { unit: Unit; context: () => HoverContext }[] = [];
  for (const c of a.module.consts) if (c.program) units.push({ unit: c, context: () => { const d = docsOf(wb.graph, wb.resolution()); return unitContext(c, c.deps.map(n => fileOrigin(a, n, d)), false); } });
  for (const [name, fn] of Object.entries(a.module.functions)) if (fn?.program) units.push({ unit: fn, context: () => functionContext(a, name, fn) });
  const owner = new Map<HoverSpan, number>(), contexts = new Map<number, HoverContext>(), spans: HoverSpan[] = [];
  units.forEach(({ unit }, k) => { for (const s of unit.spans) { owner.set(s, k); spans.push(s); } });
  spans.sort((x, y) => x.start - y.start || y.end - x.end);
  return {
    spans,
    ctxOf: span => {
      const k = owner.get(span)!;
      let ctx = contexts.get(k);
      if (!ctx) contexts.set(k, (ctx = units[k].context()));
      return ctx;
    },
  };
});

// ------------------------------------------------------------------ completion
/** the last analysis that parsed and each function's last lowering: they complete while the text is half-written */
let parsed: Analysis | null = null;
const lowerings = new Map<string, { a: Analysis; fn: Fn }>();
function remember(a: Analysis) {
  parsed = a;
  for (const [name, fn] of Object.entries(a.module.functions)) if (fn?.program) lowerings.set(name, { a, fn });
}
watch(stored, a => { if (a && !a.module.error) remember(a); }, { immediate: true });   // the committed text, from the start
/** The names readable at `pos` and their types: the consts, inputs and functions of the file. Inside a function, also
 *  its params (typed by the first caller, whatever the state of the body) and its locals. If the own analysis of the
 *  text lowered the function, the locals are the ones declared before the caret. Otherwise they are all the locals from
 *  its last lowering. */
function scopeAt(text: string, repaired: string, pos: number): Map<string, Named> {
  const ok = (a: Analysis | null) => (a && !a.module.error ? a : null);
  const fresh = ok(analysisOf(repaired)) ?? (repaired !== text ? ok(analysisOf(text)) : null);
  if (fresh) remember(fresh);
  const a = fresh ?? parsed, scope = new Map<string, Named>();
  if (!a) return scope;
  for (const c of a.module.consts) scope.set(c.name, { type: a.types[c.name] ?? null, kind: 'const' });
  for (const n of inputs.value) scope.set(n, { type: a.types[n] ?? null, kind: 'input' });
  for (const name of Object.keys(a.module.functions)) scope.set(name, { type: null, kind: 'function' });
  const unit = unitAt(text, pos), fn = unit ? a.module.functions[unit] : undefined;
  if (!unit || !fn) return scope;
  const c = typedRole(unit), typed = c && c.args.length === fn.params.length;
  fn.params.forEach((p, i) => scope.set(p, { type: typed ? c.args[i] : null, kind: 'param' }));
  const last = lowerings.get(unit);
  if (!last) return scope;
  const before = fresh !== null && last.a === fresh, ctx = functionContext(last.a, unit, last.fn);
  for (const s of last.fn.spans) if ((s.kind === 'const' || s.kind === 'arg') && s.id != null && (!before || s.start < pos)) scope.set(s.name, { type: ctx.types.get(s.id) ?? null, kind: 'local' });
  return scope;
}
function complete(text: string, pos: number, explicit: boolean): CompletionResult | null {
  const q = queryAt(text, pos, explicit);
  const options = q ? optionsFor(q, scopeAt(text, q.repaired, pos)) : [];
  return q && options.length ? { from: q.from, options, validFor: /^[\p{L}\p{N}_$]*$/u } : null;
}
</script>

<template>
  <!-- typing inside the file never reaches the canvas -->
  <div v-if="node" class="body" @keydown.stop>
    <div v-if="focus === null && unwired" class="code-hint">{{ t('还没有接到任何模块。接到训练器、评估器或回路后，这里列出要写的函数。它还说明每个函数收到什么、返回什么。') }}</div>
    <div class="code bfill" :class="{ problem: shown.length > 0 }">
      <div v-if="focus === null" class="code-head">
        <span class="code-kw">inputs</span>
        <input class="code-params" :class="{ bad: !!inputsError }" :value="inputsText" spellcheck="false" :placeholder="t('文件级输入名，逗号分隔（如 rng）')" :aria-label="t('{title} 的输入', { title })"
          :title="t('每个名称是一个必接的值端口，在整个文件里可读')" @change="commitInputs(($event.target as HTMLInputElement).value)" />
        <span v-if="source.typing.value" class="m code-typing">{{ t('输入中…') }}</span>
      </div>
      <div v-if="focus === null && inputsError" class="code-problem" role="alert">{{ inputsError }}</div>
      <CodeEditor ref="editor" :buffer="source" :model="() => hoverModel" :problems="underlined" :complete="complete" :contract="contract" :label="t('{title} 的代码', { title })"
        @help="openHelp" @hidden-edit="emit('full')" />
      <div v-for="(p, i) in shown" :key="i" class="code-problem" role="alert">
        <button v-if="p.loc" type="button" class="mini loc" :title="t('定位到第 {line} 行', { line: p.loc.line })" @click="editor?.locate(p.loc)">{{ t('定位') }}</button>
        <span class="code-unit">{{ p.label }}</span>{{ p.message }}
      </div>
    </div>
    <template v-if="focus === null">
      <div class="code-exports" :aria-label="t('{title} 的导出', { title })">
        <template v-for="e in exportRows" :key="e.kind + e.name">
          <span class="kind" :title="e.kind === 'function' ? t('导出函数：调用端口') : t('导出常量：值端口')">{{ e.kind === 'function' ? 'ƒ' : t('值') }}</span>
          <span class="name">{{ e.name }}</span>
          <span class="sig" :title="e.title">{{ e.sig }}</span>
          <span class="wired" :title="e.wired">{{ e.wired }}</span>
        </template>
        <span class="kind">▣</span>
        <span class="name">module</span>
        <span class="sig" :title="t('整个文件：交给按角色调用其中函数的模块（例如训练器运行的场景）')">{{ t('整个文件') }}</span>
        <span class="wired" :title="moduleUses.join(', ')">{{ moduleUses.length ? moduleUses.join(', ') : t('未接') }}</span>
      </div>
      <div v-for="(p, i) in rest" :key="i" class="bproblem" :class="{ incomplete: p.incomplete }">{{ p.port ? p.port + '：' : '' }}{{ p.message }}</div>
    </template>
    <RoleHelp v-for="w in windows" :key="w.key" :card="help.get(w.key) ?? null" :x="w.x" :y="w.y" @close="closeHelp(w.key)" />
  </div>
</template>
