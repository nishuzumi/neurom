<script setup lang="ts">
// The right-click menu of a single wire (ComfyUI's link menu): reroute points, own colour, disconnect. CanvasEdge.vue
// opens it at the pointer. The wire it names is the selected one (index.ts selects on edgeContextMenu). Any pointer
// press outside, a wheel, Esc or a window resize closes it.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { MAX_ROUTE, PICKER_SWATCH, useEdgePresentation } from './edge-presentation';
import { t } from '../i18n.js';
const presentation = useEdgePresentation();
const root = ref<HTMLElement | null>(null), place = ref({ left: 0, top: 0 });
/** the menu shows only when its wire is the selection, so the label and disconnect belong to the same wire */
const menu = computed(() => {
  const m = presentation.menu.value, s = presentation.selection.value;
  return m && s?.key === m.key ? { ...m, label: s.label, disconnect: s.disconnect } : null;
});
const own = computed(() => menu.value ? presentation.state.edges[menu.value.key] : undefined);
const route = computed(() => own.value?.route ?? []);
const color = computed(() => menu.value ? presentation.read(menu.value.key).color ?? null : null);
function close() { presentation.menu.value = null; }
function run(action: () => void) { action(); close(); }
function setColor(event: Event) { const m = menu.value; if (m) run(() => presentation.change(m.key, { color: (event.target as HTMLInputElement).value })); }
function outside(e: PointerEvent) { if (!root.value?.contains(e.target as Node)) close(); }
function key(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
function listen(on: boolean) {
  const method = on ? 'addEventListener' : 'removeEventListener';
  window[method]('pointerdown', outside as EventListener, true); window[method]('wheel', close, true); window[method]('keydown', key as EventListener, true); window[method]('resize', close);
}
/** keep the menu inside the window, then focus its first item */
watch(menu, async (m, previous) => {
  if (!!m !== !!previous) listen(!!m);
  if (!m) return;
  place.value = { left: m.x, top: m.y };
  await nextTick();
  const el = root.value; if (!el) return;
  const r = el.getBoundingClientRect();
  place.value = { left: Math.max(4, Math.min(m.x, innerWidth - r.width - 4)), top: Math.max(4, Math.min(m.y, innerHeight - r.height - 4)) };
  el.querySelector<HTMLElement>('[role=menuitem]')?.focus();
});
onBeforeUnmount(() => { if (menu.value) listen(false); });
</script>
<template>
  <Teleport to="body">
    <div v-if="menu" ref="root" class="edge-menu" role="menu" :aria-label="t('连线：{label}', { label: menu.label })" :style="{left:`${place.left}px`,top:`${place.top}px`}" @contextmenu.prevent>
      <div class="edge-menu-title">{{ menu.label }}</div>
      <button v-if="menu.routeIndex !== undefined" type="button" role="menuitem" @click="run(() => presentation.removeRoute(menu!.key, menu!.routeIndex!))">{{ t('删除这个中转点') }}</button>
      <button v-else type="button" role="menuitem" :disabled="route.length >= MAX_ROUTE" @click="run(() => presentation.insertRoute(menu!.key, menu!.wire, menu!.at))">{{ t('在此添加中转点') }}</button>
      <button v-if="route.length" type="button" role="menuitem" @click="run(() => presentation.reset(menu!.key, true))">{{ t('清除全部中转点') }}</button>
      <div class="edge-menu-row">
        <label>{{ t('颜色') }} <input type="color" :aria-label="t('这根线的颜色')" :value="color ?? PICKER_SWATCH" @change="setColor" /></label>
        <button type="button" role="menuitem" :aria-pressed="color === null" :title="t('按调色板分配：同一块上的线互不相同')" @click="run(() => presentation.change(menu!.key, {color:null}))">{{ t('自动配色') }}</button>
      </div>
      <button v-if="own" type="button" role="menuitem" :title="t('去掉这根线自己的颜色和中转点，跟随连线设置')" @click="run(() => presentation.reset(menu!.key))">{{ t('恢复默认') }}</button>
      <template v-if="menu.disconnect">
        <hr />
        <button type="button" role="menuitem" class="edge-menu-danger" @click="run(menu.disconnect)">{{ t('断开连接') }}</button>
      </template>
    </div>
  </Teleport>
</template>
<style scoped>
.edge-menu{position:fixed;z-index:1000;min-width:190px;max-width:280px;padding:4px;display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line-strong);border-radius:7px;color:var(--ink);font-size:12px;box-shadow:0 6px 20px #0007;user-select:none}
.edge-menu-title{padding:5px 8px 6px;color:var(--muted);font-size:11px;overflow-wrap:anywhere;border-bottom:1px solid var(--line);margin-bottom:3px}
button{font:inherit;color:inherit;background:none;border:0;border-radius:4px;padding:5px 8px;text-align:left;cursor:pointer}
button:hover:not(:disabled),button:focus-visible{background:var(--soft);outline:none}
button:disabled{color:var(--muted);cursor:default}
button[aria-pressed=true]{color:var(--focus)}
.edge-menu-row{display:flex;align-items:center;gap:6px;padding:2px 0 2px 8px}
.edge-menu-row label{display:flex;align-items:center;gap:8px;flex:1}
input[type=color]{width:30px;height:22px;padding:1px;cursor:pointer;background:none;border:1px solid var(--line);border-radius:4px}
hr{border:0;border-top:1px solid var(--line);margin:3px 0;width:100%}
.edge-menu-danger{color:var(--bad)}
</style>
