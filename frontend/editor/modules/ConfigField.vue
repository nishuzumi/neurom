<script lang="ts">
// ConfigField.vue — one registry schema descriptor (frontend/core/registry.js) rendered as a form control. Scalars
// edit in place. `object` nests a fieldset. A list of scalars is a comma-separated line. `map` / `json` and lists of
// objects (or of `oneOf` items) are JSON text. Invalid text never reaches the graph: the field shows why and keeps the
// last good value.
import { t } from '../../i18n.js';

export interface Descriptor {
  type: 'int' | 'number' | 'boolean' | 'string' | 'enum' | 'list' | 'object' | 'map' | 'json' | 'oneOf';
  label?: string; optional?: boolean; min?: number; max?: number; pattern?: string; values?: (string | number)[];
  of?: Descriptor | Descriptor[]; fields?: Record<string, Descriptor>;
}

const SCALAR = new Set(['int', 'number', 'boolean', 'string', 'enum']);
const isScalarList = (d: Descriptor) => d.type === 'list' && !!d.of && !Array.isArray(d.of) && SCALAR.has(d.of.type) && d.of.type !== 'boolean';

/** Why `v` violates a scalar descriptor, or '' when it fits (mirrors registry.js checkField for the UI). */
function scalarProblem(d: Descriptor, v: unknown): string {
  if (v === null || v === undefined) return d.optional ? '' : t('缺少必填项');
  switch (d.type) {
    case 'int': if (!Number.isSafeInteger(v)) return t('必须是整数'); break;
    case 'number': if (typeof v !== 'number' || !Number.isFinite(v)) return t('必须是有限数'); break;
    case 'boolean': return typeof v === 'boolean' ? '' : t('必须是布尔值');
    case 'string':
      if (typeof v !== 'string') return t('必须是字符串');
      if (d.pattern && !new RegExp(d.pattern).test(v)) return t('格式不正确');
      if (d.max !== undefined && v.length > d.max) return t('长度不能超过 {max}', { max: d.max });
      return '';
    case 'enum': return d.values?.includes(v as string | number) ? '' : t('必须是 {values} 之一', { values: (d.values ?? []).join(' / ') });
    default: return '';
  }
  const n = v as number;
  if ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)) return t('必须在 {min}..{max} 之间', { min: d.min ?? '-∞', max: d.max ?? '∞' });
  return '';
}
/** Parse one scalar from text (numbers/enums/strings). Returns { value } or { error }. */
function parseScalar(d: Descriptor, text: string): { value?: unknown; error?: string } {
  const s = text.trim();
  if (s === '') return d.optional ? { value: null } : { error: t('缺少必填项') };
  let value: unknown = s;
  if (d.type === 'int' || d.type === 'number') { value = Number(s); if (!Number.isFinite(value as number)) return { error: t('必须是有限数') }; }
  if (d.type === 'enum') value = d.values?.find(v => String(v) === s) ?? s;      // a select's text back to the value (numeric enums: weightBits)
  const error = scalarProblem(d, value);
  return error ? { error } : { value };
}
export const labelOf = (key: string, d: Descriptor) => (d.label ? t(d.label) : key);
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

const props = defineProps<{ name: string; desc: Descriptor; value: unknown; disabled?: boolean; problem?: string | null }>();
const emit = defineEmits<{ (e: 'change', value: unknown): void }>();

const label = computed(() => labelOf(props.name, props.desc));
const error = ref<string | null>(null);
const inputId = `cf-${Math.random().toString(36).slice(2, 9)}`;

// text-backed controls keep a local buffer so a half-typed number does not reach the graph
const text = ref('');
const asText = (v: unknown): string => {
  const d = props.desc;
  if (d.type === 'list' && isScalarList(d)) return Array.isArray(v) ? v.map(x => String(x)).join(', ') : '';
  if (d.type === 'map' || d.type === 'json' || d.type === 'list') return v === undefined ? '' : JSON.stringify(v, null, d.type === 'list' && Array.isArray(v) && v.length < 8 ? 0 : 1);
  return v === null || v === undefined ? '' : String(v);
};
watch(() => props.value, v => { text.value = asText(v); error.value = null; }, { immediate: true });

function commitScalar(raw: string) {
  const parsed = parseScalar(props.desc, raw);
  if (parsed.error) { error.value = parsed.error; return; }
  error.value = null;
  if (parsed.value !== props.value) emit('change', parsed.value);
}
function commitList(raw: string) {
  const d = props.desc, of = d.of as Descriptor;                      // a scalar list (isScalarList)
  const parts = raw.split(/[,\s，]+/).filter(Boolean);
  const out: unknown[] = [];
  for (const part of parts) { const p = parseScalar(of, part); if (p.error) { error.value = t('{item}：{problem}', { item: part, problem: p.error }); return; } out.push(p.value); }
  if ((d.min !== undefined && out.length < d.min) || (d.max !== undefined && out.length > d.max)) { error.value = t('数组长度必须在 {min}..{max} 之间', { min: d.min ?? 0, max: d.max ?? '∞' }); return; }
  error.value = null;
  if (JSON.stringify(out) !== JSON.stringify(props.value)) emit('change', out);
}
function commitJson(raw: string) {
  const s = raw.trim();
  if (s === '') { if (props.desc.optional) { error.value = null; emit('change', null); } else error.value = t('缺少必填项'); return; }
  let parsed: unknown;
  try { parsed = JSON.parse(s); } catch (e) { error.value = t('不是合法 JSON：{error}', { error: (e as Error).message }); return; }
  const d = props.desc;
  if (d.type === 'list' && !Array.isArray(parsed)) { error.value = t('必须是数组'); return; }
  if (d.type === 'map' && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) { error.value = t('必须是对象'); return; }
  error.value = null;
  if (JSON.stringify(parsed) !== JSON.stringify(props.value)) emit('change', parsed);
}
function childChange(key: string, v: unknown) {
  const base = props.value && typeof props.value === 'object' ? (props.value as Record<string, unknown>) : {};
  emit('change', { ...base, [key]: v });
}
const shown = computed(() => props.problem || error.value);
const numberStep = computed(() => (props.desc.type === 'int' ? 1 : 'any'));
const objectFields = computed(() => Object.entries(props.desc.fields ?? {}));
const objectValue = computed(() => (props.value && typeof props.value === 'object' ? (props.value as Record<string, unknown>) : {}));
/** the numeric range shown inside the field ('' for other types). Its length reserves room in the input (--rn) */
const range = computed(() => {
  const d = props.desc;
  if (d.type !== 'int' && d.type !== 'number') return '';
  return d.min === undefined && d.max === undefined ? '' : `${d.min ?? ''}..${d.max ?? ''}`;
});
</script>

<template>
  <fieldset v-if="desc.type === 'object'" class="cf-object" :disabled="disabled">
    <legend class="cf-legend">{{ label }}</legend>
    <ConfigField v-for="[k, d] in objectFields" :key="k" :name="k" :desc="d" :value="objectValue[k]" :disabled="disabled" @change="childChange(k, $event)" />
    <div v-if="shown" class="cf-error" role="alert">{{ shown }}</div>
  </fieldset>
  <div v-else class="cf-row" :class="{ bad: !!shown, bool: desc.type === 'boolean', 'cf-block': desc.type === 'map' || desc.type === 'json' || (desc.type === 'list' && !isScalarList(desc)) }" :style="range ? { '--rn': range.length } : undefined">
    <label class="cf-label" :for="inputId" :title="name">{{ label }}</label>
    <input v-if="desc.type === 'boolean'" :id="inputId" type="checkbox" :checked="value === true" :disabled="disabled" @change="emit('change', ($event.target as HTMLInputElement).checked)" />
    <select v-else-if="desc.type === 'enum'" :id="inputId" :value="value ?? ''" :disabled="disabled" @change="commitScalar(($event.target as HTMLSelectElement).value)">
      <option v-if="desc.optional" value="">—</option>
      <option v-for="v in desc.values" :key="v" :value="v">{{ v }}</option>
    </select>
    <input v-else-if="desc.type === 'int' || desc.type === 'number'" :id="inputId" type="number" :value="text" :min="desc.min" :max="desc.max" :step="numberStep" :disabled="disabled"
      @input="text = ($event.target as HTMLInputElement).value" @change="commitScalar(($event.target as HTMLInputElement).value)" />
    <input v-else-if="desc.type === 'string'" :id="inputId" type="text" :value="text" :maxlength="desc.max" :disabled="disabled" spellcheck="false"
      @input="text = ($event.target as HTMLInputElement).value" @change="commitScalar(($event.target as HTMLInputElement).value)" />
    <input v-else-if="desc.type === 'list' && isScalarList(desc)" :id="inputId" type="text" :value="text" :disabled="disabled" spellcheck="false" :placeholder="t('逗号分隔')"
      @input="text = ($event.target as HTMLInputElement).value" @change="commitList(($event.target as HTMLInputElement).value)" />
    <textarea v-else :id="inputId" class="cf-json" rows="3" :value="text" :disabled="disabled" spellcheck="false" wrap="off"
      @input="text = ($event.target as HTMLTextAreaElement).value" @change="commitJson(($event.target as HTMLTextAreaElement).value)"></textarea>
    <span v-if="range" class="cf-range">{{ range }}</span>
    <div v-if="shown" class="cf-error" role="alert">{{ shown }}</div>
  </div>
</template>
