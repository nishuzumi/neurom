<script setup lang="ts">
// ChainNodeBody.vue — the chain node on the canvas (core/kinds/chain-node.js, ADR 0028). One row picks the chain of
// the registry (chain.js CHAINS) and turns writes on, which only a local node allows. The body checks the node over
// the read connection: the chain id must match, then it shows the block number and whether the registry's Factory and
// ladder have code there. A fork entry that is not reachable shows how to start it: the anvil command of
// forkCommand, the node address and the chain id with copy buttons, and the steps to a practice challenge. Every
// value comes from CHAINS / forkCommand.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useWorkbench } from '../workbench-context';
import { useNode } from './common';
import { CHAINS, forkCommand, readConnection } from '../../chain.js';
import { describeChainError } from '../../chain-error.js';
import { t } from '../../i18n.js';
import './bodies-a.css';
import './bodies-b.css';

type Chain = { name: string; rpc: string; local?: boolean; factory?: string | null; ladder?: string | null; fork?: { of: number; port: number } | null };
const props = defineProps<{ nodeId: string }>();
const wb = useWorkbench();
const { node, problems } = useNode(wb, () => props.nodeId);
const chains = computed(() => Object.entries(CHAINS as Record<string, Chain>).map(([id, c]) => ({ id: Number(id), ...c })));
const chainId = computed(() => Number(node.value?.config.chainId ?? 0));
const chain = computed<Chain | null>(() => (CHAINS as Record<string, Chain>)[chainId.value] ?? null);
const write = computed(() => !!node.value?.config.write);
const command = computed(() => forkCommand(chainId.value));

function setWrite(on: boolean) {
  const n = node.value; if (!n) return;
  wb.edit(t('修改 {title} 的 {field}', { title: n.title, field: t('允许写入') }), () => wb.graph.patchConfig(props.nodeId, { write: on }));
}
function pickChain(e: Event) {
  const id = Number((e.target as HTMLSelectElement).value);
  const n = node.value; if (!n) return;
  // a public chain never takes writes: the switch turns off with the chain
  wb.edit(t('修改 {title} 的 {field}', { title: n.title, field: t('网络') }), () => wb.graph.patchConfig(props.nodeId, { chainId: id, write: !!n.config.write && !!(CHAINS as Record<string, Chain>)[id]?.local }));
}

// ------------------------------------------------------------------ the check of the node
type Status = { state: 'idle' | 'busy' | 'ok' | 'down' | 'mismatch'; block?: number; got?: number; factory?: boolean | null; ladder?: boolean | null; error?: string };
const status = ref<Status>({ state: 'idle' });
let checking = 0;
async function check() {
  const id = chainId.value, c = chain.value, own = ++checking;
  if (!c) { status.value = { state: 'idle' }; return; }
  status.value = { state: 'busy' };
  try {
    const { request } = readConnection(id);
    const got = Number(await request({ method: 'eth_chainId', params: [] }));
    if (own !== checking) return;
    if (got !== id) { status.value = { state: 'mismatch', got }; return; }
    const hasCode = async (address: string | null | undefined) => (address ? String(await request({ method: 'eth_getCode', params: [address, 'latest'] })) !== '0x' : null);
    const [block, factory, ladder] = await Promise.all([request({ method: 'eth_blockNumber', params: [] }), hasCode(c.factory), hasCode(c.ladder)]);
    if (own !== checking) return;
    status.value = { state: 'ok', block: Number(block), factory, ladder };
  } catch (e) {
    if (own === checking) status.value = { state: 'down', error: describeChainError(e) };
  }
}
watch(chainId, check, { immediate: true });
onBeforeUnmount(() => { checking++; });

const copied = ref<string | null>(null);
let copiedTimer = 0;
async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  copied.value = text;
  clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => { copied.value = null; }, 1500);
}
const codeLabel = (has: boolean | null | undefined) => (has === null || has === undefined ? t('未登记') : has ? t('有代码') : t('无代码'));
</script>

<template>
  <div v-if="node" class="body">
    <div class="brow">
      <label>{{ t('网络') }} <select :value="String(chainId)" :aria-label="t('网络')" @change="pickChain">
        <option v-for="c in chains" :key="c.id" :value="String(c.id)">{{ c.name }} ({{ c.id }})</option></select></label>
      <label :title="chain?.local ? t('允许 eth_sendTransaction 和 Anvil 的快照、回滚、改存储等方法') : t('只有本地节点可以写入')"><input type="checkbox" :checked="write" :disabled="!chain?.local" @change="setWrite(($event.target as HTMLInputElement).checked)" /> {{ t('允许写入') }}</label>
      <span class="bgrow"></span>
      <button type="button" class="mini" :disabled="status.state === 'busy'" @click="check">{{ t('连接') }}</button>
    </div>
    <div class="dstatus" :class="{ busy: status.state === 'busy', ok: status.state === 'ok', warn: status.state === 'down' || status.state === 'mismatch' }">
      <template v-if="status.state === 'busy'">{{ t('正在检查 {rpc}…', { rpc: chain?.rpc ?? '' }) }}</template>
      <template v-else-if="status.state === 'ok'">{{ t('已连接 {name}，区块 {block}', { name: chain?.name ?? '', block: status.block ?? 0 }) }} · Factory {{ codeLabel(status.factory) }} · {{ t('擂台') }} {{ codeLabel(status.ladder) }}</template>
      <template v-else-if="status.state === 'mismatch'">{{ t('{rpc} 上的链 id 是 {got}，不是 {chainId}', { rpc: chain?.rpc ?? '', got: status.got ?? 0, chainId }) }}</template>
      <template v-else-if="status.state === 'down'">{{ t('连不上 {rpc}：{error}', { rpc: chain?.rpc ?? '', error: status.error ?? '' }) }}</template>
      <template v-else>{{ t('网络注册表里没有链 id {chainId}', { chainId }) }}</template>
    </div>
    <div v-if="status.state === 'down' && command" class="dstage cn-guide">
      <div class="bhint">{{ t('这个 fork 还没有启动。在终端运行下面的命令，并保持终端打开：') }}</div>
      <div class="brow"><code class="cn-cmd">{{ command }}</code><button type="button" class="mini" @click="copy(command)">{{ copied === command ? t('已复制') : t('复制') }}</button></div>
      <dl class="bkv">
        <dt>{{ t('节点地址') }}</dt><dd>{{ chain?.rpc }} <button type="button" class="mini" @click="copy(chain?.rpc ?? '')">{{ copied === chain?.rpc ? t('已复制') : t('复制') }}</button></dd>
        <dt>{{ t('链 id') }}</dt><dd>{{ chainId }} <button type="button" class="mini" @click="copy(String(chainId))">{{ copied === String(chainId) ? t('已复制') : t('复制') }}</button></dd>
      </dl>
      <ol class="cn-steps">
        <li>{{ t('运行上面的命令，并保持终端打开。') }}</li>
        <li>{{ t('在「链上部署」里选择「{name}」，然后部署当前产物。', { name: chain?.name ?? '' }) }}</li>
        <li>{{ t('在「坦克对战」里运行模拟挑战。') }}</li>
      </ol>
    </div>
    <div v-for="(p, i) in problems" :key="i" class="bproblem" :class="{ incomplete: p.incomplete }">{{ p.message }}</div>
  </div>
</template>

<style scoped>
.cn-cmd{flex:1 1 10em;min-width:0;padding:3px 6px;border:1px solid var(--line);border-radius:var(--radius);background:var(--bg);font-family:var(--mono);font-size:11px;overflow-wrap:anywhere;user-select:all}
.cn-steps{margin:0;padding-left:1.4em;display:flex;flex-direction:column;gap:2px}
</style>
