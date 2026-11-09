<script setup>
// components/Guide.vue — [1] 开始: what the player needs before the first challenge: the network, the wallet and its
// balance, an entry.
import { computed } from 'vue';
import { t } from '../i18n.js';
import { href } from '../router.js';
import { entriesOf, useLadder } from '../ladder/use-ladder.js';
import { useBalance, useWallet } from '../wallet/wallet.js';
import { formatInt, formatMon, shortAddress } from '../ladder/format.js';

const props = defineProps({ config: { type: Object, required: true } });
const wallet = useWallet();
const ladder = useLadder();
const balance = useBalance(wallet.provider, () => wallet.address, () => ladder.tick);
const mine = computed(() => entriesOf(ladder.entries, wallet.address));
const items = computed(() => [
  [t('网络'), props.config.name, true],
  [t('钱包'), wallet.address ? `${shortAddress(wallet.address)} · ${formatMon(balance.value)}` : t('还没有登录'), !!wallet.address],
  [t('出战模型'), mine.value.length ? t('{n} 个', { n: mine.value.length }) : t('还没有'), mine.value.length > 0],
  [t('赛季结束块'), ladder.config ? formatInt(ladder.config.endBlock) : '…', true],
]);
</script>

<template>
  <div class="card stack">
    <dl class="kv">
      <template v-for="[k, v, ok] in items" :key="k"><dt>{{ k }}</dt><dd><span :class="`pill${ok ? ' ok' : ''}`">{{ v }}</span></dd></template>
    </dl>
    <div class="row">
      <a v-if="wallet.address" class="btn btn-primary" :href="href.entries()">{{ mine.length ? t('我的出战模型') : t('注册出战模型') }}</a>
      <button v-else type="button" class="btn btn-primary" :disabled="!wallet.ready || wallet.kind === 'none'" @click="wallet.login">{{ t('登录') }}</button>
      <a class="btn" :href="href.main('ladder')">{{ t('看榜单') }}</a>
    </div>
    <p class="muted" style="margin: 0; font-size: 13px">
      {{ config.local ? t('这是本地开发链：登录用的是 anvil 默认助记词的账号，任何人都知道它的私钥。') : t('挑战的 gas 由你的钱包付，先给钱包充值 MON。') }}
    </p>
  </div>
</template>
