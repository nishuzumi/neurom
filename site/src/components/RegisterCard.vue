<script setup>
// components/RegisterCard.vue — the archive of the account: a select of its modules by English id. A module already on
// the ladder (under any account) is shown but cannot be chosen. The parent keys the card by the account, so a choice
// never survives an account change.
import { computed, shallowRef } from 'vue';
import { t } from '../i18n.js';
import { useLadder } from '../ladder/use-ladder.js';
import { useWallet } from '../wallet/wallet.js';
import { describeError } from '../ladder/errors.js';
import { addressKey, shortAddress } from '../ladder/format.js';

const props = defineProps({ config: { type: Object, required: true }, archive: { type: Object, required: true } });
const wallet = useWallet();
const ladder = useLadder();
const choice = shallowRef('');
const error = shallowRef(null);
const status = shallowRef([]);
const busy = shallowRef(false);
const done = shallowRef(null);
const entered = computed(() => new Map(ladder.entries.map(e => [addressKey(e.module), e])));
const selected = computed(() => props.archive.items.find(d => addressKey(d.module) === choice.value) ?? null);
const selectedEntry = computed(() => (selected.value ? entered.value.get(addressKey(selected.value.module)) ?? null : null));
const valid = computed(() => !!selected.value && !selectedEntry.value);

const register = async () => {
  if (!valid.value) { choice.value = ''; return; }
  busy.value = true; status.value = []; done.value = null; error.value = null;
  try {
    const module = selected.value;
    const result = await ladder.client.register(module.module, { onStatus: s => { status.value = [...status.value, s.message]; } });
    done.value = { ...result, moduleId: module.moduleId };
    choice.value = '';
    ladder.refresh();
  } catch (e) { error.value = e; } finally { busy.value = false; }
};
const enteredText = rank => (rank > 0 ? t('已注册，第 {rank} 名', { rank }) : t('已注册，在榜外'));
const optionLabel = d => {
  const e = entered.value.get(addressKey(d.module));
  const base = `${d.moduleId || shortAddress(d.module)} · ${shortAddress(d.module)} · ${d.kindName} ${d.inputs}→${d.outputs}`;
  return e ? `${base} · ${enteredText(e.rank)}` : base;
};
const doneText = computed(() => {
  const d = done.value;
  if (!d) return '';
  return d.rank > 0
    ? t('已注册：{id}（{module}），第 {rank} 名', { id: d.moduleId || shortAddress(d.module), module: shortAddress(d.module), rank: d.rank })
    : t('已注册：{id}（{module}），在榜外。榜单已满。', { id: d.moduleId || shortAddress(d.module), module: shortAddress(d.module) });
});
</script>

<template>
  <div class="card featured stack">
    <div><span class="label">{{ t('注册') }}</span><h3 style="margin-top: 6px">{{ t('注册你部署的模块') }}</h3></div>
    <p class="muted" style="margin: 0; font-size: 13px">{{ t('在工作台的部署模块里，给接受的候选起一个英文 ID，用这个账号通过官方 Factory 部署到这条链上。页面从 Factory 的存档里列出这个账号部署过的模块，你选一个注册。页面只发注册交易，不会再部署一次。') }}</p>
    <dl class="kv">
      <dt>{{ t('链') }}</dt><dd>{{ config.name }} · {{ config.chainId }}</dd>
      <dt>{{ t('官方 Factory') }}</dt><dd class="mono">{{ ladder.config ? ladder.config.factory : '…' }}</dd>
      <dt>{{ t('部署账号') }}</dt><dd class="mono">{{ wallet.address }}</dd>
    </dl>
    <div class="field">
      <label for="module-choice">{{ t('你部署的模块') }}</label>
      <select id="module-choice" :value="choice" @change="choice = $event.target.value" :disabled="busy || !archive.loaded">
        <option value="">{{ archive.loaded ? (archive.items.length ? t('选一个模块') : t('这个账号还没有部署过模块')) : t('读取中…') }}</option>
        <option v-for="d in archive.items" :key="d.module" :value="addressKey(d.module)" :disabled="entered.has(addressKey(d.module))">{{ optionLabel(d) }}</option>
      </select>
    </div>
    <div v-if="archive.loaded && archive.items.length === 0" class="msg">{{ t('先在工作台里部署一个模块。部署以后回到这个页面，模块会出现在这里，不用复制地址。') }}</div>
    <div v-if="archive.error" class="msg bad">{{ t('读不到 Factory 的存档：{message}', { message: describeError(archive.error) }) }} <button type="button" class="btn-link" @click="archive.reload">{{ t('重试') }}</button></div>
    <dl v-if="selected" class="kv">
      <dt>{{ t('英文 ID') }}</dt><dd>{{ selected.moduleId }}</dd>
      <dt>{{ t('模块地址') }}</dt><dd>{{ selected.module }}</dd>
      <dt>{{ t('结构') }}</dt><dd>{{ selected.kindName }} · {{ selected.inputs }} → {{ selected.outputs }}</dd>
      <dt>{{ t('产物 ID') }}</dt><dd>{{ selected.artifactId }}</dd>
      <dt>{{ t('状态') }}</dt><dd><span v-if="selectedEntry" class="pill ok">{{ enteredText(selectedEntry.rank) }}</span><span v-else class="pill">{{ t('还没有注册') }}</span></dd>
    </dl>
    <div v-if="selectedEntry" class="msg warn">{{ t('这个模块已经在擂台上，不能再注册一次。') }}</div>
    <div v-if="error" class="msg bad">{{ describeError(error, { config: ladder.config }) }}</div>
    <div v-if="status.length > 0" class="msg mono" style="font-size: 12px"><div v-for="(s, i) in status" :key="i">{{ s }}</div></div>
    <div v-if="done" class="msg ok">{{ doneText }}</div>
    <p class="muted" style="margin: 0; font-size: 13px">{{ t('合约把出战模型记在发注册交易的账号名下，不看模块是谁部署的。这里只列出当前账号部署的模块。用你准备挑战的账号部署和注册。') }}</p>
    <div class="row">
      <button type="button" class="btn btn-primary" :disabled="!valid || busy || !archive.loaded" @click="register">{{ busy ? t('注册中…') : t('注册') }}</button>
      <span v-if="config.local" class="muted" style="font-size: 12px">{{ t('本地链：gas 由 anvil 账号付') }}</span>
    </div>
  </div>
</template>
