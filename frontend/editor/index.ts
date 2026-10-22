// editor/index.ts — createVueEditor(viewport, ctx): the one board. Vue Flow owns the pan/zoom/drag/selection/connection
// gestures. This module projects the core ModuleGraph (workspace.graph: nodes of registered kinds, value / call wires,
// nested groups) into Vue Flow nodes and edges. It routes every gesture back through the graph's validating mutators
// (connect / disconnect / removeNode stay authoritative). It records user edits in the history. The graph never becomes
// reactive: draw() rebuilds plain view models and gives them to Vue Flow, which diffs by id. canvas-geometry.ts (pure)
// decides where things are drawn, how big they are, and Arrange. This module measures, draws and records. Module bodies
// (modules/registry.ts) reach the workbench through the WORKBENCH injection (workbench-context.ts).
import { createApp, nextTick, shallowRef, type App } from 'vue';
import { useVueFlow, type Connection, type Edge, type EdgeMouseEvent, type GraphNode as FlowNode, type Node as FlowNodeInput, type NodeChange, type NodeDragEvent, type NodeMouseEvent, type OnConnectStartParams } from '@vue-flow/core';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/node-resizer/dist/style.css';
import '@vue-flow/minimap/dist/style.css';
import './editor.css';
import EditorRoot from './EditorRoot.vue';
import { createEditorHistory } from './history';
import { kindLabel, loopContract, loopSummary, portSpecs, problemView } from './graph-view';
import { COLLAPSED_GROUP, estimateHeight, GAP, TRAIN_FRAME } from './sizes';
import { clamp, layoutSnapshot, NODE_H_MAX, NODE_H_MIN, NODE_W_MAX, NODE_W_MIN, readLayout, round, union, ZOOM_MAX, ZOOM_MIN, type Rect } from './layout';
import { RUNTIME_KEY, type EditorContext, type EditorFacade, type EditorRuntime, type FitScope, type GroupNodeView, type LayoutSnapshot, type LoopBoxView, type ModuleNodeView, type SectionView, type SlotView, type ToolCardView, type ToolLayerView, type TrainingModuleView, type ViewState } from './types';
import { sectionColumns, sectionPorts, type SectionPort } from './training-module.js';
import { canvasGeometry, type Move } from './canvas-geometry';
import { WORKBENCH, type GraphNode, type Group, type ModuleGraph, type PrefabState, type Problem, type Resolution, type Workbench } from './workbench-context';
import type { ToolUnit } from './tool-canvas.js';
import { toolLabel } from './modules/body-utils';
import { createEdgePresentation, EDGE_PRESENTATION } from './edge-presentation';
import type { PortSpec } from './wiring';
import { fromSelection } from '../core/template.js';
import { fillSlot as fillPrefabSlot, prefabState, restoreWire as restorePrefabWire } from '../core/prefab.js';
import { freshId } from '../core/graph.js';
import { METHODS } from '../core/kinds/trainer.js';
import { structureConfig, toolSignature, isToolLayer } from '../core/kinds/network.js';
import { trainedOf } from '../core/loop.js';
import { createRunChain } from '../core/sessions/run-chain.js';
import { readoutSpec } from '../core/kinds/readout.js';
import { t } from '../i18n.js';

export type { EditorContext, EditorFacade, LayoutSnapshot } from './types';

const FIT_PAD = 48, SAVE_DELAY = 220;
const DRAG_CONTROLS = 'button,input,select,textarea,label,a,summary,[data-no-drag]';
/** a module or group moves by its header or its port band. The slots themselves are `nodrag`, because they start
 *  wires. The body stays for its controls and text selection. */
const NODE_DRAG_HANDLE = '.mnode-head,.group-head,.ports';
const EDITABLE = 'input,select,textarea,[contenteditable=""],[contenteditable="true"]';
const editableTarget = (target: EventTarget | null) => target instanceof Element && (!!target.closest(EDITABLE) || (target as HTMLElement).isContentEditable);
/** input types that take no typed text: Space there does not insert a space */
const NOT_TEXT_INPUT: Record<string, true> = { button: true, submit: true, reset: true, image: true, checkbox: true, radio: true, range: true, color: true, file: true };
let seq = 0;

export function createVueEditor(viewport: HTMLElement, ctx: EditorContext): EditorFacade {
  const flowId = `neurom-editor-${++seq}`;
  const flow = useVueFlow({ id: flowId });
  const view: ViewState = { x: 0, y: 0, k: 1 };
  const graph = (): ModuleGraph => ctx.workspace().graph;
  const S = { ready: false, disposed: false, saveTimer: 0, drawQueued: false, dragging: false, resizing: null as string | null, connectFrom: null as OnConnectStartParams | null, connected: false, suspended: 0 };
  const pending: (() => void)[] = [];
  const version = shallowRef(0);
  /** the frame pushed for every expanded group on the last draw (absolute) and the size of every measured flow node */
  const frames = new Map<string, Rect>(), measured = new Map<string, { w: number; h: number }>(), portSig = new Map<string, string>();
  /** the one node whose record outputs show their field tree, and the expanded paths (transient view state) */
  const fieldTree = { node: null as string | null, open: new Set<string>() };
  function closeFieldTree(except: string | null = null) {
    if (!fieldTree.node || fieldTree.node === except) return;
    fieldTree.node = null; fieldTree.open.clear(); scheduleDraw();
  }
  viewport.classList.add('neurom-editor');

  // ------------------------------------------------------------------ history
  const history = createEditorHistory({
    graph, presentation: () => edgePresentation.snapshot(), restorePresentation: raw => edgePresentation.restore(raw),
    changed: () => { ctx.changed(); scheduleDraw(); }, status: text => ctx.status(text),
  });
  const edgePresentation = createEdgePresentation(undefined, () => history.begin(), () => { history.commit(t('连线外观')); ctx.changed(); });
  /** History-recorded mutation. Nested calls join the outermost entry. A promise-returning `fn` (presets that import
   *  artifacts) commits when it settles. edit() holds draws only for the synchronous part. */
  let editDepth = 0;
  function edit<T>(label: string, fn: () => T): T {
    const outer = editDepth === 0;
    history.begin(); S.suspended++; editDepth++;
    const finish = () => { editDepth--; if (editDepth === 0) { history.commit(label); ctx.changed(); } scheduleDraw(); };
    let result: T;
    try { result = fn(); }
    catch (e) { S.suspended--; finish(); throw e; }
    S.suspended--;
    if (result instanceof Promise) { scheduleDraw(); return (outer ? result.finally(finish) : (finish(), result)) as T; }
    finish(); return result;
  }

  // ------------------------------------------------------------------ view transform
  const size = () => [viewport.clientWidth || 1, viewport.clientHeight || 1] as const;
  function whenReady(fn: () => void) { if (S.ready) fn(); else pending.push(fn); }
  function setView(x: number, y: number, k: number) {
    view.x = round(x); view.y = round(y); view.k = round(clamp(k, ZOOM_MIN, ZOOM_MAX));
    whenReady(() => flow.setViewport({ x: view.x, y: view.y, zoom: view.k }));
    paintView();
  }
  function paintView() {
    viewport.dataset.zoom = view.k.toFixed(2);
    viewport.style.setProperty('--zoom', String(view.k));   // selection rings keep their screen width (editor.css)
    const label = document.getElementById('canvas-zoom-label'); if (label) label.textContent = `${Math.round(view.k * 100)}%`;
  }
  function zoomAt(k: number, cx: number, cy: number) {
    const k1 = round(clamp(k, ZOOM_MIN, ZOOM_MAX));
    setView(cx - (cx - view.x) * k1 / view.k, cy - (cy - view.y) * k1 / view.k, k1);
  }
  function showRect(r: Rect | null) {
    if (!r) return false;
    const [vw, vh] = size();
    const k = round(clamp(Math.min((vw - FIT_PAD * 2) / Math.max(1, r.w), (vh - FIT_PAD * 2) / Math.max(1, r.h)), ZOOM_MIN, 1));
    setView(vw / 2 - (r.x + r.w / 2) * k, vh / 2 - (r.y + r.h / 2) * k, k);
    queueSave(); return true;
  }
  function snapshot(): LayoutSnapshot { return layoutSnapshot(view, edgePresentation.snapshot()); }
  function queueSave() {
    if (S.disposed) return;
    clearTimeout(S.saveTimer);
    S.saveTimer = window.setTimeout(() => { S.saveTimer = 0; if (!S.disposed) ctx.changed(); }, SAVE_DELAY);
  }

  // ------------------------------------------------------------------ geometry (canvas-geometry.ts, with training-module.js for training modules)
  /** `compute(key)` memoized per graph version (a reload's new graph starts with an empty memo) */
  function perVersion<V>(compute: (key: string) => V): (key: string) => V {
    let at: ModuleGraph | null = null, version = -1;
    const of = new Map<string, V>();
    return key => {
      const g = graph();
      if (at !== g || version !== g.version) { at = g; version = g.version; of.clear(); }
      if (!of.has(key)) of.set(key, compute(key));
      return of.get(key)!;
    };
  }
  /** the groups enclosing `id`, innermost first */
  function* ancestors(id: string) { for (let p = graph().parentOf(id); p; p = graph().parentOf(p.id)) yield p; }
  /** each expanded loop box's contract (graph-view.ts loopContract: it builds the env bundle) */
  const contractOf = perVersion(loopId => loopContract(graph(), graph().resolved(), loopId));
  /** the section heights each training module reports, and the column split it draws */
  const columns = sectionColumns();
  const geo = canvasGeometry({ graph, measured: id => measured.get(id), aspect: () => { const [vw, vh] = size(); return vw / vh; }, columns });
  /** store the moves a geometry operation returns */
  function place(moves: Move[]) {
    const g = graph();
    for (const m of moves) if (g.groups.has(m.id)) g.setGroupLayout(m.id, { x: m.x, y: m.y }); else g.moveNode(m.id, m.x, m.y);
  }
  /** the group that a new tool of network `id` joins: the nearest one around it that is not a loop box, or null for the
   *  canvas. A box holds exactly its loop's body, and a tool is not part of it. */
  function toolHome(id: string): string | null {
    let at = graph().parentOf(id);
    while (at?.loop) at = graph().parentOf(at.id);
    return at?.id ?? null;
  }
  /** flow position of an object with absolute rect `r`: relative to its (expanded) parent group's frame */
  function relative(id: string, r: Rect) {
    const parent = graph().parentOf(id), frame = parent ? frames.get(parent.id) : null;
    return { position: { x: r.x - (frame?.x ?? 0), y: r.y - (frame?.y ?? 0) }, parentNode: frame ? parent!.id : undefined };
  }

  // ------------------------------------------------------------------ projection into Vue Flow nodes / edges
  function keepGesture<T extends FlowNodeInput>(node: T): T {   // a draw() mid-gesture must not snap the node under the pointer
    const ex = flow.findNode(node.id);
    if (ex && ((S.dragging && ex.dragging) || S.resizing === node.id)) { node.position = ex.position; if (S.resizing === node.id) node.style = ex.style; }
    return node;
  }
  /** each flow node's and wire's view model at the last draw, by its JSON. Vue Flow gets an unchanged one as the same
   *  object, so only what changed re-renders */
  let viewModels = new Map<string, { key: string; data: unknown }>(), nextViewModels = new Map<string, { key: string; data: unknown }>();
  function reuse<T>(id: string, data: T): T {
    const key = JSON.stringify(data), last = viewModels.get(id), kept = last?.key === key ? (last.data as T) : data;
    nextViewModels.set(id, { key, data: kept });
    return kept;
  }
  function build() {
    const g = graph(), res = g.resolved(), nodes: FlowNodeInput[] = [], edges: Edge[] = [], changedPorts: string[] = [];
    const bands = new Map<string, { inputs: PortSpec[]; outputs: PortSpec[] }>();
    /** a member's port band (no field tree), computed once per draw */
    const specsOf = (id: string) => { let s = bands.get(id); if (!s) bands.set(id, (s = portSpecs(g, res, id))); return s; };
    nextViewModels.clear();
    // groups outermost first so a nested frame can be placed relative to its parent's frame
    const groups = geo.groups();
    frames.clear();
    for (const group of groups) frames.set(group.id, geo.rect(group.id));
    // wires: if its own card does not draw an end, that end goes to the slot of the flow node that shows it. That flow
    // node is a collapsed group, a box's frame for its loop node, or a training module for its sections (canvas-geometry.ts
    // socket). Wires inside one such frame are not drawn. The wires of a tool drawn inside its network card are not drawn
    // either, because the card being inside stands for every one of them.
    const crossing = new Map<string, { node: string; port: string; dir: 'in' | 'out' }[]>();
    const cross = (flowNode: string, node: string, port: string, dir: 'in' | 'out') => { if (!crossing.has(flowNode)) crossing.set(flowNode, []); crossing.get(flowNode)!.push({ node, port, dir }); };
    for (const w of g.wires.values()) {
      if (geo.toolHost(w.from.node) || geo.toolHost(w.to.node)) continue;
      const s = geo.socket(w.from.node, w.from.port), d = geo.socket(w.to.node, w.to.port);
      if (s.node === d.node) continue;
      if (s.node !== w.from.node) cross(s.node, w.from.node, w.from.port, 'out');
      if (d.node !== w.to.node) cross(d.node, w.to.node, w.to.port, 'in');
      const label = `${g.node(w.from.node).title}.${w.from.port} → ${g.node(w.to.node).title}.${w.to.port}`;
      edges.push({ id: w.id, type: 'wire', source: s.node, sourceHandle: s.handle, target: d.node, targetHandle: d.handle,
        data: reuse(`wire:${w.id}`, { kind: w.kind, label }), selectable: false, focusable: false });
    }
    for (const group of groups) {
      const frame = frames.get(group.id)!, inputs: PortSpec[] = [], outputs: PortSpec[] = [];
      if (geo.training(group.id)) { nodes.push(trainingNode(group, frame, res, changedPorts, specsOf)); continue; }
      if (group.collapsed) {
        const seen = new Set<string>();
        const add = (nodeId: string, port: string, dir: 'in' | 'out') => {
          const key = `${dir}:${nodeId}/${port}`; if (seen.has(key) || !g.hasNode(nodeId)) return; seen.add(key);
          const specs = specsOf(nodeId), p = (dir === 'in' ? specs.inputs : specs.outputs).find(s => s.id === port); if (!p) return;
          (dir === 'in' ? inputs : outputs).push({ ...p, id: geo.socket(nodeId, port).handle, label: `${g.node(nodeId).title} · ${port}` });
        };
        for (const e of group.expose) { const ports = res.portsOf(e.node); add(e.node, e.port, ports.outputs.some(p => p.id === e.port) ? 'out' : 'in'); }
        for (const e of crossing.get(group.id) ?? []) add(e.node, e.port, e.dir);
      }
      const loop = geo.boxLoop(group.id);
      let box: LoopBoxView | null = null;
      if (loop) {
        const specs = specsOf(loop);
        const slot = (list: PortSpec[], port: string) => { const p = list.find(s => s.id === port); return p && !group.collapsed ? { ...p, id: geo.socket(loop, port).handle } : null; };
        const scene = g.producers(loop, 'scenario')[0]?.node ?? null;
        box = { loop, summary: loopSummary(g, loop), problems: problemView(res.problemsOf(loop)), source: scene ? { node: scene, title: g.node(scene).title } : null,
          input: slot(specs.outputs, 'input'), handle: slot(specs.outputs, 'loop'), action: slot(specs.inputs, 'action'), scenario: slot(specs.inputs, 'scenario'),
          contract: group.collapsed ? null : contractOf(loop), inTraining: [...ancestors(group.id)].some(p => geo.training(p.id)) };
      }
      const sig = [...inputs, ...outputs, ...(box ? [box.input, box.action, box.scenario, box.handle] : [])].map(p => p?.id ?? '').join('|') + (box?.source ? `|${box.source.node}` : '');
      if (portSig.get(group.id) !== sig) { portSig.set(group.id, sig); changedPorts.push(group.id); }
      const data: GroupNodeView = reuse(group.id, { groupId: group.id, title: group.title, collapsed: group.collapsed, template: group.template ?? null, members: g.memberNodes(group.id).length, inputs, outputs, w: frame.w, h: frame.h, box });
      // an expanded group is a frame around its members. Only its header takes the pointer. The blank inside is canvas
      // (pan, marquee). Set it inline, because Vue Flow writes `pointer-events: all` inline on every node before `style`.
      nodes.push(keepGesture<FlowNodeInput<GroupNodeView>>({ id: group.id, type: 'group', ...relative(group.id, frame), dragHandle: NODE_DRAG_HANDLE,
        style: group.collapsed ? { width: `${COLLAPSED_GROUP.w}px` } : { width: `${frame.w}px`, height: `${frame.h}px`, pointerEvents: 'none' }, data, class: group.collapsed ? '' : 'group-expanded' }));
    }
    for (const n of g.nodes.values()) {
      if (geo.shownBy(n.id) !== n.id) continue;
      const ports = portSpecs(g, res, n.id, fieldTree.node === n.id ? fieldTree.open : null), layers = n.kind === 'network' ? toolViews(n, res) : [];
      // the slots of the tool cards inside are this flow node's handles too
      const sig = [...ports.inputs, ...ports.outputs, ...layers.flatMap(L => (L.folded ? [] : L.inside.flatMap(c => [...c.inputs, ...c.outputs])))].map(p => p.id).join('|');
      if (portSig.get(n.id) !== sig) { portSig.set(n.id, sig); changedPorts.push(n.id); }
      const data: ModuleNodeView = reuse(n.id, { nodeId: n.id, kind: n.kind, kindLabel: kindLabel(n.kind), title: n.title, collapsed: !!n.uiCollapsed, width: geo.hostWidth(n.id), height: n.uiCollapsed ? null : n.uiSize?.h ?? null,
        inputs: ports.inputs, outputs: ports.outputs, problems: problemView(res.problemsOf(n.id)), tools: layers });
      nodes.push(keepGesture<FlowNodeInput<ModuleNodeView>>({ id: n.id, type: 'module', ...relative(n.id, { x: n.x, y: n.y, w: data.width, h: 0 }), dragHandle: NODE_DRAG_HANDLE,
        style: { width: `${data.width}px`, ...(data.height ? { height: `${data.height}px` } : {}) }, data, class: `kind-${n.kind}` }));
    }
    for (const id of [...portSig.keys()]) if (!g.hasNode(id) && !g.groups.has(id)) { portSig.delete(id); measured.delete(id); }
    [viewModels, nextViewModels] = [nextViewModels, viewModels];
    return { nodes, edges, changedPorts };
  }
  /** A network's tool layers as its card draws them (ToolCanvas.vue). Each layer has:
   *  - the cards inside. A tool's unwired ports are slots `${module}/${port}` on the card. The card being inside stands
   *    for its wired ports.
   *  - the tools drawn outside (a frozen network's readout by its network's title)
   *  - what each wire into the port comes from */
  function toolViews(n: GraphNode, res: Resolution): ToolLayerView[] {
    const g = graph(), folded = new Set(n.uiFolded ?? []);
    const slots = (id: string) => {
      const specs = portSpecs(g, res, id, fieldTree.node === id ? fieldTree.open : null), wires = g.wiresOf(id);
      const free = (p: PortSpec, dir: 'in' | 'out') => !wires.some(w => (dir === 'in' ? w.to.node === id && w.to.port === p.id : w.from.node === id && (w.from.port === p.id || w.from.port.startsWith(`${p.id}.`))));
      const at = (p: PortSpec) => ({ ...p, id: geo.socket(id, p.id).handle });
      return { inputs: specs.inputs.filter(p => free(p, 'in')).map(at), outputs: specs.outputs.filter(p => free(p, 'out')).map(at) };
    };
    const card = (u: ToolUnit): ToolCardView => {
      const members = u.readout ? [u.node, u.readout] : [u.node], node = g.node(u.node), ports = members.map(slots);
      return { node: u.node, readout: u.readout, tool: u.tool, kind: node.kind, kindLabel: u.readout ? t('冻结网络') : kindLabel(node.kind), title: node.title,
        collapsed: members.every(id => !!g.node(id).uiCollapsed), problems: problemView(members.flatMap(id => res.problemsOf(id))),
        inputs: ports.flatMap(p => p.inputs), outputs: ports.flatMap(p => p.outputs) };
    };
    const titleOf = (tool: string) => {
      const src = g.node(tool), net = src.kind === 'readout' ? g.producers(tool, 'scores')[0]?.node : null;
      return net ? g.node(net).title : src.title;
    };
    return geo.toolLayers(n.id).map(L => ({
      port: L.port, folded: folded.has(L.port), inside: L.inside.map(card),
      outside: L.outside.map(tool => ({ tool, title: titleOf(tool) })),
      wires: g.producers(n.id, L.port).map((p, k) => ({ tool: p.node, label: toolLabel(g, n.id, L.port, k) })),
    }));
  }
  /** A training module's flow node: sections in the left column, feeds on the well's left edge, and the other section
   *  ports as outer slots (editor/training-module.js). The header badge carries the trainers' problems and those of the
   *  loop boxes in its well. Like an expanded group, it lets the pointer through, because the well is canvas. The
   *  component re-enables it. */
  function trainingNode(group: Group, frame: Rect, res: Resolution, changedPorts: string[], specsOf: (id: string) => { inputs: PortSpec[]; outputs: PortSpec[] }): FlowNodeInput<TrainingModuleView> {
    const g = graph(), F = TRAIN_FRAME, { tm, sections: drawn, codes, columns, placed: at, colW, well, min } = geo.frame(group.id);
    // the picked section's ports wired only to other sections are slots too
    const pick = picked.group === group.id && picked.node && tm.sections.includes(picked.node) ? picked.node : null;
    const ports = sectionPorts(g, res, tm, pick);
    const slot = (e: SectionPort): PortSpec[] => {
      const s = specsOf(e.node), p = (e.dir === 'in' ? s.inputs : s.outputs).find(x => x.id === e.port);
      return p ? [{ ...p, id: geo.socket(e.node, e.port).handle, label: `${g.node(e.node).title} · ${p.label}` }] : [];
    };
    const feeds = ports.feeds.flatMap(e => slot(e).map(spec => ({ spec, dir: e.dir }))), inputs = ports.inputs.flatMap(slot), outputs = ports.outputs.flatMap(slot);
    // the code modules share one 「代码」 section, keyed by the first. Each carries its rect (the minimap draws it)
    const placed = new Map(at.map(({ id, ...r }) => [id, r]));
    const sections: SectionView[] = drawn.map(id => {
      const n = g.node(id), rect = placed.get(id) ?? { x: 0, y: 0, w: 0, h: 0 };
      return id !== codes[0] ? { nodeId: id, kind: n.kind, kindLabel: kindLabel(n.kind), title: n.title, collapsed: !!n.uiCollapsed, problems: problemView(res.problemsOf(id)), rect }
        : { nodeId: id, kind: 'code', kindLabel: kindLabel('code'), title: '', collapsed: codes.every(c => !!g.node(c).uiCollapsed), problems: problemView(codes.flatMap(c => res.problemsOf(c))), codeNodes: codes, rect };
    });
    // the loop problems of the boxes in this frame's well (not those inside a collapsed group or another training module)
    const problems: Problem[] = tm.trainers.flatMap(id => res.problemsOf(id));
    const boxes = (id: string) => {
      const sub = g.group(id), loop = geo.boxLoop(id);
      if (sub.collapsed || geo.training(id)) return;
      if (loop) problems.push(...res.problemsOf(loop));
      for (const m of sub.members) if (g.groups.has(m)) boxes(m);
    };
    for (const id of tm.canvas) if (g.groups.has(id)) boxes(id);
    const sig = ['trainmod', ...[...feeds.map(f => f.spec), ...inputs, ...outputs].map(p => p.id)].join('|');
    if (portSig.get(group.id) !== sig) { portSig.set(group.id, sig); changedPorts.push(group.id); }
    const method = [...new Set(tm.trainers.map(id => (METHODS as Record<string, { label: string } | undefined>)[String(g.node(id).config.method)]?.label).filter((l): l is string => !!l))].map(l => t(l)).join(' · ');
    const state = prefabState(g, group.id) as PrefabState;
    const slots: SlotView[] = state.slots.filter(s => s.dir).map(s => ({ id: s.id, title: s.title, required: s.required, open: s.open,
      filled: s.filled.map(n => ({ nodeId: n, title: g.node(n).title })),
      create: s.create.map((c, index) => ({ index, label: c.title ?? kindLabel(c.kind) })) }));
    const drift = state.missing.map(w => ({ index: w.index, label: `${g.node(w.from.node).title}.${w.from.port} → ${g.node(w.to.node).title}.${w.to.port}` }));
    const shown = problemView(problems);
    shown.errors.push(...drift.map(d => t('缺少预期连线 {wire}', { wire: d.label })));
    const data: TrainingModuleView = reuse(group.id, { groupId: group.id, title: group.title, method,
      template: group.template ?? null, members: g.memberNodes(group.id).length, slots, drift, sections, feeds, inputs, outputs,
      column: { x: F.pad, y: F.head + F.pad, w: colW }, columns, resizable: drawn.length > 1,
      well: { x: well.x - frame.x, y: well.y - frame.y, w: well.w, h: well.h },
      w: frame.w, h: frame.h, problems: shown,
      picked: pick });
    return keepGesture<FlowNodeInput<TrainingModuleView>>({ id: group.id, type: 'trainmod', ...relative(group.id, frame), dragHandle: NODE_DRAG_HANDLE,
      style: { width: `${frame.w}px`, minHeight: `${min}px`, pointerEvents: 'none' }, data });
  }
  function draw() {
    if (S.disposed) return;
    const { nodes, edges, changedPorts } = build();
    flow.setNodes(nodes); flow.setEdges(edges); layerEdges();
    if (changedPorts.length) nextTick().then(() => { if (!S.disposed) flow.updateNodeInternals(changedPorts); });
    announceSections();
  }
  /** Each expanded training module's sections at the last draw, and the nodes the graph had then. If a module moves
   *  between the column and the well after that (a drop into the frame, a wire added or cut), the status line announces
   *  it. If it went into the column, the editor picks it, so the user finds a card that left the canvas at once. A new
   *  module is not announced. A frame seen for the first time (expanded, loaded) is not announced either. */
  const announced = { graph: null as ModuleGraph | null, sections: new Map<string, Set<string>>(), nodes: new Set<string>() };
  function announceSections() {
    const g = graph(), fresh = announced.graph !== g, now = new Map<string, Set<string>>(), notes: string[] = [];
    let pick: [string, string] | null = null;
    for (const group of g.groups.values()) {
      const tm = group.collapsed ? null : geo.training(group.id); if (!tm) continue;
      const cur = new Set(tm.sections), prev = fresh ? undefined : announced.sections.get(group.id);
      now.set(group.id, cur);
      if (!prev) continue;
      for (const id of cur) if (!prev.has(id) && announced.nodes.has(id)) { notes.push(t('{title} 已移到左栏', { title: g.node(id).title })); pick = [group.id, id]; }
      for (const id of prev) if (!cur.has(id) && tm.canvas.includes(id)) notes.push(t('{title} 已回到画布', { title: g.node(id).title }));
    }
    Object.assign(announced, { graph: g, sections: now, nodes: new Set(g.nodes.keys()) });
    if (notes.length) ctx.status(notes.join(' · '), 'ok');
    if (pick) runtime.pickSection(...pick);
  }
  /** Each wire's z: the depth of the deeper node it joins, as if that node were not selected. Vue Flow stacks a child
   *  one above its parent and a selected node 1000 higher. A wire at its nodes' unselected depth stays above the frames
   *  around them (a training module's well) and under every module. So selecting a module never draws its wires over
   *  another module's text. A selected frame lifts its members, and their wires with them. */
  function layerEdges() {
    const own = (n: FlowNode) => (n.selected ? 1000 : 0);
    const z = (n: FlowNode): number => { const p = n.parentNode ? flow.findNode(n.parentNode) : undefined; return p ? Math.max(z(p), own(n)) + 1 : own(n); };
    const unselected = (id: string) => { const n = flow.findNode(id), p = n?.parentNode ? flow.findNode(n.parentNode) : undefined; return p ? z(p) + 1 : 0; };
    for (const e of flow.getEdges.value) { const v = Math.max(unselected(e.source), unselected(e.target)); if (e.zIndex !== v) e.zIndex = v; }
  }
  function scheduleDraw() {
    if (S.drawQueued || S.disposed) return;
    S.drawQueued = true;
    queueMicrotask(() => { S.drawQueued = false; if (!S.suspended) draw(); else scheduleDraw(); });
  }

  // ------------------------------------------------------------------ workbench for the bodies
  // 「运行到这里」 (ADR 0023): one chain for the editor. A script module plays when its body answers `play`.
  const play = shallowRef<{ node: string; seq: number } | null>(null);
  const chain = createRunChain({
    workspace: ctx.workspace, session: ctx.session, status: ctx.status,
    onScript: (node: string) => { play.value = { node, seq: (play.value?.seq ?? 0) + 1 }; },
  });
  const chainTarget = shallowRef<string | null>(null), chainStep = shallowRef<string | null>(null);
  chain.subscribe(() => { const s = chain.snapshot(); chainTarget.value = s.target; chainStep.value = s.step; });
  const workbench: Workbench = {
    get workspace() { return ctx.workspace(); },
    get graph() { return graph(); },
    version,
    resolution: () => graph().resolved(),
    session: (kind, nodeId) => ctx.session(kind, nodeId),
    datasets: ctx.datasets,
    edit,
    status: (message, tone) => ctx.status(message, tone),
    python: ctx.python,
    reveal: shallowRef(null),
    chain: { target: chainTarget, step: chainStep, run: nodeId => { void chain.run(nodeId); } },
    play,
  };
  let unsubscribeGraph = () => {}, unsubscribeWorkspace = () => {};
  function subscribe() {
    unsubscribeGraph(); unsubscribeWorkspace();
    unsubscribeGraph = graph().subscribe(() => { version.value++; scheduleDraw(); });
    unsubscribeWorkspace = ctx.workspace().subscribe(what => { if (what !== 'graph') version.value++; });
  }

  // ------------------------------------------------------------------ runtime for the node components
  function nodeIdsOf(flowIds: string[]) {   // node ids behind a selection: members of selected groups included
    const g = graph(), out = new Set<string>();
    for (const id of flowIds) { if (g.hasNode(id)) out.add(id); else if (g.groups.has(id)) for (const m of g.memberNodes(id)) out.add(m); }
    return [...out];
  }
  const runtime: EditorRuntime = {
    removeNode(ids) {
      const g = graph(), list = (typeof ids === 'string' ? [ids] : [...ids]).filter(id => g.hasNode(id)); if (!list.length) return;
      edit(t('删除模块'), () => { for (const id of list) g.removeNode(id); });
    },
    toggleCollapse(ids) {
      const g = graph(), list = (typeof ids === 'string' ? [ids] : [...ids]).filter(id => g.hasNode(id)); if (!list.length) return;
      const fold = !list.every(id => g.node(id).uiCollapsed);
      edit(t('折叠模块'), () => { for (const id of list) g.setUi(id, { uiCollapsed: fold }); });
    },
    togglePort(id, port) {
      if (fieldTree.node !== id) { fieldTree.node = id; fieldTree.open.clear(); }
      if (fieldTree.open.has(port)) { for (const p of [...fieldTree.open]) if (p === port || p.startsWith(`${port}.`)) fieldTree.open.delete(p); }
      else fieldTree.open.add(port);
      if (!fieldTree.open.size) fieldTree.node = null;
      scheduleDraw();
    },
    rename(id, title) { const n = graph().nodes.get(id), next = title.trim(); if (!n || !next || next === n.title) { viewModels.delete(geo.shownBy(id)); scheduleDraw(); return; } edit(t('重命名'), () => graph().setTitle(id, next)); },
    resizeStart(flowId) { S.resizing = flowId; history.begin(); },
    resizeEnd(flowId) {
      S.resizing = null;
      const fn = flow.findNode(flowId), n = graph().nodes.get(flowId); if (!fn || !n) return;
      const w = Math.round(fn.dimensions.width), h = Math.round(fn.dimensions.height);
      graph().setUi(flowId, { uiSize: { w: clamp(w, NODE_W_MIN, NODE_W_MAX), h: clamp(h, NODE_H_MIN, NODE_H_MAX) } });
      graph().moveNode(flowId, round(fn.computedPosition.x), round(fn.computedPosition.y));
      history.commit(t('调整大小')); ctx.changed();
    },
    keyboardResize(flowId, key, shift, minHeight) {
      const step = shift ? 1 : 10, dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0, dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      if (key !== 'Home' && !dx && !dy) return false;
      const n = graph().nodes.get(flowId); if (!n) return false;
      edit(t('调整大小'), () => {
        if (key === 'Home') graph().setUi(flowId, { uiSize: null });
        else { const r = geo.rect(flowId); graph().setUi(flowId, { uiSize: { w: clamp(r.w + dx, NODE_W_MIN, NODE_W_MAX), h: clamp(r.h + dy, Math.max(NODE_H_MIN, minHeight), NODE_H_MAX) } }); }
      });
      return true;
    },
    toggleGroup(id) {
      const g = graph(); if (!g.groups.has(id)) return;
      const group = g.group(id), frame = frames.get(id) ?? geo.rect(id);
      // expanding / collapsing changes the group's footprint: untangle its interior and the levels it now overlaps
      edit(group.collapsed ? t('展开组合') : t('折叠组合'), () => { g.setGroupLayout(id, { collapsed: !group.collapsed, x: frame.x, y: frame.y, w: frame.w, h: frame.h }); place(geo.untangle(id)); });
      settleAfterMeasure(id);
    },
    renameGroup(id, title) { const group = graph().groups.get(id), next = title.trim(); if (!group || !next || next === group.title) { viewModels.delete(id); scheduleDraw(); return; } edit(t('重命名组合'), () => graph().setGroupLayout(id, { title: next })); },
    removeGroup(id) {
      const g = graph(), group = g.groups.get(id); if (!group) return;
      if (!confirm(t('删除组合 “{title}” 及其 {count} 个成员模块？（可撤销）', { title: group.title, count: g.memberNodes(id).length }))) return;
      edit(t('删除组合'), () => g.removeGroup(id, { deleteMembers: true }));
    },
    unpackGroup(id) { if (graph().groups.has(id)) unpackGroups([id]); },
    saveGroupAsTemplate(id) {
      const g = graph(), group = g.groups.get(id); if (!group) return;
      saveTemplate(g.memberNodes(id), group.title);
    },
    sectionSizes(groupId, ins, sizes) {
      columns.measure(groupId, ins, sizes); scheduleDraw();   // the first measurements settle the split. Every report re-places the sections
    },
    resizeColumns(groupId, dx, dy, done) {
      const g = graph(), tm = g.groups.has(groupId) ? geo.training(groupId) : null; if (!tm) return;
      if (!done) { if (columns.drag(g, tm, dx / view.k, dy / view.k)) scheduleDraw(); return; }
      // a click, not a drag, keeps the split as it is
      const split = columns.release(g, tm, Math.abs(dx) < 3 && Math.abs(dy) < 3 ? null : { dx: dx / view.k, dy: dy / view.k });
      if (split) edit(t('调整训练模块列数'), () => g.setGroupLayout(groupId, { columns: split })); else scheduleDraw();
    },
    resetColumns(groupId) {
      const g = graph(); if (!g.groups.has(groupId) || g.group(groupId).columns == null) return;
      edit(t('训练模块分栏恢复自动'), () => g.setGroupLayout(groupId, { columns: null }));
    },
    moveSection(groupId, key, to) {
      const g = graph(), tm = g.groups.has(groupId) ? geo.training(groupId) : null, split = tm && columns.move(g, tm, key, to);
      if (split) edit(t('移动训练模块段落'), () => g.setGroupLayout(groupId, { columns: split }));
    },
    pickSection(groupId, nodeId) {
      const fn = flow.findNode(groupId); if (!fn) return;
      if (!fn.selected) { flow.removeSelectedNodes(flow.getSelectedNodes.value); flow.addSelectedNodes([fn]); }
      if (picked.group === groupId && picked.node === nodeId) return;
      Object.assign(picked, { group: groupId, node: nodeId }); scheduleDraw();
    },
    fillSlot(groupId, slotId, index) {
      const g = graph(); if (!g.groups.has(groupId)) return;
      try {
        const node = edit(t('填入槽位'), () => fillPrefabSlot(g, groupId, slotId, index, geo.insertAt(groupId)));
        ctx.status(t('已新建 {title}，接到槽位 {slot}。', { title: node.title, slot: g.group(groupId).prefab?.slots.find(s => s.id === slotId)?.title ?? slotId }), 'ok');
        if (geo.sectionOf(node.id)) Object.assign(picked, { group: groupId, node: node.id });
      } catch (e) { ctx.status(t('不能填入槽位：{error}', { error: (e as Error).message }), 'bad'); }
    },
    restoreWire(groupId, index) {
      const g = graph(); if (!g.groups.has(groupId)) return;
      try { edit(t('恢复预期连线'), () => restorePrefabWire(g, groupId, index)); ctx.status(t('已恢复预期连线。'), 'ok'); }
      catch (e) { ctx.status(t('不能恢复这条连线：{error}', { error: (e as Error).message }), 'bad'); }
    },
    revealCode(node, name) {
      const g = graph(); if (!g.hasNode(node)) return;
      if (g.node(node).uiCollapsed) edit(t('展开模块内容'), () => g.setUi(node, { uiCollapsed: false }));
      const shown = geo.shownBy(node);
      if (geo.sectionOf(node)) nextTick().then(() => requestAnimationFrame(() => showRect(sectionRect(node))));   // a section (a code module: the 代码 section holding it), once drawn
      else if (!g.groups.has(shown)) showRect(geo.rect(shown));   // a collapsed group's member stays where it is. For a tool inside a network card: that card
      workbench.reveal.value = { node, name, seq: (workbench.reveal.value?.seq ?? 0) + 1 };
    },
    toggleToolLayer(node, port) {
      const g = graph(), n = g.nodes.get(node); if (!n) return;
      const folded = new Set(n.uiFolded ?? []), fold = !folded.has(port);
      if (fold) folded.add(port); else folded.delete(port);
      edit(fold ? t('折叠工具层') : t('展开工具层'), () => g.setUi(node, { uiFolded: [...folded] }));
    },
    addCodeTool(node, port) {
      const g = graph(), n = g.nodes.get(node); if (!n) return;
      // the tool layer's call signature (bits[D] in) with its stub body: the identity, D result bits
      const D = (g.resolved().refsOf(node) as { tools?: Record<string, { D: number | null }> }).tools?.[port]?.D ?? null, sig = toolSignature(D);
      const source = `export function tool(${sig.names.join(', ')}) {\n  ${sig.stub}\n}\n`;
      try {
        edit(t('给 {title} 新建代码工具', { title: n.title }), () => {
          const r = geo.rect(node), code = g.addNode({ kind: 'code', title: t('工具'), config: { source }, x: r.x + r.w + GAP.x, y: r.y });
          const home = toolHome(node); if (home) g.addToGroup(home, code.id);
          g.connect({ id: freshId('w'), kind: 'call', from: { node: code.id, port: 'tool' }, to: { node, port } });
        });
      } catch (e) { ctx.status(t('不能新建工具：{error}', { error: (e as Error).message }), 'bad'); }
    },
    addNetworkTool(node, port, artifactId) {
      const g = graph(), n = g.nodes.get(node); if (!n) return;
      const picker = workbench.session('network', node);
      const nameOf = (id: string) => ((picker.snapshot().choices as { id: string; name: string | null }[] | undefined) ?? []).find(c => c.id === id)?.name ?? null;
      type Tool = { kind: string; artifactId?: string };
      type Trained = { id: string; structure: { inputs: number; layers?: unknown[] } & Record<string, unknown>; readout: { mode: string } | null };
      /** a frozen network on `id` with its readout (bits or argmax), `run` wired into `into` of `host`. Then, when it
       *  has tool layers, the network tools that its artifact was trained with, wired into its own ports. The user
       *  wires code tools by hand. */
      const addFrozen = async (host: string, into: string, id: string, at: { x: number; y: number }): Promise<number> => {
        const artifact = await picker.adopt(id) as { id: string; bundle: { loop: { nodes: Record<string, { tools?: Record<string, Tool[]> }> } } };
        const trained = trainedOf(artifact.bundle.loop) as Trained | null;
        const r = trained?.readout;
        if (!trained || !r || (r.mode !== 'bits' && r.mode !== 'argmax')) throw new Error(t('这个产物的网络没有读出，不能当工具'));
        const home = toolHome(host);
        const net = g.addNode({ kind: 'network', title: nameOf(id) ?? t('冻结网络'), x: at.x, y: at.y, config: { ...structureConfig(trained.structure), inputs: trained.structure.inputs, artifact: artifact.id } });
        const readout = g.addNode({ kind: 'readout', x: at.x, y: at.y + geo.rect(net.id).h + GAP.y, config: readoutSpec(r) });
        if (home) { g.addToGroup(home, net.id); g.addToGroup(home, readout.id); }
        g.connect({ id: freshId('w'), kind: 'value', from: { node: net.id, port: 'scores' }, to: { node: readout.id, port: 'scores' } });
        g.connect({ id: freshId('w'), kind: 'call', from: { node: readout.id, port: 'run' }, to: { node: host, port: into } });
        let y = at.y + geo.rect(net.id).h + geo.rect(readout.id).h + 2 * GAP.y;
        const own = artifact.bundle.loop.nodes[trained.id].tools ?? {};
        for (const L of (trained.structure.layers ?? []).filter(isToolLayer) as { tools: string }[]) {
          for (const tool of own[L.tools] ?? []) if (tool.kind === 'net' && tool.artifactId) y = await addFrozen(net.id, L.tools, tool.artifactId, { x: at.x + geo.rect(net.id).w + GAP.x, y });
        }
        return y;
      };
      const done = edit(t('给 {title} 加冻结网络工具', { title: n.title }), async () => {
        const r = geo.rect(node);
        await addFrozen(node, port, artifactId, { x: r.x + r.w + GAP.x, y: r.y });
      });
      done.catch(e => ctx.status(t('不能加冻结网络工具：{error}', { error: (e as Error).message }), 'bad'));
    },
    jumpTo(node) { if (graph().hasNode(node)) focusNodes([node]); },
  };
  /** the section picked in a training module (TrainingModuleView.picked): what 「选中」 shows while that frame is selected */
  const picked = { group: null as string | null, node: null as string | null };
  function unpick() { if (picked.group === null) return; picked.group = picked.node = null; scheduleDraw(); }
  /** a section's canvas rect, read from the drawn column (sections are not flow nodes). For a code module: the 代码 section holding it */
  function sectionRect(node: string): Rect | null {
    const id = CSS.escape(node), el = viewport.querySelector(`.tm-sec[data-node="${id}"], .tm-sec [data-code-node="${id}"]`)?.closest('.tm-sec');
    if (!el) return null;
    const r = el.getBoundingClientRect(), vp = viewport.getBoundingClientRect();
    return { x: (r.left - vp.left - view.x) / view.k, y: (r.top - vp.top - view.y) / view.k, w: r.width / view.k, h: r.height / view.k };
  }
  function saveTemplate(nodeIds: string[], suggested: string) {
    if (!nodeIds.length) { ctx.status(t('先选中要保存为模板的模块（或组合）。'), 'warn'); return; }
    const name = prompt(t('模板名称'), suggested)?.trim(); if (!name) return;
    const id = prompt(t('模板 id（小写字母、数字、- 或 _）'), name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'template')?.trim(); if (!id) return;
    try {
      const ws = ctx.workspace(), existing = ws.template(id) as { revision: number } | null;
      const template = fromSelection(graph(), nodeIds, { id, name, revision: existing ? existing.revision + 1 : 1 });
      ws.addTemplate(template);
      ctx.status(t('已保存模板 {id}@{revision}（{count} 个模块）。', { id, revision: template.revision, count: nodeIds.length }), 'ok');
    } catch (e) { ctx.status(t('保存模板失败：{error}', { error: (e as Error).message }), 'bad'); }
  }

  // ------------------------------------------------------------------ gestures → graph / history
  /** Store dragged positions. `drop` (a drag gesture, not a keyboard nudge) also lets the drop change membership (regroup). */
  function applyPositions(nodes: FlowNode[], drop = false) {
    const g = graph(), moved = new Set<string>();
    let changed = false;
    for (const fn of nodes) {   // groups first: the members follow by the frame's displacement
      if (!g.groups.has(fn.id)) continue;
      const before = frames.get(fn.id) ?? geo.rect(fn.id);
      const dx = round(fn.computedPosition.x - before.x), dy = round(fn.computedPosition.y - before.y);
      if (!dx && !dy) continue;
      place(geo.translate(fn.id, dx, dy));
      for (const id of g.memberNodes(fn.id)) moved.add(id);
      moved.add(fn.id); changed = true;
    }
    for (const fn of nodes) {
      const n = g.nodes.get(fn.id); if (!n || moved.has(fn.id)) continue;
      const x = round(fn.computedPosition.x), y = round(fn.computedPosition.y);
      if (x !== n.x || y !== n.y) { g.moveNode(fn.id, x, y); changed = true; }
    }
    const note = drop ? regroup(nodes) : null;
    history.commit(note ? t('改变所属组合') : t('移动'));
    if (changed || note) ctx.changed();
    if (note) ctx.status(note, 'ok');
    scheduleDraw();
    return changed;
  }
  /** Dropping moves membership against the frames drawn before the drag (canvas-geometry.ts regroup). Groups are views
   *  (ADR 0003): positions and wires stay. Returns the status line, or null. */
  function regroup(nodes: FlowNode[]): string | null {
    const g = graph(), notes: string[] = [];
    for (const { id, from, to } of geo.regroup(nodes.map(fn => ({ id: fn.id, rect: flowRect(fn) })), frames)) {
      if (from) g.removeFromGroup(id);
      if (to) g.addToGroup(to, id);
      const title = g.hasNode(id) ? g.node(id).title : g.group(id).title;
      notes.push(to ? t('{title} 已移入 {group}', { title, group: g.group(to).title }) : t('{title} 已移出 {group}', { title, group: g.group(from!).title }));
    }
    return notes.length ? notes.join(' · ') : null;
  }
  function nudge(dx: number, dy: number) {
    const sel = flow.getSelectedNodes.value; if (!sel.length) return false;
    history.begin();
    for (const n of sel) { n.position = { x: n.position.x + dx, y: n.position.y + dy }; n.computedPosition = { ...n.computedPosition, x: n.computedPosition.x + dx, y: n.computedPosition.y + dy }; }
    applyPositions(sel); return true;
  }
  function deleteSelection() {
    const g = graph(), sel = flow.getSelectedNodes.value.map(n => n.id);
    const groups = sel.filter(id => g.groups.has(id)), nodes = sel.filter(id => g.hasNode(id));
    if (!groups.length && !nodes.length) return false;
    if (groups.length && !confirm(t('删除 {groups} 个组合（含成员）和 {nodes} 个模块？（可撤销）', { groups: groups.length, nodes: nodes.length }))) return false;
    edit(t('删除'), () => { for (const id of groups) if (g.groups.has(id)) g.removeGroup(id, { deleteMembers: true }); for (const id of nodes) if (g.hasNode(id)) g.removeNode(id); });
    return true;
  }
  function selectAll() { flow.addSelectedNodes(flow.getNodes.value.filter(n => !n.hidden && n.selectable !== false)); }
  function selectedNodeIds() { return nodeIdsOf(flow.getSelectedNodes.value.map(n => n.id)); }
  /** Package the selection into one collapsed group inside their parent. A selected group brings its members with it. A
   *  member whose group is selected too stays in that group. The rest must share one parent. Modules from different
   *  groups stay in their groups, and packGroup refuses the pack instead. */
  function packGroup() {
    const g = graph(), picked = flow.getSelectedNodes.value.map(n => n.id).filter(id => g.hasNode(id) || g.groups.has(id));
    const chosen = new Set(picked), within = (id: string) => [...ancestors(id)].some(p => chosen.has(p.id));
    const sel = picked.filter(id => !within(id));
    if (!sel.length) { ctx.status(t('先选中要打包的模块或组合。'), 'warn'); return false; }
    const parents = new Set(sel.map(id => g.parentOf(id)?.id ?? null));
    if (parents.size > 1) { ctx.status(t('选中的模块分属不同的组合，不能一起打包。先把它们拖到同一层。'), 'warn'); return false; }
    const parent = [...parents][0];
    const bounds = union(sel.map(geo.rect))!;
    edit(t('打包为组合'), () => {
      for (const id of sel) if (g.parentOf(id)) g.removeFromGroup(id);
      const group = g.createGroup({ title: t('组合 · {count} 个模块', { count: nodeIdsOf(sel).length }), members: sel, collapsed: true, x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
      if (parent && g.groups.has(parent)) g.addToGroup(parent, group.id);
      nextTick().then(() => { const node = flow.findNode(group.id); if (node) { flow.removeSelectedNodes(flow.getSelectedNodes.value); flow.addSelectedNodes([node]); } });
    });
    ctx.status(t('已打包为组合。双击标题展开编辑。执行图不变。'), 'ok'); return true;
  }
  function unpackSelection() {
    const g = graph(), selected = flow.getSelectedNodes.value.map(n => n.id).filter(id => g.groups.has(id));
    const viaMembers = flow.getSelectedNodes.value.map(n => g.parentOf(n.id)?.id).filter((id): id is string => !!id);
    const groups = [...new Set([...selected, ...viaMembers])];
    if (!groups.length) { ctx.status(t('选中组合或其中的模块后解包。'), 'warn'); return false; }
    unpackGroups(groups); return true;
  }
  /** Remove `groups`, and move their members to each one's parent. A training module's sections had no card while it
   *  was drawn, and their stored positions are stale. So its freed members get a new layout at the parent's level, and
   *  again after the browser measures the new cards. */
  function unpackGroups(groups: string[]) {
    const g = graph(), freed: [string[], string | null][] = [];
    const relayout = () => { for (const [members, parent] of freed) place(geo.layOut(members.filter(id => g.hasNode(id) || g.groups.has(id)), parent)); };
    edit(t('解包组合'), () => {
      for (const id of groups) {
        if (!g.groups.has(id)) continue;
        const group = g.group(id), parent = g.parentOf(id)?.id ?? null, members = [...group.members], frame = !!geo.training(id);
        g.removeGroup(id);
        if (frame) freed.push([members, parent]);
      }
      relayout();
    });
    if (freed.length) settleWith(relayout);
    ctx.status(t('已解包 {count} 个组合。模块和连线保持不变。', { count: groups.length }), 'ok');
  }

  flow.onInit(() => { S.ready = true; for (const fn of pending.splice(0)) fn(); });
  flow.onViewportChange(v => { view.x = round(v.x); view.y = round(v.y); view.k = round(v.zoom); paintView(); });
  flow.onViewportChangeEnd(() => queueSave());
  flow.onNodesChange((changes: NodeChange[]) => {   // measured sizes drive expanded group frames and fit rects. A selection change re-layers the wires
    let redraw = false, layered = false;
    for (const c of changes) {
      if (c.type === 'select') { layered = true; continue; }
      if (c.type !== 'dimensions' || !c.dimensions) continue;
      const w = Math.round(c.dimensions.width), h = Math.round(c.dimensions.height), old = measured.get(c.id);
      if (w <= 0 || h <= 0 || (old?.w === w && old?.h === h)) continue;
      measured.set(c.id, { w, h });
      if (graph().parentOf(c.id) || graph().groups.has(c.id)) redraw = true;
    }
    if (redraw && !S.dragging && !S.resizing) scheduleDraw();
    if (layered) nextTick().then(() => { if (!S.disposed) layerEdges(); });
    // new sizes continue to arrive while freshly drawn nodes render: wait until they stop before untangling
    if (settle.run && performance.now() < settle.until) { clearTimeout(settle.timer); settle.timer = window.setTimeout(runSettle, 150); }
  });
  flow.onNodeDragStart((e: NodeDragEvent) => { S.dragging = true; history.begin(); closeFieldTree(e.node.id); });
  flow.onNodeDragStop((e: NodeDragEvent) => { S.dragging = false; applyPositions(e.nodes, true); });
  flow.onNodeDoubleClick((e: NodeMouseEvent) => {
    const head = (selector: string) => e.event.target instanceof Element && !!e.event.target.closest(selector) && !e.event.target.closest(DRAG_CONTROLS);
    if (e.node.type === 'group' || e.node.type === 'trainmod') { if (head('.group-head')) runtime.toggleGroup(e.node.id); return; }
    if (head('.mnode-head')) runtime.toggleCollapse(e.node.id);
  });
  function disconnectEdge(id: string) {
    if (!graph().wires.has(id)) return;
    edit(t('断开连线'), () => graph().disconnect(id));
    edgePresentation.clear();
  }
  function selectEdge(e: EdgeMouseEvent) { edgePresentation.select(e.edge.id, e.edge.data?.label ?? '', () => disconnectEdge(e.edge.id)); }
  flow.onEdgeClick(selectEdge);
  flow.onEdgeContextMenu(selectEdge);
  flow.onPaneClick(() => { edgePresentation.clear(); closeFieldTree(); unpick(); });
  // a click on another module folds the open field tree back to the wired paths only. A click outside the picked
  // section's frame, or on the frame but outside its sections and its port slots, drops the pick. The user clicks a
  // picked section's output slot to start a wire, so the pick must outlive that click.
  flow.onNodeClick((e: NodeMouseEvent) => {
    closeFieldTree(e.node.id);
    if (e.node.id !== picked.group || !(e.event.target instanceof Element && e.event.target.closest('.tm-sec, .vue-flow__handle'))) unpick();
  });
  flow.onConnectStart(p => { S.connectFrom = p; S.connected = false; });
  function wireSpec(c: Connection) {
    // a slot of a group or of a tool card inside a network card stands for a member's port (canvas-geometry.ts socket)
    const from = geo.member(c.source, c.sourceHandle), to = geo.member(c.target, c.targetHandle);
    const g = graph(); if (!g.hasNode(from.node) || !g.hasNode(to.node) || !from.port || !to.port) return null;
    const out = g.resolved().portsOf(from.node).outputs.find(p => p.id === from.port);
    const inp = g.resolved().portsOf(to.node).inputs.find(p => p.id === to.port);
    const kind = out?.wire ?? inp?.wire ?? 'value';
    return { id: freshId('w'), kind, from, to };
  }
  function connectWire(c: Connection) {
    const spec = wireSpec(c); if (!spec) return;
    S.connected = true;
    const g = graph(), ends = { from: `${g.node(spec.from.node).title}.${spec.from.port}`, to: `${g.node(spec.to.node).title}.${spec.to.port}` };
    try { edit(t('连线'), () => g.connect(spec)); ctx.status(spec.kind === 'call' ? t('已连接调用线 ƒ：{from} → {to}', ends) : t('已连接值线：{from} → {to}', ends), 'ok'); }
    catch (e) { ctx.status(t('这条线不允许：{reason}', { reason: (e as Error).message }), 'bad'); }
  }
  flow.onConnect(connectWire);
  flow.onConnectEnd(ev => {   // dropped on an input the graph refuses: say why
    const from = S.connectFrom; S.connectFrom = null;
    if (S.connected || !from?.nodeId || !from.handleId || from.handleType !== 'source' || !ev || !('clientX' in ev)) return;
    const handle = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('.vue-flow__handle.target');
    if (!handle) return;
    const spec = wireSpec({ source: from.nodeId, sourceHandle: from.handleId, target: handle.dataset.nodeid ?? '', targetHandle: handle.dataset.handleid ?? null });
    if (!spec) return;
    const r = graph().canConnect(spec);
    if (!r.ok) ctx.status(t('这条线不允许：{reason}', { reason: r.reason }), 'bad');
  });
  // Click-to-connect: Vue Flow drops a click connection whose two handles are on one flow node. But two slots of one
  // training module (or collapsed group) stand for two different members. This code wires those here.
  let clickFrom: { nodeId: string; handleId: string | null } | null = null;
  flow.onClickConnectStart(p => { clickFrom = { nodeId: p.nodeId ?? '', handleId: p.handleId ?? null }; });
  flow.onClickConnectEnd(ev => {
    const from = clickFrom; clickFrom = null;
    const end = ev && ev.target instanceof Element ? ev.target.closest<HTMLElement>('.vue-flow__handle') : null;
    if (!from?.handleId || !end || end.dataset.nodeid !== from.nodeId || end.dataset.handleid === from.handleId) return;
    const start = [...viewport.querySelectorAll<HTMLElement>('.vue-flow__handle')].find(h => h.dataset.nodeid === from.nodeId && h.dataset.handleid === from.handleId);
    if (!start || start.classList.contains('source') === end.classList.contains('source')) return;
    const [src, dst] = start.classList.contains('source') ? [start, end] : [end, start];
    connectWire({ source: from.nodeId, sourceHandle: src.dataset.handleid ?? null, target: from.nodeId, targetHandle: dst.dataset.handleid ?? null });
  });
  /** Vue Flow runs this for live connection drags and for every edge given to setEdges. Existing wires pass, and new
   *  ones ask the graph. */
  const isValidConnection = (c: Connection) => {
    if ('id' in c && graph().wires.has(String(c.id))) return true;
    const spec = wireSpec(c);
    return !!spec && graph().canConnect(spec).ok;
  };

  // ------------------------------------------------------------------ keyboard (nothing while typing in a form control or inside a body)
  function onKeyDown(e: KeyboardEvent) {
    if (S.disposed || editableTarget(e.target) || (e.target instanceof Element && e.target.closest('.editor-resize-key,.mnode-body'))) return;
    const sel = document.getSelection();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && sel && !sel.isCollapsed && sel.anchorNode?.parentElement?.closest('.mnode-body')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z') { if (e.shiftKey) history.redo(); else history.undo(); }
      else if (k === 'y') history.redo();
      else if (k === 'c') facade.copy();
      else if (k === 'v') facade.paste();
      else if (k === 'a') selectAll();
      else if (k === 'g') { if (e.shiftKey) unpackSelection(); else packGroup(); }
      else return;
      e.preventDefault(); return;
    }
    if (mod || e.altKey) return;
    const [vw, vh] = size(), step = e.shiftKey ? 1 : 10;
    switch (e.key) {
      case '+': case '=': zoomAt(view.k * 1.2, vw / 2, vh / 2); queueSave(); break;
      case '-': case '_': zoomAt(view.k / 1.2, vw / 2, vh / 2); queueSave(); break;
      case '0': zoomAt(1, vw / 2, vh / 2); queueSave(); break;
      case 'f': case 'F': fit('all'); break;
      case 'Escape': if (!edgePresentation.selection.value) return; edgePresentation.clear(); break;
      case 'Delete': case 'Backspace':
        if (edgePresentation.selection.value) { edgePresentation.selection.value.disconnect?.(); edgePresentation.clear(); }
        else if (!deleteSelection()) return;
        break;
      case 'ArrowLeft': if (!nudge(-step, 0)) return; break;
      case 'ArrowRight': if (!nudge(step, 0)) return; break;
      case 'ArrowUp': if (!nudge(0, -step)) return; break;
      case 'ArrowDown': if (!nudge(0, step)) return; break;
      default: return;
    }
    e.preventDefault();
  }
  window.addEventListener('keydown', onKeyDown);

  // ------------------------------------------------------------------ hold Space: the canvas follows the pointer, over modules and wires too
  // Vue Flow's pan key only unlocks dragging the empty pane (nodes and edges carry `nopan`). A plain drag already pans
  // there, so the pan key would add nothing. While Space is held, every pointer move pans, and no button is necessary.
  // This code takes presses, clicks and double-clicks before any node drag, selection or connection sees them.
  // Space belongs to the canvas when the pointer is over it, unless the focused element takes typed text. Keyboard
  // focus stays on the last clicked element (a toolbar button, a body's select), so focus cannot decide.
  const spacePan = { held: false, over: false, x: 0, y: 0, moved: false, pointer: -1, justPanned: false };
  function releaseSpace() {
    if (!spacePan.held) return;
    spacePan.held = false; viewport.classList.remove('space-pan');
    if (spacePan.moved) queueSave();
  }
  function onPointerOver(e: PointerEvent) { spacePan.over = e.target instanceof Node && viewport.contains(e.target); spacePan.x = e.clientX; spacePan.y = e.clientY; }
  function onPointerOut(e: PointerEvent) { if (!e.relatedTarget) spacePan.over = false; }   // left the window
  function onPointerMove(e: PointerEvent) {
    const dx = e.clientX - spacePan.x, dy = e.clientY - spacePan.y;
    spacePan.x = e.clientX; spacePan.y = e.clientY;
    if (!spacePan.held) return;
    e.stopPropagation();
    if (!dx && !dy) return;
    spacePan.moved = true;
    setView(view.x + dx, view.y + dy, view.k);
  }
  function onSpaceKey(e: KeyboardEvent) {
    if (e.code !== 'Space' || S.disposed) return;
    if (e.type === 'keyup') { if (spacePan.held) { releaseSpace(); e.preventDefault(); } return; }
    if (spacePan.held) { e.preventDefault(); return; }   // auto-repeat
    const target = e.target instanceof HTMLElement ? e.target : null;
    const typing = !!target && (target instanceof HTMLTextAreaElement || target.isContentEditable || (target instanceof HTMLInputElement && !NOT_TEXT_INPUT[target.type]));
    if (e.ctrlKey || e.metaKey || e.altKey || !spacePan.over || typing || target?.closest('dialog')) return;
    Object.assign(spacePan, { held: true, moved: false }); viewport.classList.add('space-pan'); e.preventDefault();
  }
  /** a press while Space is held does nothing but pan. Its release, even after Space, selects nothing */
  function onPanDown(e: PointerEvent) {
    if (!spacePan.held) return;
    e.preventDefault(); e.stopPropagation();
    if (spacePan.pointer === -1) { spacePan.pointer = e.pointerId; viewport.classList.add('space-panning'); }
  }
  function onPanEnd(e: PointerEvent) {
    if (e.pointerId !== spacePan.pointer) return;
    spacePan.pointer = -1; viewport.classList.remove('space-panning');
    spacePan.justPanned = true; setTimeout(() => { spacePan.justPanned = false; });
  }
  /** mouse-compat events, clicks and double-clicks of a Space gesture never reach nodes, wires or the pane */
  function swallowPan(e: Event) { if (spacePan.held || spacePan.pointer !== -1 || spacePan.justPanned) { e.preventDefault(); e.stopPropagation(); } }
  const PAN_SWALLOW = ['mousedown', 'click', 'dblclick'] as const;
  function onBlur() { releaseSpace(); }
  window.addEventListener('keydown', onSpaceKey, true); window.addEventListener('keyup', onSpaceKey, true); window.addEventListener('blur', onBlur);
  document.addEventListener('pointerover', onPointerOver, true); document.addEventListener('pointerout', onPointerOut, true);
  document.addEventListener('pointermove', onPointerMove, true);
  viewport.addEventListener('pointerdown', onPanDown, true);
  window.addEventListener('pointerup', onPanEnd, true); window.addEventListener('pointercancel', onPanEnd, true);
  for (const type of PAN_SWALLOW) viewport.addEventListener(type, swallowPan, true);

  // ------------------------------------------------------------------ fit / focus
  /** a flow node's rect: the measured one when the browser measured it, else the estimate its view model was drawn with */
  function flowRect(fn: FlowNode): Rect {
    const m = measured.get(fn.id), data = fn.data as ModuleNodeView | GroupNodeView | TrainingModuleView;
    return { x: fn.computedPosition.x, y: fn.computedPosition.y, w: fn.dimensions.width || m?.w || ('width' in data ? data.width : data.w), h: fn.dimensions.height || m?.h || ('height' in data ? data.height ?? estimateHeight(graph().node(fn.id)) : data.h) };
  }
  /** 「选中」: the selected flow nodes. For a training module whose section is picked (and nothing else selected): that section */
  function fit(scope: FitScope = 'all') {
    const nodes = scope === 'selection' ? flow.getSelectedNodes.value : flow.getNodes.value.filter(n => !n.parentNode);
    if (scope === 'selection' && nodes.length === 1 && nodes[0].id === picked.group && picked.node) { const r = sectionRect(picked.node); if (r) return showRect(r); }
    return showRect(union(nodes.map(flowRect)));
  }
  // ------------------------------------------------------------------ layout (canvas-geometry.ts computes, the history records)
  /** Sizes of freshly drawn nodes are estimates until the browser measures them. When measurements stop arriving (or
   *  after a short window), run the layout step again and fold the result into the history entry that caused it. */
  const settle = { run: null as (() => void) | null, mark: null as unknown, until: 0, timer: 0 };
  function settleWith(run: () => void) {
    Object.assign(settle, { run, mark: history.mark(), until: performance.now() + 2000 });
    clearTimeout(settle.timer); settle.timer = window.setTimeout(runSettle, 400);
  }
  /** …untangling `unit` (null: the canvas) */
  function settleAfterMeasure(unit: string | null) {
    settleWith(() => { if (!unit || graph().groups.has(unit) || graph().hasNode(unit)) place(geo.untangle(unit)); });
  }
  function runSettle() {
    if (!settle.run || S.disposed) return;
    const { run, mark } = settle; settle.run = null;
    history.amend(mark, run);
  }
  /** 整理 (canvas-geometry.ts arrange): the selection, or the whole canvas for null. Returns false when nothing is selected */
  function arrange(ids: string[] | null) {
    const r = geo.arrange(ids); if (!r) return false;
    edit(t('整理布局'), () => place(r.moves));
    if (r.settle !== undefined) settleAfterMeasure(r.settle);
    return true;
  }
  function focusNodes(ids: string[]) {
    const targets = ids.map(geo.shownBy).map(id => flow.findNode(id)).filter((n): n is FlowNode => !!n);
    if (!targets.length) return false;
    flow.removeSelectedNodes(flow.getSelectedNodes.value); flow.addSelectedNodes(targets);
    return showRect(union(targets.map(flowRect)));
  }

  // ------------------------------------------------------------------ mount
  const app: App = createApp(EditorRoot, { flowId, isValidConnection });
  app.provide(RUNTIME_KEY, runtime);
  app.provide(EDGE_PRESENTATION, edgePresentation);
  app.provide(WORKBENCH, workbench);
  app.mount(viewport);
  paintView();

  const facade: EditorFacade = {
    draw, edit, snapshot, fit, focusNodes,
    reload() {
      clearTimeout(S.saveTimer); S.saveTimer = 0; chain.stop();
      measured.clear(); portSig.clear(); viewModels.clear(); history.clear();
      const layout = readLayout(ctx.workspace().settings.canvas);
      edgePresentation.restore(layout.edgePresentation);
      subscribe(); version.value++;
      setView(layout.view.x, layout.view.y, layout.view.k); draw();
      if (!layout.present) nextTick().then(() => requestAnimationFrame(() => { if (!S.disposed) fit('all'); }));
    },
    zoom(factor) { const [vw, vh] = size(); zoomAt(view.k * (Number.isFinite(factor) ? factor : 1), vw / 2, vh / 2); queueSave(); },
    saveTemplate,
    undo: () => history.undo(),
    redo: () => history.redo(),
    copy() { const n = history.copy(selectedNodeIds()); ctx.status(n ? t('已复制 {count} 个模块。', { count: n }) : t('先选中要复制的模块。'), n ? 'ok' : 'warn'); return n; },
    paste() {
      const ids = history.paste(); if (!ids.length) return ids;
      nextTick().then(() => { const nodes = ids.map(id => flow.findNode(geo.shownBy(id))).filter((n): n is FlowNode => !!n); flow.removeSelectedNodes(flow.getSelectedNodes.value); if (nodes.length) flow.addSelectedNodes(nodes); });
      return ids;
    },
    selectedNodes: selectedNodeIds,
    insertionPoint() {
      const g = graph(), sel = flow.getSelectedNodes.value;
      if (sel.length !== 1 || !g.groups.has(sel[0].id) || g.group(sel[0].id).collapsed) return null;
      const group = g.group(sel[0].id);
      return { group: group.id, title: group.title, ...geo.insertAt(group.id) };
    },
    arrange(ids) { if (ids) return arrange(ids); const sel = selectedNodeIds(); return arrange(sel.length ? sel : null); },
    select(ids) { const nodes = ids.map(id => flow.findNode(id)).filter((n): n is FlowNode => !!n); flow.removeSelectedNodes(flow.getSelectedNodes.value); if (nodes.length) flow.addSelectedNodes(nodes); },
    group: packGroup,
    ungroup: unpackSelection,
    dispose() {
      S.disposed = true; clearTimeout(S.saveTimer);
      edgePresentation.dispose(); unsubscribeGraph(); unsubscribeWorkspace(); chain.dispose();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onSpaceKey, true); window.removeEventListener('keyup', onSpaceKey, true); window.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerover', onPointerOver, true); document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('pointermove', onPointerMove, true); viewport.removeEventListener('pointerdown', onPanDown, true);
      window.removeEventListener('pointerup', onPanEnd, true); window.removeEventListener('pointercancel', onPanEnd, true);
      for (const type of PAN_SWALLOW) viewport.removeEventListener(type, swallowPan, true);
      app.unmount(); flow.$destroy(); viewport.classList.remove('neurom-editor');
    },
  };
  facade.reload();
  return facade;
}
