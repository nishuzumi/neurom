<script setup>
// components/EntryCard.vue — one entry of the account. `moduleId`: the English id of the module in the archive of the
// Factory when this account deployed it (null: another account deployed it). The name is the display name of the
// contest, apart.
import { computed, shallowRef } from 'vue';
import { t } from '../i18n.js';
import { href } from '../router.js';
import { useLadder } from '../ladder/use-ladder.js';
import { useChallenge } from '../ladder/use-challenge.js';
import { useWallet } from '../wallet/wallet.js';
import { describeError, nameErrorMessage } from '../ladder/errors.js';
import { BANNED_WORDS, setName, validateName } from '../ladder/names.js';
import { formatInt, rankLabel, score, shortAddress } from '../ladder/format.js';

const props = defineProps({
  entry: { type: Object, required: true },
  name: { type: String, default: null },
  moduleId: { type: String, default: null },
  config: { type: Object, required: true },
});
const ladder = useLadder();
const wallet = useWallet();
const challenge = useChallenge();
const draft = shallowRef('');
const error = shallowRef(null);
const busy = shallowRef(false);
const local = computed(() => (draft.value ? validateName(draft.value, BANNED_WORDS) : null));
const active = computed(() => props.entry.activeChallenge || null);
const resume = () => challenge.resume(active.value, props.entry.module, null).catch(() => {});
const submit = async () => {
  busy.value = true; error.value = null;
  try {
    await setName({ signer: wallet.signer, chainId: props.config.chainId, module: props.entry.module, name: draft.value });
    draft.value = '';
    ladder.refreshName(props.entry.module);
  } catch (err) { error.value = err; } finally { busy.value = false; }
};
</script>

<template>
  <div class="card entry">
    <div class="rank">{{ rankLabel(entry.rank) }}</div>
    <div class="stack" style="gap: 6px">
      <div class="name">{{ name ?? shortAddress(entry.module) }}</div>
      <div v-if="moduleId" class="meta">{{ t('英文 ID') }} {{ moduleId }}</div>
      <div class="meta">{{ entry.module }}</div>
      <div v-if="entry.rank === 0" class="meta">{{ t('在榜外。挑战成功就能上榜。') }}</div>
      <div class="meta">{{ t('权重字节数 {n}', { n: formatInt(entry.weightBytes) }) }} · {{ t('战绩') }} {{ score(entry.wins, entry.losses) }}</div>
      <form v-if="name === null" class="row" @submit.prevent="submit">
        <input type="text" :value="draft" @input="draft = $event.target.value" :placeholder="t('起一个英文名字（3 到 24 个字符）')" :aria-label="t('名字')" :disabled="busy" style="flex: 1 1 160px" />
        <button type="submit" class="btn btn-small" :disabled="!draft || !!local || busy">{{ busy ? t('签名中…') : t('设置名字') }}</button>
        <span v-if="local" class="msg bad" style="padding: 4px 8px">{{ nameErrorMessage(local) }}</span>
        <span v-if="error" class="msg bad" style="padding: 4px 8px">{{ describeError(error, { config: ladder.config }) }}</span>
      </form>
      <div v-if="name !== null" class="meta">{{ t('名字设置以后不能改。') }}</div>
    </div>
    <div class="entry-actions">
      <a v-if="active" class="pill live" :href="href.challenge(active)">{{ t('挑战中') }} #{{ active }}</a>
      <button v-if="active && !challenge.busy" type="button" class="btn btn-small" @click="resume">{{ t('继续打') }}</button>
      <a v-if="!active" class="btn btn-small" :href="href.main('ladder')">{{ t('去挑战') }}</a>
    </div>
  </div>
</template>
