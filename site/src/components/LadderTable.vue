<script setup>
// components/LadderTable.vue — [2] the ladder, as the OKC leaderboard: rank, name (or short address), the weight size
// with a bar against the maximum (rank 1 in the accent colour), the record, the owner. The entries off the board follow
// the board under their own heading. After the login, the rows the selected entry can challenge show a 挑战 button.
// Status pills (HashSmash) say 挑战中 or 冷却到第 N 块.
// The challenge dialog (ChallengeDialog.vue) shows the estimated cost and refuses to send when the balance is too low.
import { computed, shallowRef, watch } from 'vue';
import { t } from '../i18n.js';
import { href } from '../router.js';
import { entriesOf, entryOf, useLadder } from '../ladder/use-ladder.js';
import { useChallenge } from '../ladder/use-challenge.js';
import { useWallet } from '../wallet/wallet.js';
import { ladderErrorMessage } from '../ladder/errors.js';
import { addressKey, formatInt, nameOf, rankLabel, rankTag, score, shortAddress } from '../ladder/format.js';
import ChallengeDialog from './ChallengeDialog.vue';

const ladder = useLadder();
const wallet = useWallet();
const challenge = useChallenge();
const mine = computed(() => entriesOf(ladder.entries, wallet.address));
const ranked = computed(() => ladder.entries.filter(e => e.rank > 0).sort((a, b) => a.rank - b.rank));
const off = computed(() => ladder.entries.filter(e => e.rank === 0));
const challengerModule = shallowRef(null);
const challenger = computed(() => entryOf(mine.value, challengerModule.value) ?? mine.value[mine.value.length - 1] ?? null);
const targets = shallowRef({});
const dialog = shallowRef(null);

watch([() => challenger.value?.module, () => ladder.tick], ([module], _, onCleanup) => {
  if (!module) { targets.value = {}; return; }
  let on = true;
  onCleanup(() => { on = false; });
  ladder.client.targets(module).then(list => { if (on) targets.value = Object.fromEntries(list.map(x => [addressKey(x.module), x])); }, () => {});
}, { immediate: true });

const max = computed(() => (ladder.config ? Number(ladder.config.maxWeightBytes) : 0));
/** The facts of one row: `{ e, isMine, target, canChallenge, refusal }`. */
const rows = list => list.map(e => {
  const target = targets.value[addressKey(e.module)] ?? null;
  return {
    e,
    isMine: mine.value.includes(e),
    target,
    canChallenge: !!(challenger.value && target && !target.reason && !challenge.busy),
    refusal: target?.reason ? ladderErrorMessage(target.reason, { config: ladder.config }) ?? target.reason : null,
  };
});
/** The board, then the entries off the board under their heading. */
const groups = computed(() => [
  { key: 'ranked', head: null, rows: rows(ranked.value) },
  { key: 'off', head: off.value.length > 0 ? t('榜外：{n} 个出战模型', { n: formatInt(off.value.length) }) : null, rows: rows(off.value) },
]);
const challengerText = computed(() => {
  const c = challenger.value;
  return c.rank > 0 ? t('挑战者：{name}（第 {rank} 名）', { name: nameOf(ladder.names, c.module), rank: c.rank }) : t('挑战者：{name}（榜外）', { name: nameOf(ladder.names, c.module) });
});
</script>

<template>
  <div class="section-head">
    <div><span class="label">{{ t('擂台榜') }} / 02</span><h2>{{ t('擂台榜') }}</h2></div>
    <div class="section-tools">
      <label v-if="wallet.address && mine.length > 1" class="row">{{ t('用哪个出战模型挑战') }}
        <select :value="challenger?.module ?? ''" @change="challengerModule = $event.target.value">
          <option v-for="e in mine" :key="e.module" :value="e.module">{{ rankTag(e.rank) }} {{ nameOf(ladder.names, e.module) }}</option>
        </select>
      </label>
      <span v-if="wallet.address && mine.length === 1" class="muted">{{ challengerText }}</span>
      <a v-if="wallet.address && mine.length === 0" :href="href.entries()" class="btn btn-small">{{ t('注册出战模型') }}</a>
      <span class="muted mono">{{ t('权重字节数上限 {max}', { max: formatInt(max) }) }}</span>
    </div>
  </div>
  <div v-if="ladder.entries.length === 0" class="empty">{{ t('还没有出战模型') }}</div>
  <table v-else class="table">
    <colgroup><col style="width: 48px" /><col style="width: 22%" /><col /><col style="width: 90px" /><col style="width: 120px" /><col style="width: 150px" /></colgroup>
    <thead><tr>
      <th>#</th><th>{{ t('名字') }}</th><th>{{ t('权重字节数') }}</th><th class="num">{{ t('战绩') }}</th><th>{{ t('拥有者') }}</th><th>{{ t('状态') }}</th>
    </tr></thead>
    <tbody>
      <template v-for="g in groups" :key="g.key">
        <tr v-if="g.head" class="off-head"><td colspan="6">{{ g.head }}</td></tr>
        <tr v-for="{ e, isMine, target, canChallenge, refusal } in g.rows" :key="e.module" :class="isMine ? 'mine' : ''">
          <td class="rank">{{ rankLabel(e.rank) }}</td>
          <td :title="e.module"><span class="mono">{{ nameOf(ladder.names, e.module) }}</span></td>
          <td>
            <div class="bar">
              <span class="v">{{ formatInt(e.weightBytes) }}</span>
              <div class="track"><div :class="`fill${e.rank === 1 ? ' top' : ''}`" :style="{ width: `${max ? Math.min(100, (100 * e.weightBytes) / max) : 0}%` }" /></div>
            </div>
          </td>
          <td class="num mono">{{ score(e.wins, e.losses) }}</td>
          <td class="mono" :title="e.owner">{{ isMine ? t('我') : shortAddress(e.owner) }}</td>
          <td>
            <a v-if="e.activeChallenge !== 0" class="pill live" :href="href.challenge(e.activeChallenge)">{{ t('挑战中') }} #{{ e.activeChallenge }}</a>
            <span v-else-if="target?.reason === 'Cooldown'" class="pill warn" :title="ladderErrorMessage('Cooldown', { config: ladder.config, cooldownUntil: target.cooldownUntil, block: ladder.block })">{{ t('冷却到第 {block} 块', { block: formatInt(target.cooldownUntil) }) }}</span>
            <span v-else-if="target?.reason" class="pill" :title="refusal">{{ refusal }}</span>
            <button v-else-if="canChallenge" type="button" class="btn btn-primary btn-small" @click="dialog = e">{{ t('挑战') }}</button>
          </td>
        </tr>
      </template>
    </tbody>
  </table>
  <div class="footnote">
    <span>{{ t('条形是权重字节数和上限的比。第 1 名的条是强调色。') }}</span>
    <span>{{ t('登录以后，比你的出战模型高 1 到 {range} 名、不在冷却中、没有在挑战中的行显示“挑战”按钮。', { range: ladder.config?.range ?? '—' }) }}</span>
    <span v-if="ladder.config">{{ t('榜单有 {size} 个名次。榜单满了以后，新出战模型在榜外。榜外的出战模型当作第 {next} 名发起挑战。', { size: ladder.config.boardSize, next: ladder.config.boardSize + 1 }) }}</span>
  </div>
  <ChallengeDialog v-if="dialog && challenger" :challenger="challenger" :defender="dialog" @close="dialog = null" />
</template>
