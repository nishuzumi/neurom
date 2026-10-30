<script setup lang="ts">
// HeadIcon.vue — the icons of the node headers' icon buttons (`.mnode-icon`, editor.css). Font glyphs (⚙ − + ×) put
// their ink at different heights (math axis, baseline, a fallback font's metrics), so side by side they never align.
// These icons share one 24×24 stroked viewBox, geometrically centred, and sit on the same line in every font.
// The gear path is Lucide's `settings` (ISC licence).
defineProps<{ name: 'gear' | 'minus' | 'plus' | 'close' | 'play' }>();
</script>

<template>
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <template v-if="name === 'gear'">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </template>
    <path v-else-if="name === 'minus'" d="M5 12h14" />
    <path v-else-if="name === 'plus'" d="M5 12h14M12 5v14" />
    <path v-else-if="name === 'play'" d="M8 5.5v13l10.5-6.5z" />
    <path v-else d="M6 6l12 12M18 6 6 18" />
  </svg>
</template>
