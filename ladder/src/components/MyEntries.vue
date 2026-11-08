<script setup>
// components/MyEntries.vue — the view 我的出战模型: choose one of the modules the current account deployed through the
// official Factory (the archive of the Factory, by English id) and register it (RegisterCard.vue), name the entry.
// Every entry of the account is listed with its rank, a running challenge to continue and the name form (EntryCard.vue).
import { computed } from 'vue';
import { t } from '../i18n.js';
import { href } from '../router.js';
import { entriesOf, useLadder } from '../ladder/use-ladder.js';
import { useDeployments } from '../ladder/use-deployments.js';
import { useWallet } from '../wallet/wallet.js';
import { addressKey } from '../ladder/format.js';
import RegisterCard from './RegisterCard.vue';
import EntryCard from './EntryCard.vue';
import RememberedChallenge from './RememberedChallenge.vue';

defineProps({ config: { type: Object, required: true } });
const wallet = useWallet();
const ladder = useLadder();
const archive = useDeployments(() => wallet.address);
const mine = computed(() => entriesOf(ladder.entries, wallet.address));
const idOf = computed(() => new Map(archive.items.map(d => [addressKey(d.module), d.moduleId])));
</script>

<template>
  <div class="view"><div class="wrap">
    <div class="view-head">
      <div><span class="label">{{ t('我的出战模型') }}</span><h2>{{ t('我的出战模型') }}</h2></div>
      <a :href="href.main('ladder')" class="btn">{{ t('回到擂台榜') }}</a>
    </div>
    <div v-if="!wallet.address" class="card stack">
      <p style="margin: 0">{{ t('先登录，然后注册出战模型。') }}</p>
      <div><button type="button" class="btn btn-primary" :disabled="!wallet.ready || wallet.kind === 'none'" @click="wallet.login">{{ t('登录') }}</button></div>
      <p v-if="wallet.kind === 'dev'" class="muted" style="margin: 0; font-size: 13px">{{ t('本地开发：登录用 anvil 默认助记词的账号 #{index}。', { index: config.devAccount }) }}</p>
    </div>
    <div v-else class="two">
      <RegisterCard :key="addressKey(wallet.address)" :config="config" :archive="archive" />
      <div class="stack">
        <h3>{{ t('已注册的出战模型') }}</h3>
        <div v-if="ladder.loaded && mine.length === 0" class="empty">{{ t('这个账号还没有出战模型') }}</div>
        <div class="entry-list">
          <EntryCard v-for="e in mine" :key="e.module" :entry="e" :name="ladder.names[addressKey(e.module)] ?? null" :module-id="idOf.get(addressKey(e.module)) || null" :config="config" />
        </div>
        <RememberedChallenge :mine="mine" />
      </div>
    </div>
  </div></div>
</template>
