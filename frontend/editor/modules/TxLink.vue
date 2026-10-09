<script setup lang="ts">
// TxLink.vue — a transaction reference: `tx <short hash>`, linked to the explorer where the network has one.
defineProps<{ tx: { url: string | null; short: string } }>();
</script>

<template><a v-if="tx.url" target="_blank" rel="noopener" :href="tx.url">tx {{ tx.short }}</a><span v-else class="pin">tx {{ tx.short }}</span></template>
