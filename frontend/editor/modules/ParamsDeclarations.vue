<script setup lang="ts">
// ParamsDeclarations.vue — the Params module's declaration dialog (ADR 0006). The module's settings button opens it,
// and it mounts only while open. It shows itself as a modal on mount and emits `close` to be unmounted.
// Left: the visual editor for fields (name, type, label, range / choices, default) and function inputs (the
// module's call ports, each `fn(params) → record`). Right: the same declaration as YAML `{ fields, functions }`.
// Visual edits commit at once and regenerate the YAML. The dialog validates YAML during typing and applies it on blur
// or Ctrl / ⌘ Enter (one history entry), so half-typed keys never become fields. Function-input wires follow a
// rename: same count → by position, otherwise the dialog drops wires into vanished names (the code module's rule,
// ADR 0006).
import { computed, onMounted, ref, watch } from 'vue';
import YAML from 'yaml';
import { fieldConstraints, fieldProblem, FUNCTION_INPUT_NAME, MAX_FUNCTION_INPUTS } from '../../core/kinds/params.js';
import { validateConfig } from '../../core/registry.js';
import { t } from '../../i18n.js';
import { useWorkbench } from '../workbench-context';
import { carryInputWires, useNode } from './common';
import './bodies-a.css';

interface Field { type: 'int' | 'number' | 'boolean' | 'enum' | 'string'; label?: string; min?: number | string; max?: number | string; values?: string[] | string; default: unknown }
interface Constraint { min?: number; max?: number; values?: string[]; errors: string[] }
interface Config { fields: Record<string, Field>; values: Record<string, unknown>; functions: string[] }

const FIELD_TYPES = ['int', 'number', 'boolean', 'enum', 'string'] as const;
const props = defineProps<{ nodeId: string }>();
const emit = defineEmits<{ close: [] }>();
const wb = useWorkbench();

const { node } = useNode(wb, () => props.nodeId);
const config = computed<Config>(() => (node.value?.config ?? { fields: {}, values: {}, functions: [] }) as unknown as Config);
const names = computed(() => Object.keys(config.value.fields));
const title = computed(() => node.value?.title ?? '');
/** Effective constraints under `fields` (default: the stored ones) with the current values — expressions evaluated. */
const constraintsFor = (fields: Record<string, Field>) => fieldConstraints({ ...config.value, fields }) as Record<string, Constraint>;
const constraints = computed(() => constraintsFor(config.value.fields));

// ------------------------------------------------------------------ one commit path for every declaration change
const declError = ref<string | null>(null);
/** Commit fields + functions (+ values). Wires into function inputs are carried (common.ts carryInputWires). A wire
 *  that cannot be carried is dropped and reported. Returns false when nothing was applied. */
function commit(label: string, fields: Record<string, Field>, functions: string[], values: Record<string, unknown>): boolean {
  try { declError.value = carryInputWires(wb, props.nodeId, config.value.functions, functions, label, { fields, functions, values }); }
  catch (e) { declError.value = (e as Error).message; return false; }
  return true;
}
const commitFields = (label: string, fields: Record<string, Field>, values = config.value.values) => commit(label, fields, config.value.functions, values);
const commitFunctions = (label: string, functions: string[]) => commit(label, config.value.fields, functions, config.value.values);

// ------------------------------------------------------------------ fields
function defaultFor(type: Field['type'], f?: Field): unknown {
  switch (type) {
    case 'boolean': return typeof f?.default === 'boolean' ? f.default : false;
    case 'enum': return f?.values?.[0] ?? '';
    case 'string': return typeof f?.default === 'string' ? f.default : '';
    default: return typeof f?.default === 'number' ? (type === 'int' ? Math.round(f.default) : f.default) : 0;
  }
}
const IDENTIFIER_ERROR = () => t('参数名必须是标识符（字母、数字、下划线，不能以数字开头）');
const newField = ref('');
function addField() {
  const name = newField.value.trim();
  if (!FUNCTION_INPUT_NAME.test(name)) { declError.value = IDENTIFIER_ERROR(); return; }
  if (name in config.value.fields) { declError.value = t('参数 {name} 已存在', { name }); return; }
  if (commitFields(t('新增参数 {name}', { name }), { ...config.value.fields, [name]: { type: 'number', default: 0 } })) newField.value = '';
}
function removeField(name: string) {
  const { [name]: _, ...fields } = config.value.fields;
  const { [name]: __, ...values } = config.value.values;
  commitFields(t('删除参数 {name}', { name }), fields, values);
}
function patchField(name: string, patch: Partial<Field>) {
  const f = { ...config.value.fields[name], ...patch };
  for (const k of ['min', 'max', 'values', 'label'] as const) if (f[k] === undefined || f[k] === null || (f[k] as unknown) === '') delete f[k];
  commitFields(t('修改参数 {name} 的声明', { name }), { ...config.value.fields, [name]: f });
}
function setType(name: string, type: Field['type']) {
  const f = config.value.fields[name];
  const next: Field = { type, default: defaultFor(type, f) };
  if (f.label) next.label = f.label;
  if (type === 'int' || type === 'number') { if (f.min !== undefined) next.min = f.min; if (f.max !== undefined) next.max = f.max; }
  if (type === 'enum') {
    next.values = (Array.isArray(f.values) ? f.values.length : f.values) ? f.values : ['a', 'b'];
    next.default = constraintsFor({ ...config.value.fields, [name]: next })[name].values?.[0] ?? '';
  }
  const { [name]: _, ...values } = config.value.values;      // an old override rarely fits the new type
  commitFields(t('修改参数 {name} 的类型', { name }), { ...config.value.fields, [name]: next }, values);
}
/** min / max: blank clears it, a number is static, anything else is a constraint expression (for example `grid - 1`). */
function setBound(name: string, key: 'min' | 'max', raw: string) {
  const s = raw.trim();
  if (s === '') { patchField(name, { [key]: undefined }); return; }
  const n = Number(s);
  patchField(name, { [key]: Number.isFinite(n) ? n : s });
}
/** values: a comma list is static. `= expression` is a constraint expression returning a string list. */
function setValues(name: string, raw: string) {
  const s = raw.trim();
  const values: string[] | string = s.startsWith('=') ? s.slice(1).trim() : s.split(/[,\s，]+/).filter(Boolean);
  if (!values.length) { declError.value = t('参数 {name} 是枚举，需要 values', { name }); return; }
  const f = config.value.fields[name];
  const choices = constraintsFor({ ...config.value.fields, [name]: { ...f, values } })[name].values ?? [];
  patchField(name, { values, default: choices.includes(f.default as string) ? f.default : choices[0] ?? f.default });
}
const valuesText = (f: Field) => (typeof f.values === 'string' ? `= ${f.values}` : (f.values ?? []).join(', '));
/** The evaluated range / choices of a field whose constraints include an expression, for example `0..11`. */
function currentRange(name: string): string {
  const c = constraints.value[name];
  return c?.values ? c.values.join(' / ') : `${c?.min ?? ''}..${c?.max ?? ''}`;
}
function setDefault(name: string, raw: unknown) {
  const f = config.value.fields[name];
  let v = raw;
  if (f.type === 'int' || f.type === 'number') { v = Number(String(raw).trim()); if (!Number.isFinite(v as number)) { declError.value = t('必须是有限数'); return; } }
  const problem = fieldProblem(f, v, { values: constraints.value[name]?.values });   // ranges may depend on other fields: shown as problems, not rejected
  if (problem) { declError.value = t('默认值：{problem}', { problem }); return; }
  patchField(name, { default: v });
}
function renameField(name: string, raw: string) {
  const next = raw.trim();
  if (next === name) return;
  if (!FUNCTION_INPUT_NAME.test(next)) { declError.value = IDENTIFIER_ERROR(); return; }
  if (next in config.value.fields) { declError.value = t('参数 {name} 已存在', { name: next }); return; }
  const fields: Record<string, Field> = {};
  for (const [k, f] of Object.entries(config.value.fields)) fields[k === name ? next : k] = f;
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config.value.values)) values[k === name ? next : k] = v;
  commitFields(t('重命名参数 {name} 为 {next}', { name, next }), fields, values);
}

// ------------------------------------------------------------------ function inputs
const FUNCTION_NAME_ERROR = () => t('函数输入名必须是标识符（字母、数字、下划线，不能以数字开头）');
/** The module wired into a function input, for the "who supplies it" column. */
function supplierOf(port: string): string | null {
  void wb.version.value;
  const p = wb.graph.producers(props.nodeId, port)[0];
  return p ? wb.graph.node(p.node)?.title ?? p.node : null;
}
const newFunction = ref('');
function addFunction() {
  const name = newFunction.value.trim();
  if (!FUNCTION_INPUT_NAME.test(name)) { declError.value = FUNCTION_NAME_ERROR(); return; }
  if (config.value.functions.includes(name)) { declError.value = t('函数输入 {name} 已存在', { name }); return; }
  if (config.value.functions.length >= MAX_FUNCTION_INPUTS) { declError.value = t('最多 {max} 个函数输入', { max: MAX_FUNCTION_INPUTS }); return; }
  if (commitFunctions(t('新增函数输入 {name}', { name }), [...config.value.functions, name])) newFunction.value = '';
}
function removeFunction(name: string) {
  commitFunctions(t('删除函数输入 {name}', { name }), config.value.functions.filter(n => n !== name));
}
function renameFunction(name: string, raw: string) {
  const next = raw.trim();
  if (next === name) return;
  if (!FUNCTION_INPUT_NAME.test(next)) { declError.value = FUNCTION_NAME_ERROR(); return; }
  if (config.value.functions.includes(next)) { declError.value = t('函数输入 {name} 已存在', { name: next }); return; }
  commitFunctions(t('重命名函数输入 {name} 为 {next}', { name, next }), config.value.functions.map(n => (n === name ? next : n)));
}

// ------------------------------------------------------------------ YAML: `{ fields, functions }`
function toYAML(c: Config): string {
  const doc = new YAML.Document({ fields: c.fields, functions: c.functions });
  const fields = doc.get('fields', true) as YAML.YAMLMap<unknown, YAML.YAMLMap>;
  for (const item of fields.items) if (item.value) item.value.flow = true;
  (doc.get('functions', true) as YAML.YAMLSeq).flow = true;
  return doc.toString({ lineWidth: 0 });
}
/** Parse and validate YAML text → the declaration, or a message. */
function fromYAML(text: string): { fields: Record<string, Field>; functions: string[] } | string {
  let raw: unknown;
  try { raw = YAML.parse(text); } catch (e) { return t('YAML 解析失败：{message}', { message: (e as Error).message }); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return t('声明必须是含 fields 与 functions 的对象');
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (key !== 'fields' && key !== 'functions') return t('声明含未知字段 {key}', { key });
  const functions = (obj.functions ?? []) as string[];
  if (Array.isArray(functions)) {
    const bad = functions.find(n => typeof n !== 'string' || !FUNCTION_INPUT_NAME.test(n));
    if (bad !== undefined) return `${String(bad)}: ${FUNCTION_NAME_ERROR()}`;
    const dup = functions.find((n, i) => functions.indexOf(n) !== i);
    if (dup !== undefined) return t('函数输入 {name} 已存在', { name: String(dup) });
  }
  try {
    const checked = validateConfig('params', { fields: obj.fields ?? {}, functions, values: {} }) as unknown as Config;
    return { fields: checked.fields, functions: checked.functions };
  } catch (e) { return (e as Error).message; }
}
const yaml = (() => {
  const stored = computed(() => toYAML(config.value));
  const text = ref(stored.value);
  const dirty = ref(false);
  watch(stored, v => { if (!dirty.value) text.value = v; });            // visual edits, undo: follow unless the user types
  const parsed = computed(() => (dirty.value ? fromYAML(text.value) : null));
  const error = computed(() => (typeof parsed.value === 'string' ? parsed.value : null));
  function reset() { text.value = stored.value; dirty.value = false; }
  function onInput(e: Event) { text.value = (e.target as HTMLTextAreaElement).value; dirty.value = text.value !== stored.value; }
  /** Apply the typed YAML. Returns false (dialog stays open) while it is invalid. */
  function apply(): boolean {
    if (!dirty.value) return true;
    const p = parsed.value;
    if (!p || typeof p === 'string') return false;
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config.value.values)) if (p.fields[k] && p.fields[k].type === config.value.fields[k]?.type) values[k] = v;
    if (!commit(t('用 YAML 修改参数声明'), p.fields, p.functions, values)) return false;
    reset();
    return true;
  }
  function onKeydown(e: KeyboardEvent) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); } }
  return { text, dirty, error, onInput, apply, onKeydown };
})();

// ------------------------------------------------------------------ dialog
const dialog = ref<HTMLDialogElement | null>(null);
onMounted(() => dialog.value?.showModal());
/** Closing applies YAML the user typed but did not apply yet. Invalid YAML keeps the dialog open. */
function requestClose(e?: Event) {
  e?.preventDefault();
  if (!yaml.apply()) return;
  emit('close');
}
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="pdecl" :aria-label="t('参数声明：{title}', { title })" @cancel="requestClose($event)" @keydown.stop @pointerdown.stop @wheel.stop>
      <header class="pdecl-head">
        <h2>{{ t('参数声明：{title}', { title }) }}</h2>
        <button type="button" class="mini" :aria-label="t('关闭')" @click="requestClose()">×</button>
      </header>
      <div class="pdecl-main">
        <section class="pdecl-visual" :aria-label="t('可视化编辑')">
          <h3>{{ t('参数（{n}）', { n: names.length }) }}</h3>
          <p class="bhint">{{ t('最小、最大可以写数，也可以写引用其他参数的表达式，例如 grid - 1。枚举取值写逗号列表，或写 “= 表达式”。表达式按当前值求值。越界的参数会报错，并阻止生成训练快照。') }}</p>
          <div class="cform">
            <div v-for="name in names" :key="name" class="pf-decl">
              <input type="text" :value="name" spellcheck="false" :aria-label="t('参数名')" :title="t('参数名（标识符）')" @change="renameField(name, ($event.target as HTMLInputElement).value)" />
              <select :value="config.fields[name].type" :aria-label="t('参数类型')" @change="setType(name, ($event.target as HTMLSelectElement).value as Field['type'])">
                <option v-for="ty in FIELD_TYPES" :key="ty" :value="ty">{{ ty }}</option>
              </select>
              <input type="text" :value="config.fields[name].label ?? ''" :placeholder="t('标签')" :aria-label="t('参数 {name} 的标签', { name })" @change="patchField(name, { label: ($event.target as HTMLInputElement).value.trim() || undefined })" />
              <button type="button" class="mini" :aria-label="t('删除参数 {name}', { name })" :title="t('删除参数及其取值')" @click="removeField(name)">×</button>
              <div class="pf-full">
                <template v-if="config.fields[name].type === 'int' || config.fields[name].type === 'number'">
                  <label>{{ t('最小') }}<input type="text" class="pdecl-expr" :value="config.fields[name].min ?? ''" :placeholder="t('数或表达式')" spellcheck="false" @change="setBound(name, 'min', ($event.target as HTMLInputElement).value)" /></label>
                  <label>{{ t('最大') }}<input type="text" class="pdecl-expr" :value="config.fields[name].max ?? ''" :placeholder="t('数或表达式')" spellcheck="false" @change="setBound(name, 'max', ($event.target as HTMLInputElement).value)" /></label>
                  <label>{{ t('默认') }}<input type="number" :value="config.fields[name].default" :step="config.fields[name].type === 'int' ? 1 : 'any'" @change="setDefault(name, ($event.target as HTMLInputElement).value)" /></label>
                </template>
                <template v-else-if="config.fields[name].type === 'enum'">
                  <label class="bgrow">{{ t('取值') }}<input type="text" class="pdecl-expr" :value="valuesText(config.fields[name])" :placeholder="t('逗号分隔，或 = 表达式')" spellcheck="false" @change="setValues(name, ($event.target as HTMLInputElement).value)" /></label>
                  <label>{{ t('默认') }}<select :value="config.fields[name].default" @change="setDefault(name, ($event.target as HTMLSelectElement).value)"><option v-for="v in constraints[name]?.values ?? []" :key="v" :value="v">{{ v }}</option></select></label>
                </template>
                <label v-else-if="config.fields[name].type === 'boolean'">{{ t('默认') }}<input type="checkbox" :checked="config.fields[name].default === true" @change="setDefault(name, ($event.target as HTMLInputElement).checked)" /></label>
                <label v-else class="bgrow">{{ t('默认') }}<input type="text" :value="config.fields[name].default" spellcheck="false" @change="setDefault(name, ($event.target as HTMLInputElement).value)" /></label>
                <div v-if="constraints[name]?.errors.length" class="bproblem pf-full-row">{{ constraints[name].errors.join('\n') }}</div>
                <div v-else-if="typeof config.fields[name].min === 'string' || typeof config.fields[name].max === 'string' || typeof config.fields[name].values === 'string'" class="bhint pf-full-row">{{ t('当前：{range}', { range: currentRange(name) }) }}</div>
              </div>
            </div>
            <div class="brow">
              <input v-model="newField" type="text" :placeholder="t('新参数名')" spellcheck="false" :aria-label="t('新参数名')" @keydown.enter.prevent="addField" />
              <button type="button" class="mini" @click="addField">{{ t('＋ 参数') }}</button>
            </div>
          </div>

          <h3>{{ t('函数输入（{n}）', { n: config.functions.length }) }}</h3>
          <p class="bhint">{{ t('每个函数输入是左侧的一个 ƒ 端口，接一个 fn(params) → record 的函数。函数返回的每个键（例如 actions）都显示为计算结果，不约束任何参数。如果两个函数输入返回同一个键，会报错。') }}</p>
          <div class="cform">
            <div v-for="name in config.functions" :key="name" class="pdecl-fn">
              <input type="text" :value="name" spellcheck="false" :aria-label="t('函数输入名')" @change="renameFunction(name, ($event.target as HTMLInputElement).value)" />
              <span class="pdecl-supplier" :class="{ none: !supplierOf(name) }">{{ supplierOf(name) ? `← ${supplierOf(name)}` : t('未接') }}</span>
              <button type="button" class="mini" :aria-label="t('删除函数输入 {name}', { name })" :title="t('删除函数输入及其连线')" @click="removeFunction(name)">×</button>
            </div>
            <div class="brow">
              <input v-model="newFunction" type="text" :placeholder="t('新函数输入名')" spellcheck="false" :aria-label="t('新函数输入名')" @keydown.enter.prevent="addFunction" />
              <button type="button" class="mini" @click="addFunction">{{ t('＋ 函数输入') }}</button>
            </div>
          </div>
          <div v-if="declError" class="bproblem" role="alert">{{ declError }}</div>
        </section>

        <section class="pdecl-yaml" aria-label="YAML">
          <h3>YAML <span v-if="yaml.dirty.value" class="bhint">{{ yaml.error.value ? t('有错误，未应用') : t('未应用：失焦或 Ctrl / ⌘ Enter 应用') }}</span></h3>
          <textarea class="pdecl-src" :class="{ bad: !!yaml.error.value }" :value="yaml.text.value" spellcheck="false" :aria-label="t('参数声明 YAML')" @input="yaml.onInput" @blur="yaml.apply()" @keydown="yaml.onKeydown"></textarea>
          <div v-if="yaml.error.value" class="bproblem" role="alert">{{ yaml.error.value }}</div>
        </section>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.pdecl{width:min(1100px,92vw);height:min(760px,86vh);max-width:none;max-height:none;padding:0;border:1px solid var(--line-strong);border-radius:10px;background:var(--panel);color:var(--ink);box-shadow:0 24px 64px -16px rgba(0,0,0,.9);font-size:12px}
.pdecl[open]{display:flex;flex-direction:column}
.pdecl::backdrop{background:rgba(0,0,0,.55)}
.pdecl-head{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 8px 0 14px;border-bottom:1px solid var(--line);background:var(--panel-head)}
.pdecl-head h2{margin:0;flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdecl-main{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.pdecl-visual,.pdecl-yaml{min-width:0;min-height:0;padding:10px 14px;display:flex;flex-direction:column;gap:6px}
.pdecl-visual{overflow:auto;border-right:1px solid var(--line)}
h3{margin:6px 0 2px;font-size:12px;font-weight:600;display:flex;gap:8px;align-items:baseline}
h3:first-child{margin-top:0}
/* the dialog has room the node body did not: wider name / type columns, range and default inputs share one row */
.pdecl .pf-decl{grid-template-columns:minmax(0,10em) 7.5em minmax(0,1fr) auto;padding:4px 0;border-bottom:1px solid var(--line)}
.pdecl .pf-decl .pf-full label{flex:1 1 8em;min-width:0}
.pdecl .pf-decl .pf-full label input,.pdecl .pf-decl .pf-full label select{flex:1 1 auto;width:100%;min-width:0}
.pdecl .pf-decl .pf-full input.pdecl-expr{font-family:var(--mono)}
.pdecl .pf-decl .pf-full .pf-full-row{flex-basis:100%}
.pdecl-fn{display:grid;grid-template-columns:minmax(0,10em) minmax(0,1fr) auto;gap:5px;align-items:center;min-width:0}
.pdecl-fn input{width:100%;min-width:0;font-family:var(--mono)}
.pdecl-supplier{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdecl-supplier.none{color:var(--muted)}
.pdecl-src{flex:1;min-height:0;width:100%;resize:none;font-family:var(--mono);font-size:12px;line-height:1.5;tab-size:2;white-space:pre;overflow:auto;padding:6px 8px}
.pdecl-src.bad{border-color:var(--bad)}
</style>
