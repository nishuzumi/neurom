<script setup lang="ts">
// ScriptFiles.vue — the code editor of a script module (ADR 0019), a modal dialog. The 「✎ 编辑代码」 button of the
// body opens it, and it mounts only while open. The file list is on the left (new, delete, select), and the selected
// file is on the right in ScriptEditor.vue (plain JavaScript on CodeMirror, as for a view script). Under the files are
// the declared inputs (`functions` and `inputs`, the ports of the module, ADR 0006): add, rename, delete, and the
// module wired into each. The dialog edits a draft. 「保存并重新运行」 writes the draft as one history entry and emits
// `saved`, so the body starts the script again. The wires of the inputs follow a rename (common.ts carryInputLists,
// per list: same count → by position, otherwise by name). A wire that cannot follow stays reported in the dialog.
// 「取消」 drops the draft. `main.js` cannot be deleted.
import { computed, onMounted, ref, shallowRef, toRaw } from 'vue';
import { useWorkbench } from '../workbench-context';
import { carryInputLists, useNode, type Buffered } from './common';
import { FILE_NAME, INPUT_NAME, MAIN_FILE, MAX_INPUTS } from '../../core/kinds/script.js';
import ScriptEditor from './ScriptEditor.vue';
import { t } from '../../i18n.js';
import './bodies-a.css';

type File = { name: string; source: string };
type Draft = { files: File[]; functions: string[]; inputs: string[] };
type ListKey = 'functions' | 'inputs';
const props = defineProps<{ nodeId: string }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const wb = useWorkbench();
const { node } = useNode(wb, () => props.nodeId);
const title = computed(() => node.value?.title ?? '');
const stored = (): Draft => {
  const c = (node.value?.config ?? {}) as Partial<Draft>;
  return { files: (c.files ?? []).map(f => ({ name: f.name, source: f.source })), functions: [...(c.functions ?? [])], inputs: [...(c.inputs ?? [])] };
};

const draft = ref<Draft>(stored());
const active = ref(draft.value.files.some(f => f.name === MAIN_FILE) ? MAIN_FILE : draft.value.files[0]?.name ?? '');
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(stored()));
/** the selected file as a buffer for ScriptEditor. The editor mounts again per file (its key), so undo stays per file.
 *  The text is read untracked: typing changes the draft, not the buffer */
const buffer = computed<Buffered | null>(() => {
  const file = draft.value.files.find(f => f.name === active.value);
  if (!file) return null;
  const text = shallowRef(toRaw(file).source);
  return { text, input: v => { text.value = v; file.source = v; }, flush: () => {}, typing: computed(() => false) };
});

const newName = ref(''), error = ref<string | null>(null);
const NAME = new RegExp(FILE_NAME);
function addFile() {
  const raw = newName.value.trim();
  const name = raw && !raw.endsWith('.js') ? `${raw}.js` : raw;
  if (!NAME.test(name)) { error.value = t('文件名 {name} 不合法：只用字母、数字、_、- 和 .，以 .js 结尾', { name: raw }); return; }
  if (draft.value.files.some(f => f.name === name)) { error.value = t('文件 {name} 已经存在', { name }); return; }
  draft.value.files.push({ name, source: '' });
  active.value = name; newName.value = ''; error.value = null;
}
function removeFile(name: string) {
  if (name === MAIN_FILE) return;
  draft.value.files = draft.value.files.filter(f => f.name !== name);
  if (active.value === name) active.value = MAIN_FILE;
}

// ------------------------------------------------------------------ declared inputs
const newInput = ref<Record<ListKey, string>>({ functions: '', inputs: '' });
/** why `name` cannot be a new name in the draft, or null. `except`: the name it replaces */
function nameProblem(name: string, except: string | null = null): string | null {
  if (!INPUT_NAME.test(name)) return t('输入名必须是标识符：字母、数字、下划线或汉字，不能以数字开头');
  if (name !== except && [...draft.value.functions, ...draft.value.inputs].includes(name)) return t('输入 {name} 已经存在', { name });
  return null;
}
function addInput(key: ListKey) {
  const name = newInput.value[key].trim();
  error.value = nameProblem(name) ?? (draft.value[key].length >= MAX_INPUTS ? t('最多 {max} 个输入', { max: MAX_INPUTS }) : null);
  if (error.value) return;
  draft.value[key].push(name);
  newInput.value[key] = '';
}
function renameInput(key: ListKey, i: number, raw: string) {
  const name = raw.trim(), old = draft.value[key][i];
  if (name === old) return;
  error.value = nameProblem(name, old);
  if (!error.value) draft.value[key][i] = name;
}
function removeInput(key: ListKey, i: number) { draft.value[key].splice(i, 1); }
/** the module wired into the stored input `name`, or null */
function supplierOf(name: string): string | null {
  void wb.version.value;
  const p = wb.graph.producers(props.nodeId, name)[0];
  return p ? wb.graph.node(p.node)?.title ?? p.node : null;
}
/** `← <module>`, 未接, or 保存后生效 for a name the module does not have yet */
function supplierText(name: string): string {
  const now = stored();
  if (![...now.functions, ...now.inputs].includes(name)) return t('保存后生效');
  const from = supplierOf(name);
  return from ? `← ${from}` : t('未接');
}
const LISTS = computed(() => [
  { key: 'functions' as const, title: t('函数输入（{n}）', { n: draft.value.functions.length }), placeholder: t('新函数输入名'), add: t('＋ 函数输入'), remove: (name: string) => t('删除函数输入 {name}', { name }) },
  { key: 'inputs' as const, title: t('值输入（{n}）', { n: draft.value.inputs.length }), placeholder: t('新值输入名'), add: t('＋ 值输入'), remove: (name: string) => t('删除值输入 {name}', { name }) },
]);

function save() {
  const before = stored(), next = draft.value;
  try {
    error.value = carryInputLists(wb, props.nodeId, [[before.functions, next.functions], [before.inputs, next.inputs]], t('编辑脚本 {title}', { title: title.value }),
      { files: next.files.map(f => ({ ...f })), functions: [...next.functions], inputs: [...next.inputs] });
  } catch (e) { error.value = (e as Error).message; return; }
  emit('saved');
  if (!error.value) emit('close');
}
function cancel(e?: Event) {
  e?.preventDefault();
  if (dirty.value && !window.confirm(t('放弃未保存的修改？'))) return;
  emit('close');
}

const dialog = ref<HTMLDialogElement | null>(null);
onMounted(() => dialog.value?.showModal());
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="smf" :aria-label="t('编辑代码：{title}', { title })" @cancel="cancel($event)" @keydown.stop @pointerdown.stop @wheel.stop>
      <header class="smf-head">
        <h2>{{ t('编辑代码：{title}', { title }) }}</h2>
        <button type="button" class="mini" :aria-label="t('关闭')" @click="cancel()">×</button>
      </header>
      <div class="smf-main">
        <nav class="smf-files" :aria-label="t('文件')">
          <h3>{{ t('文件（{n}）', { n: draft.files.length }) }}</h3>
          <ul>
            <li v-for="f in draft.files" :key="f.name" :class="{ on: f.name === active }">
              <button type="button" class="smf-file" :aria-current="f.name === active ? 'true' : undefined" @click="active = f.name">{{ f.name }}</button>
              <button v-if="f.name !== MAIN_FILE" type="button" class="smf-del" :title="t('删除文件 {name}', { name: f.name })" :aria-label="t('删除文件 {name}', { name: f.name })" @click="removeFile(f.name)">×</button>
            </li>
          </ul>
          <form class="smf-new" @submit.prevent="addFile">
            <input v-model="newName" type="text" spellcheck="false" :placeholder="t('新文件名')" :aria-label="t('新文件名')" />
            <button type="submit" class="mini" :disabled="!newName.trim()">{{ t('＋ 文件') }}</button>
          </form>
          <template v-for="list in LISTS" :key="list.key">
            <h3 class="smf-sect">{{ list.title }}</h3>
            <ul>
              <li v-for="(name, i) in draft[list.key]" :key="`${i}:${name}`" class="smf-decl">
                <input type="text" class="smf-name" :value="name" spellcheck="false" :aria-label="t('输入名')" @change="renameInput(list.key, i, ($event.target as HTMLInputElement).value)" />
                <button type="button" class="smf-del" :title="list.remove(name)" :aria-label="list.remove(name)" @click="removeInput(list.key, i)">×</button>
                <span class="smf-supplier" :class="{ none: !supplierOf(name) }">{{ supplierText(name) }}</span>
              </li>
            </ul>
            <form class="smf-new" @submit.prevent="addInput(list.key)">
              <input v-model="newInput[list.key]" type="text" spellcheck="false" :placeholder="list.placeholder" :aria-label="list.placeholder" />
              <button type="submit" class="mini" :disabled="!newInput[list.key].trim()">{{ list.add }}</button>
            </form>
          </template>
          <p class="bhint smf-hint">{{ t('每个输入是模块左边的一个端口。脚本里写 await ctx.call.名字(…) 调用函数输入，写 ctx.values.名字 读取值输入。') }}</p>
          <div v-if="error" class="bproblem" role="alert">{{ error }}</div>
        </nav>
        <section class="smf-code" :aria-label="active">
          <div class="smf-crumb">{{ active }}</div>
          <ScriptEditor v-if="buffer" :key="active" :buffer="buffer" :label="t('{title} 的文件 {name}', { title, name: active })" />
        </section>
      </div>
      <footer class="smf-foot">
        <span v-if="dirty" class="bhint">{{ t('有未保存的修改') }}</span>
        <span class="bgrow" />
        <button type="button" @click="cancel()">{{ t('取消') }}</button>
        <button type="button" class="smf-save" @click="save">{{ t('保存并重新运行') }}</button>
      </footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.smf{width:min(1100px,92vw);height:min(760px,86vh);max-width:none;max-height:none;padding:0;border:1px solid var(--line-strong);border-radius:10px;background:var(--panel);color:var(--ink);box-shadow:0 24px 64px -16px rgba(0,0,0,.9);font-size:12px}
.smf[open]{display:flex;flex-direction:column}
.smf::backdrop{background:rgba(0,0,0,.55)}
.smf-head{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 8px 0 14px;border-bottom:1px solid var(--line);background:var(--panel-head)}
.smf-head h2{margin:0;flex:1;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.smf-main{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,clamp(190px,26%,280px)) minmax(0,1fr)}
.smf-files{min-width:0;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;padding:10px 8px;border-right:1px solid var(--line);background:var(--bg)}
h3{margin:0 6px 2px;font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.04em}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
li{display:flex;align-items:center;min-width:0;border-radius:5px}
li:hover{background:var(--soft)}
li.on{background:color-mix(in srgb,var(--focus) 22%,transparent)}
.smf-file{flex:1;min-width:0;padding:4px 8px;border:0;background:transparent;color:var(--muted);text-align:left;font-family:var(--mono);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.smf-file:hover{background:transparent;color:var(--ink)}
li.on .smf-file{color:var(--ink)}
.smf-del{flex:none;padding:0 7px;border:0;background:transparent;color:var(--muted);visibility:hidden}
li:hover .smf-del,.smf-del:focus-visible{visibility:visible}
.smf-del:hover{background:transparent;color:var(--bad)}
.smf-new{display:flex;gap:4px;min-width:0;margin-top:4px}
.smf-new input{flex:1 1 auto;width:100%;min-width:0;font-family:var(--mono)}
.smf-new button{flex:none}
/* a declared input: the name and ×, then the module wired into it */
.smf-sect{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
li.smf-decl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1px 2px;padding:2px 0 3px}
.smf-name{width:100%;min-width:0;font-family:var(--mono)}
li.smf-decl .smf-del{visibility:visible}
.smf-supplier{grid-column:1 / -1;padding:0 4px;font-size:11px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.smf-supplier.none{color:var(--muted)}
.smf-hint{margin:8px 4px 0}
.smf-code{min-width:0;min-height:0;display:flex;flex-direction:column}
.smf-crumb{flex:none;padding:6px 12px;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:12px;color:var(--muted)}
.smf-code .code-edit{flex:1;min-height:0}
.smf-code :deep(.cm-editor){flex:1 1 0;min-height:0}
.smf-code :deep(.cm-scroller){max-height:none}
.smf-foot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--line);background:var(--panel-head)}
.smf-save{border-color:var(--focus);background:color-mix(in srgb,var(--focus) 24%,var(--soft))}
.smf-save:hover{background:color-mix(in srgb,var(--focus) 38%,var(--soft))}
</style>
