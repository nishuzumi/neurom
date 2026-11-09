<script setup>
// components/StatusPill.vue — the pill of a challenge status, as the viewer on `side` (`viewerSide`) reads it.
import { computed } from 'vue';
import { outcomeOf } from '../ladder/outcome.js';

const props = defineProps({ status: { type: Number, required: true }, side: { type: String, default: null } });
const outcome = computed(() => outcomeOf(props.status, props.side));
</script>

<template>
  <span :class="`pill${outcome.tone ? ` ${outcome.tone}` : ''}`">{{ outcome.text ?? '—' }}</span>
</template>
