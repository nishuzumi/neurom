<script setup>
// App.vue — the root of the ladder page: the providers (wallet, ladder data, the running challenge), the top bar and
// the view of the route. The main page is one long page (ui-reference.md): hero, data strip, then the numbered
// sections. The other views are my entries, a challenge in progress and a replay.
import { onErrorCaptured, shallowRef } from 'vue';
import { pageConfig } from './config.js';
import { useRoute } from './router.js';
import { t } from './i18n.js';
import { provideWallet } from './wallet/wallet.js';
import { readConnection } from '../../frontend/chain.js';
import { provideLadder } from './ladder/use-ladder.js';
import { provideChallenge } from './ladder/use-challenge.js';
import TopBar from './components/TopBar.vue';
import MainPage from './components/MainPage.vue';
import MyEntries from './components/MyEntries.vue';
import ChallengeView from './components/ChallengeView.vue';
import ReplayPage from './components/ReplayPage.vue';
import { describeChainError } from '../../frontend/chain-error.js';

const config = pageConfig();
/** The read provider of the page: one connection to the chain of the configuration. */
const { provider } = readConnection(config.chainId);
const route = useRoute();

/** A render error shows its message instead of a blank page. */
const fatal = shallowRef(null);
onErrorCaptured(error => { fatal.value = error; return false; });
const reload = () => location.reload();

const privyHost = shallowRef(null);
const wallet = provideWallet(config, provider, privyHost);
const ladder = provideLadder({ config, provider, signer: () => wallet.signer, includeRecent: () => route.value.view === 'main' });
provideChallenge(ladder, wallet);
</script>

<template>
  <div v-if="fatal" class="wrap"><div class="msg bad" style="margin-top: 40px">{{ t('页面出错了：{message}', { message: fatal.message }) }} <button type="button" class="btn-link" @click="reload">{{ t('重新加载') }}</button></div></div>
  <template v-else>
    <div v-if="wallet.kind === 'privy'" ref="privyHost" />
    <TopBar :route="route" />
    <div v-if="!config.ladder" class="wrap"><div class="msg warn" style="margin-top: 20px">{{ t('这条链（{name}）上还没有部署擂台合约', { name: config.name }) }}</div></div>
    <div v-if="ladder.error" class="wrap"><div class="msg bad" style="margin-top: 20px">{{ t('读不到链上数据：{message}', { message: describeChainError(ladder.error) }) }}</div></div>
    <div v-if="wallet.error" class="wrap"><div class="msg bad" role="alert" style="margin-top: 20px">{{ t('钱包连接失败：{message}', { message: describeChainError(wallet.error) }) }}</div></div>
    <MainPage v-if="route.view === 'main'" :config="config" :route="route" />
    <MyEntries v-else-if="route.view === 'entries'" :config="config" />
    <ChallengeView v-else-if="route.view === 'challenge'" :id="route.id" />
    <ReplayPage v-else-if="route.view === 'replay'" :id="route.id" />
    <footer class="footer"><div class="wrap">
      <span>NEUROM · {{ t('坦克擂台') }}</span>
      <span class="mono">{{ config.name }} · {{ t('合约') }} {{ config.ladder ?? '—' }}</span>
      <span v-if="!ladder.loaded">{{ t('读取中…') }}</span>
    </div></footer>
  </template>
</template>
