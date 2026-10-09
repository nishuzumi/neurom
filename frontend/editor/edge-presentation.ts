// editor/edge-presentation.ts — persisted wire appearance (Workspace.settings.canvas.edgePresentation) and the reroute
// gestures. The wire shape is one canvas-wide setting (ComfyUI's Link Render Mode). A single wire keeps only its colour
// and its reroute chain, keyed by its wire id.
// A wire may carry an ordered chain of reroute points (中转点) from source to target. Each point lives in the wire's own
// frame: fractions of its length along the chord (u) and across it (n). So a detour drawn on a long wire shrinks with
// the wire. It can never send a short wire on a long trip. Chains are stored per wire in the workspace appearance,
// never in the domain graph.
import { inject, reactive, shallowRef, type ShallowRef } from 'vue';
import { getBezierPath, getSmoothStepPath, getStraightPath, type Position } from '@vue-flow/core';
export type EdgeShape = 'curve' | 'step' | 'straight';
export type Side = 'left' | 'right' | 'top' | 'bottom';
interface Point { x: number; y: number }
/** reroute point in the wire frame: `u` along the chord, `n` across it, both as fractions of the wire length */
interface RoutePoint { u: number; n: number }
/** a single wire's appearance: `route` is the reroute chain in source→target order, absent when the wire follows its automatic path */
interface EdgeAppearance { color?: string | null; route?: RoutePoint[] }
/** canvas-wide settings: every wire's shape, and the colour of wires that have none of their own (`null` = palette) */
interface EdgeDefaults { shape: EdgeShape; color: string | null }
export interface EdgePresentationState { defaults: EdgeDefaults; edges: Record<string, EdgeAppearance> }
interface EdgeSelection { key: string; label: string; disconnect?: () => void }
/** the endpoints of the wire a reroute gesture edits: they define the frame its points are stored in */
interface WireFrame { a: Point; b: Point }
/** a wire's context menu: `x`/`y` in client pixels, `at` the flow position clicked, `routeIndex` the reroute point clicked */
interface EdgeMenu { key: string; x: number; y: number; at: Point; wire: WireFrame; routeIndex?: number }
interface EdgePresentation {
  state: EdgePresentationState;
  selection: ShallowRef<EdgeSelection | null>;
  /** the open wire context menu, closed by `clear()` */
  menu: ShallowRef<EdgeMenu | null>;
  /** the wire under the pointer (its presentation key): a wire, its docks and its port rows light up together */
  hover: ShallowRef<string | null>;
  hoverEnter(key: string): void;
  hoverLeave(key: string): void;
  /** a wire's own colour over the canvas default, and its reroute chain */
  read(key: string): EdgeAppearance;
  change(key: string, patch: EdgeAppearance): void;
  changeDefaults(patch: Partial<EdgeDefaults>): void;
  /** `routeOnly` clears the wire's reroute chain and keeps its colour. Otherwise the wire returns to the canvas defaults. */
  reset(key: string, routeOnly?: boolean): void;
  resetDefaults(): void;
  /** add a reroute point at flow position `p`, splitting the chain segment nearest to it */
  insertRoute(key: string, wire: WireFrame, p: Point): void;
  removeRoute(key: string, index: number): void;
  /** drag reroute point `index`, which currently sits at `from`. On an unrouted wire, index 0 creates the first point. */
  startRoute(key: string, event: PointerEvent, toLocal: (x: number, y: number) => Point, wire: WireFrame, index: number, from: Point): void;
  select(key: string, label: string, disconnect?: () => void): void;
  openMenu(menu: EdgeMenu): void;
  clear(): void;
  restore(raw: unknown): void;
  snapshot(): EdgePresentationState;
  dispose(): void;
}
const shapes = ['curve', 'step', 'straight'];
/** a reroute point may reach at most this many wire lengths away from the chord midpoint */
const ROUTE_REACH = 1.5;
/** the frame of very short wires is floored so a route on them stays draggable and finite */
const MIN_WIRE = 40;
/** longest reroute chain a wire may carry */
export const MAX_ROUTE = 16;
/** what a colour picker shows while the wire (or the canvas) is on the automatic palette */
export const PICKER_SWATCH = '#7aa2f7';
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clampReach = (v: number) => Math.max(-ROUTE_REACH, Math.min(ROUTE_REACH, v));
/** a chain keeps only finite, reach-clamped points */
function routeChain(raw: unknown): RoutePoint[] {
  const chain: RoutePoint[] = [];
  if (!Array.isArray(raw)) return chain;
  for (const v of raw) {
    if (isObject(v) && typeof v.u === 'number' && Number.isFinite(v.u) && typeof v.n === 'number' && Number.isFinite(v.n)) chain.push({ u: clampReach(v.u), n: clampReach(v.n) });
    if (chain.length === MAX_ROUTE) break;
  }
  return chain;
}
function edgeColor(raw: unknown): string | null | undefined {
  return raw === null || typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw : undefined;
}
function appearance(raw: unknown): EdgeAppearance {
  if (!isObject(raw)) return {};
  const result: EdgeAppearance = {}, color = edgeColor(raw.color);
  if (color !== undefined) result.color = color;
  const chain = routeChain(raw.route);
  if (chain.length) result.route = chain;
  return result;
}
/** chord midpoint, unit chord direction, unit normal and effective length of a wire */
interface Chord { m: Point; u: Point; n: Point; len: number }
function frameOf(a: Point, b: Point): Chord {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  const u = len < 1e-6 ? { x: 1, y: 0 } : { x: dx / len, y: dy / len };
  return { m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, u, n: { x: -u.y, y: u.x }, len: Math.max(MIN_WIRE, len) };
}
/** where a reroute point sits on the canvas, given its wire's chord */
function routeHandle(f: Chord, route: RoutePoint): Point {
  return { x: f.m.x + (route.u * f.u.x + route.n * f.n.x) * f.len, y: f.m.y + (route.u * f.u.y + route.n * f.n.y) * f.len };
}
/** the reroute point that sits at canvas position `p` */
function routeAt(a: Point, b: Point, p: Point): RoutePoint {
  const f = frameOf(a, b), dx = p.x - f.m.x, dy = p.y - f.m.y;
  return { u: clampReach((dx * f.u.x + dy * f.u.y) / f.len), n: clampReach((dx * f.n.x + dy * f.n.y) / f.len) };
}
/** index of the polyline segment of `stops` closest to `p` */
function nearestSegment(stops: Point[], p: Point) {
  let best = 0, bestDistance = Infinity;
  for (let i = 0; i + 1 < stops.length; i++) {
    const s = stops[i], dx = stops[i + 1].x - s.x, dy = stops[i + 1].y - s.y, l2 = dx * dx + dy * dy;
    const k = l2 ? Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / l2)) : 0;
    const d = Math.hypot(p.x - s.x - k * dx, p.y - s.y - k * dy);
    if (d < bestDistance) { bestDistance = d; best = i; }
  }
  return best;
}
function normalizeEdgePresentation(raw?: unknown): EdgePresentationState {
  const data = isObject(raw) ? raw : {}, defaults = isObject(data.defaults) ? data.defaults : {}, edges: Record<string, EdgeAppearance> = Object.create(null);
  if (isObject(data.edges)) for (const [key, value] of Object.entries(data.edges)) { const v = appearance(value); if (Object.keys(v).length) edges[key] = v; }
  return { defaults: { shape: shapes.includes(String(defaults.shape)) ? defaults.shape as EdgeShape : 'curve', color: edgeColor(defaults.color) ?? null }, edges };
}
export function createEdgePresentation(initial: unknown, begin: () => void, commit: () => void): EdgePresentation {
  const state = reactive(normalizeEdgePresentation(initial));
  const selection = shallowRef<EdgeSelection | null>(null), hover = shallowRef<string | null>(null), menu = shallowRef<EdgeMenu | null>(null);
  let cancelGesture: (() => void) | null = null;
  const read = (key: string): EdgeAppearance => ({ color: state.defaults.color, ...state.edges[key] });
  /** store a chain. An empty chain leaves no `route`, and a wire with nothing left to say leaves no entry. */
  function setChain(key: string, chain: RoutePoint[]) {
    const next = { ...state.edges[key] };
    if (chain.length) next.route = chain; else delete next.route;
    if (Object.keys(next).length) state.edges[key] = next; else delete state.edges[key];
  }
  function change(key: string, patch: EdgeAppearance) {
    begin(); state.edges[key] = { ...state.edges[key], ...appearance(patch) }; commit();
  }
  function changeDefaults(patch: Partial<EdgeDefaults>) {
    begin();
    if (patch.shape && shapes.includes(patch.shape)) state.defaults.shape = patch.shape;
    const color = edgeColor(patch.color);
    if (color !== undefined) state.defaults.color = color;
    commit();
  }
  function reset(key: string, routeOnly = false) {
    begin();
    if (routeOnly) setChain(key, []); else delete state.edges[key];
    commit();
  }
  function resetDefaults() { begin(); state.defaults.shape = 'curve'; state.defaults.color = null; commit(); }
  function insertRoute(key: string, wire: WireFrame, p: Point) {
    const chain = state.edges[key]?.route ?? [];
    if (chain.length >= MAX_ROUTE) return;
    const f = frameOf(wire.a, wire.b), at = nearestSegment([wire.a, ...chain.map(r => routeHandle(f, r)), wire.b], p);
    begin(); setChain(key, [...chain.slice(0, at), routeAt(wire.a, wire.b, p), ...chain.slice(at)]); commit();
  }
  function removeRoute(key: string, index: number) {
    const chain = state.edges[key]?.route ?? [];
    if (index < 0 || index >= chain.length) return;
    begin(); setChain(key, chain.filter((_, i) => i !== index)); commit();
  }
  /** Drag a reroute point: the pointer's displacement moves the point from where it sits, and the new spot is stored in the wire's frame. */
  function startRoute(key: string, event: PointerEvent, toLocal: (x: number, y: number) => Point, wire: WireFrame, index: number, from: Point) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); cancelGesture?.();
    const previous = state.edges[key] ? { ...state.edges[key] } : undefined;
    const chain = previous?.route ?? [], at = Math.min(index, chain.length);
    if (at >= MAX_ROUTE) return;
    const start = toLocal(event.clientX, event.clientY);
    const target = event.currentTarget instanceof Element ? event.currentTarget : null;
    let moved = false;
    begin();
    try { target?.setPointerCapture(event.pointerId); } catch { /* window listeners still own the gesture */ }
    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      const p = toLocal(e.clientX, e.clientY);
      if (!moved && Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) < 3) return;
      moved = true;
      const next = chain.slice();
      next[at] = routeAt(wire.a, wire.b, { x: from.x + p.x - start.x, y: from.y + p.y - start.y });
      state.edges[key] = { ...previous, route: next };
    };
    const finish = (cancelled: boolean) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
      try { if (target?.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId); } catch { /* detached view */ }
      if (cancelled) { if (previous) state.edges[key] = previous; else delete state.edges[key]; }
      cancelGesture = null; commit();
    };
    const up = (e: PointerEvent) => { if (e.pointerId === event.pointerId) finish(false); };
    const cancel = (e: PointerEvent) => { if (e.pointerId === event.pointerId) finish(true); };
    cancelGesture = () => finish(true);
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel);
  }
  return {
    state, selection, hover, menu, read, change, changeDefaults, reset, resetDefaults, insertRoute, removeRoute, startRoute,
    hoverEnter(key: string) { hover.value = key; },
    hoverLeave(key: string) { if (hover.value === key) hover.value = null; },
    select(key: string, label: string, disconnect?: () => void) { selection.value = { key, label, disconnect }; if (menu.value && menu.value.key !== key) menu.value = null; },
    openMenu(value: EdgeMenu) { menu.value = value; },
    clear() { selection.value = null; menu.value = null; },
    restore(raw: unknown) { cancelGesture?.(); const value = normalizeEdgePresentation(raw); state.defaults = value.defaults; state.edges = value.edges; selection.value = null; hover.value = null; menu.value = null; },
    snapshot(): EdgePresentationState { return JSON.parse(JSON.stringify(state)); },
    dispose() { cancelGesture?.(); selection.value = null; hover.value = null; menu.value = null; },
  };
}
export const EDGE_PRESENTATION: unique symbol = Symbol('neurom-edge-presentation');
export function useEdgePresentation(): EdgePresentation {
  const value = inject<EdgePresentation>(EDGE_PRESENTATION);
  if (!value) throw new Error('Canvas edge presentation provider is missing');
  return value;
}
function pathBetween(a: Point, b: Point, from: Side, to: Side, shape: EdgeShape) {
  const options = {sourceX:a.x,sourceY:a.y,targetX:b.x,targetY:b.y,sourcePosition:from as Position,targetPosition:to as Position};
  return shape === 'straight' ? getStraightPath(options) : shape === 'step' ? getSmoothStepPath({...options,borderRadius:0}) : getBezierPath(options);
}
/** the side a wire enters a reroute point on so that its tangent there follows the line from the previous stop to the next */
function throughSide(prev: Point, next: Point): Side {
  return Math.abs(next.x-prev.x) >= Math.abs(next.y-prev.y) ? (next.x>=prev.x?'left':'right') : (next.y>=prev.y?'top':'bottom');
}
const opposite: Record<Side, Side> = {left:'right',right:'left',top:'bottom',bottom:'top'};
/**
 * The automatic path, or one library segment per chain link threaded through every reroute point in order (`straight` is a
 * polyline). `points` are the reroute points on the canvas. `handle` is where the wire's label sits, and on an unrouted
 * wire also its first reroute handle. That is the middle segment's label spot, or the automatic label spot when there are
 * no points.
 */
export function routeGeometry(a: Point, b: Point, from: Side, to: Side, shape: EdgeShape, route: readonly RoutePoint[] = []) {
  if (!route.length) { const [path, x, y] = pathBetween(a,b,from,to,shape); return {path,handle:{x,y},points:[] as Point[]}; }
  const f = frameOf(a, b), points = route.map(r => routeHandle(f, r));
  const stops = [a, ...points, b], middle = points.length >> 1;
  let path = '', handle = a;
  for (let i = 0; i + 1 < stops.length; i++) {
    // Consecutive segments meet at each reroute point on opposite sides of one axis, so their tangents agree there.
    const exit = i === 0 ? from : opposite[throughSide(stops[i-1], stops[i+1])];
    const enter = i + 2 === stops.length ? to : throughSide(stops[i], stops[i+2]);
    const segment = pathBetween(stops[i], stops[i+1], exit, enter, shape);
    if (i === middle) handle = shape === 'straight' ? {x:(stops[i].x+stops[i+1].x)/2,y:(stops[i].y+stops[i+1].y)/2} : {x:segment[1],y:segment[2]};
    path += i === 0 ? segment[0] : segment[0].replace(/^M\s*[-+\d.e]+[,\s]+[-+\d.e]+\s*/i,'');
  }
  return {path,handle,points};
}
