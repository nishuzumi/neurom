<script setup lang="ts">
// CodeTabs.vue — code modules as vertical tabs (ADR 0012). It has a strip and a pane.
// The strip is grouped by module. Each group has:
// - One tab per role (code-roles.ts: the exports that some module calls by protocol, in file order).
// - A red tab per missing required role.
// - One ⊕ that lists the missing optional roles.
// - 全文 (the whole file: helpers, consts, inputs, the other exports).
// The pane shows the CodeModule of the selected module, focused on the selected role. For a missing role, the pane
// shows the text that the role would get with 「添加」.
// Every module stays mounted, so its buffer, undo history and help windows stay after a tab switch. Only the selected
// module shows.
// A code module on the canvas is one group (its host carries the title). The 「代码」 section of the training module
// has one group per code module, each with its title and delete. Only the selected module lists its tabs. The others
// collapse to one row (title, role count or problem count) that opens the module.
// CodeTabs answers EditorRuntime.revealCode for its modules. It selects the module and the tab of the role (else 全文).
// Then the module puts the caret on the revealed name.
import { computed, inject, nextTick, reactive, ref, watch } from 'vue';
import { t } from '../../i18n.js';
import { useWorkbench } from '../workbench-context';
import { RUNTIME_KEY, type EditorRuntime } from '../types';
import CodeModule from './CodeModule.vue';
import type { MissingRole, RoleTab } from './code-roles';

/** `grouped`: several modules share the strip (the training module's 「代码」 section): each group shows its title */
const props = defineProps<{ nodeIds: string[]; grouped?: boolean }>();
const wb = useWorkbench();
const rt = inject(RUNTIME_KEY, null) as EditorRuntime | null;
const titleOf = (id: string) => { void wb.version.value; return wb.graph.nodes.get(id)?.title ?? id; };

interface Roles { tabs: RoleTab[]; missing: MissingRole[]; other: number }
const roles = reactive<Record<string, Roles>>({});
/** the selected tab: a role key, '' for 全文, or `+name` for a missing role's preview */
const active = ref<{ node: string; tab: string }>({ node: props.nodeIds[0] ?? '', tab: '' });
const chosen = new Set<string>();   // modules whose tab the user (or a reveal) picked: a first roles report does not move it
const moreOpen = ref<string | null>(null);
const mods: Record<string, InstanceType<typeof CodeModule> | null> = {};

function onRoles(id: string, tabs: RoleTab[], missing: MissingRole[], other: number) {
  roles[id] = { tabs, missing, other };
  const a = active.value;
  if (a.node !== id) return;
  const valid = a.tab === '' ? true : a.tab.startsWith('+') ? missing.some(m => `+${m.name}` === a.tab) : tabs.some(r => r.key === a.tab);
  if (!chosen.has(id) || !valid) active.value = { node: id, tab: tabs[0]?.key ?? (a.tab.startsWith('+') && valid ? a.tab : '') };
}
function select(node: string, tab: string) {
  chosen.add(node); moreOpen.value = null;
  const moved = active.value.node !== node;
  active.value = { node, tab };
  if (moved) nextTick(() => mods[node]?.refresh());
}
watch(() => props.nodeIds, ids => { if (!ids.includes(active.value.node)) active.value = { node: ids[0] ?? '', tab: roles[ids[0]]?.tabs[0]?.key ?? '' }; });
const focusOf = (id: string) => (active.value.node === id && active.value.tab && !active.value.tab.startsWith('+') ? active.value.tab : null);
const preview = computed(() => {
  const a = active.value;
  return a.tab.startsWith('+') ? roles[a.node]?.missing.find(m => `+${m.name}` === a.tab) ?? null : null;
});
function add(node: string, m: MissingRole) { m.add(); select(node, m.name); }
/** a module is expanded when it is the selected one (or alone): the training module's 「代码」 lists the others as one row each */
const open = (id: string) => !props.grouped || active.value.node === id;
/** problems a collapsed module still shows: located errors, bad or missing required roles, problems outside the roles */
function problemsOf(id: string) {
  const r = roles[id]; if (!r) return 0;
  return r.tabs.reduce((n, x) => n + (x.errors || (x.bad ? 1 : 0)), 0) + r.missing.filter(m => m.required).length + r.other;
}

watch(() => wb.reveal.value, async r => {
  if (!r || !props.nodeIds.includes(r.node)) return;
  wb.reveal.value = null;
  select(r.node, roles[r.node]?.tabs.some(x => x.key === r.name) ? r.name : '');
  await nextTick();
  mods[r.node]?.reveal(r.name);
}, { immediate: true });
</script>

<template>
  <div class="ctabs">
    <nav class="ctabs-strip" role="tablist" aria-orientation="vertical" :aria-label="t('代码')">
      <div v-for="id in nodeIds" :key="id" class="ctabs-group" :class="{ closed: !open(id) }" :data-code-node="id">
        <div v-if="grouped" class="ctabs-head">
          <input v-if="open(id)" class="ctabs-title" :value="titleOf(id)" maxlength="80" :aria-label="t('模块名称')" @keydown.stop @change="rt?.rename(id, ($event.target as HTMLInputElement).value)" />
          <button v-else type="button" class="ctabs-open" :title="titleOf(id)" @click="select(id, roles[id]?.tabs[0]?.key ?? '')">
            <span class="ctab-name">{{ titleOf(id) }}</span>
            <span v-if="problemsOf(id)" class="ctab-badge">{{ problemsOf(id) }}</span><span v-else class="ctabs-count">{{ roles[id]?.tabs.length ?? 0 }}</span>
          </button>
          <button type="button" class="ctabs-del" :title="t('删除模块（可撤销）')" :aria-label="t('删除模块 {title}', { title: titleOf(id) })" @click="rt?.removeNode(id)">×</button>
        </div>
        <template v-if="open(id)">
          <button v-for="r in roles[id]?.tabs ?? []" :key="r.key" type="button" role="tab" class="ctab" :class="{ on: active.node === id && active.tab === r.key, bad: r.bad || r.errors > 0 }"
            :aria-selected="active.node === id && active.tab === r.key" :title="r.errors ? t('{count} 个问题', { count: r.errors }) : r.key" @click="select(id, r.key)">
            <span class="ctab-name">{{ r.key }}</span><span v-if="r.errors || r.bad" class="ctab-badge">{{ r.errors || '!' }}</span>
          </button>
          <button v-for="m in (roles[id]?.missing ?? []).filter(m => m.required)" :key="m.name" type="button" role="tab" class="ctab missing" :class="{ on: active.node === id && active.tab === `+${m.name}` }"
            :aria-selected="active.node === id && active.tab === `+${m.name}`" :title="t('必需，还没写')" @click="select(id, `+${m.name}`)">
            <span class="ctab-name">{{ m.name }}</span>
          </button>
          <template v-if="(roles[id]?.missing ?? []).some(m => !m.required)">
            <button type="button" class="ctab more" :aria-expanded="moreOpen === id" :title="t('可选的函数')" @click="moreOpen = moreOpen === id ? null : id">⊕</button>
            <template v-if="moreOpen === id">
              <button v-for="m in roles[id].missing.filter(m => !m.required)" :key="m.name" type="button" role="tab" class="ctab optional" :class="{ on: active.node === id && active.tab === `+${m.name}` }"
                :aria-selected="active.node === id && active.tab === `+${m.name}`" :title="t('可选')" @click="select(id, `+${m.name}`)">
                <span class="ctab-name">{{ m.name }}</span>
              </button>
            </template>
          </template>
          <button type="button" role="tab" class="ctab whole" :class="{ on: active.node === id && active.tab === '', bad: (roles[id]?.other ?? 0) > 0 }" :aria-selected="active.node === id && active.tab === ''"
            :title="t('整个文件：辅助函数、常量、输入')" @click="select(id, '')">
            <span class="ctab-name">{{ t('全文') }}</span><span v-if="roles[id]?.other" class="ctab-badge">{{ roles[id].other }}</span>
          </button>
        </template>
      </div>
    </nav>
    <div class="ctabs-pane">
      <CodeModule v-for="id in nodeIds" v-show="active.node === id && !preview" :key="id" :ref="el => { mods[id] = el as InstanceType<typeof CodeModule> | null; }"
        :node-id="id" :focus="focusOf(id)" @roles="(tabs, missing, other) => onRoles(id, tabs, missing, other)" @full="select(id, '')" />
      <div v-if="preview" class="ctabs-missing">
        <div class="ctabs-missing-head">
          <span>{{ preview.required ? t('{name} 是必需的，还没写', { name: preview.name }) : t('{name} 是可选的', { name: preview.name }) }}</span>
          <button type="button" class="mini" @click="add(active.node, preview)">{{ t('添加') }}</button>
        </div>
        <pre class="ctabs-preview">{{ preview.preview }}</pre>
      </div>
    </div>
  </div>
</template>
