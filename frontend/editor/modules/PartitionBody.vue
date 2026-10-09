<script setup lang="ts">
// PartitionBody.vue — the partition module: pick the split kind (seed / enumerate / window), edit its form and see
// how many episodes each role gets (core/kinds/partition.js partitionEpisodes). Window partitions read the row count
// of the dataset wired into `table`. The bar shows the three ranges and the embargo skipped at each later split.
import { computed, ref } from 'vue';
import { partitionEpisodes, ROLES } from '../../core/kinds/partition.js';
import { t } from '../../i18n.js';
import { useWorkbench } from '../workbench-context';
import { ROLE_LABEL, useNode } from './common';
import { usePatch } from './body-utils';
import './bodies-a.css';

type Role = 'training' | 'validation' | 'test';
interface Config {
  kind: 'seed' | 'enumerate' | 'window';
  seed: Record<Role, { seed: number; count: number }>;
  enumerate: { axes: Record<string, unknown[]>; roles: Record<Role, 'all' | 'even' | 'odd' | number[]> };
  window: { length: number; stride: number; embargo: number; splits: Partial<Record<Role, [number, number]>> };
}
const KIND_LABEL = { seed: '种子区间', enumerate: '枚举组合', window: '时间窗' } as const;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();
const { node, problems } = useNode(wb, () => props.nodeId);
const cfg = computed(() => node.value?.config as unknown as Config | undefined);
const roles = ROLES as readonly Role[];

/** rows of the wired table (dataset node config) — what window episodes are counted over */
const rows = computed(() => {
  void wb.version.value;
  const p = wb.graph.producers(props.nodeId, 'table')[0];
  if (!p) return null;
  const src = wb.graph.node(p.node);
  return src?.kind === 'dataset' ? Number(src.config.rows ?? 0) : null;
});
const counts = computed<Record<Role, number | string>>(() => {
  const out = {} as Record<Role, number | string>;
  for (const role of roles) {
    try { out[role] = cfg.value ? partitionEpisodes(cfg.value, role, { rows: rows.value ?? 0 }).length : 0; } catch (e) { out[role] = (e as Error).message; }
  }
  return out;
});
const total = computed(() => { const c = cfg.value; if (!c || c.kind !== 'enumerate') return 0; return Object.values(c.enumerate.axes).reduce((n, v) => n * v.length, 1); });
/** the per-role episode counts: a seed partition's are the counts typed above, so they show only when one fails */
const showCounts = computed(() => cfg.value?.kind !== 'seed' || roles.some(r => typeof counts.value[r] === 'string'));
const { error, patch } = usePatch(() => props.nodeId);
const int = (raw: string) => { const n = Number(raw); return Number.isSafeInteger(n) ? n : null; };
function setKind(kind: Config['kind']) { patch(t('切换分区方式为 {kind}', { kind: t(KIND_LABEL[kind]) }), { kind }); }
function setSeed(role: Role, key: 'seed' | 'count', raw: string) {
  const n = int(raw); if (n === null) { error.value = t('必须是整数'); return; }
  const c = cfg.value!;
  patch(t('修改 {role} 分区的 {key}', { role: t(ROLE_LABEL[role]), key }), { seed: { ...c.seed, [role]: { ...c.seed[role], [key]: n } } });
}
function setWindow(key: 'length' | 'stride' | 'embargo', raw: string) {
  const n = int(raw); if (n === null) { error.value = t('必须是整数'); return; }
  patch(t('修改时间窗的 {key}', { key }), { window: { ...cfg.value!.window, [key]: n } });
}
function setSplit(role: Role, i: 0 | 1, raw: string) {
  const n = Number(raw); if (!Number.isFinite(n)) { error.value = t('必须是有限数'); return; }
  const c = cfg.value!, cur = c.window.splits[role] ?? [0, 0];
  const next: [number, number] = i === 0 ? [n, cur[1]] : [cur[0], n];
  patch(t('修改 {role} 分区的区间', { role: t(ROLE_LABEL[role]) }), { window: { ...c.window, splits: { ...c.window.splits, [role]: next } } });
}
function toggleSplit(role: Role, on: boolean) {
  const c = cfg.value!, splits = { ...c.window.splits };
  if (on) splits[role] = [0, 1]; else delete splits[role];
  patch(t('修改 {role} 分区的区间', { role: t(ROLE_LABEL[role]) }), { window: { ...c.window, splits } });
}
// enumerate: axes are `name: v1, v2, …` (numbers when every value parses, booleans for true/false, else strings)
function parseAxis(raw: string): unknown[] {
  const parts = raw.split(/[,\s，]+/).filter(Boolean);
  if (parts.every(p => p === 'true' || p === 'false')) return parts.map(p => p === 'true');
  if (parts.every(p => p !== '' && Number.isFinite(Number(p)))) return parts.map(Number);
  return parts;
}
const newAxis = ref('');
function addAxis() {
  const name = newAxis.value.trim();
  if (!IDENTIFIER.test(name)) { error.value = t('轴名必须是标识符'); return; }
  const c = cfg.value!;
  if (name in c.enumerate.axes) { error.value = t('轴 {name} 已存在', { name }); return; }
  patch(t('新增枚举轴 {name}', { name }), { enumerate: { ...c.enumerate, axes: { ...c.enumerate.axes, [name]: [0, 1] } } });
  newAxis.value = '';
}
function setAxis(name: string, raw: string) {
  const values = parseAxis(raw);
  if (!values.length) { error.value = t('轴 {name} 至少需要一个取值', { name }); return; }
  const c = cfg.value!;
  patch(t('修改枚举轴 {name}', { name }), { enumerate: { ...c.enumerate, axes: { ...c.enumerate.axes, [name]: values } } });
}
function removeAxis(name: string) {
  const c = cfg.value!, { [name]: _, ...axes } = c.enumerate.axes;
  patch(t('删除枚举轴 {name}', { name }), { enumerate: { ...c.enumerate, axes } });
}
const roleSel = (role: Role) => { const s = cfg.value!.enumerate.roles[role]; return Array.isArray(s) ? 'indices' : s; };
const roleIndices = (role: Role) => { const s = cfg.value!.enumerate.roles[role]; return Array.isArray(s) ? s.join(', ') : ''; };
function setRoleSel(role: Role, sel: string) {
  const c = cfg.value!;
  const value = sel === 'indices' ? (Array.isArray(c.enumerate.roles[role]) ? c.enumerate.roles[role] : []) : sel;
  patch(t('修改 {role} 分区的选择', { role: t(ROLE_LABEL[role]) }), { enumerate: { ...c.enumerate, roles: { ...c.enumerate.roles, [role]: value } } });
}
function setRoleIndices(role: Role, raw: string) {
  const idx = raw.split(/[,\s，]+/).filter(Boolean).map(Number);
  if (!idx.every(i => Number.isInteger(i) && i >= 0)) { error.value = t('下标必须是非负整数'); return; }
  const c = cfg.value!;
  patch(t('修改 {role} 分区的选择', { role: t(ROLE_LABEL[role]) }), { enumerate: { ...c.enumerate, roles: { ...c.enumerate.roles, [role]: idx } } });
}
const axisText = (values: unknown[]) => values.map(v => String(v)).join(', ');
/** window bar segments as percentages: [role, from, to] sorted. Embargo drawn at the start of every split but the first */
const segments = computed(() => {
  const c = cfg.value; if (!c || c.kind !== 'window') return [];
  const list = roles.filter(r => c.window.splits[r]).map(r => ({ role: r, from: c.window.splits[r]![0], to: c.window.splits[r]![1] })).sort((a, b) => a.from - b.from);
  const n = rows.value ?? 0, emb = n ? c.window.embargo / n : 0;
  return list.map((s, i) => ({ ...s, embargo: i > 0 ? Math.min(emb, s.to - s.from) : 0 }));
});
</script>

<template>
  <div v-if="cfg" class="body" @keydown.stop>
    <div class="pt-form">
      <label class="pt-role" :for="`${nodeId}-kind`">{{ t('切法') }}</label>
      <select :id="`${nodeId}-kind`" class="pt-span" :value="cfg.kind" @change="setKind(($event.target as HTMLSelectElement).value as any)">
        <option v-for="(label, k) in KIND_LABEL" :key="k" :value="k">{{ t(label) }}</option>
      </select>
      <span v-if="cfg.kind === 'window'" class="bhint pt-span">{{ rows === null ? t('未接数据表，所以行数按 0 计') : t('数据表 {rows} 行', { rows }) }}</span>
      <template v-if="cfg.kind === 'seed'">
        <span></span><span class="bhint">{{ t('起始种子') }}</span><span class="bhint">{{ t('回合数') }}</span>
        <template v-for="role in roles" :key="role">
          <span class="pt-role">{{ t(ROLE_LABEL[role]) }}</span>
          <input type="number" min="0" max="4294967295" step="1" :value="cfg.seed[role].seed" :aria-label="t('{role} 起始种子', { role: t(ROLE_LABEL[role]) })" @change="setSeed(role, 'seed', ($event.target as HTMLInputElement).value)" />
          <input type="number" min="0" max="1000000" step="1" :value="cfg.seed[role].count" :aria-label="t('{role} 回合数', { role: t(ROLE_LABEL[role]) })" @change="setSeed(role, 'count', ($event.target as HTMLInputElement).value)" />
        </template>
      </template>
    </div>

    <template v-if="cfg.kind === 'enumerate'">
      <div v-for="(values, name) in cfg.enumerate.axes" :key="name" class="pt-axis">
        <span class="pt-role" :title="name">{{ name }}</span>
        <input type="text" :value="axisText(values)" spellcheck="false" :aria-label="t('轴 {name} 的取值', { name })" :title="t('用逗号分隔。如果全部是数字，就按数字处理。true/false 按布尔值处理。其他按字符串处理。')" @change="setAxis(name, ($event.target as HTMLInputElement).value)" />
        <button type="button" class="mini" :aria-label="t('删除轴 {name}', { name })" @click="removeAxis(name)">×</button>
      </div>
      <div class="brow">
        <input type="text" v-model="newAxis" :placeholder="t('新轴名')" spellcheck="false" :aria-label="t('新轴名')" @keydown.enter.prevent="addAxis" />
        <button type="button" class="mini" @click="addAxis">{{ t('＋ 轴') }}</button>
        <span class="bhint">{{ t('组合共 {n} 个', { n: total }) }}</span>
      </div>
      <div class="pt-roles">
        <template v-for="role in roles" :key="role">
          <span class="pt-role">{{ t(ROLE_LABEL[role]) }}</span>
          <span class="brow">
            <select :value="roleSel(role)" :aria-label="t('{role} 分区的选择', { role: t(ROLE_LABEL[role]) })" @change="setRoleSel(role, ($event.target as HTMLSelectElement).value)">
              <option value="all">{{ t('全部') }}</option><option value="even">{{ t('偶数下标') }}</option><option value="odd">{{ t('奇数下标') }}</option><option value="indices">{{ t('指定下标') }}</option>
            </select>
            <input v-if="roleSel(role) === 'indices'" type="text" :value="roleIndices(role)" spellcheck="false" :placeholder="t('例如 0, 3, 5')" :aria-label="t('{role} 分区的下标', { role: t(ROLE_LABEL[role]) })" @change="setRoleIndices(role, ($event.target as HTMLInputElement).value)" />
          </span>
        </template>
      </div>
    </template>

    <template v-else-if="cfg.kind === 'window'">
      <div class="brow">
        <label>{{ t('窗长') }}<input type="number" min="1" step="1" :value="cfg.window.length" @change="setWindow('length', ($event.target as HTMLInputElement).value)" /></label>
        <label>{{ t('步长') }}<input type="number" min="1" step="1" :value="cfg.window.stride" @change="setWindow('stride', ($event.target as HTMLInputElement).value)" /></label>
        <label :title="t('后续区间开头跳过的行数（隔离带）')">{{ t('隔离') }}<input type="number" min="0" step="1" :value="cfg.window.embargo" @change="setWindow('embargo', ($event.target as HTMLInputElement).value)" /></label>
      </div>
      <div class="pt-window">
        <span></span><span class="bhint">{{ t('起（比例）') }}</span><span class="bhint">{{ t('止（比例）') }}</span><span></span>
        <template v-for="role in roles" :key="role">
          <span class="pt-role">{{ t(ROLE_LABEL[role]) }}</span>
          <input type="number" min="0" max="1" step="0.01" :disabled="!cfg.window.splits[role]" :value="cfg.window.splits[role]?.[0] ?? ''" :aria-label="t('{role} 起', { role: t(ROLE_LABEL[role]) })" @change="setSplit(role, 0, ($event.target as HTMLInputElement).value)" />
          <input type="number" min="0" max="1" step="0.01" :disabled="!cfg.window.splits[role]" :value="cfg.window.splits[role]?.[1] ?? ''" :aria-label="t('{role} 止', { role: t(ROLE_LABEL[role]) })" @change="setSplit(role, 1, ($event.target as HTMLInputElement).value)" />
          <input type="checkbox" :checked="!!cfg.window.splits[role]" :aria-label="t('启用 {role} 分区', { role: t(ROLE_LABEL[role]) })" :title="t('启用这个角色的区间')" @change="toggleSplit(role, ($event.target as HTMLInputElement).checked)" />
        </template>
      </div>
      <div class="pt-bar" :title="t('区间示意（红色为隔离带）')">
        <template v-for="s in segments" :key="s.role">
          <span v-if="s.embargo" class="embargo" :style="{ width: `${s.embargo * 100}%` }"></span>
          <span :class="s.role" :style="{ width: `${Math.max(0, s.to - s.from - s.embargo) * 100}%` }"></span>
        </template>
      </div>
    </template>

    <div v-if="showCounts" class="pt-roles bsection">
      <template v-for="role in roles" :key="role">
        <span class="pt-role">{{ t(ROLE_LABEL[role]) }}</span>
        <span class="pt-count" :class="{ bad: typeof counts[role] === 'string' }">{{ typeof counts[role] === 'number' ? t('{n} 个回合', { n: counts[role] }) : counts[role] }}</span>
      </template>
    </div>
    <div v-if="error" class="bproblem" role="alert">{{ error }}</div>
    <div v-for="(p, i) in problems" :key="i" class="bproblem" :class="{ incomplete: p.incomplete }">{{ p.message }}</div>
  </div>
</template>
