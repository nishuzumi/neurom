<script setup>
// components/RememberedChallenge.vue — the challenge that localStorage remembers from a closed page, when it still runs.
import { computed } from 'vue';
import { t } from '../i18n.js';
import { useChallenge } from '../ladder/use-challenge.js';
import { nameOf } from '../ladder/format.js';

const props = defineProps({ mine: { type: Array, required: true } });
const challenge = useChallenge();
// localStorage is not reactive. The page writes it together with `challenge.run`, so the id follows the run.
const id = computed(() => (challenge.run, challenge.remembered()));
const entry = computed(() => props.mine.find(e => Number(e.activeChallenge) === id.value));
const resume = () => challenge.resume(id.value, entry.value.module, null).catch(() => {});
</script>

<template>
  <div v-if="id && entry && !challenge.busy" class="msg warn row">
    <span>{{ t('上次关掉页面时，{name} 的挑战 #{id} 还没打完。', { name: nameOf({}, entry.module), id }) }}</span>
    <button type="button" class="btn btn-small" @click="resume">{{ t('继续打') }}</button>
  </div>
</template>
