<script setup>
// components/ChallengeView.vue — the view 挑战进行中: the 6 episodes as cells, the current step, the transaction
// pipeline (in flight, confirmed), then the result and the rank change. The chain state comes from `challengeInfo`
// (shown as soon as it answers) and `replay` (the episodes so far) while the challenge plays, the pipeline from the
// running challenge of the page. Past the deadline the view settles the challenge by itself for the account that
// owns the challenger (once); anyone logged in can settle it with the button.
import { computed, shallowRef, watch } from 'vue';
import { t } from '../i18n.js';
import { href } from '../router.js';
import { entryOf, useLadder } from '../ladder/use-ladder.js';
import { useChallenge } from '../ladder/use-challenge.js';
import { useWallet } from '../wallet/wallet.js';
import { describeError } from '../ladder/errors.js';
import { formatInt, nameOf, rankTag, score } from '../ladder/format.js';
import { outcomeOf, viewerSide } from '../ladder/outcome.js';
import { EPISODES } from '../chain/client.js';
import ReplayPlayer from '../replay/ReplayPlayer.vue';
import { challengerSideOf, episodeResult } from '../replay/episodes.js';
import StatusPill from './StatusPill.vue';

const props = defineProps({ id: { type: String, default: null } });
const ladder = useLadder();
const challenge = useChallenge();
const wallet = useWallet();
const run = computed(() => challenge.run);
const numeric = computed(() => (props.id !== 'new' && props.id !== null ? Number(props.id) : run.value?.id ?? null));
const read = shallowRef(null);
const replay = shallowRef(null);
const error = shallowRef(null);
const rankBefore = shallowRef(null);
// One read at a time. A public RPC can take longer than a block to answer, so a new block never cancels the read
// in flight: it asks for one more read after it (`again`). A new client or challenge id makes a new flight; the
// old flight's answer and bookkeeping no longer match `flight` and are dropped, also after an unmount.
// A settled challenge is immutable: the page reads it once and keeps the replay object.
let flight = null;
watch([() => ladder.client, numeric], (_, __, onCleanup) => {
  const f = { busy: false, again: false, settled: false };
  flight = f;
  read.value = null; replay.value = null; error.value = null; rankBefore.value = null;
  onCleanup(() => { if (flight === f) flight = null; });
}, { immediate: true });
watch([() => ladder.client, numeric, () => ladder.tick, () => run.value?.phase], ([client, id]) => {
  const f = flight;
  if (id === null || !f || f.settled) return;
  if (f.busy) { f.again = true; return; }
  const current = () => flight === f;
  (async () => {
    f.busy = true;
    try {
      do {
        f.again = false;
        try {
          const i = await client.challengeInfo(id);
          if (!current()) return;
          read.value = i; error.value = null;
          const r = await client.replay(id);
          if (!current()) return;
          replay.value = r;
          if (i && Number(i.status) >= 2) { f.settled = true; return; }
        } catch (e) { if (current()) error.value = e; }
      } while (f.again && current());
    } finally { f.busy = false; }
  })();
}, { immediate: true });

// the challenge the page just settled or played out is known before the next read answers
const ours = computed(() => !!run.value && (run.value.id === numeric.value || numeric.value === null));
const settledByRun = computed(() => (ours.value && run.value.phase === 'done' && run.value.result && Number(run.value.result.status) >= 2 ? run.value.result : null));
const info = computed(() => (settledByRun.value && (!read.value || Number(read.value.status) < 2) ? settledByRun.value : read.value));

// the rank of the challenger when the view first sees the challenge: the change shows against it
const challengerEntry = computed(() => (info.value ? entryOf(ladder.entries, info.value.challenger) : null));
const defenderEntry = computed(() => (info.value ? entryOf(ladder.entries, info.value.defender) : null));
watch([challengerEntry, () => info.value?.status], ([entry]) => { if (entry && rankBefore.value === null && Number(info.value?.status) === 1) rankBefore.value = entry.rank; }, { immediate: true });

const running = computed(() => ours.value && (run.value.phase === 'starting' || run.value.phase === 'playing'));
const settling = computed(() => running.value && (run.value.kind === 'expire' || run.value.progress?.phase === 'settling'));
const progress = computed(() => (ours.value ? run.value.progress : null));
// the route `#/challenge/new` becomes the id as soon as the start receipt names it
watch([() => props.id, () => run.value?.id], ([routeId, id]) => { if (routeId === 'new' && id !== null && id !== undefined) history.replaceState(null, '', href.challenge(id)); }, { immediate: true });
const status = computed(() => Number(info.value?.status ?? 0));
const side = computed(() => viewerSide(info.value, ladder.entries, wallet.address));
const mineChallenger = computed(() => side.value === 'challenger');
const episodes = computed(() => replay.value?.episodes ?? []);
const expired = computed(() => !!info.value && status.value === 1 && ladder.block > Number(info.value.deadline));
// Only the challenger pays automatically. A failed attempt needs an explicit retry.
const canSettle = computed(() => Boolean(wallet.signer) && !challenge.busy && !running.value);
const settle = () => challenge.expire(numeric.value, info.value.challenger, info.value.defender).catch(() => {});
const resume = () => challenge.resume(numeric.value, info.value.challenger, info.value.defender).catch(() => {});
watch([expired, canSettle, mineChallenger, numeric], ([isExpired, can, mine, id]) => {
  if (!isExpired || !can || !mine || id === null || challenge.expireAttempted(id)) return;
  settle();
}, { immediate: true });

/** The cells of the 6 episodes. */
const cells = computed(() => Array.from({ length: EPISODES }, (_, i) => {
  const ep = episodes.value[i];
  const done = !!ep && ep.end >= 0;
  const now = status.value === 1 && Number(info.value.episode) === i;
  const won = done && ep.end === challengerSideOf(ep, info.value.challenger);
  const lost = done && ep.end !== 2 && !won;
  return { i, ep, done, now, won, lost };
}));
const title = computed(() => {
  const i = info.value, r = run.value;
  return i ? `${nameOf(ladder.names, i.challenger)} → ${nameOf(ladder.names, i.defender)}` : r ? `${nameOf(ladder.names, r.challenger)} → ${nameOf(ladder.names, r.defender)}` : t('挑战');
});
</script>

<template>
  <div class="view"><div class="wrap">
    <div class="view-head">
      <div>
        <span class="label">{{ t('挑战') }} {{ numeric !== null ? `#${numeric}` : '' }}</span>
        <h2>{{ title }}</h2>
      </div>
      <div class="row">
        <StatusPill v-if="info" :status="status" :side="side" />
        <a :href="href.main('ladder')" class="btn">{{ t('回到擂台榜') }}</a>
      </div>
    </div>

    <div v-if="ours && run.phase === 'failed'" class="msg bad">{{ describeError(run.error, { config: ladder.config, block: ladder.block }) }}</div>
    <div v-if="error" class="msg bad">{{ describeError(error, { config: ladder.config, block: ladder.block }) }}</div>
    <div v-if="run?.phase === 'starting' && numeric === null" class="msg">{{ t('正在发出第一笔交易，这笔交易就开打…') }}</div>

    <template v-if="info">
      <div class="episodes">
        <div v-for="{ i, ep, done, now, won, lost } in cells" :key="i" :class="`episode${won ? ' won' : ''}${lost ? ' lost' : ''}${now ? ' now' : ''}`">
          <span class="n">{{ t('第 {n} 局', { n: i + 1 }) }}</span>
          <span class="r">{{ done ? episodeResult(ep, challengerSideOf(ep, info.challenger)) : now ? t('第 {t} 步', { t: Number(info.step) }) : '—' }}</span>
          <span v-if="ep" class="muted mono" style="font-size: 11px">{{ t('{n} 步', { n: ep.actions.length }) }}</span>
        </div>
      </div>

      <div class="card">
        <div class="pipeline">
          <div><span class="big accent">{{ score(info.challengerWins, info.defenderWins) }}</span>{{ t('比分（挑战者 : 擂主）') }}</div>
          <div><span class="big">{{ Math.min(EPISODES, Number(info.episode) + 1) }}/{{ EPISODES }}</span>{{ t('局') }}</div>
          <div><span class="big">{{ Number(info.step) }}</span>{{ t('当前步') }}</div>
          <div><span class="big">{{ running ? progress?.inFlight ?? '…' : progress ? 0 : '—' }}</span>{{ t('在途交易') }}</div>
          <div><span class="big">{{ progress ? progress.confirmed : '—' }}</span>{{ t('已确认交易') }}</div>
          <div><span class="big">{{ formatInt(info.startBlock) }}</span>{{ t('发起块') }}</div>
          <div><span class="big">{{ formatInt(info.deadline) }}</span>{{ t('超时块') }}</div>
        </div>
        <div v-if="status === 1 && !running && !expired" class="row" style="margin-top: 14px">
          <span class="muted">{{ t('页面没有在推进这场挑战。') }}</span>
          <button v-if="canSettle" type="button" class="btn btn-primary btn-small" @click="resume">{{ mineChallenger ? t('继续打') : t('帮忙推进') }}</button>
        </div>
        <div v-if="status === 1 && !running && expired" class="row" style="margin-top: 14px">
          <span class="pill bad">{{ t('已超时：任何人都可以结算为守擂成功') }}</span>
          <button v-if="canSettle" type="button" class="btn btn-primary btn-small" @click="settle">{{ ours && run.phase === 'failed' && run.kind === 'expire' ? t('再试一次结算') : t('结算超时') }}</button>
        </div>
        <div v-if="status === 1 && settling" class="muted" style="margin-top: 14px; font-size: 13px">{{ t('已超时，页面正在发结算交易，等回执…') }}</div>
        <div v-if="status === 1 && running && !settling" class="muted" style="margin-top: 14px; font-size: 13px">{{ t('页面正在自动发交易。同一个账户最多 3 笔在途，收到回执以后再发下一笔。') }}</div>
      </div>

      <div v-if="status >= 2" class="card featured stack">
        <div class="result">{{ outcomeOf(status, side).text }}</div>
        <dl class="kv">
          <dt>{{ t('比分') }}</dt><dd>{{ score(info.challengerWins, info.defenderWins) }}</dd>
          <dt>{{ t('挑战者的名次') }}</dt><dd>{{ rankBefore !== null && challengerEntry ? `${rankTag(rankBefore)} → ${rankTag(challengerEntry.rank)}` : challengerEntry ? rankTag(challengerEntry.rank) : '—' }}</dd>
          <dt>{{ t('擂主的名次') }}</dt><dd>{{ defenderEntry ? rankTag(defenderEntry.rank) : '—' }}</dd>
          <template v-if="status === 3 && ladder.config"><dt>{{ t('冷却') }}</dt><dd>{{ t('到第 {block} 块以前不能再挑战这个擂主', { block: formatInt(Number(info.startBlock) + Number(ladder.config.cooldownBlocks)) }) }}</dd></template>
        </dl>
        <div class="row"><a class="btn btn-primary" :href="href.replay(numeric)">{{ t('回放') }}</a><a class="btn" :href="href.main('ladder')">{{ t('看榜单') }}</a></div>
      </div>

      <ReplayPlayer v-if="episodes.length > 0" :replay="replay" :names="ladder.names" :autoplay="status === 1" :compact="status === 1" />
    </template>
  </div></div>
</template>
