<script setup>
// components/Hero.vue — the first screen of the main page: the title, the three steps and the actions on the left,
// the replay of the latest decided episode on the right.
import { computed, shallowRef, watch } from 'vue';
import { t } from '../i18n.js';
import { site } from '../site.js';
import { href } from '../router.js';
import { useLadder } from '../ladder/use-ladder.js';
import { useWallet } from '../wallet/wallet.js';
import { nameOf } from '../ladder/format.js';
import ReplayPlayer from '../replay/ReplayPlayer.vue';
import Steps from './Steps.vue';

const ladder = useLadder();
const wallet = useWallet();
const featured = computed(() => ladder.recent.find(c => c.challengerWins > 0 || c.defenderWins > 0) ?? null);
const replay = shallowRef(null);
const featuredReplay = computed(() => (replay.value?.id === featured.value?.id ? replay.value : null));
watch([() => featured.value?.id, () => (featured.value?.status === 1 ? ladder.tick : 0)], (_, __, onCleanup) => {
  const f = featured.value;
  if (!f) { replay.value = null; return; }
  let on = true;
  onCleanup(() => { on = false; });
  ladder.client.replay(f.id).then(r => {
    if (on) replay.value = { ...r, episodes: r.episodes.filter(ep => ep.end === 0 || ep.end === 1) };
  }, () => {});
}, { immediate: true });
</script>

<template>
  <section class="hero"><div class="wrap">
    <div class="hero-left">
      <span class="label">NEUROM / {{ t('坦克大战擂台赛') }}</span>
      <h1>{{ t('坦克擂台') }}</h1>
      <p class="lead">{{ t('把工作台里训练的坦克网络注册成出战模型，挑战排在你上面的出战模型。裁判是链上合约，每一场都能回放和复现。') }}</p>
      <Steps />
      <div class="hero-actions">
        <a v-if="wallet.address" class="btn btn-primary" :href="href.entries()">{{ t('注册出战模型') }}</a>
        <button v-else type="button" class="btn btn-primary" :disabled="!wallet.ready || wallet.kind === 'none'" @click="wallet.login">{{ t('登录并注册出战模型') }}</button>
        <a class="btn" :href="href.main('rules')">{{ t('看规则') }}</a>
        <a class="btn" :href="site.guide">{{ t('参与指南') }}</a>
      </div>
    </div>
    <div class="hero-right">
      <ReplayPlayer v-if="featuredReplay?.episodes.length > 0" :replay="featuredReplay" :names="ladder.names" autoplay compact />
      <div v-else class="replay-panel replay-empty">{{ ladder.recentLoaded && (!featured || featuredReplay) ? t('还没有分出胜负的对局') : t('读取中…') }}</div>
      <div class="hero-caption">
        <template v-if="featuredReplay?.episodes.length > 0">
          <span>{{ t('胜负回放') }} · #{{ featuredReplay.id }} · {{ nameOf(ladder.names, featuredReplay.challenger) }} vs {{ nameOf(ladder.names, featuredReplay.defender) }}</span>
          <a :href="href.replay(featuredReplay.id)">{{ t('回放') }} →</a>
        </template>
      </div>
    </div>
  </div></section>
</template>
