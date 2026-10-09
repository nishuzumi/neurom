<script setup lang="ts">
// GroupSettings.vue — the settings dialog of a group. The ⚙ in the header of a group or training module opens it. The
// dialog is mounted only while open. It sets:
// - which member ports the group shows when collapsed (its exposed ports, graph.setExpose). A template records them
//   as `expose`.
// - which of its direct loop members the group is the box of (graph.setGroupLoop, a loop drawn as the frame).
// Every change is one history entry. While the dialog is open, the lists follow undo.
import { computed, onMounted, ref } from 'vue';
import { portSpecs } from './graph-view';
import { useWorkbench } from './workbench-context';
import { t } from '../i18n.js';

const props = defineProps<{ groupId: string }>();
const emit = defineEmits<{ close: [] }>();
const wb = useWorkbench();

/** `group` is the graph's own (mutated in place) record, so every derived list reads `version` itself */
const group = computed(() => { void wb.version.value; return wb.graph.groups.get(props.groupId) ?? null; });
const exposed = computed(() => { void wb.version.value; return new Set((group.value?.expose ?? []).map(e => `${e.node}/${e.port}`)); });
/** every member module (through nested groups) with its declared ports, in member order */
const members = computed(() => {
  void wb.version.value;
  if (!group.value) return [];
  const g = wb.graph, res = wb.resolution();
  return g.memberNodes(props.groupId).map(id => {
    const { inputs, outputs } = portSpecs(g, res, id), n = g.node(id);
    return { id, title: n.title, ports: [...inputs.map(p => ({ ...p, dir: 'in' as const })), ...outputs.map(p => ({ ...p, dir: 'out' as const }))].filter(p => !p.id.includes('.')) };
  }).filter(m => m.ports.length);
});
const count = computed(() => exposed.value.size);
/** the group's direct loop members: what it can be the box of */
const loops = computed(() => { void wb.version.value; const gr = group.value; return gr ? gr.members.filter(id => wb.graph.hasNode(id) && wb.graph.node(id).kind === 'loop').map(id => ({ id, title: wb.graph.node(id).title })) : []; });
const error = ref<string | null>(null);

function toggle(node: string, port: string, on: boolean) {
  const gr = group.value; if (!gr) return;
  const next = gr.expose.map(e => ({ node: e.node, port: e.port })).filter(e => !(e.node === node && e.port === port));
  if (on) next.push({ node, port });
  try { wb.edit(on ? t('暴露端口 {port}', { port }) : t('取消暴露端口 {port}', { port }), () => wb.graph.setExpose(props.groupId, next)); error.value = null; }
  catch (e) { error.value = (e as Error).message; }
}
function setLoop(raw: string) {
  try { wb.edit(t('设置回路框'), () => wb.graph.setGroupLoop(props.groupId, raw || null)); error.value = null; }
  catch (e) { error.value = (e as Error).message; }
}

const dialog = ref<HTMLDialogElement | null>(null);
onMounted(() => dialog.value?.showModal());
function close(e?: Event) { e?.preventDefault(); emit('close'); }
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="gset" :aria-label="t('组合设置：{title}', { title: group?.title ?? '' })" @cancel="close($event)" @keydown.stop @pointerdown.stop @wheel.stop>
      <header class="gset-head">
        <h2>{{ t('组合设置：{title}', { title: group?.title ?? '' }) }}</h2>
        <button type="button" class="mini" :aria-label="t('关闭')" @click="close()">×</button>
      </header>
      <div class="gset-main">
        <section v-if="loops.length">
          <h3>{{ t('回路框') }}</h3>
          <label class="gset-loop">
            <select :value="group?.loop ?? ''" :aria-label="t('回路框')" @change="setLoop(($event.target as HTMLSelectElement).value)">
              <option value="">{{ t('不作为回路框') }}</option>
              <option v-for="l in loops" :key="l.id" :value="l.id">{{ l.title }}</option>
            </select>
          </label>
        </section>
        <section>
          <h3>{{ t('对外端口（{n}）', { n: count }) }}</h3>
          <details v-for="m in members" :key="m.id" class="gset-member" :open="m.ports.some(p => exposed.has(`${m.id}/${p.id}`))">
            <summary>{{ m.title }}<span v-if="m.ports.some(p => exposed.has(`${m.id}/${p.id}`))" class="gset-n">{{ m.ports.filter(p => exposed.has(`${m.id}/${p.id}`)).length }}</span></summary>
            <label v-for="p in m.ports" :key="`${p.dir}:${p.id}`" class="gset-port">
              <input type="checkbox" :checked="exposed.has(`${m.id}/${p.id}`)" @change="toggle(m.id, p.id, ($event.target as HTMLInputElement).checked)" />
              <span class="gset-dir">{{ p.dir === 'in' ? t('输入') : t('输出') }}</span>
              <span class="gset-name" :title="p.title ?? p.label">{{ p.label }}</span>
            </label>
          </details>
        </section>
        <div v-if="error" class="bproblem" role="alert">{{ error }}</div>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.gset{width:min(520px,92vw);max-height:min(720px,86vh);padding:0;border:1px solid var(--line-strong);border-radius:10px;background:var(--panel);color:var(--ink);box-shadow:0 24px 64px -16px rgba(0,0,0,.9);font-size:12px}
.gset[open]{display:flex;flex-direction:column}
.gset::backdrop{background:rgba(0,0,0,.55)}
.gset-head{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 8px 0 14px;border-bottom:1px solid var(--line);background:var(--panel-head)}
.gset-head h2{margin:0;flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gset-main{flex:1;min-height:0;overflow:auto;padding:10px 14px 14px;display:flex;flex-direction:column;gap:12px}
h3{margin:0 0 6px;font-size:12px;font-weight:600}
.gset-loop select{width:100%}
.gset-member{border-bottom:1px solid var(--line)}
.gset-member summary{display:flex;gap:8px;align-items:center;padding:5px 0;cursor:pointer}
.gset-n{margin-left:auto;padding:0 6px;border-radius:8px;background:var(--focus);color:var(--bg);font-size:10.5px;font-weight:700}
.gset-port{display:grid;grid-template-columns:auto 3em minmax(0,1fr);gap:6px;align-items:center;padding:2px 0 2px 14px}
.gset-dir{color:var(--muted);font-size:11px}
.gset-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono)}
</style>
