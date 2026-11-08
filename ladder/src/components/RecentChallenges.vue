<script setup>
// components/RecentChallenges.vue — [4] the recent challenges, as the HashSmash result table: challenger, defender,
// score, a result pill, gas, time and the replay link.
import { shallowRef, watch } from 'vue';
import { t } from '../i18n.js';
import { href } from '../router.js';
import { useLadder } from '../ladder/use-ladder.js';
import { useWallet } from '../wallet/wallet.js';
import { formatGas, formatInt, formatTime, nameOf, score } from '../ladder/format.js';
import { viewerSide } from '../ladder/outcome.js';
import StatusPill from './StatusPill.vue';

const ladder = useLadder();
const wallet = useWallet();

/** The timestamps of the start blocks of the recent challenges, read once per block. `known` bumps when more arrive. */
const times = new Map();
const known = shallowRef(0);
watch(() => ladder.recent, (items, _, onCleanup) => {
  let on = true;
  onCleanup(() => { on = false; });
  const missing = items.map(c => Number(c.startBlock)).filter(b => b && !times.has(b));
  if (!missing.length) return;
  Promise.all(missing.map(b => wallet.provider.getBlock(b).then(blk => { if (blk) times.set(b, blk.timestamp); }, () => {}))).then(() => { if (on) known.value += 1; });
}, { immediate: true });
const timeOf = b => (known.value, times.get(Number(b)) ?? null);
</script>

<template>
  <div class="section-head"><div><span class="label">{{ t('最近的挑战') }} / 04</span><h2>{{ t('最近的挑战') }}</h2></div></div>
  <div v-if="!ladder.recentLoaded" class="empty">{{ t('读取中…') }}</div>
  <div v-else-if="ladder.recent.length === 0" class="empty">{{ t('还没有挑战') }}</div>
  <table v-else class="table">
    <colgroup><col style="width: 56px" /><col /><col /><col style="width: 70px" /><col style="width: 130px" /><col style="width: 80px" /><col style="width: 170px" /><col style="width: 70px" /></colgroup>
    <thead><tr>
      <th>#</th><th>{{ t('挑战者') }}</th><th>{{ t('擂主') }}</th><th class="num">{{ t('比分') }}</th><th>{{ t('结果') }}</th><th class="num">gas</th><th>{{ t('时间') }}</th><th />
    </tr></thead>
    <tbody>
      <tr v-for="c in ladder.recent" :key="c.id">
        <td class="rank">{{ c.id }}</td>
        <td class="mono" :title="c.challenger">{{ nameOf(ladder.names, c.challenger) }}</td>
        <td class="mono" :title="c.defender">{{ nameOf(ladder.names, c.defender) }}</td>
        <td class="num mono">{{ score(c.challengerWins, c.defenderWins) }}</td>
        <td><StatusPill :status="c.status" :side="viewerSide(c, ladder.entries, wallet.address)" /></td>
        <td class="num mono" :title="formatInt(c.gasUsed ?? 0)">{{ c.gasUsed ? formatGas(c.gasUsed) : '—' }}</td>
        <td class="mono" :title="t('第 {block} 块', { block: formatInt(c.startBlock) })">{{ formatTime(timeOf(c.startBlock)) }}</td>
        <td><a :href="c.status === 1 ? href.challenge(c.id) : href.replay(c.id)">{{ c.status === 1 ? t('进度') : t('回放') }}</a></td>
      </tr>
    </tbody>
  </table>
  <div class="footnote">
    <span>{{ t('比分是挑战者赢的局数 : 擂主赢的局数。gas 为比赛推进所用，不含超时结算。') }}</span>
  </div>
</template>
