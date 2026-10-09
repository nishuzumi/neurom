<script setup lang="ts">
// DeploymentBody.vue — the deployment module over sessions/deployment.js. It shows the network (workspace setting)
// and its official Factory (explorer-linked where the network has an explorer, ADR 0016), the wallet and the session
// label. Then it shows the deployment record on this network (deploy / verify / read state). Next come the deployment
// plan (chunks needed / on chain, the transactions mined and still to send) and the status line with explorer link.
// Last comes one of two parts. Stateless modules get free inference + step transactions on explicit input bits.
// Other modules get the episode mirrored on chain (preview / reset / step) with the decision and the chain-step history.
import { computed, shallowRef, watch } from 'vue';
import { useSession, useAct, shortId, structureLabel } from './body-utils';
import { ROLE_LABEL } from './common';
import { ROLES } from '../../core/kinds/partition.js';
import KvRenderer from '../renderers/kv.vue';
import TxLink from './TxLink.vue';
import { formatCell } from '../renderers/scope.js';
import { t } from '../../i18n.js';
import './bodies-a.css';
import './bodies-b.css';

const props = defineProps<{ nodeId: string }>();
const { session, snap } = useSession('deployment', props.nodeId);
const { error, act } = useAct();

type Tx = { hash: string; url: string | null; short: string; gasUsed: string | null };
type Decision = { scores: number[]; counts?: number[]; voltages?: number[]; action: number; actionName?: string | null; tx?: Tx | null; mode?: string; source?: string; input?: number[]; state?: unknown };
type Infer = { source: string; bits: number[]; chain: { scores: number[]; action: number; bits: number[] }; local: { scores: number[]; action: number; bits: number[] }; same: boolean; tx: Tx | null };
type ToolRef = { kind: string; artifactId: string | null; short: string | null };
type ToolModule = { artifactId: string; address: string; reused?: boolean };
const artifact = computed(() => snap.value.artifact as { id: string; short: string; engine: string; kind: string; inputs: number; outputs: number; layers?: unknown[]; weightBits: number; ticks?: number; leak_shift?: number; episodic: boolean; tools: ToolRef[] } | null);
const can = computed(() => (snap.value.can as Record<string, boolean>) ?? {});
const reasons = computed(() => (snap.value.reasons as Record<string, string | null>) ?? {});
const status = computed(() => (snap.value.status as { tone: string; text: string; tx: Tx | null }) ?? { tone: 'info', text: '', tx: null });
const chains = computed(() => (snap.value.chains as { id: number; name: string; local: boolean }[]) ?? []);
const deployment = computed(() => snap.value.deployment as { address: string; artifactId: string; txHash?: string; tx: Tx | null; stale: boolean } | null);
type EngineVersion = { address: string; number: number; latest: boolean };
const chainSession = computed(() => snap.value.session as { chainId: number; address: string; artifactId: string; account: string; sessionHex: string; tools: ToolModule[]; engineVersion: EngineVersion | null } | null);
type PlanTx = { kind: string; tool: boolean; label: string; gas: string | null };
const plan = computed(() => snap.value.deployPlan as { needed: number; onChain: number; bytes: number; transactions: PlanTx[] } | null);
const run = computed(() => snap.value.deployRun as { done: { kind: string; label: string; tx: Tx }[]; sending: boolean; failed: string | null; finished: boolean } | null);
/** The deployment's transactions in sending order: the run's mined ones, then (unless it finished) the plan's rest. */
const txRows = computed(() => {
  const r = run.value, done = (r?.done ?? []).map(x => ({ label: x.label, state: 'mined', gas: x.tx.gasUsed, tx: x.tx as Tx | null }));
  if (r?.finished) return done.map((x, k) => ({ ...x, i: k + 1 }));
  const rest = (plan.value?.transactions ?? []).map((x, k) => ({ label: x.label, state: k > 0 ? 'planned' : r?.sending ? 'sending' : r?.failed ? 'failed' : 'planned', gas: x.gas, tx: null as Tx | null }));
  return [...done, ...rest].map((x, k) => ({ ...x, i: k + 1 }));
});
const episode = computed(() => snap.value.episode as { record: unknown; state: unknown; t: number; done: boolean; budget: number | null; steps: number; gasUsed: number; success: boolean | null } | null);
const preview = computed(() => snap.value.preview as Decision | null);
const last = computed(() => snap.value.last as Decision | null);
const infer = computed(() => snap.value.infer as Infer | null);
const history = computed(() => (snap.value.history as (Decision & { t: number })[]) ?? []);
const actions = computed(() => (snap.value.actions as string[] | null) ?? null);
const rows = computed(() => { const h = history.value, first = Math.max(0, h.length - 40); return h.slice(first).map((e, k) => ({ i: first + k, h: e })).reverse(); });
const decision = computed(() => preview.value ?? last.value);
/** the bar scale of the decision's scores: their largest magnitude (at least 1) */
const scoreMax = computed(() => Math.max(1, ...(decision.value?.scores ?? []).map(Math.abs)));
const stateScope = computed(() => ({ state: preview.value?.state ?? episode.value?.state ?? null }));
const fmtGas = (g: unknown) => (g == null ? '—' : Number(g).toLocaleString());
const actionLabel = (a: number | null | undefined, name?: string | null) => (a === null || a === undefined ? '—' : `${a}${name ? ` ${t(name)}` : actions.value?.[a] ? ` ${t(actions.value[a])}` : ''}`);

// ------------------------------------------------------------------ inputs committed to the session
const labelInput = shallowRef(String(snap.value.label ?? ''));
watch(() => snap.value.label, v => { labelInput.value = String(v ?? ''); });
const bits = computed<number[]>(() => (snap.value.inputBits as number[] | null) ?? new Array(artifact.value?.inputs ?? 0).fill(0));
function toggleBit(i: number) { const b = bits.value.slice(); b[i] = b[i] ? 0 : 1; act(() => session.setInputBits(b)); }
const selRole = shallowRef('training'), selIndex = shallowRef('0'), seedInput = shallowRef('1');
function pickRole() { act(() => session.setEpisode({ role: selRole.value, index: Math.max(0, Math.floor(Number(selIndex.value) || 0)) })); }
function pickSeed() { const seed = Number(seedInput.value); if (!Number.isInteger(seed) || seed < 0) { error.value = t('种子需要是非负整数'); return; } act(() => session.setEpisode({ seed })); }
</script>

<template>
  <div class="body">
    <div v-if="snap.dead" class="bproblem">{{ snap.dead }}</div>
    <!-- network · wallet · label, and the network's official Factory -->
    <div class="brow">
      <label>{{ t('网络') }} <select :value="String(snap.chainId)" :aria-label="t('网络')" :disabled="!!snap.busy" @change="act(() => session.setChainId(Number(($event.target as HTMLSelectElement).value)))">
        <option v-for="c in chains" :key="c.id" :value="String(c.id)">{{ c.name }} ({{ c.id }})</option><option v-if="!chains.length" :value="String(snap.chainId)">{{ snap.chainName }}</option></select></label>
      <button type="button" class="mini" :disabled="!can.connect" :title="reasons.connect ?? t('连接钱包 / 本地节点')" @click="act(() => session.connect())">{{ t('连接') }}</button>
      <label class="bhint">{{ t('会话标签') }} <input v-model="labelInput" class="dlabel" :aria-label="t('会话标签')" :title="String(snap.sessionId ?? t('会话 id = keccak256(标签)'))" @change="act(() => session.setLabel(labelInput))" @keydown.enter.prevent="act(() => session.setLabel(labelInput))" /></label>
    </div>
    <div class="brow bhint dfactory">
      {{ t('官方 Factory') }}
      <template v-if="snap.factory"><a v-if="snap.factoryUrl" class="mono" target="_blank" rel="noopener" :href="String(snap.factoryUrl)">{{ snap.factory }}</a><span v-else class="pin">{{ snap.factory }}</span></template>
      <span v-else class="bad">{{ snap.factoryProblem }}</span>
    </div>
    <div class="brow bhint">
      <span v-if="artifact"><span class="pin" :title="artifact.id">{{ artifact.short }}</span> {{ structureLabel(artifact) }}</span>
      <span v-else>{{ snap.artifactProblem }}</span>
      <span class="bgrow"></span>
      <span v-if="chainSession">{{ t('会话：') }}<span class="pin" :title="chainSession.address">{{ shortId(chainSession.address) }}</span> · {{ t('调用者') }} <span class="pin" :title="chainSession.account">{{ shortId(chainSession.account) }}</span>
        <template v-if="chainSession.engineVersion"> · {{ t('引擎版本 {number}', { number: chainSession.engineVersion.number }) }} <span class="pin" :title="chainSession.engineVersion.address">{{ shortId(chainSession.engineVersion.address) }}</span>{{ chainSession.engineVersion.latest ? t('（最新）') : t('（不是最新）') }}</template></span>
      <span v-else>{{ t('没有链上会话') }}</span>
    </div>
    <div v-if="artifact?.tools.length" class="brow bhint">
      {{ t('工具层的工具（先部署它们，同一产物已有链上模块时复用那个模块）：') }}
      <template v-for="(tool, k) in artifact.tools" :key="k">
        <span v-if="tool.short" class="pin" :title="tool.artifactId ?? ''">{{ tool.short }}</span><span v-else class="bad">{{ t('代码工具') }}</span>
        <template v-if="chainSession?.tools[k]"> → <span class="pin" :title="chainSession.tools[k].address">{{ shortId(chainSession.tools[k].address) }}</span></template>
      </template>
    </div>
    <div v-if="snap.deployProblem" class="bproblem">{{ snap.deployProblem }}</div>
    <div v-if="error" class="bproblem">{{ error }}</div>

    <!-- record on this network -->
    <div class="drecord">
      <div v-if="deployment" class="bhint">
        {{ t('本网络上的模块合约') }} <span class="pin" :title="deployment.address">{{ deployment.address }}</span> · {{ t('产物') }} {{ shortId(deployment.artifactId) }}
        <span v-if="deployment.stale" class="bad">{{ t('（部署的产物不是当前已接受的产物。再部署一次可以更新）') }}</span>
        <template v-if="deployment.tx"> · <TxLink :tx="deployment.tx" /></template>
      </div>
      <div v-else class="bhint">{{ t('这个网络上还没有部署。一份产物 = 一个模块合约（Factory 记录 artifactId / taskId / engineId 与权重字节）。工具层的每个网络工具也有自己的模块合约。') }}</div>
      <div class="brow">
        <button type="button" :disabled="!can.deploy" :title="reasons.deploy ?? t('通过 Factory 部署当前已接受产物，并核对链上字节')" @click="act(() => session.deploy())">{{ t('部署当前产物') }}</button>
        <button type="button" :disabled="!can.verify" :title="reasons.verify ?? t('核对链上模块 = 当前产物，并以当前账户建立会话')" @click="act(() => session.verify())">{{ t('核对链上模块') }}</button>
        <button type="button" class="mini" :disabled="!can.state" :title="reasons.state ?? t('读取链上为（调用者，会话）保存的膜电位')" @click="act(() => session.readState())">{{ t('读取链上状态') }}</button>
        <button type="button" class="mini" :disabled="!can.plan" :title="reasons.plan ?? t('只读：按 CREATE2 地址查询链上已有的权重块，列出部署要发送的交易')" @click="act(() => session.plan())">{{ t('部署计划') }}</button>
      </div>
      <div v-if="plan" class="bhint">
        {{ t('权重块：需要 {needed} 个（{bytes} 字节）· 链上已有 {onChain} 个', { needed: plan.needed, bytes: plan.bytes.toLocaleString(), onChain: plan.onChain }) }}<template v-if="!run?.finished"> · {{ t('还要发送 {count} 笔交易', { count: plan.transactions.length }) }}</template>
      </div>
      <div v-else class="bhint">{{ t('“部署计划”只读查询：要几个权重块、链上已有几个、要发几笔交易。') }}</div>
      <ol v-if="txRows.length" class="hist-list" :aria-label="t('部署交易')">
        <li v-for="row in txRows" :key="row.i" class="hist-row" :class="{ manual: row.state === 'planned' }"><span class="hist-i">{{ row.i }}</span><span>{{ row.label }}</span><span class="bgrow"></span>
          <span v-if="row.state === 'mined'" class="bhint"><b class="ok">{{ t('已上链') }}</b> · gas {{ fmtGas(row.gas) }} · <a v-if="row.tx?.url" target="_blank" rel="noopener" :href="row.tx.url">tx {{ row.tx.short }}</a><template v-else-if="row.tx">tx {{ row.tx.short }}</template></span>
          <span v-else-if="row.state === 'sending'" class="bhint pl">{{ t('发送中…') }}</span>
          <span v-else-if="row.state === 'failed'" class="bhint bad">{{ t('未上链') }}</span>
          <span v-else class="bhint">{{ row.gas === null ? t('gas 待前面的交易上链后估算') : t('估算 gas {gas}', { gas: fmtGas(row.gas) }) }}</span></li>
      </ol>
      <div v-if="run?.finished" class="bhint">{{ t('本次部署 {count} 笔交易全部上链。', { count: run.done.length }) }}</div>
    </div>

    <!-- status -->
    <div class="dstatus" :class="status.tone" :role="status.tone === 'warn' ? 'alert' : 'status'" aria-live="polite">
      <span v-if="snap.busy" class="pl">{{ t(String(snap.busy)) }}…</span>
      <span>{{ status.text || (chainSession ? t('会话就绪。') : t('先点“连接”，再点“部署当前产物”或“核对链上模块”，建立会话。')) }}</span>
      <TxLink v-if="status.tx" :tx="status.tx" />
    </div>

    <!-- stateless: explicit input bits -->
    <template v-if="artifact && !artifact.episodic">
      <div class="brow"><span class="bhint">{{ t('输入 {n} 位（低位在前）', { n: artifact.inputs }) }}</span>
        <button type="button" class="mini" :disabled="!can.infer" :title="reasons.infer ?? t('免费 eth_call，不发交易')" @click="act(() => session.infer())">{{ t('链上推理（免费 eth_call）') }}</button>
        <button type="button" class="mini" :disabled="!can.step" :title="reasons.step ?? t('发送 step 交易。链上分数必须等于本地分数。')" @click="act(() => session.step())">{{ t('step 交易') }}</button></div>
      <div class="bitgrid"><button v-for="(b, i) in bits" :key="i" type="button" class="bit" :class="{ on: b === 1 }" :disabled="!!snap.busy" :aria-pressed="b === 1" @click="toggleBit(i)">{{ i }}</button></div>
      <div v-if="infer" class="bhint">
        {{ t('本地') }} <b>{{ infer.local.action }}</b>{{ t('（分数 {scores}）', { scores: infer.local.scores.join(' ') }) }} ·
        {{ t('链上（{source}）→', { source: infer.source === 'infer' ? 'eth_call' : t('step 交易') }) }} <b :class="infer.same ? 'ok' : 'bad'">{{ infer.chain.action }}</b>{{ t('（分数 {scores}）', { scores: infer.chain.scores.join(' ') }) }} {{ infer.same ? t('链上 = 本地。') : t('不一致！') }}
        <template v-if="infer.tx"> · gas {{ fmtGas(infer.tx.gasUsed) }} · <TxLink :tx="infer.tx" /></template>
        <span class="bits"><i v-for="(b, i) in infer.chain.bits" :key="i" :class="{ on: b === 1 }"></i></span>
      </div>
    </template>

    <!-- episodic: the episode mirrored on chain -->
    <template v-else-if="artifact">
      <div class="brow">
        <select v-model="selRole" :aria-label="t('分区角色')" :disabled="!!snap.busy" @change="pickRole"><option v-for="r in ROLES" :key="r" :value="r">{{ t(ROLE_LABEL[r]) }}</option></select>
        <input v-model="selIndex" type="number" min="0" class="xidx" :aria-label="t('回合下标')" :disabled="!!snap.busy" @change="pickRole" @keydown.enter.prevent="pickRole" />
        <label class="bhint">{{ t('种子') }} <input v-model="seedInput" type="number" min="0" :aria-label="t('种子')" :disabled="!!snap.busy" @change="pickSeed" @keydown.enter.prevent="pickSeed" /></label>
        <span class="bgrow"></span>
        <span v-if="snap.selection" class="bhint mono">{{ formatCell(snap.selection, 6) }}</span>
      </div>
      <div class="brow">
        <button type="button" class="mini" :disabled="!can.preview" :title="reasons.preview ?? t('免费 eth_call：不发交易、不推进对局')" @click="act(() => session.preview())">{{ t('只读预览一步（免费）') }}</button>
        <button type="button" :disabled="!can.reset" :title="reasons.reset ?? t('发送 reset 交易并开新的本地对局')" @click="act(() => session.reset())">{{ t('新一局（reset 交易）') }}</button>
        <button type="button" :disabled="!can.step" :title="reasons.step ?? t('发送 step 交易。链上的分数、放电和膜电位必须与本地一致。')" @click="act(() => session.step())">{{ t('走一步（step 交易）') }}</button>
      </div>
      <div v-if="episode || preview" class="dstage">
        <div class="bhint" :class="preview ? 'pl' : ''">{{ preview ? t('只读 eth_call {mode}：不发交易、不推进对局、不改链上状态。', { mode: preview.mode }) : t('链上回合的本地镜像') }}</div>
        <KvRenderer :scope="stateScope" path="state" :marks="{}" />
        <div v-if="episode" class="bhint">{{ t('第 {step} 步', { step: episode.t }) }}<template v-if="episode.budget">/{{ episode.budget }}</template> · {{ t('已用 gas {gas}（{count} 笔 step）', { gas: fmtGas(episode.gasUsed), count: episode.steps }) }}
          <b v-if="episode.done" :class="episode.success ? 'ok' : 'bad'"> · {{ episode.success ? t('成功') : t('结束') }}</b></div>
        <template v-if="decision">
          <div class="bhint"><b>{{ t('决策') }}</b> {{ t('链上选择 {action} → 环境动作', { action: decision.action }) }} <b class="ink">{{ actionLabel(decision.action, decision.actionName) }}</b></div>
          <div class="scores">
            <div v-for="(s, i) in decision.scores" :key="i" class="score" :class="{ pick: i === decision.action }">
              <span class="score-name">{{ actions?.[i] ? t(actions[i]) : `#${i}` }}</span>
              <span class="score-bar"><i :style="{ width: `${Math.round(50 + (50 * s) / scoreMax)}%` }"></i></span>
              <span class="score-val">{{ s }}</span>
            </div>
          </div>
          <div v-if="decision.voltages?.length" class="bhint mono xvolts">V {{ decision.voltages.join(' ') }}</div>
          <div v-if="decision.tx" class="bhint">gas {{ fmtGas(decision.tx.gasUsed) }} · <TxLink :tx="decision.tx" /></div>
        </template>
      </div>
      <details v-if="history.length" class="bsection" open>
        <summary>{{ t('链上步骤 {count} 笔', { count: history.length }) }}</summary>
        <ol class="hist-list">
          <li v-for="{ i, h } in rows" :key="i" class="hist-row"><span class="hist-i">{{ i + 1 }}</span><span>{{ t('选择 {action} → {name} · 分数 {scores}', { action: h.action, name: h.actionName ? t(h.actionName) : h.action, scores: h.scores.join(' ') }) }}</span><span class="bgrow"></span>
            <span class="bhint" v-if="h.tx">gas {{ fmtGas(h.tx.gasUsed) }} · <a v-if="h.tx.url" target="_blank" rel="noopener" :href="h.tx.url">tx {{ h.tx.short }}</a><template v-else>tx {{ h.tx.short }}</template></span></li>
        </ol>
      </details>
    </template>
  </div>
</template>
