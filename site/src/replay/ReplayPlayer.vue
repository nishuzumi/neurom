<script setup>
// replay/ReplayPlayer.vue — the replay of one challenge: the dark panel with the board, segmented tabs for the 6
// episodes (HashSmash style), a step slider and play / pause. The states come from scene.js, the drawing from the
// view script of the template in ScriptFrame.vue. `replay` is `client.replay(id)`; `names` the name map; `autoplay`
// runs through all episodes without controls (the hero panel).
// The position (episode, step) belongs to the challenge, not to the `replay` object: the pages fetch the replay again
// on every block, and a refresh of the same challenge must not move the player. Only another challenge starts over.
// Without `autoplay`, the player stops on the last state of an episode and stays there; the user picks the next one.
import { computed, shallowRef, watch } from 'vue';
import ScriptFrame from './ScriptFrame.vue';
import { episodeStates, tankScene } from './scene.js';
import { challengerSideOf, episodeResult } from './episodes.js';
import { t } from '../i18n.js';
import { nameOf } from '../ladder/format.js';

const STEP_MS = 350;
const EPISODE_PAUSE_MS = 1200;

const props = defineProps({
  replay: { type: Object, default: null },
  names: { type: Object, required: true },
  autoplay: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
});
const scene = tankScene();
const episodes = computed(() => props.replay?.episodes ?? []);
const challenger = computed(() => props.replay?.challenger ?? null);
const episode = shallowRef(0);
const step = shallowRef(0);
const playing = shallowRef(props.autoplay);
const live = shallowRef(false);
const ep = computed(() => episodes.value[episode.value]);
// the states of the episode: the actions of a challenge on chain never change, so the same episode with the same
// number of actions gives the same states. A refresh of the replay keeps them (and the board does not redraw).
const states = shallowRef([]);
watch([() => props.replay?.id, () => ep.value?.episode, () => ep.value?.seed, () => ep.value?.actions?.length], () => {
  states.value = ep.value ? episodeStates(scene, ep.value) : [];
}, { immediate: true });
const last = computed(() => Math.max(0, states.value.length - 1));
const at = computed(() => Math.min(step.value, last.value));
const ended = computed(() => !!ep.value && ep.value.end >= 0);

// the player: one step per STEP_MS. At the end of an episode autoplay goes on to the next one (and loops); the
// manual player stops and keeps the last state.
watch([playing, episode, at, last, () => episodes.value.length, () => props.autoplay], ([on, , now, end, count, autoplay], _, onCleanup) => {
  if (!on) return;
  if (now >= end && !autoplay) { playing.value = false; return; }
  const timer = setTimeout(() => {
    if (now < end) { live.value = true; step.value = now + 1; return; }
    live.value = false;
    step.value = 0;
    episode.value = (episode.value + 1) % Math.max(1, count);
  }, now < end ? STEP_MS : EPISODE_PAUSE_MS);
  onCleanup(() => clearTimeout(timer));
}, { immediate: true });

// another challenge: start again. A change of `autoplay` alone (the challenge ended) only starts or stops the player.
watch(() => props.replay?.id, () => { episode.value = 0; step.value = 0; live.value = false; });
watch([() => props.replay?.id, () => props.autoplay], () => { playing.value = props.autoplay; });

const state = computed(() => states.value[at.value] ?? null);
const ctx = computed(() => (state.value ? { state: state.value, live: live.value } : null));
const challengerSide = computed(() => (ep.value ? challengerSideOf(ep.value, challenger.value) : 0));
const sideName = k => nameOf(props.names, ep.value?.[k ? 'side1' : 'side0']);
const sideRole = k => (challengerSide.value === k ? ` · ${t('挑战者')}` : ` · ${t('擂主')}`);
/** Go to step `s` of episode `e` without animation. A manual move stops the player. */
const jump = (e, s) => { playing.value = false; live.value = false; episode.value = e; step.value = s; };
const toggle = () => { if (playing.value) playing.value = false; else { if (at.value >= last.value) jump(episode.value, 0); playing.value = true; } };
</script>

<template>
  <div v-if="!replay" class="replay-panel replay-empty">{{ t('还没有挑战可以回放') }}</div>
  <div v-else :class="`replay-panel${compact ? ' replay-compact' : ''}`">
    <div v-if="!compact" class="replay-tabs" role="tablist">
      <button v-for="(e, i) in episodes" :key="i" type="button" role="tab" :aria-selected="i === episode" :class="`seg${i === episode ? ' on' : ''}`" @click="jump(i, 0)">
        <span class="seg-n">{{ t('第 {n} 局', { n: e.episode + 1 }) }}</span>
        <span class="seg-r">{{ episodeResult(e, challengerSideOf(e, challenger)) }}</span>
      </button>
    </div>
    <div class="replay-sides mono">
      <span class="side side0">■ {{ sideName(0) }}{{ sideRole(0) }}</span>
      <span class="side side1">■ {{ sideName(1) }}{{ sideRole(1) }}</span>
      <span class="side-ep">{{ t('第 {n} 局', { n: (ep?.episode ?? episode) + 1 }) }} · {{ t('第 {t} 步', { t: at }) }} / {{ last }}{{ ended && at >= last ? ` · ${episodeResult(ep, challengerSide)}` : '' }}</span>
    </div>
    <ScriptFrame :source="scene.viewScript" :ctx="ctx" class="replay-board" />
    <div v-if="!compact" class="replay-controls">
      <button type="button" class="btn btn-dark" @click="toggle">{{ playing ? t('暂停') : t('播放') }}</button>
      <button type="button" class="btn btn-dark" @click="jump(episode, Math.max(0, at - 1))" :disabled="at === 0">{{ t('上一步') }}</button>
      <button type="button" class="btn btn-dark" @click="jump(episode, Math.min(last, at + 1))" :disabled="at >= last">{{ t('下一步') }}</button>
      <button type="button" class="btn btn-dark" @click="jump(episode, last)" :disabled="at >= last">{{ t('最后一步') }}</button>
      <input type="range" :min="0" :max="last" :value="at" @input="jump(episode, Number($event.target.value))" :aria-label="t('当前步')" />
      <span class="mono muted">{{ ep ? t('种子 {seed}', { seed: ep.seed }) : '' }}</span>
    </div>
    <div v-if="!compact" class="replay-note muted">{{ t('棋盘里的“我方”是第 0 方，“机器人”是第 1 方。颜色和上面的两方一致。') }}</div>
  </div>
</template>
