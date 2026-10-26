// editor/types.ts — contracts between graph_app.js and the Vue Flow editor, plus the presentation models handed to
// the node components. The domain is frontend/core (ModuleGraph inside a Workspace). The editor never makes it
// reactive. draw() rebuilds plain view models and Vue Flow diffs them by id.
import type { Ref } from 'vue';
import type { SessionKind, SessionOf, Workspace, WorkspaceClient } from './workbench-context';
import type { EdgePresentationState } from './edge-presentation';
import type { PortSpec } from './wiring';
import type { LoopContract } from './graph-view';

export interface ViewState { x: number; y: number; k: number }
/** Editor-owned persistence (Workspace.settings.canvas): the view transform and wire appearance. Node / group geometry
 *  lives in the graph itself. */
export interface LayoutSnapshot { view: ViewState; edgePresentation: EdgePresentationState }

/** What graph_app.js hands the editor. `workspace()` is read on every access so an import can swap the instance. */
export interface EditorContext {
  workspace(): Workspace;
  /** graph or layout changed → persist (debounced by the app) */
  changed(): void;
  status(text: string, tone?: 'ok' | 'warn' | 'bad'): void;
  session<K extends SessionKind>(kind: K, nodeId: string): SessionOf<K>;
  python: { client: WorkspaceClient | null; connected: Ref<boolean> };
}

export type FitScope = 'all' | 'selection';

/** The editor as graph_app.js drives it. Gestures inside the canvas commit their own history entries. App-level
 *  mutations (palette, presets, template instantiation, import) run inside `edit()`. */
export interface EditorFacade {
  draw(): void;
  edit<T>(label: string, fn: () => T): T;
  /** Re-read the workspace (after import / clear). This drops the history and restores view + wire appearance from settings. */
  reload(): void;
  snapshot(): LayoutSnapshot;
  fit(scope?: FitScope): boolean;
  focusNodes(ids: string[]): boolean;
  zoom(factor: number): void;
  /** prompt for a name and id, then store `nodeIds` as the next revision of that user template */
  saveTemplate(nodeIds: string[], suggested: string): void;
  undo(): boolean;
  redo(): boolean;
  copy(): number;
  paste(): string[];
  /** selected node ids (members of selected groups included) */
  selectedNodes(): string[];
  /** where a new module goes: into the one selected expanded group or training module, below its canvas members
   *  (a section lands in the frame's column by itself). Returns null when no such group is selected. */
  insertionPoint(): { group: string; title: string; x: number; y: number } | null;
  /** Auto-layout: `ids` (default: the selection, or the whole canvas when nothing is selected). The members of one
   *  group are laid out as that group's tree (nested groups first). */
  arrange(ids?: string[]): boolean;
  select(ids: string[]): void;
  /** package the selection into a collapsed group / dissolve the selected groups */
  group(): boolean;
  ungroup(): boolean;
  dispose(): void;
}

// ------------------------------------------------------------------ presentation models handed to the Vue nodes

export interface ProblemView { errors: string[]; incomplete: string[] }
export interface ModuleNodeView {
  nodeId: string; kind: string; kindLabel: string; title: string; collapsed: boolean;
  width: number; height: number | null;
  inputs: PortSpec[]; outputs: PortSpec[];
  problems: ProblemView;
  /** a network's tool layers in layer order (editor/tool-canvas.js), drawn as sub-canvases of its card */
  tools: ToolLayerView[];
}
/** A tool drawn inside a network card's tool layer: a module wired only into that tool port (`node`), or a frozen
 *  network (`node`) with the readout whose `run` is the tool (`readout`). `tool` is the module wired into the
 *  port. Its unwired ports are slots `${module}/${port}` on the host network's flow node (the card inside the layer
 *  stands for its wired ones). */
export interface ToolCardView {
  node: string; readout: string | null; tool: string;
  kind: string; kindLabel: string; title: string; collapsed: boolean; problems: ProblemView;
  inputs: PortSpec[]; outputs: PortSpec[];
}
/** One 「工具层 · port」 sub-canvas: the cards inside, the tools also wired elsewhere (labels that jump to them), and
 *  what each wire into the port comes from, in wire order (an execution's `choice` indexes it). */
export interface ToolLayerView {
  port: string; folded: boolean;
  inside: ToolCardView[];
  outside: { tool: string; title: string }[];
  wires: { tool: string; label: string }[];
}
/** A group that is a loop's box (group.loop). The loop node is not drawn. The frame is the loop, and its run is drawn
 *  around the members (GroupNode.vue). Start ← loop is on top, init → State → input is on the left, action is on the
 *  right, and step and the end are below. The four ports' slot ids are `${loop}/${port}` (like a collapsed group's).
 *  `summary` names the body in evaluation order (the collapsed box shows it). */
export interface LoopBoxView {
  loop: string; summary: string; problems: ProblemView;
  /** the scenario module the loop calls by role (wired into `scenario`) */
  source: { node: string; title: string } | null;
  input: PortSpec | null; action: PortSpec | null; scenario: PortSpec | null; handle: PortSpec | null;
  /** what the frame draws, read off the graph (graph-view.ts loopContract). It is null while collapsed. */
  contract: LoopContract | null;
  /** the box is a canvas member of an expanded training module: its problems show on the module's header instead */
  inTraining: boolean;
}
export interface GroupNodeView {
  groupId: string; title: string; collapsed: boolean; template: { id: string; revision: number } | null;
  members: number; inputs: PortSpec[]; outputs: PortSpec[];
  w: number; h: number;
  box: LoopBoxView | null;
}
/** A module drawn as a section of a training module's left column (no flow node, no port band). The frame's code
 *  modules share one 「代码」 section (their tabs, CodeTabs.vue): `codeNodes` lists them, and `nodeId` is the first.
 *  `rect`: where the column draws it, relative to the frame (training-module.js, and the minimap draws it there). */
export interface SectionView {
  nodeId: string; kind: string; kindLabel: string; title: string; collapsed: boolean; problems: ProblemView;
  codeNodes?: string[];
  rect: { x: number; y: number; w: number; h: number };
}
/** A prefab slot as the frame lists it (core/prefab.js prefabState): what fills it, and what its 「+」 buttons add. */
export interface SlotView {
  id: string; title: string; required: boolean; open: boolean;
  filled: { nodeId: string; title: string }[];
  create: { index: number; label: string }[];
}
/** An expanded prefab (editor/training-module.js), drawn as one frame: the slots and sections in the left column,
 *  canvas members in the recessed well on the right. Coordinates are relative to the frame. */
export interface TrainingModuleView {
  groupId: string; title: string;
  /** the trainers' `config.method` labels for the header badge (for example, reinforce → 强化学习), '' when there is none */
  method: string;
  template: { id: string; revision: number } | null; members: number;
  slots: SlotView[];
  /** expected wires that are missing, each restorable by its index in the prefab's `expect` */
  drift: { index: number; label: string }[];
  sections: SectionView[];
  /** well-edge handles, in draw order. Each PortSpec.id is the slot id `${node}/${port}`. */
  feeds: { spec: PortSpec; dir: 'in' | 'out' }[];
  /** outer-edge slots */
  inputs: PortSpec[]; outputs: PortSpec[];
  column: { x: number; y: number; w: number };
  /** the drawn sections (SectionView.nodeId), column by column, top to bottom */
  columns: string[][];
  /** more than one section: the corner handle can change the column count */
  resizable: boolean;
  well: { x: number; y: number; w: number; h: number };
  w: number; h: number;
  /** the trainers' and the well's loop boxes' problems and the missing expected wires, for the header badge */
  problems: ProblemView;
  /** the section picked by a click on its head (「选中」 zooms to it while the frame is selected), or null */
  picked: string | null;
}

/** Imperative services that the node components call. They live in index.ts and are never reactive. */
export interface EditorRuntime {
  /** delete modules in one history entry (a frozen tool network with its readout) */
  removeNode(ids: string | readonly string[]): void;
  /** fold / unfold modules together: all unfold when every one is folded, else all fold */
  toggleCollapse(ids: string | readonly string[]): void;
  /** expand / collapse the field tree of a record output (`port` may be a field path). One node's tree is open at a time. */
  togglePort(id: string, port: string): void;
  rename(id: string, title: string): void;
  resizeStart(flowId: string): void;
  resizeEnd(flowId: string): void;
  /** arrows grow / shrink by 10 px (Shift: 1), never below `minHeight` (header + ports + a strip of body). Home = natural size. */
  keyboardResize(flowId: string, key: string, shift: boolean, minHeight: number): boolean;
  toggleGroup(id: string): void;
  renameGroup(id: string, title: string): void;
  removeGroup(id: string): void;
  /** remove the group, keeping its members (they move to its parent) with their positions and wires */
  unpackGroup(id: string): void;
  saveGroupAsTemplate(id: string): void;
  /** a click on a section's head: select its training module and mark the section as what 「选中」 shows */
  pickSection(groupId: string, nodeId: string): void;
  /** add create entry `index` of prefab slot `slotId` into the group and wire it (core/prefab.js fillSlot) */
  fillSlot(groupId: string, slotId: string, index: number): void;
  /** put the prefab's expected wire `index` back (core/prefab.js restoreWire) */
  restoreWire(groupId: string, index: number): void;
  /** the frame's measured section heights (layout px): each drawn section, and the slot rows above them */
  sectionSizes(groupId: string, ins: number, sizes: Record<string, number>): void;
  /** the frame's corner dragged by (dx, dy) screen px since it was grabbed. A horizontal drag steps the column count by
   *  column widths. A vertical drag picks the fewest columns whose tallest fits. `done` re-splits the current order into
   *  that count and stores it as the group's `columns`. */
  resizeColumns(groupId: string, dx: number, dy: number, done: boolean): void;
  /** back to the automatic split: ADR 0011 §2's order, the count chosen by the frame's shape */
  resetColumns(groupId: string): void;
  /** a section (its drawn key, TrainingModuleView.columns) dropped in the frame's left column: before the index-th
   *  section of column `column`, or into a new column before column `before`. Stores the split (one history entry). */
  moveSection(groupId: string, key: string, to: { column: number; index: number } | { before: number }): void;
  /** bring code module `node` into view and put its editor's caret on the export `name` */
  revealCode(node: string, name: string): void;
  /** fold / unfold the 「工具层 · port」 sub-canvas of network `node` (node.uiFolded) */
  toggleToolLayer(node: string, port: string): void;
  /** a code tool `(bits) → bits` wired into tool port `port` of network `node`, one history entry */
  addCodeTool(node: string, port: string): void;
  /** a frozen network running `artifactId` with its readout (bits or argmax), `run` wired into `port` of network `node`. One entry. */
  addNetworkTool(node: string, port: string, artifactId: string): void;
  /** select and show a module on the outer canvas (a tool drawn outside its network card) */
  jumpTo(node: string): void;
}
export const RUNTIME_KEY: unique symbol = Symbol('neurom-editor-runtime');
