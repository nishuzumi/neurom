<script setup lang="ts">
// EvaluatorBody.vue — the evaluator module. Pick the partition role and run the whole loop greedily on it (every
// network on its accepted weights). The body shows the metrics table and, when the evaluator groups by an enumerate
// axis, the grouped curve (success rate per axis value). It also shows which artifact each network ran and a sample of
// episodes. When the graph changes after a report, the body keeps the report shown and marks it stale (like an
// execution's running loop).
import { computed, shallowRef, watch } from 'vue';
import { useWorkbench } from '../workbench-context';
import { useSession, useAct, fmt, shortId } from './body-utils';
import { ROLE_LABEL as ROLE } from './common';
import ConfigForm from './ConfigForm.vue';
import SeriesRenderer from '../renderers/series.vue';
import TableRenderer from '../renderers/table.vue';
import { reportScope } from '../renderers/scope.js';
import { t } from '../../i18n.js';
import './bodies-a.css';
import './bodies-b.css';

const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();
const { session, snap } = useSession('evaluator', props.nodeId);
const { error, act } = useAct();

/** `meanReturn` is null when no objective is wired (core/sessions/evaluator.js): there is no return to show */
type Report = { role: string; n: number; successRate: number; meanReturn: number | null; meanSteps: number; metrics: Record<string, { mean: number; n: number }>; groups?: { axis: string; rows: { key: string; n: number; successRate: number; meanReturn: number | null; metrics: Record<string, { mean: number; n: number }> }[] }; episodes: unknown[]; artifacts: Record<string, string> };
const report = computed(() => snap.value.report as Report | null);
const roles = computed(() => ((snap.value.roles as string[] | undefined) ?? ['test']));
const role = shallowRef<string>(String(snap.value.role ?? roles.value[0] ?? 'test'));
watch(roles, rs => { if (!rs.includes(role.value)) role.value = rs[0] ?? 'test'; });
const progress = computed(() => snap.value.progress as { done: number; total: number } | null);
const scope = computed(() => reportScope(report.value));
const groupMarks = { x: 'report.groups.rows.key' };   // the grouped curve is the success rate per key. Other metrics are in the table
const groupColumns = computed(() => {
  const g = report.value?.groups; if (!g) return {};
  const cols: Record<string, string> = { [g.axis]: 'key', n: 'n', successRate: 'successRate' };
  if (report.value?.meanReturn !== null) cols.meanReturn = 'meanReturn';
  for (const name of Object.keys(g.rows[0]?.metrics ?? {})) if (!(name in cols)) cols[name] = `metrics.${name}.mean`;
  return cols;
});
/** the artifact every network of the loop ran, by network title */
const ran = computed(() => { void wb.version.value; return Object.entries(report.value?.artifacts ?? {}).map(([net, id]) => ({ net: wb.graph.nodes.get(net)?.title ?? net, id })); });
const showEpisodes = shallowRef(false);
</script>

<template>
  <div class="body">
    <div v-if="snap.dead" class="bproblem">{{ snap.dead }}</div>
    <ConfigForm :node-id="nodeId" :fields="['groupBy']" />
    <div class="brow">
      <label>{{ t('分区') }} <select v-model="role" :aria-label="t('分区角色')"><option v-for="r in roles" :key="r" :value="r">{{ t(ROLE[r] ?? r) }}</option></select></label>
      <button type="button" :disabled="!snap.bundleReady || !!snap.busy" :title="String(snap.problem ?? '')" @click="act(() => session.run(role))">{{ snap.busy ? t('评估中…') : t('评估') }}</button>
      <button v-if="report" type="button" class="mini" @click="act(() => session.clear())">{{ t('清除') }}</button>
    </div>
    <div v-if="progress && snap.busy" class="tbar"><i :style="{ width: `${Math.round((100 * progress.done) / Math.max(1, progress.total))}%` }"></i></div>
    <div v-if="snap.problem" class="bproblem incomplete">{{ snap.problem }}</div>
    <div v-if="report && snap.stale" class="bhint warn">{{ t('图已改动：这份报告来自改动前的回路。重新评估后更新') }}</div>
    <div v-if="snap.error" class="bproblem">{{ snap.error }}</div>
    <div v-if="error" class="bproblem">{{ error }}</div>

    <template v-if="report">
      <div class="brow bhint">
        <span>{{ t('{role} 分区 · {n} 个回合', { role: t(ROLE[report.role] ?? report.role), n: report.n }) }}</span>
        <span v-for="a in ran" :key="a.net" class="pin" :title="a.id">{{ a.net }} {{ shortId(a.id) }}</span>
        <span class="bgrow"></span>
        <span>{{ t('成功率') }} <b>{{ fmt(report.successRate) }}</b><template v-if="report.meanReturn !== null"> · {{ t('回报') }} <b>{{ fmt(report.meanReturn) }}</b></template> · {{ t('步数') }} <b>{{ fmt(report.meanSteps) }}</b></span>
      </div>
      <table class="btable emetrics">
        <thead><tr><th class="l">{{ t('指标') }}</th><th>{{ t('均值') }}</th><th>n</th></tr></thead>
        <tbody><tr v-for="(m, name) in report.metrics" :key="name"><td class="l mono">{{ name }}</td><td>{{ fmt(m.mean, 4) }}</td><td>{{ m.n }}</td></tr></tbody>
      </table>
      <div v-if="report.groups" class="egroups">
        <div class="bhint">{{ t('按 {axis} 分组', { axis: report.groups.axis }) }}</div>
        <SeriesRenderer :scope="scope" path="report.groups.rows.successRate" :marks="groupMarks" />
        <TableRenderer :scope="scope" path="report.groups.rows" :marks="groupColumns" />
      </div>
      <details class="bsection" @toggle="showEpisodes = ($event.target as HTMLDetailsElement).open">
        <summary>{{ t('回合样本 {n} 个', { n: report.episodes.length }) }}</summary>
        <TableRenderer v-if="showEpisodes" :scope="scope" path="report.episodes" :marks="{ limit: '64' }" />
      </details>
    </template>
  </div>
</template>
