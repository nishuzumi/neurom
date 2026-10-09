// editor/wire-palette.js — how the editor tells wires apart. Every wire gets a palette colour that no other wire on
// either of its nodes shares. The wire wears that colour. When it is a port's only wire, that port's slot wears it too.
// This is a pure assignment over the canvas wires. wiring.ts calls it.

/** @typedef {{id: string, source: string, target: string}} PaletteEdge */

/** Size of the wire palette (`--wire-0` … `--wire-${WIRE_COLORS - 1}` in styles.css). */
export const WIRE_COLORS = 12;
/**
 * Give every wire a palette index so that no two wires touching the same node share one. The assignment is greedy in
 * array order, smallest free index first. It wraps only when a node carries more wires than the palette has colours.
 * @param {readonly PaletteEdge[]} edges @returns {Map<string, number>}
 */
export function colorEdges(edges) {
  /** @type {Map<string, Set<number>>} */
  const taken = new Map();
  const used = node => { let s = taken.get(node); if (!s) { s = new Set(); taken.set(node, s); } return s; };
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const e of edges) {
    const s = used(e.source), t = used(e.target);
    let i = 0;
    while (i < WIRE_COLORS && (s.has(i) || t.has(i))) i++;
    if (i === WIRE_COLORS) i = out.size % WIRE_COLORS;
    s.add(i); t.add(i); out.set(e.id, i);
  }
  return out;
}
/** CSS colour of a wire's palette index. */
export const wireColor = index => `var(--wire-${index})`;
