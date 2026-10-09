// editor/canvas-geometry.ts — where everything on the canvas is drawn and how big it is. The functions are pure over
// the ModuleGraph, the browser's measurements (a lookup, sizes.ts estimates until then) and the viewport's aspect.
// This file answers:
//  - Which flow node draws a module. It can be the module's own card, the collapsed group that holds it, or the loop
//    box whose loop it is. It can also be the training module it is a section of, or the network card whose tool
//    layer it is in.
//  - Which handle on that flow node stands for each member port (ADR 0003: every gesture resolves a socket back to
//    its member port).
//  - The rect of every unit. A unit is a module, a collapsed group, or an expanded group around its members. A unit
//    can also be a loop box with the room its run takes, or a training module (training-module.js lays its frame out).
//  - Arrange (CONTEXT.md), the tidy-up after a resize, and a drop's new membership. These operations return the moves
//    and membership changes, and index.ts applies them as one history edit.
// Nothing here changes the graph or touches the DOM.
import type { Group, GraphNode, ModuleGraph } from './workbench-context';
import { facing, trainingModule, type SectionColumns, type TrainingFrame, type TrainingModule } from './training-module.js';
import { toolLayers, type ToolLayer, type ToolUnit } from './tool-canvas.js';
import { COLLAPSED_GROUP, estimateHeight, GAP, GROUP_PAD, LOOP_FRAME, TOOL_CANVAS, widthOf } from './sizes.ts';
import { clamp, contiguousSplit, intersects, round, union, type Rect } from './layout.ts';

/** a unit's new stored corner: a node's position, a group's x / y */
export interface Move { id: string; x: number; y: number }
/** a drop's new membership: `id` leaves group `from` (null: the canvas) for `to` */
export interface Membership { id: string; from: string | null; to: string | null }
/** a member port as a flow node's handle */
export interface Socket { node: string; handle: string }

export interface CanvasGeometry {
  /** the training module group `groupId` is drawn as, or null */
  training(groupId: string): TrainingModule | null;
  /** a training module's frame as drawn (group `groupId` must be one) */
  frame(groupId: string): TrainingFrame;
  /** the loop node group `groupId` is the box of (`group.loop`, while it is a direct member), or null. An expanded box
   *  draws it as its frame. */
  boxLoop(groupId: string): string | null;
  /** every group drawn (not inside a collapsed one), outermost first */
  groups(): Group[];
  /** the flow node that draws `id`: the group it docks in, the network card it is drawn inside, or its own */
  shownBy(id: string): string;
  /** the training module `id` is a section of, or null */
  sectionOf(id: string): string | null;
  /** the network whose tool layer draws `id` inside its card, or null */
  toolHost(id: string): string | null;
  /** the tool layers of network `id` (tool-canvas.js), [] when it is not drawn itself or has none */
  toolLayers(id: string): ToolLayer[];
  /** where member port `port` of `node` is drawn: its own card's handle, else the slot `${node}/${port}` of the flow
   *  node that shows it */
  socket(node: string, port: string): Socket;
  /** the member port a flow node's handle stands for, the inverse of socket. Any other handle is the node's own port. */
  member(flowNode: string, handle: string | null | undefined): { node: string; port: string };
  /** a module's host width (AGENTS.md): node.uiSize.w, else its kind's. A network with tool layers is as wide as the
   *  cards of its unfolded layers want. */
  hostWidth(id: string): number;
  /** the rect of a node or group, measured where the browser measured it */
  rect(unit: string): Rect;
  /** where a module added into the expanded group `groupId` goes: below its canvas members, else inside its frame */
  insertAt(groupId: string): { x: number; y: number };
  /** Arrange (整理) the selected node ids, or the whole canvas for null. Returns null when nothing is selected.
   *  `settle`: the unit to untangle again once the new cards are measured (null: the canvas), absent when there is
   *  none. */
  arrange(ids: string[] | null): { moves: Move[]; settle?: string | null } | null;
  /** the tidy-up after `unit` changed size (null: the canvas) */
  untangle(unit: string | null): Move[];
  /** lay `units`, members of `container` (null: the canvas), out as Arrange does */
  layOut(units: string[], container: string | null): Move[];
  /** move a node, or a group with everything inside it, by (dx, dy) */
  translate(unit: string, dx: number, dy: number): Move[];
  /** where dropped nodes and groups (`rect`: where they landed) now belong, against the expanded groups' `frames` drawn
   *  before the drag */
  regroup(drops: { id: string; rect: Rect }[], frames: ReadonlyMap<string, Rect>): Membership[];
}

/**
 * @param env.graph the graph drawn (a reload swaps it)
 * @param env.measured a flow node's size after the browser measures it
 * @param env.aspect the viewport's width / height: Arrange keeps the whole close to it
 * @param env.columns the training modules' section columns (training-module.js sectionColumns)
 */
export function canvasGeometry(env: { graph: () => ModuleGraph; measured: (id: string) => { w: number; h: number } | undefined; aspect: () => number; columns: SectionColumns }): CanvasGeometry {
  const { measured, columns } = env;
  /** per graph version: each group's training module, the tool layers of every network drawn itself and the network
   *  each module drawn inside one of them belongs to */
  const memo = { graph: null as ModuleGraph | null, version: -1, training: new Map<string, TrainingModule | null>(), tools: null as { layers: Map<string, ToolLayer[]>; host: Map<string, string> } | null };
  function graph(): ModuleGraph {
    const g = env.graph();
    if (memo.graph !== g || memo.version !== g.version) { Object.assign(memo, { graph: g, version: g.version, tools: null }); memo.training.clear(); }
    return g;
  }
  /** positions that an operation moved so far (null outside one). Every rect reads them. The graph stays unchanged. */
  let draft: Map<string, { x: number; y: number }> | null = null;
  function at(id: string) {
    const g = graph(), o = g.groups.get(id) ?? g.node(id);
    return draft?.get(id) ?? { x: o.x, y: o.y };
  }
  function moving(fn: () => void): Move[] {
    draft = new Map();
    try { fn(); return [...draft].map(([id, p]) => ({ id, ...p })); } finally { draft = null; }
  }

  // ------------------------------------------------------------------ what draws what
  /** the groups enclosing `id`, innermost first */
  function* ancestors(id: string) { const g = graph(); for (let p = g.parentOf(id); p; p = g.parentOf(p.id)) yield p; }
  const nestingOf = (id: string) => [...ancestors(id)].length;
  /** the outermost collapsed group above `id`, or null when the object is drawn itself */
  function holderOf(id: string): Group | null {
    let holder: Group | null = null;
    for (const g of ancestors(id)) if (g.collapsed) holder = g;
    return holder;
  }
  /** the loop node a group is the box of: `group.loop`, when that node is one of its direct members */
  function boxLoop(group: Group): string | null {
    return group.loop && group.members.includes(group.loop) && graph().hasNode(group.loop) ? group.loop : null;
  }
  function training(groupId: string): TrainingModule | null {
    const g = graph();
    if (!memo.training.has(groupId)) memo.training.set(groupId, trainingModule(g, groupId));
    return memo.training.get(groupId)!;
  }
  function sectionOf(id: string): string | null {
    const parent = graph().parentOf(id);
    return parent && training(parent.id)?.sections.includes(id) ? parent.id : null;
  }
  /** where a node's slots are drawn when the node is not drawn itself. That is the collapsed group that holds it, or
   *  the expanded box whose loop it is (its ports sit on the frame). It can also be the training module it is a
   *  section of. */
  function dockOf(id: string): string | null {
    const holder = holderOf(id); if (holder) return holder.id;
    const parent = graph().parentOf(id);
    return parent && boxLoop(parent) === id ? parent.id : sectionOf(id);
  }
  function tools() {
    const g = graph();
    if (memo.tools) return memo.tools;
    const layers = new Map<string, ToolLayer[]>(), host = new Map<string, string>();
    for (const n of g.nodes.values()) {
      if (n.kind !== 'network' || holderOf(n.id)) continue;
      const of = toolLayers(g, n.id, id => !holderOf(id));   // a module held in a collapsed group is never drawn inside
      if (!of.length) continue;
      layers.set(n.id, of);
      for (const L of of) for (const u of L.inside) for (const id of [u.node, u.readout]) if (id) host.set(id, n.id);
    }
    return (memo.tools = { layers, host });
  }
  const toolHost = (id: string) => tools().host.get(id) ?? null;
  const shownBy = (id: string) => dockOf(id) ?? toolHost(id) ?? id;

  // ------------------------------------------------------------------ sizes and rects
  /** the cards of a network's unfolded tool layers: the frozen networks (columns) and the code tools (a row each) */
  function toolCards(n: GraphNode) {
    const g = graph(), folded = new Set(n.uiFolded ?? []), units = (tools().layers.get(n.id) ?? []).filter(L => !folded.has(L.port)).map(L => L.inside);
    const isCode = (u: ToolUnit) => !u.readout && g.node(u.node).kind === 'code';
    return { columns: units.map(us => us.filter(u => !isCode(u))), rows: units.map(us => us.filter(isCode)) };
  }
  /** up to TOOL_CANVAS.columns cards stand side by side, and each code tool gets its own row */
  function widthIn(n: GraphNode): number {
    const T = TOOL_CANVAS;
    if (n.uiSize?.w || n.uiCollapsed || n.kind !== 'network') return widthOf(n);
    const { columns: cols, rows } = toolCards(n);
    let w = widthOf(n);
    for (const [i, cards] of cols.entries()) {
      const k = Math.min(T.columns, cards.length);
      if (k) w = Math.max(w, k * T.column + (k - 1) * T.gap + T.pad);
      if (rows[i].length) w = Math.max(w, T.code + T.pad);
    }
    return w;
  }
  /** the estimated height of a module (before it is measured): a network card adds its tool layers */
  function heightIn(n: GraphNode): number {
    const T = TOOL_CANVAS, h = estimateHeight(n);
    if (n.uiSize?.h || n.uiCollapsed || !tools().layers.has(n.id)) return h;
    const g = graph(), all = tools().layers.get(n.id)!.length, { columns: cols, rows } = toolCards(n);
    const card = (u: ToolUnit) => T.card + (g.node(u.node).uiCollapsed ? 0 : estimateHeight(g.node(u.node)) + (u.readout ? estimateHeight(g.node(u.readout)) : 0));
    let extra = all * T.head;
    for (const [i, cards] of cols.entries()) {
      const k = Math.max(1, Math.min(T.columns, cards.length));
      for (let r = 0; r < cards.length; r += k) extra += Math.max(...cards.slice(r, r + k).map(card)) + T.gap;
      for (const u of rows[i]) extra += card(u) + T.gap;
    }
    return h + extra;
  }
  function rect(unit: string): Rect {
    const g = graph();
    if (g.groups.has(unit)) return groupRect(g.group(unit));
    const n = g.node(unit), m = measured(unit), p = at(unit);
    return { x: p.x, y: p.y, w: m?.w ?? widthIn(n), h: m?.h ?? heightIn(n) };
  }
  /** an expanded group's frame is the union of its members plus padding. A loop box leaves out its loop node and adds the
   *  room LOOP_FRAME keeps for the loop's run around them. A training module's frame holds its well and section
   *  columns. A collapsed group is a node at its stored position. */
  function groupRect(group: Group): Rect {
    const loop = boxLoop(group), p = at(group.id), C = COLLAPSED_GROUP;
    if (group.collapsed) return { ...p, w: C.w, h: measured(group.id)?.h ?? C.head + C.row * (Math.max(1, group.expose.length) + (loop ? 1 : 0)) };
    if (training(group.id)) return frame(group.id).rect;
    const u = union(group.members.filter(id => id !== loop && !toolHost(id)).map(rect)) ?? { ...p, w: 200, h: 100 };
    if (loop) { const F = LOOP_FRAME; return { x: u.x - F.left, y: u.y - F.top, w: u.w + F.left + F.right, h: Math.max(u.h, F.minH) + F.top + F.bottom }; }
    return { x: u.x - GROUP_PAD.x, y: u.y - GROUP_PAD.top, w: u.w + GROUP_PAD.x * 2, h: u.h + GROUP_PAD.top + GROUP_PAD.bottom };
  }
  /** frames that choose their column count now. A frame is not a neighbour of the frames that it looks at during that
   *  time. */
  const framing = new Set<string>();
  function frame(groupId: string): TrainingFrame {
    const g = graph(), tm = training(groupId)!;
    return columns.frame(g, tm, {
      content: union(tm.canvas.filter(id => !toolHost(id)).map(rect)), corner: at(groupId), height: measured(groupId)?.h,
      neighbours: () => {
        framing.add(groupId);
        try { return unitsOf(g.parentOf(groupId)?.id ?? null).filter(u => u !== groupId && !framing.has(u)).map(rect); } finally { framing.delete(groupId); }
      },
    });
  }

  // ------------------------------------------------------------------ Arrange
  /** The direct members of a group, or the top level of the canvas for null. A box leaves out its loop node, because
   *  the frame draws it. A training module gives its canvas members, because the frame draws the sections. A tool drawn
   *  inside its network card is never a unit (it moves with the card). */
  function unitsOf(container: string | null): string[] {
    const g = graph();
    if (!container) return [...g.nodes.keys(), ...g.groups.keys()].filter(id => !g.parentOf(id) && !toolHost(id));
    const group = g.group(container), loop = boxLoop(group);
    return (training(container)?.canvas ?? group.members).filter(id => id !== loop && !toolHost(id));
  }
  /** The member of `container` a node sits in (itself, or the nested group holding it). Null outside `container`. */
  function unitIn(container: string | null) {
    return (nodeId: string): string | null => {
      let unit = nodeId;
      for (const p of ancestors(nodeId)) { if (p.id === container) return unit; unit = p.id; }
      return container === null ? unit : null;
    };
  }
  function translate(unit: string, dx: number, dy: number) {
    const g = graph(), p = at(unit);
    if (!g.groups.has(unit)) { draft!.set(unit, { x: round(p.x + dx), y: round(p.y + dy) }); return; }
    for (const m of g.group(unit).members) translate(m, dx, dy);
    draft!.set(unit, { x: p.x + dx, y: p.y + dy });
  }
  /**
   * Lay `units` out as a flow that reads step by step, like text. Layers go left→right by wire depth. The layers wrap
   * into bands stacked top→bottom, so the whole keeps about the viewport's aspect and is not one endless row.
   * Every wire counts between the units that hold its two ends. A wire that crosses group boundaries links the members
   * of this level that contain its endpoints. Three rules come from the port declarations:
   *  - A wire into a port declared `loop` (a loop's `action`, a network's `weights`) counts like any other wire. The
   *    exception is a wire that would close a cycle (the trained network's own candidates → weights, through its
   *    trainer). So frozen weights stand before the box they feed.
   *  - A wire into a facing input (training-module.js facing: a driver's `loop` or `structure` handle) runs from the
   *    driver to what it drives (trainer, evaluator, execution → the loop they run, the network they train). So
   *    drivers stand before their loop box.
   *  - A unit that only hands a whole module to one consumer (a scenario to its loop) follows the rules of that
   *    consumer: same layer, right below it.
   * Wires stay short and straight:
   *  - A unit with no inputs sits one layer before its nearest consumer, not at the far left.
   *  - Inside a layer, units are ordered by the barycentre of their neighbours (alternating sweeps) to cut crossings.
   *  - Each unit is placed level with the units that feed it, and never overlaps the one above.
   * The top-left corner stays where the topmost/leftmost unit was. `unitOf(nodeId)` names the unit a node belongs to
   * (null: this layout does not include the node).
   */
  function layoutUnits(units: string[], unitOf: (nodeId: string) => string | null) {
    const g = graph(), res = g.resolved(), list = [...new Set(units)];
    if (!list.length) return;
    const preds = new Map(list.map(u => [u, new Set<string>()])), succs = new Map(list.map(u => [u, new Set<string>()]));
    const handsModule: [string, string][] = [], closing: [string, string][] = [];
    const link = (a: string, b: string) => { preds.get(b)!.add(a); succs.get(a)!.add(b); };
    for (const w of g.wires.values()) {
      let a = unitOf(w.from.node), b = unitOf(w.to.node);
      if (!a || !b || a === b || !preds.has(a) || !preds.has(b)) continue;
      const into = res.portsOf(w.to.node).inputs.find(p => p.id === w.to.port);
      if (into?.loop) { closing.push([a, b]); continue; }
      if (into && facing(into)) [a, b] = [b, a];
      if (into?.handle === 'module') handsModule.push([a, b]);
      link(a, b);
    }
    const reaches = (from: string, to: string) => {
      const seen = new Set([from]), stack = [from];
      while (stack.length) for (const s of succs.get(stack.pop()!)!) { if (s === to) return true; if (!seen.has(s)) { seen.add(s); stack.push(s); } }
      return false;
    };
    for (const [a, b] of closing) if (!reaches(b, a)) link(a, b);
    const below = new Map<string, string>();
    for (const [a, b] of handsModule) if (!preds.get(a)!.size && succs.get(a)!.size === 1) { below.set(a, b); succs.get(a)!.clear(); preds.get(b)!.delete(a); }
    const depth = new Map<string, number>(), visiting = new Set<string>();
    const depthOf = (u: string): number => {
      if (depth.has(u)) return depth.get(u)!;
      if (visiting.has(u)) return 0;
      visiting.add(u);
      const d = [...preds.get(u)!].reduce((m, p) => Math.max(m, depthOf(p) + 1), 0);
      visiting.delete(u); depth.set(u, d); return d;
    };
    list.forEach(depthOf);
    for (const u of list) if (!preds.get(u)!.size && succs.get(u)!.size) depth.set(u, Math.max(0, Math.min(...[...succs.get(u)!].map(s => depth.get(s)!)) - 1));
    const rects = new Map(list.map(u => [u, rect(u)]));
    const origin = { x: Math.min(...[...rects.values()].map(r => r.x)), y: Math.min(...[...rects.values()].map(r => r.y)) };
    const byDepth: string[][] = [];
    for (const u of list) if (!below.has(u)) (byDepth[depth.get(u)!] ??= []).push(u);
    const layers = byDepth.filter(Boolean).map(layer => layer.sort((a, b) => rects.get(a)!.y - rects.get(b)!.y));
    // crossing reduction: barycentre ordering, sweeping down (by predecessors) and up (by successors)
    const rank = new Map<string, number>();
    for (const layer of layers) layer.forEach((u, i) => rank.set(u, i / Math.max(1, layer.length - 1)));
    const centre = (u: string, nbrs: Set<string>) => { const r = [...nbrs].map(v => rank.get(v)!); return r.length ? r.reduce((s, v) => s + v, 0) / r.length : rank.get(u)!; };
    for (let sweep = 0; sweep < 4; sweep++) {
      const down = sweep % 2 === 0, order = down ? layers.slice(1) : layers.slice(0, -1).reverse();
      for (const layer of order) {
        const key = new Map(layer.map(u => [u, centre(u, down ? preds.get(u)! : succs.get(u)!)]));
        layer.sort((a, b) => key.get(a)! - key.get(b)!);
        layer.forEach((u, i) => rank.set(u, i / Math.max(1, layer.length - 1)));
      }
    }
    for (const [a, b] of below) { const layer = layers.find(l => l.includes(b)); if (layer) layer.splice(layer.indexOf(b) + 1, 0, a); else layers.push([a]); }
    // wrap consecutive layers into bands. For every band count, take the split with the narrowest widest band
    // (balanced rows). Then keep the count whose overall shape is closest to the viewport's aspect.
    const n = layers.length;
    const colW = layers.map(layer => Math.max(...layer.map(u => rects.get(u)!.w)));
    const colH = layers.map(layer => layer.reduce((s, u) => s + rects.get(u)!.h, 0) + GAP.y * (layer.length - 1));
    const target = clamp(env.aspect(), 1.2, 2.2);
    const prefix = [0]; colW.forEach(w => prefix.push(prefix[prefix.length - 1] + w));
    const span = (from: number, to: number) => prefix[to] - prefix[from] + GAP.x * (to - from - 1);   // layers [from, to)
    let bands: number[][] = [layers.map((_, i) => i)], best = Infinity;
    for (let k = 1; k <= n; k++) {
      const split = contiguousSplit(n, k, span), widest = Math.max(...split.map(band => span(band[0], band[band.length - 1] + 1)));
      const h = split.reduce((s, band) => s + Math.max(...band.map(i => colH[i])), 0) + GAP.band * (k - 1);
      const score = Math.abs(Math.log(widest / h / target));
      if (score < best - 1e-9) { best = score; bands = split; }
    }
    // place: each unit level with the centre of what feeds it (within its band), pushed down past the unit above
    const centreY = new Map<string, number>();
    let top = origin.y;
    for (const band of bands) {
      let x = origin.x, bottom = top;
      for (const i of band) {
        let y = top;
        for (const u of layers[i]) {
          const r = rects.get(u)!, fed = [...preds.get(u)!].filter(p => centreY.has(p)).map(p => centreY.get(p)!);
          const want = fed.length ? fed.reduce((s, v) => s + v, 0) / fed.length - r.h / 2 : top;
          const y1 = Math.max(y, Math.round(want));
          translate(u, x - r.x, y1 - r.y);
          centreY.set(u, y1 + r.h / 2); y = y1 + r.h + GAP.y; bottom = Math.max(bottom, y1 + r.h);
        }
        x += colW[i] + GAP.x;
      }
      for (const i of band) for (const u of layers[i]) centreY.delete(u);   // the next band starts level again
      top = bottom + GAP.band;
    }
  }
  const layoutLevel = (container: string | null) => layoutUnits(unitsOf(container), unitIn(container));
  /** Lay out a whole composite: every nested group's interior first (collapsed ones too, so they open tidy), then the level. */
  function layoutTree(container: string | null) {
    for (const unit of unitsOf(container)) if (graph().groups.has(unit)) layoutTree(unit);
    layoutLevel(container);
  }
  /** Does `unit` (or, without it, any member of the level) overlap another member of `container`? */
  function crowded(container: string | null, unit: string | null = null) {
    const rects = unitsOf(container).map(u => [u, rect(u)] as const);
    return rects.some(([a, ra], i) => (unit === null || a === unit) && rects.some(([, rb], j) => j !== i && intersects(ra, rb)));
  }
  /** Untangle after `unit` changed size (a group expanded / collapsed, members measured). Inside every expanded group
   *  of its subtree, a level that overlaps is laid out again. Then every enclosing group re-flows its level (its
   *  footprint changed, so its bands are re-balanced). The top level of the canvas holds the user's own arrangement,
   *  so it re-flows only when the outermost group now overlaps a neighbour there. */
  function untangle(unit: string | null) {
    const g = graph();
    const inner = (container: string) => {
      for (const u of g.group(container).members) if (g.groups.has(u) && !g.group(u).collapsed) inner(u);
      if (crowded(container)) layoutLevel(container);
    };
    if (unit && g.groups.has(unit) && !g.group(unit).collapsed) inner(unit);
    for (let up = unit; up; ) {
      const parent = g.parentOf(up)?.id ?? null;
      if (parent) layoutLevel(parent);
      else if (crowded(null, up)) layoutLevel(null);
      if (!parent) break;
      up = parent;
    }
  }

  return {
    training,
    frame,
    boxLoop: groupId => boxLoop(graph().group(groupId)),
    groups() { return [...graph().groups.values()].filter(group => !holderOf(group.id)).sort((a, b) => nestingOf(a.id) - nestingOf(b.id)); },
    shownBy,
    sectionOf,
    toolHost,
    toolLayers: id => tools().layers.get(id) ?? [],
    socket(node, port) { const shown = shownBy(node); return { node: shown, handle: shown === node ? port : `${node}/${port}` }; },
    member(flowNode, handle) {
      const slash = handle?.indexOf('/') ?? -1, node = slash > 0 ? handle!.slice(0, slash) : null;
      return node !== null && graph().hasNode(node) && shownBy(node) === flowNode ? { node, port: handle!.slice(slash + 1) } : { node: flowNode, port: handle ?? '' };
    },
    hostWidth: id => widthIn(graph().node(id)),
    rect,
    insertAt(groupId) {
      const u = union(unitsOf(groupId).map(rect)), r = rect(groupId);
      return { x: round(u ? u.x : r.x + GROUP_PAD.x), y: round(u ? u.y + u.h + GAP.y : r.y + r.h) };
    },
    /** Selected nodes that are exactly one group's members lay out that group as a tree (template instances
     *  included). Any other selection is laid out flat. A node inside a collapsed group or a training module moves as
     *  that frame (a section always does). With nothing selected, Arrange lays out the whole canvas. The frames that
     *  split their sections themselves split them again (a placed split stays). */
    arrange(ids) {
      const g = graph();
      columns.rebalance();
      if (ids === null) return { moves: moving(() => layoutTree(null)), settle: null };
      const selected = new Set(ids.filter(id => g.hasNode(id)));
      if (!selected.size) return null;
      const whole = [...g.groups.values()].find(group => { const m = g.memberNodes(group.id); return m.length === selected.size && m.every(id => selected.has(id)); });
      if (whole) return { moves: moving(() => layoutTree(whole.id)), settle: whole.id };
      const unitOf = (id: string) => {
        let unit = id;
        for (const p of ancestors(id)) {
          const members = new Set(g.memberNodes(p.id));
          if ([...selected].every(m => members.has(m))) break;
          if (p.collapsed || training(p.id)) unit = p.id;
        }
        return unit;
      };
      const units = [...new Set([...selected].map(unitOf))].filter(u => !sectionOf(u));
      return { moves: moving(() => layoutUnits(units, id => { const u = unitOf(id); return units.includes(u) ? u : null; })) };
    },
    untangle: unit => moving(() => untangle(unit)),
    layOut: (units, container) => moving(() => layoutUnits(units, unitIn(container))),
    translate: (unit, dx, dy) => moving(() => translate(unit, dx, dy)),
    /** A dragged node or group whose centre lands in another expanded group's frame joins the deepest such group. A
     *  module that lands in a training module becomes a section there when the frame's rule makes it one. A unit
     *  dropped wholly outside its own group's frame leaves that group, for the group its centre is in or the canvas.
     *  A drop that still touches its own frame changes nothing (it only moved inside). A member of a dragged group
     *  moves with it. */
    regroup(drops, frames) {
      const g = graph(), ids = new Set(drops.map(d => d.id).filter(id => g.hasNode(id) || g.groups.has(id))), out: Membership[] = [];
      const inside = (id: string, ancestor: string) => [...ancestors(id)].some(p => p.id === ancestor);
      for (const { id, rect: r } of drops) {
        if (!ids.has(id) || [...ids].some(o => o !== id && inside(id, o))) continue;
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2, current = g.parentOf(id)?.id ?? null;
        let target: string | null = null;
        for (const [gid, f] of frames) {
          if (gid === id || !g.groups.has(gid) || g.group(gid).collapsed || inside(gid, id)) continue;
          if (cx < f.x || cx > f.x + f.w || cy < f.y || cy > f.y + f.h) continue;
          if (target === null || nestingOf(gid) > nestingOf(target)) target = gid;
        }
        if (target === current) continue;
        const intoCurrent = current !== null && target !== null && inside(target, current);
        if (current !== null && !intoCurrent) { const f = frames.get(current); if (f && intersects(r, f)) continue; }
        out.push({ id, from: current, to: target });
      }
      return out;
    },
  };
}
