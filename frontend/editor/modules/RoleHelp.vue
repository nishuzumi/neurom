<script setup lang="ts">
// RoleHelp.vue — the window that the `?` of a role opens (CodeModule.vue). The content is the code-roles.ts `Card`.
// The card has the signature, and the problem of a header that does not follow the protocol, with its fix. It also has
// who calls the role and when, the parameters (a record opens into its fields) and what to return. Then it has the
// example, why the header is locked, and the actions of the role.
// The window is teleported to <body>, fixed, and unscaled by the canvas zoom. The user drags it by its title bar.
// Several windows can be open. ✕ or Esc closes it. It follows the card as the code changes.
import { onBeforeUnmount, ref } from 'vue';
import { t } from '../../i18n.js';
import RoleField from './RoleField.vue';
import type { Card } from './code-roles';

const props = defineProps<{ card: Card | null; x: number; y: number }>();
const emit = defineEmits<{ close: [] }>();
const pos = ref({ x: props.x, y: props.y });
const open = ref(false);
let drag: { dx: number; dy: number } | null = null;
function move(e: PointerEvent) {
  if (!drag) return;
  pos.value = { x: Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.dx)), y: Math.max(0, Math.min(window.innerHeight - 30, e.clientY - drag.dy)) };
}
function stop() { drag = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); }
function start(e: PointerEvent) {
  if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
  e.preventDefault();
  drag = { dx: e.clientX - pos.value.x, dy: e.clientY - pos.value.y };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop);
}
onBeforeUnmount(stop);
</script>

<template>
  <Teleport to="body">
    <div class="rhelp" role="dialog" :aria-label="card ? t('{name} 的说明', { name: card.key }) : t('说明')" tabindex="-1" :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
      @keydown.esc.stop="emit('close')" @wheel.stop @pointerdown.stop>
      <div class="rh-bar" @pointerdown="start">
        <code class="rh-sig">{{ card?.signature ?? '' }}</code>
        <button type="button" class="rh-close" :title="t('关闭')" :aria-label="t('关闭')" @click="emit('close')">×</button>
      </div>
      <div v-if="card" class="rh-body">
        <div v-if="card.problem" class="rh-problem">{{ card.problem }}</div>
        <div v-for="(c, i) in card.callers" :key="i" class="rh-when">{{ c }}</div>
        <template v-if="card.params.length">
          <div class="rh-label">{{ t('参数') }}</div>
          <RoleField v-for="p in card.params" :key="p.name" :field="p" />
        </template>
        <div class="rh-label">{{ card.returns.label }}</div>
        <div class="rh-row rh-leaf"><code class="rh-type">{{ card.returns.type }}</code><span v-if="card.returns.doc" class="rh-doc">{{ card.returns.doc }}</span></div>
        <template v-if="card.example">
          <div class="rh-label">{{ t('例子') }}</div>
          <div v-if="'error' in card.example" class="rh-doc">{{ card.example.error }}</div>
          <template v-else>
            <div class="rh-doc">{{ card.example.label }}</div>
            <code class="rh-eg" :class="{ open }" :title="open ? '' : t('点击展开')" @click="open = !open">{{ open ? card.example.full : card.example.text }}</code>
          </template>
        </template>
        <div v-if="card.locked" class="rh-note">{{ t('调用方规定函数名和参数个数。参数可以改名。只写下面的函数体。') }}</div>
        <div v-if="card.actions.length" class="rh-actions">
          <button v-for="a in card.actions" :key="a.label" type="button" class="mini" :title="a.title" @click="a.run()">{{ a.label }}</button>
        </div>
      </div>
      <div v-else class="rh-body rh-doc">{{ t('这个角色已经不在代码里了') }}</div>
    </div>
  </Teleport>
</template>
