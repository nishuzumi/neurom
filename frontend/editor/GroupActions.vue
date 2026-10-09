<script setup lang="ts">
// GroupActions.vue — the action buttons at the right of a group's header. GroupNode (a composite, a loop box) and
// TrainingModuleNode share them. The buttons: save as template, the ⚙ settings dialog (GroupSettings.vue: exposed
// ports, loop box), unpack (the group goes, its members stay), collapse / expand, delete with its members.
import { inject, ref } from 'vue';
import HeadIcon from './HeadIcon.vue';
import GroupSettings from './GroupSettings.vue';
import { RUNTIME_KEY, type EditorRuntime } from './types';
import { t } from '../i18n.js';

const props = defineProps<{ groupId: string; collapsed: boolean }>();
const rt = inject(RUNTIME_KEY) as EditorRuntime;
const settings = ref(false);
</script>

<template>
  <button type="button" class="mnode-act nodrag" :title="t('把这个组合另存为模板')" @click.stop="rt.saveGroupAsTemplate(props.groupId)">{{ t('存为模板') }}</button>
  <button type="button" class="mnode-act nodrag" :title="t('解包：去掉这个组合，里面的模块和连线都保留（可撤销）')" @click.stop="rt.unpackGroup(props.groupId)">{{ t('解包') }}</button>
  <button type="button" class="mnode-act mnode-icon nodrag" aria-haspopup="dialog" :title="t('组合设置：对外端口、回路框')" :aria-label="t('组合设置')" @click.stop="settings = true"><HeadIcon name="gear" /></button>
  <button type="button" class="mnode-act mnode-icon nodrag" :aria-expanded="!props.collapsed" :title="props.collapsed ? t('展开：在框里编辑成员模块') : t('折叠为一个节点，只露出暴露的端口')" :aria-label="props.collapsed ? t('展开：在框里编辑成员模块') : t('折叠为一个节点，只露出暴露的端口')" @click.stop="rt.toggleGroup(props.groupId)"><HeadIcon :name="props.collapsed ? 'plus' : 'minus'" /></button>
  <button type="button" class="mnode-del mnode-icon nodrag" :title="t('删除组合及其全部成员（可撤销）')" :aria-label="t('删除组合及其全部成员（可撤销）')" @click.stop="rt.removeGroup(props.groupId)"><HeadIcon name="close" /></button>
  <GroupSettings v-if="settings" :group-id="props.groupId" @close="settings = false" />
</template>
