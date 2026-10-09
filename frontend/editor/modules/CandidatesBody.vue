<script setup lang="ts">
// CandidatesBody.vue — the candidates module. It lists the artifacts of every run wired into `run`, plus imports. Each
// row shows the metric, engine / structure and compatibility with the loop that contains the node. Actions: preview,
// accept (flows out of `weights` / `artifact`), import / export `neurom-module` JSON, remove.
import { computed, shallowRef } from 'vue';
import { useSession, useAct, fmt, shortId, when, structureLabel, compatLabel, compatClass } from './body-utils';
import ArtifactImport from './ArtifactImport.vue';
import { t } from '../../i18n.js';
import './bodies-a.css';
import './bodies-b.css';

const props = defineProps<{ nodeId: string }>();
const { session, snap } = useSession('candidates', props.nodeId);
const { error, act } = useAct();

type Candidate = { id: string; run: string; imported: boolean; method: string | null; backend: string | null; metric: number | null; metricName: string | null; engine: string; kind: string; inputs: number; outputs: number; layers?: unknown[]; createdAt: number | null; accepted: boolean; previewed: boolean; compatible: { ok: boolean | null; reason: string } };
const candidates = computed(() => (snap.value.candidates as Candidate[]) ?? []);
const reference = computed(() => snap.value.reference as { trainer: string; problem: string | null } | null);
const accepted = computed(() => snap.value.accepted as string | null);

const importing = shallowRef(false);
function exportOne(c: Candidate) {
  act(() => {
    const json = session.exportArtifact(c.id);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `artifact-${c.id.slice(2, 14)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
</script>

<template>
  <div class="body">
    <div v-if="snap.dead" class="bproblem">{{ snap.dead }}</div>
    <div class="brow bhint">
      <span v-if="accepted">{{ t('已接受') }} <span class="pin ok" :title="accepted">{{ shortId(accepted) }}</span></span>
      <span v-else>{{ t('尚未接受任何候选') }}</span>
      <span class="bgrow"></span>
      <span v-if="reference?.problem" class="warn" :title="reference.problem">{{ t('无法对照训练器的训练快照') }}</span>
      <button type="button" class="mini" @click="importing = !importing">{{ t('导入') }}</button>
      <button v-if="accepted" type="button" class="mini" @click="act(() => session.clearAccepted())">{{ t('取消接受') }}</button>
    </div>
    <ArtifactImport v-if="importing" :run="text => session.importArtifact(text)" @done="importing = false" />
    <div v-if="error" class="bproblem">{{ error }}</div>

    <div v-if="!candidates.length" class="bhint">{{ t('还没有候选：接一个训练器的 run 并训练，或导入产物。') }}</div>
    <ul v-else class="cands">
      <li v-for="c in candidates" :key="c.id" :class="{ accepted: c.accepted, previewing: c.previewed, incompatible: c.compatible.ok === false }">
        <div class="brow">
          <span class="pin" :title="c.id">{{ shortId(c.id) }}</span>
          <span class="mono">{{ c.metricName ?? 'metric' }} <b>{{ fmt(c.metric) }}</b></span>
          <span class="bhint">{{ structureLabel(c) }}</span>
          <span class="bgrow"></span>
          <span class="ctag" :class="compatClass(c)" :title="c.compatible.reason">{{ compatLabel(c) }}</span>
        </div>
        <div class="brow bhint">
          <span>{{ c.imported ? t('导入') : `${c.method ?? ''} · ${c.backend === 'python' ? 'Python' : t('浏览器')}` }} · {{ when(c.createdAt) }}</span>
          <span v-if="c.accepted" class="ok">{{ t('已接受') }}</span>
          <span v-if="c.previewed" class="pl">{{ t('预览中') }}</span>
        </div>
        <div v-if="c.compatible.ok === false" class="bproblem">{{ c.compatible.reason }}</div>
        <div class="brow">
          <button type="button" class="mini" :disabled="c.accepted || c.compatible.ok === false" :title="c.compatible.ok === false ? c.compatible.reason : t('接受：权重从 weights / artifact 端口流出')" @click="act(() => session.accept(c.id))">{{ t('接受') }}</button>
          <button type="button" class="mini" @click="act(() => session.preview(c.previewed ? null : c.id))">{{ c.previewed ? t('停止预览') : t('预览') }}</button>
          <button type="button" class="mini" @click="exportOne(c)">{{ t('导出') }}</button>
          <span class="bgrow"></span>
          <button type="button" class="mini" :disabled="c.accepted" :title="c.accepted ? t('已接受的候选不能删除') : t('从运行中移除这份产物')" @click="act(() => session.remove(c.id))">×</button>
        </div>
      </li>
    </ul>
  </div>
</template>
