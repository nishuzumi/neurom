<script setup lang="ts">
// CodeBody.vue — the body of a code module on the canvas: its roles as vertical tabs (CodeTabs.vue). The host box
// carries the title. In a training module the code modules share the tabs of the 「代码」 section instead.
import CodeTabs from './CodeTabs.vue';

const props = defineProps<{ nodeId: string }>();
</script>

<template>
  <CodeTabs :node-ids="[props.nodeId]" />
</template>
