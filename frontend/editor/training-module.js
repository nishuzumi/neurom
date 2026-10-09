// editor/training-module.js — the training module frame (ADR 0011), pure over the ModuleGraph. An expanded prefab (a
// group with a `prefab` record, core/prefab.js) is drawn as one frame. Its direct members split into sections and
// canvas members. Sections are the trainers' interface, drawn in the frame's left column (no flow node, no port band).
// Canvas members are drawn in the recessed well. Every section port is a feed (a handle on the well's left edge), a
// slot (the frame's outer edges) or hidden. A hidden port joins only other sections of the frame, and those wires are
// not drawn. The frame's code modules are drawn as one 「代码」 section (ADR 0012). sectionColumns() splits the drawn
// sections into the frame's columns (ADR 0011 §5) and lays the frame out around its well. Presentation only: nothing
// here changes the graph.
import { MAX_COLUMNS } from '../core/graph.js';
import { estimateHeight, TRAIN_FRAME } from './sizes.ts';
import { contiguousSplit, intersects } from './layout.ts';

/** @typedef {import('./workbench-context').ModuleGraph} ModuleGraph */
/** @typedef {import('./workbench-context').Resolution} Resolution */
/** @typedef {import('./workbench-context').PortDecl} PortDecl */
/** @typedef {import('./layout').Rect} Rect */
/**
 * @typedef {object} TrainingModule
 * @property {string} group    the group id
 * @property {string[]} trainers its direct trainers, in member order (none, one, or several: the template decides)
 * @property {string[]} sections direct member nodes drawn in the left column: the stored split's order, else ADR 0011 §2's
 * @property {string[][] | null} split the sections column by column as the user placed them (group.columns applied), or
 *   null: the frame splits them itself
 * @property {string[]} canvas   every other direct member (nodes and nested groups), in member order
 */
/** @typedef {{ node: string, port: string, dir: 'in' | 'out' }} SectionPort */

/** kinds that are always sections */
const DRIVERS = new Set(['trainer', 'candidates', 'evaluator', 'execution', 'partition', 'dataset']);
/** kinds that are sections when every wire joins them to a section */
const SATELLITES = new Set(['code', 'params', 'view', 'random']);

/** Is `p` an input that a driver takes from what it drives: a loop's `loop` handle or a trained network's `structure`? */
export function facing(/** @type {PortDecl} */ p) {
  const T = /** @type {{ type?: string, of?: string } | null} */ (p.wire === 'call' ? (p.handle ? { type: 'handle', of: p.handle } : null) : (p.type ?? p.constraint ?? null));
  return !!T && T.type === 'handle' && (T.of === 'loop' || T.of === 'structure');
}

/** Is `groupId` drawn as a frame: an expanded prefab? */
function isFrame(/** @type {ModuleGraph} */ graph, /** @type {string} */ groupId) {
  const group = graph.groups.get(groupId);
  return !!group && !group.collapsed && !!group.prefab;
}
/** the nearest frame around `id` */
function frameOf(/** @type {ModuleGraph} */ graph, /** @type {string} */ id) {
  for (let g = graph.parentOf(id); g; g = graph.parentOf(g.id)) if (isFrame(graph, g.id)) return g.id;
  return null;
}

/**
 * The frame `groupId` is, or null. Groups that are collapsed or carry no prefab record are not frames.
 * Sections are the driver kinds, the scenario modules and the satellites.
 * A scenario module is a direct code member wired into the `scenario` of a loop whose nearest training module is this
 * one. The loop runs in this frame's well, and each loop has one scenario module.
 * Satellites (code / params / view / random) are found by the greatest fixed point. A satellite with a wire stays a
 * section while every one of its wires joins it to a section. So mutually wired satellites are sections together
 * (weights.params → reward.w, reward → trainer.objective, params / rng → the scenario module). A satellite also wired
 * into the well is not a section.
 * @param {ModuleGraph} graph
 * @param {string} groupId
 * @returns {TrainingModule | null}
 */
export function trainingModule(graph, groupId) {
  if (!isFrame(graph, groupId)) return null;
  const group = graph.group(groupId);
  const direct = group.members.filter(id => graph.nodes.has(id)), kind = (/** @type {string} */ id) => graph.node(id).kind;
  const trainers = direct.filter(id => kind(id) === 'trainer');
  const scenarios = new Set(direct.filter(id => kind(id) === 'code' && graph.wiresOf(id).some(w => w.from.node === id && w.to.port === 'scenario'
    && graph.node(w.to.node).kind === 'loop' && frameOf(graph, w.to.node) === groupId)));
  const sections = new Set([...direct.filter(id => DRIVERS.has(kind(id))), ...scenarios]);
  /** satellite → the nodes at the other ends of its wires */
  const peers = new Map();
  for (const id of direct) if (SATELLITES.has(kind(id)) && !scenarios.has(id)) {
    const ends = graph.wiresOf(id).map(w => (w.from.node === id ? w.to.node : w.from.node));
    if (ends.length) { peers.set(id, ends); sections.add(id); }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, ends] of peers) if (sections.has(id) && ends.some(/** @param {string} e */ e => !sections.has(e))) { sections.delete(id); changed = true; }
  }
  // the frame draws its code modules as one 「代码」 section (ADR 0012), so a code module the split lacks joins the others
  const order = sectionOrder(graph, direct, sections, trainers, scenarios), codes = new Set(order.filter(id => kind(id) === 'code'));
  const split = group.columns ? placeSections(group.columns, order, codes) : null;
  return { group: groupId, trainers, sections: split ? split.flat() : order, split, canvas: group.members.filter(id => !sections.has(id)) };
}

/**
 * A stored split applied to the sections there are now (ADR 0011 §5). An entry that is no longer a section is
 * skipped. A section that the split lacks goes to the first of these places that applies:
 *  - right below the last member of its `together` set, when the section is in that set and the split holds one
 *  - right below the nearest placed section before it in `order`
 *  - at the top of the first column
 * Columns left empty are dropped.
 * @param {string[][]} stored group.columns
 * @param {string[]} order the sections in ADR 0011 §2's order
 * @param {ReadonlySet<string>} [together] sections drawn as one (the 「代码」 section's code modules)
 * @returns {string[][]}
 */
function placeSections(stored, order, together = new Set()) {
  const live = new Set(order), at = /** @type {Map<string, string[]>} */ (new Map()), cols = /** @type {string[][]} */ ([]);
  for (const column of stored) {
    const col = /** @type {string[]} */ ([]);
    for (const id of column) if (live.has(id) && !at.has(id)) { col.push(id); at.set(id, col); }
    if (col.length) cols.push(col);
  }
  if (!cols.length) cols.push([]);
  let last = cols.flat().findLast(p => together.has(p)) ?? null;
  order.forEach((id, i) => {
    if (at.has(id)) return;
    let prev = together.has(id) ? last : null;
    if (prev !== null) last = id;
    for (let j = i - 1; j >= 0 && prev === null; j--) if (at.has(order[j])) prev = order[j];
    const col = prev === null ? cols[0] : /** @type {string[]} */ (at.get(prev));
    col.splice(prev === null ? 0 : col.indexOf(prev) + 1, 0, id);
    at.set(id, col);
  });
  return cols.filter(col => col.length);
}

/**
 * `columns` with section `key` moved (a drop in the frame's left column). `{ column, index }` puts it before the
 * index-th section of that column, counted without it. `{ before }` opens a new column holding it before column
 * `before` (columns.length: after the last). Columns left empty are dropped. Null when nothing changes or the split
 * would pass MAX_COLUMNS.
 * @param {string[][]} columns
 * @param {string} key
 * @param {{ column: number, index: number } | { before: number }} to
 * @returns {string[][] | null}
 */
export function moveSection(columns, key, to) {
  const cols = columns.map(col => col.filter(id => id !== key));
  if ('before' in to) cols.splice(Math.max(0, Math.min(to.before, cols.length)), 0, [key]);
  else if (cols[to.column]) cols[to.column].splice(Math.max(0, Math.min(to.index, cols[to.column].length)), 0, key);
  else return null;
  const out = cols.filter(col => col.length);
  if (out.length > MAX_COLUMNS || JSON.stringify(out) === JSON.stringify(columns)) return null;
  return out;
}

/**
 * @typedef {object} TrainingFrame a training module as its frame is drawn (absolute canvas coordinates)
 * @property {TrainingModule} tm
 * @property {string[]} sections the drawn sections: the code modules as one 「代码」 section, keyed by the first of them
 * @property {string[]} codes    the code modules that section shows, in section order ([] when there is none)
 * @property {string[][]} columns the drawn sections column by column, top to bottom
 * @property {{ id: string, x: number, y: number, w: number, h: number }[]} placed each drawn section's rect relative to
 *   the frame, column by column: below the slot rows, stacked at its measured height (estimated before)
 * @property {number} colW       the section columns' width
 * @property {Rect} rect         the frame
 * @property {Rect} well         the well, stretched down to the frame's bottom padding
 * @property {number} min        the frame height the well's members need
 */
/**
 * @typedef {object} FrameRoom what the canvas around a frame decides (canvas-geometry.ts measures it)
 * @property {Rect | null} content the union of the frame's canvas members, null when it has none
 * @property {{ x: number, y: number }} corner the group's stored corner: the well's place when it holds nothing
 * @property {number | undefined} height the frame's measured height, after the browser draws it
 * @property {() => Rect[]} neighbours the other units at the frame's level (asked only when the frame splits itself)
 */
/**
 * @typedef {object} SectionColumns one editor's memory of how its frames split their sections into columns
 * @property {(groupId: string, ins: number, sizes: Record<string, number>) => void} measure the frame's measured slot rows
 *   (`ins`) and drawn section heights: they settle its split once, and place its sections from then on
 * @property {(graph: ModuleGraph, tm: TrainingModule, room: FrameRoom) => TrainingFrame} frame the frame as drawn now
 * @property {(graph: ModuleGraph, tm: TrainingModule, dx: number, dy: number) => boolean} drag the frame's corner dragged
 *   by (dx, dy) canvas px since it was grabbed. A horizontal drag steps the count by column widths. A vertical drag
 *   picks the fewest columns whose tallest fits. Returns true when the drawn count changed (redraw).
 * @property {(graph: ModuleGraph, tm: TrainingModule, by: { dx: number, dy: number } | null) => string[][] | null} release
 *   the corner released after it moved `by` (null: a click, and the split stays). Returns the sections in their drawn
 *   order, re-split into the dragged count, as the split to store (group.columns).
 * @property {(graph: ModuleGraph, tm: TrainingModule, key: string, to: { column: number, index: number } | { before: number }) => string[][] | null} move
 *   a drawn section dropped in the left column (moveSection on the drawn columns), as the split to store. Null when
 *   nothing changes.
 * @property {() => void} rebalance forget every split a frame chose itself (整理): the next draw splits again
 */

/**
 * The section columns of every frame one editor draws (ADR 0011 §5). A split the user placed (TrainingModule.split)
 * is drawn as it is. Otherwise the frame splits its drawn sections, in order, into a count of columns. It picks the
 * count whose frame is closest to TRAIN_FRAME.aspect, with the lowest tallest column. More columns widen the frame to
 * the left (the well stays where its members are). The count stops before the frame would reach a neighbour at its
 * level. That split is kept while the drawn sections, their folding and the dragged count stay the same. So a section
 * that grows at run time lengthens its column and never jumps to another. The split is redone when the first
 * measurements arrive (estimates before), and after rebalance(). The stored split lists the 「代码」 section as every
 * code module it shows, adjacent.
 * @returns {SectionColumns}
 */
export function sectionColumns() {
  /** measured heights per frame: the slot rows above the sections, and each drawn section */
  const sizes = /** @type {Map<string, { ins: number, of: Map<string, number> }>} */ (new Map());
  /** the split each frame draws, and what it was chosen for */
  const kept = /** @type {Map<string, { key: string, measured: boolean, columns: string[][] }>} */ (new Map());
  /** a dragged corner: the count shown, and the count / tallest column it started from */
  const dragging = /** @type {Map<string, { n: number, base: number, tallest: number }>} */ (new Map());
  const F = TRAIN_FRAME, columnsWidth = (/** @type {number} */ n) => n * F.column + (n - 1) * F.gap;

  /** @param {ModuleGraph} graph @param {TrainingModule} tm */
  function drawn(graph, tm) {
    const codes = tm.sections.filter(id => graph.node(id).kind === 'code');
    return { codes, sections: tm.sections.filter(id => graph.node(id).kind !== 'code' || id === codes[0]) };
  }
  /** @param {ModuleGraph} graph @param {string} groupId @param {string[]} ids */
  const heightsOf = (graph, groupId, ids) => ids.map(id => sizes.get(groupId)?.of.get(id) ?? estimateHeight(graph.node(id)));
  /** `hs` in order into `n` contiguous columns with the lowest tallest one (indices) */
  function partition(/** @type {number[]} */ hs, /** @type {number} */ n) {
    const pre = [0]; for (const h of hs) pre.push(pre[pre.length - 1] + h);
    return contiguousSplit(hs.length, n, (j, i) => pre[i] - pre[j]);
  }
  const tallest = (/** @type {number[]} */ hs, /** @type {number} */ n) => Math.max(0, ...partition(hs, n).map(col => col.reduce((s, i) => s + hs[i], 0)));
  /** the count whose frame is closest to TRAIN_FRAME.aspect. The count stops before the frame reaches a neighbour. */
  function autoCount(/** @type {number[]} */ hs, /** @type {number} */ ins, /** @type {Rect} */ well, /** @type {Rect[]} */ others) {
    let best = 1, score = Infinity;
    for (let n = 1; n <= Math.max(1, hs.length); n++) {
      const colW = columnsWidth(n), w = F.pad + colW + F.gap + well.w + F.pad, h = F.head + F.pad + Math.max(ins + tallest(hs, n), well.h) + F.pad;
      if (n > 1 && others.some(r => intersects({ x: well.x - F.gap - colW - F.pad, y: well.y - F.head - F.pad, w, h }, r))) break;
      const s = Math.abs(Math.log(w / h / F.aspect));
      if (s < score - 1e-9) { score = s; best = n; }
    }
    return best;
  }
  /** @param {ModuleGraph} graph @param {TrainingModule} tm @param {string[]} ids @param {Rect} well @param {() => Rect[]} neighbours */
  function columnsOf(graph, tm, ids, well, neighbours) {
    const group = tm.group, measured = sizes.get(group), want = dragging.get(group)?.n ?? null;
    if (tm.split && want === null) {
      const shown = new Set(ids), columns = tm.split.map(col => col.filter(id => shown.has(id))).filter(col => col.length);
      kept.set(group, { key: 'placed', measured: true, columns: columns.length ? columns : [[]] });
      return /** @type {string[][]} */ (kept.get(group)?.columns);
    }
    const key = `${ids.map(id => (graph.node(id).uiCollapsed ? `-${id}` : id)).join(',')}|${want ?? 'auto'}`;
    const measuredAll = !!measured && ids.every(id => measured.of.has(id)), entry = kept.get(group);
    if (entry && entry.key === key && (entry.measured || !measuredAll)) return entry.columns;
    const hs = heightsOf(graph, group, ids);
    const columns = partition(hs, want ?? autoCount(hs, measured?.ins ?? 0, well, neighbours())).map(col => col.map(i => ids[i]));
    kept.set(group, { key, measured: measuredAll, columns });
    return columns;
  }
  /** the count a corner dragged by (dx, dy) canvas px shows, and the drawn sections it re-splits */
  function dragged(/** @type {ModuleGraph} */ graph, /** @type {TrainingModule} */ tm, /** @type {number} */ dx, /** @type {number} */ dy) {
    const ids = drawn(graph, tm).sections, hs = heightsOf(graph, tm.group, ids), N = Math.min(Math.max(1, ids.length), MAX_COLUMNS);
    let r = dragging.get(tm.group);
    if (!r) {
      const shown = kept.get(tm.group)?.columns ?? [ids], height = new Map(ids.map((id, i) => [id, hs[i]]));
      r = { n: shown.length, base: shown.length, tallest: Math.max(0, ...shown.map(col => col.reduce((s, id) => s + (height.get(id) ?? 0), 0))) };
      dragging.set(tm.group, r);
    }
    let n = r.base;
    if (Math.abs(dx) >= Math.abs(dy)) n = Math.min(N, Math.max(1, Math.round(r.base + dx / (F.column + F.gap))));
    else { n = N; for (let k = 1; k <= N; k++) if (tallest(hs, k) <= r.tallest + dy) { n = k; break; } }
    return { r, n, ids, hs };
  }
  /** drawn columns → the split a group stores: the 「代码」 section as every code module it shows, adjacent */
  function stored(/** @type {string[][]} */ columns, /** @type {string[]} */ codes) {
    return columns.map(col => col.flatMap(id => (id === codes[0] ? codes : [id])));
  }

  return {
    measure(groupId, ins, of) {
      sizes.set(groupId, { ins, of: new Map(Object.entries(of)) });
    },
    frame(graph, tm, { content, corner, height, neighbours }) {
      const W = F.well, { sections, codes } = drawn(graph, tm);
      const well = content ? { x: content.x - W.left, y: content.y - W.top, w: content.w + W.left + W.right, h: content.h + W.top + W.bottom } : { x: corner.x, y: corner.y, w: 320, h: 200 };
      const columns = columnsOf(graph, tm, sections, well, neighbours), colW = columnsWidth(columns.length);
      const x = well.x - F.gap - colW - F.pad, y = well.y - F.head - F.pad, min = well.y + well.h + F.pad - y, h = Math.max(min, height ?? 0);
      const hs = heightsOf(graph, tm.group, sections), at = new Map(sections.map((id, i) => [id, hs[i]])), top = F.head + F.pad + (sizes.get(tm.group)?.ins ?? 0);
      const placed = columns.flatMap((col, c) => {
        let y0 = top;
        return col.map(id => { const r = { id, x: F.pad + c * (F.column + F.gap), y: y0, w: F.column, h: at.get(id) ?? 0 }; y0 += r.h; return r; });
      });
      return { tm, sections, codes, columns, placed, colW, min, well: { ...well, h: y + h - F.pad - well.y }, rect: { x, y, w: well.x + well.w + F.pad - x, h } };
    },
    drag(graph, tm, dx, dy) {
      const { r, n } = dragged(graph, tm, dx, dy);
      if (n === r.n) return false;
      r.n = n; return true;
    },
    release(graph, tm, by) {
      const { n, ids, hs } = dragged(graph, tm, by?.dx ?? 0, by?.dy ?? 0);
      dragging.delete(tm.group);
      return by ? stored(partition(hs, n).map(col => col.map(i => ids[i])), drawn(graph, tm).codes) : null;
    },
    move(graph, tm, key, to) {
      const shown = kept.get(tm.group)?.columns, columns = shown ? moveSection(shown, key, to) : null;
      return columns ? stored(columns, drawn(graph, tm).codes) : null;
    },
    rebalance() { kept.clear(); },
  };
}

/**
 * Left column order:
 *  1. data (dataset, partition)
 *  2. the scenario modules, each just after the satellites that feed it, directly or through each other
 *  3. per trainer: what feeds its objective (likewise), what feeds its metric (likewise), then the trainer
 *  4. candidates
 *  5. each evaluator, after the code it calls that is not yet placed (its metrics, likewise), and before the views it
 *     feeds
 *  6. each execution with the views it feeds
 *  7. the rest
 * Member order applies within a rank.
 * @param {ModuleGraph} graph
 * @param {string[]} members direct member nodes, in member order
 * @param {Set<string>} sections
 * @param {string[]} trainers
 * @param {Set<string>} scenarios
 */
function sectionOrder(graph, members, sections, trainers, scenarios) {
  const out = /** @type {string[]} */ ([]), placed = new Set(), at = new Map(members.map((id, i) => [id, i]));
  const place = (/** @type {string} */ id) => { if (sections.has(id) && !placed.has(id)) { placed.add(id); out.push(id); } };
  const inOrder = (/** @type {string[]} */ ids) => [...new Set(ids)].filter(id => sections.has(id)).sort((a, b) => at.get(a) - at.get(b));
  const ofKind = (/** @type {string[]} */ ...kinds) => members.filter(id => sections.has(id) && kinds.includes(graph.node(id).kind));
  /** a module, after the satellites feeding it (directly or through each other), depth first */
  const placeFeeder = (/** @type {string} */ id, seen = new Set()) => {
    if (seen.has(id)) return;
    seen.add(id);
    inOrder(graph.wiresOf(id).filter(w => w.to.node === id && SATELLITES.has(graph.node(w.from.node).kind)).map(w => w.from.node)).forEach(f => placeFeeder(f, seen));
    place(id);
  };
  ofKind('dataset', 'partition').forEach(place);
  inOrder([...scenarios]).forEach(id => placeFeeder(id));
  for (const trainer of trainers) {
    for (const port of ['objective', 'metric']) inOrder(graph.producers(trainer, port).map(p => p.node)).forEach(id => placeFeeder(id));
    place(trainer);
  }
  ofKind('candidates').forEach(place);
  for (const kind of ['evaluator', 'execution']) for (const id of ofKind(kind)) {
    inOrder(graph.wiresOf(id).filter(w => w.to.node === id && graph.node(w.from.node).kind === 'code').map(w => w.from.node)).forEach(id => placeFeeder(id));
    place(id);
    inOrder(graph.wiresOf(id).filter(w => w.from.node === id && graph.node(w.to.node).kind === 'view').map(w => w.to.node)).forEach(place);
  }
  members.forEach(place);
  return out;
}

/**
 * Where each section port is drawn. A port end is one declared input, one declared output, or one wired field path of
 * a record output (`params.bonus`: its own slot, like a node's port band). The rules for an end:
 *  - An end wired to a canvas member (at any depth) is a feed. A facing input is also a feed (wired or not: it stays
 *    reconnectable).
 *  - An end wired only to sections of this frame is hidden, except where another wire can still join it. An input
 *    that takes many wires (evaluator.metrics) stays a slot. The outputs of the picked section also stay slots. When
 *    the picked section is the 「代码」 section, the outputs of every code module stay slots. The user draws reward →
 *    trainer.objective and evaluator.objective by picking 奖励 and wiring its slot. Outputs sit on the outer right, so
 *    picking does not move the column.
 *  - Any other end (unwired, or wired outside the frame) is a slot: inputs on the outer left, outputs on the outer
 *    right.
 * Each list follows section order, then declaration order (a section's inputs before its outputs, a record output's
 * wired field paths right after it, sorted).
 * @param {ModuleGraph} graph
 * @param {Resolution} res
 * @param {TrainingModule} tm
 * @param {string | null} [picked] the picked section, whose outputs are slots
 * @returns {{ feeds: SectionPort[], inputs: SectionPort[], outputs: SectionPort[] }}
 */
export function sectionPorts(graph, res, tm, picked = null) {
  const code = (/** @type {string} */ id) => graph.node(id).kind === 'code';
  const open = new Set(picked === null || !tm.sections.includes(picked) ? [] : code(picked) ? tm.sections.filter(code) : [picked]);
  const sections = new Set(tm.sections), inside = new Set(graph.memberNodes(tm.group));
  const feeds = /** @type {SectionPort[]} */ ([]), inputs = /** @type {SectionPort[]} */ ([]), outputs = /** @type {SectionPort[]} */ ([]);
  for (const node of tm.sections) {
    const ports = res.portsOf(node), wires = graph.wiresOf(node);
    /** `more`: the end can take another wire from here (an input that takes many, or an output of a picked section) */
    /** @type {{ port: string, dir: 'in' | 'out', facing: boolean, more: boolean, peers: string[] }[]} */
    const ends = ports.inputs.map(p => ({ port: p.id, dir: /** @type {const} */ ('in'), facing: facing(p), more: !!p.many, peers: wires.filter(w => w.to.node === node && w.to.port === p.id).map(w => w.from.node) }));
    for (const p of ports.outputs) {
      const from = wires.filter(w => w.from.node === node);
      const paths = [...new Set(from.filter(w => w.from.port.startsWith(`${p.id}.`)).map(w => w.from.port))].sort();
      for (const port of [p.id, ...paths]) ends.push({ port, dir: 'out', facing: false, more: open.has(node), peers: from.filter(w => w.from.port === port).map(w => w.to.node) });
    }
    for (const end of ends) {
      const at = { node, port: end.port, dir: end.dir };
      if (end.facing || end.peers.some(n => inside.has(n) && !sections.has(n))) feeds.push(at);
      else if (!end.peers.length || end.more || end.peers.some(n => !sections.has(n))) (end.dir === 'in' ? inputs : outputs).push(at);
    }
  }
  return { feeds, inputs, outputs };
}
