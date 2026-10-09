<script setup lang="ts">
// ArtifactImport.vue — the artifact import panel of the candidates and network bodies. It hands a neurom-module
// JSON file or pasted text to `run` (the body's session import). It emits `done` after the import, or on close.
import { shallowRef } from 'vue';
import { useAct } from './body-utils';
import { t } from '../../i18n.js';
import './bodies-b.css';

const props = defineProps<{ run: (text: string) => unknown }>();
const emit = defineEmits<{ done: [] }>();
const { error, act } = useAct();
const pasted = shallowRef('');
function importText(text: string) { act(async () => { await props.run(text); emit('done'); }); }
function pick(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return;
  void file.text().then(importText, err => { error.value = String(err?.message ?? err); });
  (e.target as HTMLInputElement).value = '';
}
</script>

<template>
  <div class="cimport">
    <label class="mini cfile">{{ t('选择产物 JSON 文件') }}<input type="file" accept="application/json,.json" @change="pick" /></label>
    <textarea v-model="pasted" rows="3" :placeholder="t('或粘贴 neurom-module JSON')" spellcheck="false"></textarea>
    <div class="brow"><button type="button" class="mini" :disabled="!pasted.trim()" @click="importText(pasted)">{{ t('导入粘贴内容') }}</button><button type="button" class="mini" @click="emit('done')">{{ t('关闭') }}</button></div>
  </div>
  <div v-if="error" class="bproblem">{{ error }}</div>
</template>
