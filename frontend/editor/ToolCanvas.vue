<script setup lang="ts">
// ToolCanvas.vue — the tool layers of a network card (ADR 0010 §9), inside its body in layer order. Each layer is one
// foldable sub-canvas 「工具层 · port」 (the fold is node.uiFolded). Inside it, as full cards, are the tools wired only
// into that port. editor/tool-canvas.js decides which tools, and index.ts projects them (ToolLayerView). A frozen
// network with its readout (bits or argmax) is one card. Their unwired ports are slots on the host flow node
// (`${module}/${port}`). Wiring one of them elsewhere takes the tool out of the layer. The tools also wired elsewhere
// stay on the outer canvas, and here a label jumps to each. 「+ 工具」 adds a code tool or a frozen network that runs a
// picked artifact (FF or LIF, its own network tools wired in too). It wires the new tool in (one history entry each).
// The current step of the execution that runs this network highlights the tool it chose, with the data bits it handed
// over and the result. The other tools dim. Folded, the layer shows one line: that call, or the tools. The card is the
// host and owns the width (AGENTS.md). The cards fill a grid of the width it gives them.
import { computed, inject, shallowRef } from 'vue';
import NodePorts from './NodePorts.vue';
import HeadIcon from './HeadIcon.vue';
import { BODIES } from './modules/registry';
import { problemHint } from './graph-view';
import { useExecutionOf, useSession, shortId } from './modules/body-utils';
import { RUNTIME_KEY, type EditorRuntime, type ToolLayerView } from './types';
import { CANVAS_WIRING, type Wiring } from './wiring';
import { isToolLayer } from '../core/kinds/network.js';
import { t } from '../i18n.js';
import './tool-canvas.css';

const props = defineProps<{ nodeId: string; layers: ToolLayerView[] }>();
const rt = inject(RUNTIME_KEY) as EditorRuntime;
const wiring = inject(CANVAS_WIRING) as Wiring;

// ------------------------------------------------------------------ the step's decision (sessions/execution.js `tools`)
type ToolCall = { choice: number; data: number[]; result: number[] };
const execution = useExecutionOf(props.nodeId);
const calls = computed(() => {
  const last = execution.value?.last as { tools?: Record<string, Record<string, ToolCall>> } | null | undefined;
  return last?.tools?.[props.nodeId] ?? {};
});
const bitsText = (xs: number[], max = 12) => (xs.length > max ? `${xs.slice(0, max).join('')}…` : xs.join(''));
/** the tool the step chose in layer `L` (the module wired into the port), with its data and result */
function callOf(L: ToolLayerView) {
  const c = calls.value[L.port], wire = c ? L.wires[c.choice] : null;
  return c && wire ? { tool: wire.tool, label: wire.label, data: bitsText(c.data), result: bitsText(c.result) } : null;
}
/** chosen / dim when a step chose a tool in this layer, '' otherwise */
function lit(L: ToolLayerView, tool: string): string {
  const c = callOf(L);
  return c ? (c.tool === tool ? 'chosen' : 'dim') : '';
}
function summary(L: ToolLayerView): string {
  const c = callOf(L);
  if (c) return t('调用 {tool} · 数据 {data} · 结果 {result}', { tool: c.label, data: c.data, result: c.result });
  return L.wires.length ? L.wires.map(w => w.label).join(' · ') : t('还没有工具');
}

// ------------------------------------------------------------------ 「+ 工具」
type Choice = { id: string; name: string | null; builtin: boolean; kind: string; inputs: number; outputs: number; layers?: unknown[]; readout: { mode: string } | null };
const { snap: pick } = useSession('network', props.nodeId);
/** the artifacts a tool can run: any network with a readout, bits or argmax (FF or LIF, with tool layers of its own or not) */
const frozen = computed(() => ((pick.value.choices as Choice[]) ?? []).filter(c => c.readout?.mode === 'bits' || c.readout?.mode === 'argmax'));
const frozenLabel = (c: Choice) => `${c.name ?? shortId(c.id)}${c.builtin ? ` · ${t('内置')}` : ''} · ${c.kind === 'lif' ? 'LIF' : 'FF'}${(c.layers ?? []).some(isToolLayer) ? ` · ${t('带工具')}` : ''}${c.readout?.mode === 'argmax' ? ' · argmax' : ''} · ${c.inputs} → ${c.outputs}`;
const adding = shallowRef<string | null>(null);
function addCode(port: string) { adding.value = null; rt.addCodeTool(props.nodeId, port); }
function addNetwork(port: string, e: Event) {
  const id = (e.target as HTMLSelectElement).value; if (!id) return;
  adding.value = null; rt.addNetworkTool(props.nodeId, port, id);
}

/** a record output's field tree on an inner card: the slot id is `${module}/${port}` */
function toggle(slot: string) { const at = slot.indexOf('/'); rt.togglePort(slot.slice(0, at), slot.slice(at + 1)); }
</script>

<template>
  <div class="tcans">
    <section v-for="L in layers" :key="L.port" class="tcan" :class="{ folded: L.folded }" :aria-label="t('工具层 · {port}', { port: L.port })">
      <header class="tcan-head">
        <button type="button" class="mnode-act mnode-icon" :aria-expanded="!L.folded" :title="L.folded ? t('展开工具层') : t('折叠工具层')" :aria-label="L.folded ? t('展开工具层') : t('折叠工具层')"
          @click="rt.toggleToolLayer(nodeId, L.port)"><HeadIcon :name="L.folded ? 'plus' : 'minus'" /></button>
        <span class="tcan-title">{{ t('工具层 · {port}', { port: L.port }) }}</span>
        <span class="tcan-count">{{ t('{count} 个工具', { count: L.wires.length }) }}</span>
        <button v-if="!L.folded" type="button" class="tm-add tcan-plus" :aria-expanded="adding === L.port" @click="adding = adding === L.port ? null : L.port">{{ t('+ 工具') }}</button>
      </header>
      <p v-if="L.folded" class="tcan-summary">{{ summary(L) }}</p>
      <div v-if="!L.folded && adding === L.port" class="tcan-add">
        <button type="button" class="mini" :title="t('新建一个代码模块：(bits) → bits 的函数，接到 {port}', { port: L.port })" @click="addCode(L.port)">{{ t('新建代码工具') }}</button>
        <select :aria-label="t('冻结网络：选择产物')" :disabled="!frozen.length" @change="addNetwork(L.port, $event)">
          <option value="">{{ frozen.length ? t('冻结网络：选择产物…') : t('没有可当工具的产物（需要带读出的网络）') }}</option>
          <option v-for="c in frozen" :key="c.id" :value="c.id">{{ frozenLabel(c) }}</option>
        </select>
      </div>
      <div v-if="!L.folded" class="tcan-well">
        <article v-for="c in L.inside" :key="c.node" class="tcard" :class="[`kind-${c.kind}`, lit(L, c.tool), { code: c.kind === 'code', folded: c.collapsed, 'has-problem': c.problems.errors.length > 0 }]"
          :aria-label="t('{kind} 模块 {title}', { kind: c.kindLabel, title: c.title })">
          <header class="tcard-head">
            <span class="mnode-kind" :title="c.kindLabel">{{ c.kindLabel }}</span>
            <input class="mnode-title" :value="c.title" maxlength="80" :aria-label="t('模块名称')" @keydown.stop @dblclick.stop @change="rt.rename(c.node, ($event.target as HTMLInputElement).value)" />
            <span v-if="c.problems.errors.length" class="mnode-problem bad" :title="problemHint(c.problems)" :aria-label="t('{count} 个问题', { count: c.problems.errors.length })">{{ c.problems.errors.length }}</span>
            <span v-else-if="c.problems.incomplete.length" class="mnode-problem m" :title="problemHint(c.problems)" :aria-label="t('{count} 项未连接', { count: c.problems.incomplete.length })">{{ c.problems.incomplete.length }}</span>
            <button type="button" class="mnode-act mnode-icon" :aria-expanded="!c.collapsed" :title="c.collapsed ? t('展开模块内容') : t('折叠模块')" :aria-label="c.collapsed ? t('展开模块内容') : t('折叠模块')"
              @click="rt.toggleCollapse(c.readout ? [c.node, c.readout] : c.node)"><HeadIcon :name="c.collapsed ? 'plus' : 'minus'" /></button>
            <button type="button" class="mnode-del mnode-icon" :title="t('删除模块（可撤销）')" :aria-label="t('删除模块 {title}', { title: c.title })"
              @click="rt.removeNode(c.readout ? [c.node, c.readout] : c.node)"><HeadIcon name="close" /></button>
          </header>
          <NodePorts v-if="c.inputs.length || c.outputs.length" :node="nodeId" :inputs="c.inputs" :outputs="c.outputs" :wiring="wiring" :label="c.title" @toggle="toggle" />
          <div v-if="lit(L, c.tool) === 'chosen'" class="tcard-call" role="status">
            <b>{{ t('本步调用') }}</b><span class="mono">{{ t('数据 {data} → 结果 {result}', { data: callOf(L)!.data, result: callOf(L)!.result }) }}</span>
          </div>
          <div v-if="!c.collapsed" class="tcard-body">
            <component :is="BODIES[c.kind].body" v-if="BODIES[c.kind]" :node-id="c.node" />
            <template v-if="c.readout">
              <div class="tcard-sub">{{ t('读出') }}</div>
              <component :is="BODIES.readout.body" :node-id="c.readout" />
            </template>
          </div>
        </article>
        <div v-if="L.outside.length" class="tcan-outside" role="list" :aria-label="t('接在别处的工具')">
          <span class="tcan-note" :title="t('这些工具还接在别处，所以外面的画布显示它们')">{{ t('接在别处') }}</span>
          <button v-for="o in L.outside" :key="o.tool" type="button" role="listitem" class="tjump" :class="lit(L, o.tool)" :title="t('跳到 {title}', { title: o.title })" @click.stop="rt.jumpTo(o.tool)">
            ↗ {{ o.title }}<span v-if="lit(L, o.tool) === 'chosen'" class="mono tjump-call">{{ t('数据 {data} → 结果 {result}', { data: callOf(L)!.data, result: callOf(L)!.result }) }}</span>
          </button>
        </div>
        <p v-if="!L.wires.length" class="tcan-empty">{{ t('还没有工具：「+ 工具」新建代码工具，或加一个冻结网络') }}</p>
      </div>
    </section>
  </div>
</template>
