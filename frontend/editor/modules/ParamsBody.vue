<script setup lang="ts">
// ParamsBody.vue — the parameters module: a value form generated from `config.fields` (int / number / boolean / enum /
// string). Ranges and choices are the kind's effective constraints (params.js fieldConstraints). A constraint is a
// number / list as written, or a constraint expression over the current values such as `max: grid - 1` (ADR 0007).
// A value outside them shows here and is a problem of the module, which blocks bundling. The body calls the declared
// function inputs (`config.functions`, ADR 0006) with the values. Every key of their merged result (for example
// `actions`) shows as a computed value. Values commit through wb.edit → patchConfig({ values }). The body stores a
// value equal to its default as an override anyway, so a later default change does not move it. The user edits
// declarations (fields and function inputs) in a dialog. The ⚙ button in the module header (ParamsHead.vue) opens it.
import { computed, ref } from 'vue';
import * as ir from '../../ir/index.js';
import { fieldConstraints, fieldProblem, mergeOptions, paramsValue } from '../../core/kinds/params.js';
import { staticValue } from '../../core/bundle.js';
import { t } from '../../i18n.js';
import { useWorkbench } from '../workbench-context';
import { useNode } from './common';
import './bodies-a.css';

interface Field { type: 'int' | 'number' | 'boolean' | 'enum' | 'string'; label?: string; min?: number | string; max?: number | string; values?: string[] | string; default: unknown }
interface Config { fields: Record<string, Field>; values: Record<string, unknown>; functions: string[] }
interface Site { carries: { program: unknown; bound: Record<string, unknown> }; paramTypes: unknown[]; exact: boolean; node: { id: string } }

const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();

const { node, problems: nodeProblems } = useNode(wb, () => props.nodeId);
const config = computed<Config>(() => (node.value?.config ?? { fields: {}, values: {}, functions: [] }) as unknown as Config);
const names = computed(() => Object.keys(config.value.fields));
const effective = computed(() => paramsValue(config.value) as Record<string, unknown>);
const labelOf = (name: string) => (config.value.fields[name].label ? t(config.value.fields[name].label!) : name);

// ------------------------------------------------------------------ function inputs: derived values from the wired code modules
const options = computed<{ result: Record<string, unknown>; errors: { port: string; message: string }[] }>(() => {
  void wb.version.value;
  const res = wb.resolution();
  const entries: [string, Record<string, unknown>][] = [], errors: { port: string; message: string }[] = [];
  for (const port of new Set(config.value.functions)) {
    if (!wb.graph.producers(props.nodeId, port).length) continue;
    const site = res.callSite(props.nodeId, port) as Site | null;
    if (!site) {
      const problem = res.problemsOf(props.nodeId).find(p => p.port === port);
      errors.push({ port, message: problem?.message ?? t('{port} 尚不可用', { port }) });
      continue;
    }
    try {
      const args: unknown[] = [effective.value];
      for (const name of Object.keys(site.carries.bound)) {
        const p = wb.graph.producers(site.node.id, name)[0];
        args.push(staticValue(wb.graph, res, p.node, p.port));
      }
      entries.push([port, ir.compile(site.carries.program, site.paramTypes, { exact: site.exact }).run(...args) as Record<string, unknown>]);
    } catch (e) { errors.push({ port, message: (e as Error).message }); }
  }
  return { result: mergeOptions(entries).result as Record<string, unknown>, errors };
});
/** Effective constraints (static or expression, evaluated over the current values) — the same ones the kind checks. */
const constraints = computed(() => fieldConstraints(config.value) as Record<string, { min?: number; max?: number; values?: string[]; errors: string[] }>);
const constraintOf = (name: string) => constraints.value[name] ?? { errors: [] };
/** Every key of the function inputs' merged result is a computed value. None constrains a field (ADR 0007). */
const extras = computed(() => Object.entries(options.value.result ?? {}).filter(([k]) => !Object.hasOwn(config.value.fields, k)));
function problemOf(name: string): string {
  const c = constraintOf(name);
  return c.errors[0] ?? fieldProblem(config.value.fields[name], effective.value[name], c);
}

// ------------------------------------------------------------------ values
const rejected = ref<Record<string, string>>({});
function setValue(name: string, raw: unknown) {
  const f = config.value.fields[name];
  let v = raw;
  if (f.type === 'int' || f.type === 'number') {
    const s = String(raw).trim();
    if (s === '') { rejected.value = { ...rejected.value, [name]: t('缺少必填项') }; return; }
    v = Number(s);
  }
  const problem = fieldProblem(f, v, { values: constraintOf(name).values });     // type only: a range may depend on fields set later
  if (problem) { rejected.value = { ...rejected.value, [name]: problem }; return; }
  const { [name]: _, ...rest } = rejected.value; rejected.value = rest;
  if (v === effective.value[name] && Object.hasOwn(config.value.values, name)) return;
  wb.edit(t('设置参数 {name}', { name: labelOf(name) }), () => wb.graph.patchConfig(props.nodeId, { values: { ...config.value.values, [name]: v } }));
}
function resetValue(name: string) {
  const { [name]: _, ...values } = config.value.values;
  wb.edit(t('恢复参数 {name} 的默认值', { name: labelOf(name) }), () => wb.graph.patchConfig(props.nodeId, { values }));
}
const overridden = (name: string) => Object.hasOwn(config.value.values, name);

// ------------------------------------------------------------------ range hints
const fmt = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
/** `max = grid - 1` lines for the keys written as expressions, or '' when the field has none. */
function expressionsOf(name: string): string {
  const f = config.value.fields[name];
  return (['min', 'max', 'values'] as const).filter(k => typeof f[k] === 'string').map(k => `${k} = ${f[k] as string}`).join('\n');
}
function rangeTitle(name: string): string {
  const d = fmt(config.value.fields[name].default);
  const head = overridden(name) ? t('已修改。点击恢复默认值 {value}', { value: d }) : t('默认值 {value}', { value: d });
  const exprs = expressionsOf(name);
  return exprs ? `${head}\n${exprs}` : head;
}
const numeric = (name: string) => config.value.fields[name].type === 'int' || config.value.fields[name].type === 'number';
/** the range shown inside a numeric field. With the ↺ reset, its length reserves room in the input (--rn) */
const rangeText = (name: string) => (numeric(name) ? `${constraintOf(name).min ?? ''}..${constraintOf(name).max ?? ''}` : '');
const rangeRoom = (name: string) => rangeText(name).length + (overridden(name) ? 4 : 0);
</script>

<template>
  <div class="body pf-form" @keydown.stop>
    <div v-if="!names.length" class="bhint">{{ t('还没有参数。点标题栏的 ⚙ 新增参数。') }}</div>
    <div v-for="name in names" :key="name" class="pf-row" :class="{ bad: !!(rejected[name] || problemOf(name)), changed: overridden(name), bool: config.fields[name].type === 'boolean' }" :style="{ '--rn': rangeRoom(name) }">
      <label class="pf-label" :for="`pf-${nodeId}-${name}`" :title="name + (config.fields[name].label ? ' · ' + name : '')">{{ labelOf(name) }}</label>
      <input v-if="config.fields[name].type === 'boolean'" :id="`pf-${nodeId}-${name}`" type="checkbox" :checked="effective[name] === true" @change="setValue(name, ($event.target as HTMLInputElement).checked)" />
      <select v-else-if="config.fields[name].type === 'enum' || constraintOf(name).values" :id="`pf-${nodeId}-${name}`" :value="effective[name]" @change="setValue(name, ($event.target as HTMLSelectElement).value)">
        <option v-if="!(constraintOf(name).values ?? []).includes(effective[name] as string)" :value="effective[name]">{{ effective[name] }}</option>
        <option v-for="v in constraintOf(name).values" :key="v" :value="v">{{ v }}</option>
      </select>
      <input v-else-if="config.fields[name].type === 'string'" :id="`pf-${nodeId}-${name}`" type="text" :value="effective[name]" spellcheck="false" @change="setValue(name, ($event.target as HTMLInputElement).value)" />
      <input v-else :id="`pf-${nodeId}-${name}`" type="number" :value="effective[name]" :min="constraintOf(name).min" :max="constraintOf(name).max" :step="config.fields[name].type === 'int' ? 1 : 'any'" @change="setValue(name, ($event.target as HTMLInputElement).value)" />
      <span class="pf-range" :class="{ dyn: !!expressionsOf(name) }" :title="rangeTitle(name)">
        <template v-if="numeric(name)">{{ rangeText(name) }}</template>
        <button v-if="overridden(name)" type="button" class="mini" :aria-label="t('恢复参数 {name} 的默认值', { name: labelOf(name) })" @click="resetValue(name)">↺</button>
      </span>
      <div v-if="rejected[name] || problemOf(name)" class="pf-error" role="alert">{{ rejected[name] || problemOf(name) }}</div>
    </div>
    <div v-for="[k, v] in extras" :key="k" class="pf-row pf-computed" :title="t('函数输入计算出的字段')">
      <span class="pf-label">{{ k }}</span>
      <ol v-if="Array.isArray(v)" class="pf-list">
        <li v-for="(x, i) in v" :key="i"><span class="pf-idx">{{ i }}</span>{{ fmt(x) }}</li>
      </ol>
      <span v-else class="pf-value">{{ fmt(v) }}</span>
      <span class="pf-range">ƒ</span>
    </div>
    <div v-if="options.errors.length" class="bhint">
      <div v-for="e in options.errors" :key="e.port">{{ t('{port}：{error}', { port: e.port, error: e.message }) }}</div>
    </div>
    <div v-for="(p, i) in nodeProblems" :key="i" class="bproblem" :class="{ incomplete: p.incomplete }">{{ p.message }}</div>
  </div>
</template>
