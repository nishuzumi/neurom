<script setup lang="ts">
import { computed, inject } from 'vue';
import { BaseEdge, EdgeLabelRenderer, useVueFlow, type EdgeProps } from '@vue-flow/core';
import { routeGeometry, useEdgePresentation, type Side } from './edge-presentation';
import { CANVAS_WIRING } from './wiring';
import { t } from '../i18n.js';
// CanvasEdge.vue — one wire of the module graph. Value wires are solid. Call wires (a function handed to the receiver)
// are dashed and labelled ƒ. The persisted appearance (colour, reroute chain) and the reroute gestures come from
// edge-presentation.ts. The label names the two ends of the wire.
interface CanvasEdgeData {kind:'value'|'call';label:string}
const props=defineProps<EdgeProps<CanvasEdgeData>>();
const presentation=useEdgePresentation(),flow=useVueFlow(),canvas=inject(CANVAS_WIRING);
const key=computed(()=>props.id);
const appearance=computed(()=>presentation.read(key.value));
const selected=computed(()=>presentation.selection.value?.key===key.value);
/** the pointer is on this wire or on one of its docks / port markers: the whole path highlights and shows its name */
const hot=computed(()=>presentation.hover.value===key.value);
const wire=computed(()=>({a:{x:props.sourceX,y:props.sourceY},b:{x:props.targetX,y:props.targetY}}));
const geometry=computed(()=>routeGeometry(wire.value.a,wire.value.b,props.sourcePosition as Side,props.targetPosition as Side,presentation.state.defaults.shape,appearance.value.route));
/** persisted appearance, else the wire's palette colour (the same one its docks and port markers wear) */
const stroke=computed(()=>appearance.value.color??canvas?.colorOf(props.id)??'var(--wire)');
const isCall=computed(()=>props.data?.kind==='call');
/** the wire goes through reroute points. They stay visible as dots, so the user sees why a wire bends (检查器 → 清除中转点 straightens it) */
const routed=computed(()=>geometry.value.points.length>0);
const label=computed(()=>(isCall.value?'ƒ ':'')+(props.data?.label??''));
/** a call wire always wears a small ƒ. The full label appears on hover / selection */
const shown=computed(()=>isCall.value&&!selected.value&&!hot.value?'ƒ':label.value);
/** the slot's full hint: label, dashed-line meaning, reroute count, then the gestures the wire takes */
const hint=computed(()=>{
  const parts=[label.value];
  if(isCall.value)parts.push(t('虚线：调用线。接收方按签名调用这个函数'));
  if(routed.value)parts.push(t('{count} 个中转点',{count:geometry.value.points.length}));
  return t('{summary}。点击选择连线。右键打开连线菜单。Alt+点击或双击连线，添加中转点。拖动中转点来移动它。双击中转点删除它。',{summary:parts.join(' · ')});
});
const toFlow=(x:number,y:number)=>flow.screenToFlowCoordinate({x,y});
/** drag reroute point `index` from its current position. On an unrouted wire, the automatic handle becomes the first point */
function moveRoute(e:PointerEvent,index:number,from:{x:number;y:number}){ presentation.startRoute(key.value,e,toFlow,wire.value,index,from); }
function insertAt(e:MouseEvent){ presentation.insertRoute(key.value,wire.value,toFlow(e.clientX,e.clientY)); }
/** Alt+click on the wire adds a reroute point under the pointer. The click still selects the wire */
function onWireClick(e:MouseEvent){ if(e.altKey)insertAt(e); }
function onWireDoubleClick(e:MouseEvent){ e.stopPropagation(); insertAt(e); }
/** Alt+click on a reroute point removes it. A plain click only stops the node and pane gestures */
function onPointClick(e:MouseEvent,index:number){ if(e.altKey)presentation.removeRoute(key.value,index); }
/** right-click opens the menu of this wire (ComfyUI's link menu). On a reroute point, the menu can also remove that point.
 * The event still bubbles to the Vue Flow edge wrapper, whose edgeContextMenu hook selects the wire (index.ts). */
function onMenu(e:MouseEvent){
  e.preventDefault();
  const index=(e.target as Element|null)?.closest?.('[data-route-index]')?.getAttribute('data-route-index');
  presentation.openMenu({key:key.value,x:e.clientX,y:e.clientY,at:toFlow(e.clientX,e.clientY),wire:wire.value,routeIndex:index==null?undefined:+index});
}
</script>
<template>
  <g class="canvas-link" :class="{selected,hot}" :data-presentation-key="key" @mouseenter="presentation.hoverEnter(key)" @mouseleave="presentation.hoverLeave(key)" @click="onWireClick" @dblclick="onWireDoubleClick" @contextmenu="onMenu">
    <title>{{ hint }}</title>
    <BaseEdge :id="id" :path="geometry.path" :interaction-width="16" :style="{stroke,strokeWidth:selected||hot?3.5:2,strokeDasharray:isCall?'6 5':undefined,fill:'none'}" />
    <circle v-for="(p,i) in geometry.points" :key="i" class="edge-route-handle" :data-edge-key="key" :data-route-index="i" :cx="p.x" :cy="p.y" :r="selected?8:4" :fill="stroke" tabindex="0" role="button" :aria-label="t('中转点：拖动移动，双击删除')" @pointerdown.stop="moveRoute($event,i,p)" @click.stop="onPointClick($event,i)" @dblclick.stop="presentation.removeRoute(key,i)" />
    <circle v-if="selected&&!routed" class="edge-route-handle" :data-edge-key="key" :cx="geometry.handle.x" :cy="geometry.handle.y" r="8" :fill="stroke" tabindex="0" role="button" :aria-label="t('拖出中转点')" @pointerdown.stop="moveRoute($event,0,geometry.handle)" @click.stop @dblclick.stop />
  </g>
  <EdgeLabelRenderer v-if="selected||hot||isCall"><div class="binding-label" :class="{hot}" :style="{transform:`translate(-50%, -100%) translate(${geometry.handle.x}px, ${geometry.handle.y-12}px)`,'--wc':stroke}">{{ shown }}<span v-if="routed&&(selected||hot)"> · {{ t('手动路径') }}</span></div></EdgeLabelRenderer>
</template>
