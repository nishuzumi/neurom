// editor/history.ts — undo/redo and clipboard for the module-graph editor.
//
// A snapshot is the graph's own JSON (nodes with config and geometry, wires, nested groups) plus the wire appearance.
// Undo/redo does not swap the graph instance, because sessions hold it. It applies the target JSON as a delta onto the
// live graph. Nodes keep their identity (and their sessions) when only fields changed. `ModuleGraph.admit` adds what
// is missing, so a restored state can never contain a wire that the domain refuses. Runs, artifacts and datasets are
// workspace data and never part of the history.
import { joinList, t } from '../i18n.js';
import type { GraphJSON, ModuleGraph } from './workbench-context';

export interface HistoryContext {
  graph(): ModuleGraph;
  presentation(): unknown;
  restorePresentation(raw: unknown): void;
  /** after every restore / paste */
  changed(): void;
  status(text: string): void;
}
export interface EditorHistory {
  begin(): void;
  /** true when the state differs from the last `begin()` (an entry was recorded) */
  commit(label: string): boolean;
  undo(): boolean;
  redo(): boolean;
  clear(): void;
  copy(nodeIds: string[]): number;
  /** node ids of the pasted copies */
  paste(): string[];
  /** an opaque handle on the newest entry (null when there is none), for `amend` */
  mark(): unknown;
  /** Run `fn` as a follow-up of the entry that `mark` named. Inside an open `begin()`, it joins that open edit. If that
   *  entry is still the newest, its "after" state absorbs the change. If not, the change applies without a record (the
   *  next entry starts from it). Use it for layout that can settle only after the browser measures new nodes. */
  amend(mark: unknown, fn: () => void): void;
}

interface Snapshot { graph: GraphJSON; presentation: unknown; key: string }
interface Entry { before: Snapshot; after: Snapshot; label: string }
interface Clipboard { graph: GraphJSON; pastes: number }

const MAX_ENTRIES = 100, PASTE_OFFSET = 40;
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Apply `target` onto the live graph as a delta. Wires and nodes that differ go. Nodes that are still there get updates
 *  in place. The rest (missing nodes and wires, every group) is admitted leniently. So an impossible target degrades to
 *  the closest legal state, and the function returns the differences as notes. */
export function applyGraphJSON(graph: ModuleGraph, target: GraphJSON): string[] {
  const notes: string[] = [];
  const wantNodes = new Map(target.nodes.map(n => [n.id, n]));
  const wantWires = new Map(target.wires.map(w => [w.id, w]));
  // 1. wires that are not in the target exactly as they are
  for (const w of [...graph.wires.values()]) {
    const want = wantWires.get(w.id);
    if (!want || want.kind !== w.kind || !eq(want.from, w.from) || !eq(want.to, w.to)) graph.disconnect(w.id);
  }
  // 2. groups are cheap and stateless: drop them all. The target's groups are admitted at the end
  for (const id of [...graph.groups.keys()]) if (graph.groups.has(id)) graph.removeGroup(id);
  // 3. nodes: remove, update in place
  for (const n of [...graph.nodes.values()]) {
    const want = wantNodes.get(n.id);
    if (!want || want.kind !== n.kind) graph.removeNode(n.id);
  }
  for (const want of target.nodes) {
    const live = graph.nodes.get(want.id);
    if (!live) continue;
    if (live.x !== want.x || live.y !== want.y) graph.moveNode(want.id, want.x, want.y);
    if (live.title !== want.title) graph.setTitle(want.id, want.title);
    if (!eq(live.uiSize ?? null, want.uiSize ?? null) || !!live.uiCollapsed !== (want.uiCollapsed === true) || !eq(live.uiFolded ?? [], want.uiFolded ?? []))
      graph.setUi(want.id, { uiSize: want.uiSize ?? null, uiCollapsed: want.uiCollapsed === true, uiFolded: want.uiFolded ?? [] });
    if (!eq(live.config, want.config)) { try { graph.setConfig(want.id, want.config); } catch (e) { notes.push((e as Error).message); } }
  }
  // 4. the rest
  const rest = { nodes: target.nodes.filter(n => !graph.hasNode(n.id)), wires: target.wires.filter(w => !graph.wires.has(w.id)), groups: target.groups };
  notes.push(...graph.admit(rest, { strict: false }).notes);
  return notes;
}

/** The part of the graph spanned by `nodeIds`: those nodes, wires between them, groups whose member nodes are all
 *  selected (with their nested groups). */
export function sliceGraphJSON(graph: ModuleGraph, nodeIds: string[]): GraphJSON {
  const set = new Set(nodeIds), json = graph.toJSON();
  const groups = json.groups.filter(grp => { const members = graph.memberNodes(grp.id); return members.length > 0 && members.every(m => set.has(m)); });
  const groupIds = new Set(groups.map(grp => grp.id));
  return {
    format: json.format,
    nodes: json.nodes.filter(n => set.has(n.id)),
    wires: json.wires.filter(w => set.has(w.from.node) && set.has(w.to.node)),
    groups: groups.map(grp => ({ ...grp, members: grp.members.filter(m => set.has(m) || groupIds.has(m)) })),
  };
}

export function createEditorHistory(ctx: HistoryContext): EditorHistory {
  const undoStack: Entry[] = [], redoStack: Entry[] = [];
  let pending: Snapshot | null = null, head: Snapshot | null = null, clipboard: Clipboard | null = null;

  function capture(): Snapshot {
    const graph = ctx.graph().toJSON(), presentation = ctx.presentation();
    return { graph, presentation, key: JSON.stringify([graph, presentation]) };
  }
  function restore(snap: Snapshot): string[] {
    const notes = applyGraphJSON(ctx.graph(), snap.graph);
    ctx.restorePresentation(snap.presentation);
    return notes;
  }
  function apply(entry: Entry, target: Snapshot, verb: string) {
    const notes = restore(target);
    head = capture(); ctx.changed();
    ctx.status(notes.length ? t('{verb}{label}（{notes}）。', { verb, label: entry.label, notes: joinList(notes) }) : t('{verb}{label}。', { verb, label: entry.label }));
  }
  function begin() { if (!pending) pending = capture(); }
  function commit(label: string): boolean {
    const before = pending ?? head; pending = null;
    const after = capture(); head = after;
    if (!before || before.key === after.key) return false;
    undoStack.push({ before, after, label }); redoStack.length = 0;
    if (undoStack.length > MAX_ENTRIES) undoStack.splice(0, undoStack.length - MAX_ENTRIES);
    return true;
  }
  function undo(): boolean {
    if (pending) commit(t('编辑'));
    const entry = undoStack.pop(); if (!entry) { ctx.status(t('没有可撤销的编辑。')); return false; }
    redoStack.push(entry); apply(entry, entry.before, t('已撤销：')); return true;
  }
  function redo(): boolean {
    if (pending) commit(t('编辑'));
    const entry = redoStack.pop(); if (!entry) { ctx.status(t('没有可重做的编辑。')); return false; }
    undoStack.push(entry); apply(entry, entry.after, t('已重做：')); return true;
  }
  function clear() { undoStack.length = 0; redoStack.length = 0; pending = null; head = null; clipboard = null; }
  function copy(nodeIds: string[]): number {
    const slice = sliceGraphJSON(ctx.graph(), nodeIds);
    clipboard = slice.nodes.length ? { graph: slice, pastes: 0 } : null;
    return slice.nodes.length;
  }
  function paste(): string[] {
    if (!clipboard) { ctx.status(t('剪贴板为空。')); return []; }
    const offset = PASTE_OFFSET * (clipboard.pastes + 1);
    begin();
    const { ids, notes } = ctx.graph().admit(clipboard.graph, { fresh: true, dx: offset, dy: offset, strict: false });
    const pasted = clipboard.graph.nodes.flatMap(n => ids.get(n.id) ?? []);
    clipboard.pastes++;
    commit(t('粘贴')); ctx.changed();
    ctx.status(t('已粘贴 {count} 个模块{rejected}。', { count: pasted.length, rejected: notes.length ? t('，{count} 条连线因规则不允许未复制', { count: notes.length }) : '' }));
    return pasted;
  }
  function amend(target: unknown, fn: () => void) {
    if (pending) { fn(); return; }
    fn();
    const after = capture(); if (head && after.key === head.key) return;
    const last = undoStack.at(-1);
    if (target && last === target) last.after = after;
    head = after; ctx.changed();
  }
  return { begin, commit, undo, redo, clear, copy, paste, mark: () => undoStack.at(-1) ?? null, amend };
}
