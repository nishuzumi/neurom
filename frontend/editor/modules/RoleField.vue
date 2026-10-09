<script setup lang="ts">
// RoleField.vue — one parameter / field line of a role's help window (RoleHelp.vue): name, type, doc. A record opens
// into its fields (this component again).
import type { CardField } from './code-roles';

defineProps<{ field: CardField }>();
</script>

<template>
  <details v-if="field.fields?.length" class="rh-rec">
    <summary class="rh-row"><code class="rh-name">{{ field.name }}</code><code class="rh-type">{{ field.type }}</code><span v-if="field.doc" class="rh-doc">{{ field.doc }}</span></summary>
    <div class="rh-fields"><RoleField v-for="f in field.fields" :key="f.name" :field="f" /></div>
  </details>
  <div v-else class="rh-row rh-leaf"><code class="rh-name">{{ field.name }}</code><code class="rh-type">{{ field.type }}</code><span v-if="field.doc" class="rh-doc">{{ field.doc }}</span></div>
</template>
