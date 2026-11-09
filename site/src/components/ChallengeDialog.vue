<script setup>
// components/ChallengeDialog.vue — the dialog before a challenge: the two entries, the tie rule, the estimated cost
// (typical and worst) against the balance, the timeout. 开打 starts the challenge and goes to its view.
import { computed, shallowRef, watch } from 'vue';
import { t } from '../i18n.js';
import { href, go } from '../router.js';
import { useLadder } from '../ladder/use-ladder.js';
import { useChallenge } from '../ladder/use-challenge.js';
import { useBalance, useWallet } from '../wallet/wallet.js';
import { describeError } from '../ladder/errors.js';
import { formatGas, formatInt, formatMon, nameOf, rankTag, shortAddress } from '../ladder/format.js';

const props = defineProps({ challenger: { type: Object, required: true }, defender: { type: Object, required: true } });
const emit = defineEmits(['close']);
const ladder = useLadder();
const wallet = useWallet();
const challenge = useChallenge();
const balance = useBalance(wallet.provider, () => wallet.address, () => ladder.tick);
const estimate = shallowRef(null);
const error = shallowRef(null);
const sending = shallowRef(false);
watch([() => props.challenger.module, () => props.defender.module], ([c, d], _, onCleanup) => {
  let on = true;
  onCleanup(() => { on = false; });
  ladder.client.estimate(c, d).then(e => { if (on) estimate.value = e; }, e => { if (on) error.value = e; });
}, { immediate: true });
const short = computed(() => estimate.value && balance.value !== null && balance.value < BigInt(estimate.value.costTypicalWei));
const shortWorst = computed(() => estimate.value && balance.value !== null && balance.value < BigInt(estimate.value.costWorstWei));
const close = () => emit('close');
const onBack = e => { if (e.target === e.currentTarget) close(); };
const start = async () => {
  sending.value = true; error.value = null;
  try {
    const p = challenge.start(props.challenger.module, props.defender.module);
    close();
    go(href.challenge('new'));
    await p;
  } catch (e) { error.value = e; sending.value = false; }
};

/** Who wins a tie on episodes between `c` and `d` under δ. */
function tieText(c, d, config) {
  if (!config) return '…';
  const delta = Number(config.deltaBps) / 10000;
  const limit = Math.floor(Number(d.weightBytes) * (1 - delta));
  return Number(c.weightBytes) <= limit
    ? t('挑战者赢（{c} ≤ {limit}，比擂主小 δ = {delta}% 以上）', { c: formatInt(c.weightBytes), limit: formatInt(limit), delta: delta * 100 })
    : t('擂主守擂（挑战者要 ≤ {limit} 字节才能靠 δ = {delta}% 赢）', { limit: formatInt(limit), delta: delta * 100 });
}
</script>

<template>
  <div class="modal-back" role="dialog" aria-modal="true" @click="onBack">
    <div class="modal">
      <div><span class="label">{{ t('发起挑战') }}</span><h3 style="margin-top: 6px">{{ nameOf(ladder.names, challenger.module) }} → {{ nameOf(ladder.names, defender.module) }}</h3></div>
      <dl class="kv">
        <dt>{{ t('挑战者') }}</dt><dd>{{ rankTag(challenger.rank) }} · {{ formatInt(challenger.weightBytes) }} B · {{ shortAddress(challenger.module) }}</dd>
        <dt>{{ t('擂主') }}</dt><dd>{{ rankTag(defender.rank) }} · {{ formatInt(defender.weightBytes) }} B · {{ shortAddress(defender.module) }}</dd>
        <dt>{{ t('平局时') }}</dt><dd>{{ tieText(challenger, defender, ladder.config) }}</dd>
        <dt>{{ t('预计费用（典型）') }}</dt><dd>{{ estimate ? `${formatMon(estimate.costTypicalWei)} · ${formatGas(estimate.gasTypical)} gas` : '…' }}</dd>
        <dt>{{ t('预计费用（最坏）') }}</dt><dd>{{ estimate ? `${formatMon(estimate.costWorstWei)} · ${formatGas(estimate.gasWorst)} gas · ${t('{n} 笔交易', { n: estimate.txWorst })}` : '…' }}</dd>
        <dt>{{ t('钱包余额') }}</dt><dd>{{ formatMon(balance) }}</dd>
        <dt>{{ t('超时') }}</dt><dd>{{ ladder.config ? t('从第 {start} 块起 {n} 块内要打完', { start: formatInt(ladder.block), n: formatInt(ladder.config.timeoutBlocks) }) : '…' }}</dd>
      </dl>
      <div v-if="short" class="msg bad">{{ t('余额不够付典型的一场挑战，先给钱包充值') }}</div>
      <div v-if="!short && shortWorst" class="msg warn">{{ t('余额够典型的一场，但是不够最坏的一场（600 步）') }}</div>
      <div v-if="error" class="msg bad">{{ describeError(error, { config: ladder.config, block: ladder.block }) }}</div>
      <p class="muted" style="margin: 0; font-size: 13px">{{ t('页面会自动发出这场挑战的全部交易，不再弹窗确认。关掉页面以后，在超时以前回来还能接着打。') }}</p>
      <div class="row" style="justify-content: flex-end">
        <button type="button" class="btn" @click="close">{{ t('取消') }}</button>
        <button type="button" class="btn btn-primary" :disabled="!estimate || short || sending || challenge.busy" @click="start">{{ t('开打') }}</button>
      </div>
    </div>
  </div>
</template>
