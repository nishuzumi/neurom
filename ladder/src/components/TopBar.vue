<script setup>
// components/TopBar.vue — the top bar of the ladder page: the site bar (SiteBar.vue) with the section links of the
// ladder and the login button on the right. After the login the button becomes the wallet chip: address, balance and
// the way out. The section links are hash links, so they stay on `/ladder/` (router.js).
import { t } from '../i18n.js';
import { href } from '../router.js';
import { useBalance, useWallet } from '../wallet/wallet.js';
import { useLadder } from '../ladder/use-ladder.js';
import { formatMon, shortAddress } from '../ladder/format.js';
import SiteBar from './SiteBar.vue';

const props = defineProps({ route: { type: Object, required: true } });
const wallet = useWallet();
const ladder = useLadder();
const balance = useBalance(wallet.provider, () => wallet.address, () => ladder.tick);
const main = () => props.route.view === 'main';
</script>

<template>
  <SiteBar page="ladder" :sub="t('坦克擂台')">
    <template #nav>
      <a :href="href.main('ladder')" :class="main() && route.section === 'ladder' ? 'on' : ''">{{ t('擂台榜') }}</a>
      <a :href="href.main('rules')" :class="main() && route.section === 'rules' ? 'on' : ''">{{ t('规则') }}</a>
      <a :href="href.main('recent')" :class="main() && route.section === 'recent' ? 'on' : ''">{{ t('最近的挑战') }}</a>
      <a v-if="wallet.address" :href="href.entries()" :class="route.view === 'entries' ? 'on' : ''">{{ t('我的出战模型') }}</a>
    </template>
    <div v-if="wallet.address" class="wallet-chip">
      <span v-if="wallet.kind === 'dev'" class="dev" :title="t('anvil 默认助记词的账号，只用于本地开发')">{{ t('本地开发') }}</span>
      <a class="mono" :href="href.entries()" :title="wallet.address">{{ shortAddress(wallet.address) }}</a>
      <span class="mono muted">{{ formatMon(balance) }}</span>
      <button type="button" class="btn-link" @click="wallet.logout">{{ t('退出') }}</button>
    </div>
    <button v-else type="button" class="btn btn-primary" :disabled="!wallet.ready || wallet.kind === 'none'" @click="wallet.login" :title="wallet.kind === 'dev' ? wallet.label : ''">
      {{ t('登录') }}
    </button>
  </SiteBar>
</template>
