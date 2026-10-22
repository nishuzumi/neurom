<script setup lang="ts">
// renderers/script-module.vue — the views of a script module (ADR 0019) in a sandboxed frame (script-frame.js
// scriptModuleDocument). The page rewrites the files (script-module.js compileScript) and sends them to the frame in
// the `load` message. The frame runs main.js and draws its views in the grid of `layout`. The frame fills the stage,
// and the stage fills the spare height of the host (AGENTS.md: the host box owns the width). A new `files` or `run`
// gives a new frame, so a run starts clean. A new `play` (「运行到这里」, ADR 0023) also gives a new frame, and the
// page sends `play` right after `load`, so that frame plays. Errors show above the frame, with the file and the line
// when known.
// `inputs` (core/script-calls.js scriptCalls) runs the calls the frame asks for and gives the values of the value
// inputs. The frame gets the values before `load` and again when they change. The replies of a frame that was
// replaced or reset are dropped (callBridge).
import { computed, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue';
import vueSource from 'vue/dist/vue.global.prod.js?raw';
import runtimeSource from './script-module-runtime.js?raw';
import { scriptModuleDocument, themeVars } from './script-frame.js';
import { compileScript } from './script-module.js';
import { callBridge } from '../../core/script-calls.js';
import { t } from '../../i18n.js';

type Inputs = { functions: string[]; call(name: string, args: unknown[]): unknown; values(): Record<string, unknown> };
const props = defineProps<{ files: { name: string; source: string }[]; run: number; play?: number; inputs: Inputs }>();
const frame = ref<HTMLIFrameElement | null>(null);

// read once (script.vue: a second document that replaces a loading first one can lose its colours)
const html = scriptModuleDocument(themeVars(), vueSource, runtimeSource, getComputedStyle(document.documentElement).colorScheme || 'normal');
// compared as text: an edit elsewhere in the graph gives a new `files` array with the same content, and no new run
const filesText = computed(() => JSON.stringify(props.files));
const compiled = computed(() => compileScript(JSON.parse(filesText.value)));
/** bumped per run: a fresh frame element, so nothing of the old run stays */
const generation = ref(0);
watch([compiled, () => props.run], () => { generation.value++; error.value = null; bridge.reset(); });
/** set by a new `play`: the next frame plays once it has loaded */
let playOnLoad = false;
watch(() => props.play, () => { playOnLoad = true; generation.value++; error.value = null; bridge.reset(); });

type ScriptError = { file?: string | null; line?: number | null; message?: string; code?: string; params?: Record<string, string> };
const error = ref<ScriptError | null>(null);
const CONTRACT: Record<string, string> = {
  missing: '脚本模块缺少 {file}',
  import: '找不到要导入的文件 {name}',
  export: 'main.js 的默认导出必须是对象，并且有 main 函数',
  views: 'views 必须把格子名映射到 Vue 组件',
  layout: 'layout 的 columns 和 rows 必须是字符串，areas 必须是字符串或字符串列表',
  template: '视图模板有错误：{message}',
};
const shown = computed(() => {
  const e = error.value ?? ('error' in compiled.value ? compiled.value.error : null);
  if (!e) return null;
  const message = e.code && CONTRACT[e.code] ? t(CONTRACT[e.code], e.params ?? {}) : String(e.message ?? '');
  if (e.file && e.line) return t('{file} 第 {line} 行：{message}', { file: e.file, line: e.line, message });
  return e.file && e.code !== 'missing' ? t('{file}：{message}', { file: e.file, message }) : message;
});

/** the texts of `@ui` and of the input errors in the UI language */
const uiText = computed(() => ({
  reset: t('重置'), step: t('单步'), play: t('运行'), pause: t('暂停'), round: t('第 {n} 轮'), done: t('已结束'),
  call: t('脚本模块没有声明函数输入 {name}', { name: '{name}' }), value: t('脚本模块没有声明值输入 {name}', { name: '{name}' }),
}));
function post(message: Record<string, unknown>) { frame.value?.contentWindow?.postMessage(message, '*'); }
const bridge = callBridge(post);
/** the declarations and values of the inputs, evaluated one time per resolution */
const inputValues = computed(() => ({ functions: [...props.inputs.functions], values: props.inputs.values() }));
// compared as text: a new resolution with the same declarations and values sends nothing
const inputsText = computed(() => JSON.stringify(inputValues.value));
const postValues = () => post({ type: 'values', ...inputValues.value });
function onMessage(e: MessageEvent) {
  if (!frame.value || e.source !== frame.value.contentWindow) return;
  const m = e.data as ({ type?: string; id?: number; name?: string; args?: unknown[] } & ScriptError) | null;
  switch (m?.type) {
    case 'ready': {
      const c = compiled.value;
      postValues();
      if ('modules' in c) post({ type: 'load', modules: toRaw(c.modules), text: uiText.value });
      if ('modules' in c && playOnLoad) post({ type: 'play' });
      playOnLoad = false;
      break;
    }
    case 'ok': error.value = null; bridge.reset(); break;
    case 'error': error.value = { file: m.file ?? null, line: typeof m.line === 'number' && m.line > 0 ? m.line : null, message: m.message, code: m.code, params: m.params }; break;
    case 'call': bridge.handle({ id: m.id, name: String(m.name), args: Array.isArray(m.args) ? m.args : [] }, (name: string, args: unknown[]) => props.inputs.call(name, args)); break;
  }
}
watch(inputsText, postValues);
watch(uiText, text => post({ type: 'text', text }));
onMounted(() => window.addEventListener('message', onMessage));
onBeforeUnmount(() => window.removeEventListener('message', onMessage));
</script>

<template>
  <div class="smod">
    <div v-if="shown" class="bproblem" role="alert">{{ shown }}</div>
    <iframe :key="generation" ref="frame" class="smod-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" :srcdoc="html" :title="t('脚本模块的视图')" />
  </div>
</template>

<style scoped>
.smod{display:flex;flex-direction:column;gap:6px;width:100%;min-width:0;min-height:0}
.smod-frame{display:block;flex:1 1 0;width:100%;min-height:0;border:0;background:transparent}
</style>
