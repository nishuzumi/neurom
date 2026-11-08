<script setup>
// replay/ScriptFrame.vue — the tank board: the replay view script of the template in its sandboxed frame
// (frontend/editor/renderers/script-frame.js, ADR 0013). The host posts `{ type: 'ctx', ctx }` to the frame, as the
// workbench renderer (renderers/script.vue) does. `ctx.state` is the scene state to draw. `ctx.live` makes the script
// animate from the state before (one step), else it jumps. The frame reports its content height, and the host sizes it.
// The workbench renderer is not reused here: it reads the colours of its own document (light on this page), and the
// replay panel is dark.
import { computed, onBeforeUnmount, onMounted, shallowRef, toRaw, watch } from 'vue';
import vueSource from 'vue/dist/vue.global.prod.js?raw';
import { scriptDocument } from '../../../frontend/editor/renderers/script-frame.js';
import { t } from '../i18n.js';

/** The colours of the dark replay panel, as the variables of the workbench that the view script reads. */
const DARK_VARS = {
  '--bg': '#111216',
  '--ink': '#e6e8ec',
  '--muted': '#8a8f98',
  '--line': '#2a2d35',
  '--line-strong': '#3a3e48',
  '--bad': '#f0684d',
  '--spike': '#f2bc4a',
  '--inh': '#7c8cff',
  '--brick': '#b4643c',
  '--water': '#3b6fb6',
};

/** `source` is the view script, `ctx` the context to draw (`{ state, live }`). */
const props = defineProps({ source: { type: String, required: true }, ctx: { type: Object, default: null } });
const frame = shallowRef(null);
const ready = shallowRef(false);
const height = shallowRef(240);
const error = shallowRef(null);
const doc = computed(() => scriptDocument(props.source, DARK_VARS, vueSource, 'dark').html);

function post() {
  if (!ready.value || !props.ctx) return;
  frame.value?.contentWindow?.postMessage({ type: 'ctx', ctx: toRaw(props.ctx) }, '*');
}
function onMessage(e) {
  if (e.source !== frame.value?.contentWindow || !e.data) return;
  switch (e.data.type) {
    case 'ready': ready.value = true; post(); break;
    case 'size': height.value = Math.max(60, e.data.h); break;
    case 'error': error.value = e.data.message; break;
    case 'missing': error.value = t('视图脚本既没有定义 component，也没有定义 render(ctx, el)'); break;
    default: break;
  }
}
onMounted(() => addEventListener('message', onMessage));
onBeforeUnmount(() => removeEventListener('message', onMessage));
watch(() => props.ctx, post);
</script>

<template>
  <div>
    <iframe ref="frame" class="replay-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" :srcdoc="doc" :style="{ height: `${height}px` }" :title="t('坦克棋盘')" />
    <div v-if="error" class="replay-error">{{ error }}</div>
  </div>
</template>
