<script setup lang="ts">
// renderers/script.vue — a view script (ADR 0013) in its sandboxed frame (script-frame.js, Vue inlined as the global
// `Vue`). This component rebuilds the frame when the source changes. It posts every new `ctx` to the frame when the
// frame is ready, and the frame re-renders the script's component (or calls its render). The frame fills the host's
// width (AGENTS.md: the host box owns it) and takes the height its content reports. This component shows errors under
// the frame, with the script's line when known. Errors are a throw, a syntax or template error, or neither a component
// nor a render.
import { computed, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue';
import vueSource from 'vue/dist/vue.global.prod.js?raw';
import { scriptDocument } from './script-frame.js';
import { t } from '../../i18n.js';

const props = defineProps<{ ctx: Record<string, unknown>; source: string }>();
const frame = ref<HTMLIFrameElement | null>(null);

/** the workbench's colour variables (every custom property a :root rule declares), so a script can use var(--spike) */
function themeVars(): Record<string, string> {
  const names = new Set<string>(), style = getComputedStyle(document.documentElement), out: Record<string, string> = {};
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) if (rule instanceof CSSStyleRule && rule.selectorText === ':root') for (const name of rule.style) if (name.startsWith('--')) names.add(name);
  }
  for (const name of names) { const v = style.getPropertyValue(name).trim(); if (v) out[name] = v; }
  return out;
}
// read once, before the frame's first document is built. If a second document replaces the first while the first still
// loads, the browser can drop the second document, and the frame then has no colours
const vars = themeVars(), scheme = getComputedStyle(document.documentElement).colorScheme || 'normal';
const doc = computed(() => scriptDocument(props.source, vars, vueSource, scheme).html);
/** bumped per document: a new source gets a fresh frame element instead of a srcdoc swap */
const generation = ref(0);
const ready = ref(false), height = ref(40);
const error = ref<{ message: string; line: number | null } | null>(null);
function post() {
  const w = frame.value?.contentWindow; if (!w || !ready.value) return;
  try { w.postMessage({ type: 'ctx', ctx: toRaw(props.ctx) }, '*'); }
  catch (e) { error.value = { message: (e as Error).message, line: null }; }
}
function onMessage(e: MessageEvent) {
  if (!frame.value || e.source !== frame.value.contentWindow) return;
  const m = e.data as { type?: string; h?: number; message?: string; line?: number } | null;
  switch (m?.type) {
    case 'ready': ready.value = true; post(); break;
    case 'size': height.value = Math.max(24, Math.min(4000, Number(m.h) || 0)); break;
    case 'ok': error.value = null; break;
    case 'error': error.value = { message: String(m.message ?? ''), line: typeof m.line === 'number' && m.line > 0 ? m.line : null }; break;
    case 'missing': error.value = { message: t('视图脚本既没有定义 component，也没有定义 render(ctx, el)'), line: null }; break;
  }
}
onMounted(() => window.addEventListener('message', onMessage));
onBeforeUnmount(() => window.removeEventListener('message', onMessage));
watch(doc, () => { generation.value++; ready.value = false; error.value = null; });
watch(() => props.ctx, post);
</script>

<template>
  <div class="rscript">
    <iframe :key="generation" ref="frame" class="rscript-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" :srcdoc="doc" :style="{ height: `${height}px` }" :title="t('视图脚本')" />
    <div v-if="error" class="bproblem" role="alert">{{ error.line ? t('第 {line} 行：{message}', { line: error.line, message: error.message }) : error.message }}</div>
  </div>
</template>

<style scoped>
.rscript{display:flex;flex-direction:column;gap:4px;width:100%;min-width:0}
.rscript-frame{display:block;width:100%;border:0;background:transparent}
</style>
