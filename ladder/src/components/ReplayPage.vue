<script setup>
// components/ReplayPage.vue — the view 回放: the dark panel with the board, the segmented tabs of the 6 episodes
// and the step slider (ReplayPlayer), with the facts of the challenge beside it.
import { computed, shallowRef, watch } from 'vue';
import { t } from '../i18n.js';
import { href } from '../router.js';
import { useLadder } from '../ladder/use-ladder.js';
import { useWallet } from '../wallet/wallet.js';
import { describeError } from '../ladder/errors.js';
import { formatInt, nameOf, score, shortAddress } from '../ladder/format.js';
import { viewerSide } from '../ladder/outcome.js';
import ReplayPlayer from '../replay/ReplayPlayer.vue';
import StatusPill from './StatusPill.vue';

const props = defineProps({ id: { type: String, default: null } });
const ladder = useLadder();
const wallet = useWallet();
const numeric = computed(() => Number(props.id));
const info = shallowRef(null);
const replay = shallowRef(null);
const error = shallowRef(null);
watch([() => ladder.client, numeric], ([client, id], _, onCleanup) => {
  let on = true;
  onCleanup(() => { on = false; });
  (async () => {
    try {
      const [i, r] = await Promise.all([client.challengeInfo(id), client.replay(id)]);
      if (on) { info.value = i; replay.value = r; }
    } catch (e) { if (on) error.value = e; }
  })();
}, { immediate: true });
</script>

<template>
  <div class="view"><div class="wrap">
    <div class="view-head">
      <div>
        <span class="label">{{ t('回放') }} #{{ id }}</span>
        <h2>{{ info ? `${nameOf(ladder.names, info.challenger)} vs ${nameOf(ladder.names, info.defender)}` : t('回放') }}</h2>
      </div>
      <div class="row">
        <StatusPill v-if="info" :status="info.status" :side="viewerSide(info, ladder.entries, wallet.address)" />
        <a v-if="info && Number(info.status) === 1" class="btn btn-small" :href="href.challenge(numeric)">{{ t('进度') }}</a>
        <a :href="href.main('recent')" class="btn">{{ t('最近的挑战') }}</a>
      </div>
    </div>
    <div v-if="error" class="msg bad">{{ describeError(error, { config: ladder.config, block: ladder.block }) }}</div>
    <dl v-if="info" class="kv card">
      <dt>{{ t('挑战者') }}</dt><dd>{{ nameOf(ladder.names, info.challenger) }} · {{ shortAddress(info.challenger) }}</dd>
      <dt>{{ t('擂主') }}</dt><dd>{{ nameOf(ladder.names, info.defender) }} · {{ shortAddress(info.defender) }}</dd>
      <dt>{{ t('比分') }}</dt><dd>{{ score(info.challengerWins, info.defenderWins) }}</dd>
      <dt>{{ t('种子') }}</dt><dd>{{ info.seed }}</dd>
      <dt>{{ t('发起块') }}</dt><dd>{{ formatInt(info.startBlock) }}</dd>
    </dl>
    <ReplayPlayer v-if="replay" :replay="replay" :names="ladder.names" />
    <p class="muted" style="margin: 0; font-size: 13px">{{ t('回放由种子、事件里的动作和模板的场景重建，页面不读任何权重。') }}</p>
  </div></div>
</template>
