// editor/sizes.ts — the sizes the canvas assumes before the browser measures. These are each kind's natural host size,
// the room the frames keep around their members and the gaps Arrange leaves. Frames are groups, loop boxes, training
// modules and a network's tool layers. This is plain data with no Vue, so the geometry (canvas-geometry.ts,
// training-module.js) can load under node.
// AGENTS.md: the host owns its width. A body fills it and never sets min-width.

/** each kind's host width until the user resizes, and the rough height that layout assumes before the browser measures
 *  the node. The height is a function of the config when the body grows with it. Kinds without an entry get FALLBACK. */
const NATURAL: Record<string, { width: number; height: number | ((config: Record<string, unknown>) => number) }> = {
  text: { width: 260, height: 140 },
  params: { width: 340, height: config => 120 + (config.fields && typeof config.fields === 'object' ? Object.keys(config.fields as object).length : 0) * 26 },
  code: { width: 620, height: 420 },
  dataset: { width: 340, height: 200 },
  partition: { width: 320, height: 260 },
  random: { width: 320, height: 200 },
  readout: { width: 300, height: 220 },
  network: { width: 320, height: 300 },
  trainer: { width: 380, height: 520 },
  candidates: { width: 420, height: 320 },
  evaluator: { width: 420, height: 360 },
  execution: { width: 520, height: 520 },
  view: { width: 420, height: 360 },
  script: { width: 480, height: 530 },
  deployment: { width: 480, height: 420 },
  bits: { width: 320, height: 220 },
  loop: { width: 340, height: 180 },
};
const FALLBACK = { width: 320, height: 140 };
/** header + port band of a collapsed module */
const COLLAPSED_HEIGHT = 60;

/** Host width: node.uiSize.w, else the kind's natural width. */
export function widthOf(node: { kind: string; uiSize?: { w?: number; h?: number } | null }): number {
  return node.uiSize?.w ?? NATURAL[node.kind]?.width ?? FALLBACK.width;
}
/** Rough height for layout before the browser measures a node. */
export function estimateHeight(node: { kind: string; config: Record<string, unknown>; uiSize?: { w?: number; h?: number } | null; uiCollapsed?: boolean }): number {
  if (node.uiCollapsed) return COLLAPSED_HEIGHT;
  if (node.uiSize?.h) return node.uiSize.h;
  const h = NATURAL[node.kind]?.height ?? FALLBACK.height;
  return typeof h === 'function' ? h(node.config) : h;
}

/** an expanded group's padding around its members */
export const GROUP_PAD = { x: 24, top: 48, bottom: 24 };
/** A collapsed group is a node whose host owns its width (AGENTS.md). The width is enough for its header row. Before the
 *  browser measures it, layout estimates its height from its exposed ports (one row each, an upper bound). So layout
 *  never overlaps it. */
export const COLLAPSED_GROUP = { w: 440, head: 44, row: 24 };
/** An expanded loop box (GroupNode.vue, editor.css .lb-*). The frame keeps room around its members for:
 *  - the header and the Start row above the members
 *  - the left column (init → State → input)
 *  - the right column (action)
 *  - the bottom row (step, the end).
 *  `minH` is the least member height that the left column needs. */
export const LOOP_FRAME = { left: 250, right: 230, top: 130, bottom: 140, minH: 240 };
/** a training module's frame:
 *  - the header, the padding, the width of one section column, and the gap between columns and to the well
 *  - the well's inner padding around its canvas members. The left side is the feed lane, so the feed names (up to
 *    .tm-feed-name's max-width) stay clear of the members.
 *  - the width / height ratio that the section columns aim the whole frame at, when their count is chosen by shape */
export const TRAIN_FRAME = { head: 44, pad: 20, column: 440, gap: 24, well: { left: 160, top: 28, right: 28, bottom: 28 }, aspect: 1.5 };
/** a network card's tool layers (ToolCanvas.vue, tool-canvas.css):
 *  - the width of one tool card column
 *  - the gap between cards
 *  - the card's horizontal room around the sub-canvas grid (body padding, borders, the well's padding)
 *  - the width that a code tool card wants (it spans the row)
 *  - the most card columns that the natural width makes room for
 *  - the height of a layer's header row and of a card's header, before the browser measures them */
export const TOOL_CANVAS = { column: 300, gap: 18, pad: 48, code: 600, columns: 3, head: 36, card: 30 };
/** Arrange's gaps: between layers, between units of a layer, between bands */
export const GAP = { x: 80, y: 40, band: 120 };
