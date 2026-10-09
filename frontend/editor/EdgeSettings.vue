<script setup lang="ts">
// Canvas-wide wire settings (ComfyUI's Link Render Mode): one shape for every wire, and the colour of wires without their
// own colour. The colour, reroute points and disconnect of a single wire are in its right-click menu (EdgeMenu.vue).
import { PICKER_SWATCH, useEdgePresentation, type EdgeShape } from './edge-presentation';
import { t } from '../i18n.js';
const presentation = useEdgePresentation();
function setShape(event: Event) { presentation.changeDefaults({ shape: (event.target as HTMLSelectElement).value as EdgeShape }); }
function setColor(event: Event) { presentation.changeDefaults({ color: (event.target as HTMLInputElement).value }); }
</script>
<template>
  <details class="edge-settings nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop>
    <summary :title="t('所有连线的走线方式与默认颜色')">{{ t('连线设置') }}</summary>
    <div class="edge-settings-body">
      <label>{{ t('走线') }} <select :value="presentation.state.defaults.shape" :aria-label="t('连线形状')" @change="setShape"><option value="curve">{{ t('曲线') }}</option><option value="step">{{ t('折线') }}</option><option value="straight">{{ t('直线') }}</option></select></label>
      <label>{{ t('颜色') }} <input type="color" :aria-label="t('默认连线颜色')" :value="presentation.state.defaults.color ?? PICKER_SWATCH" @change="setColor" /><button type="button" :aria-pressed="!presentation.state.defaults.color" :title="t('按调色板分配：同一块上的线互不相同')" @click="presentation.changeDefaults({color:null})">{{ t('自动配色') }}</button></label>
      <button type="button" class="edge-settings-reset" @click="presentation.resetDefaults()">{{ t('恢复默认') }}</button>
      <p>{{ t('单根线：右键打开菜单，设置颜色、中转点或断开。值线实线，调用线虚线 ƒ。设置随工作区保存，可撤销。') }}</p>
    </div>
  </details>
</template>
<style scoped>
.edge-settings{background:var(--panel);border:1px solid var(--line-strong);border-radius:7px;color:var(--ink);font-size:12px;box-shadow:0 4px 16px #0005;user-select:none}
summary{cursor:pointer;padding:5px 10px;font-weight:600}
.edge-settings[open]{width:250px}
.edge-settings-body{padding:0 12px 10px;display:flex;flex-direction:column;gap:9px}
label{display:flex;align-items:center;gap:8px}
select{min-width:125px;flex:1}
input[type=color]{width:34px;height:26px;padding:2px;cursor:pointer}
button{font-size:11px;padding:3px 7px}
.edge-settings-reset{align-self:flex-start}
p{font-size:11px;line-height:1.5;color:var(--muted);margin:0}
</style>
