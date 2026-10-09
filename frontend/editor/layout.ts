// editor/layout.ts — the editor's own persisted state (Workspace.settings.canvas): the view transform and the wire
// appearance. Node and group geometry belong to the graph. The file also holds the numeric helpers that the projection
// shares.
import type { LayoutSnapshot, ViewState } from './types';
import type { EdgePresentationState } from './edge-presentation';

export const ZOOM_MIN = 0.05, ZOOM_MAX = 1.5;
export const NODE_W_MIN = 160, NODE_W_MAX = 1600, NODE_H_MIN = 60, NODE_H_MAX = 2400;
const COORD_MAX = 1e6;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const round = (v: number) => Math.round(v * 100) / 100;

/** an axis-aligned rectangle in canvas coordinates */
export interface Rect { x: number; y: number; w: number; h: number }
/** the smallest rect around `rects` (non-finite ones skipped), or null when there is none */
export function union(rects: Rect[]): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) { if (!Number.isFinite(r.x + r.y + r.w + r.h)) continue; x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** indices 0…N-1 in order into `n` contiguous parts [j, i) with the lowest largest `cost(j, i)` */
export function contiguousSplit(N: number, n: number, cost: (j: number, i: number) => number): number[][] {
  const k = Math.max(1, Math.min(n, N));
  if (!N) return [[]];
  const best = Array.from({ length: k + 1 }, () => new Array(N + 1).fill(Infinity)), cut = Array.from({ length: k + 1 }, () => new Array(N + 1).fill(0));
  best[0][0] = 0;
  for (let c = 1; c <= k; c++) for (let i = c; i <= N; i++) for (let j = c - 1; j < i; j++) {
    const v = Math.max(best[c - 1][j], cost(j, i));
    if (v < best[c][i]) { best[c][i] = v; cut[c][i] = j; }
  }
  const out: number[][] = [];
  for (let c = k, i = N; c >= 1; c--) { const j = cut[c][i]; out.unshift(Array.from({ length: i - j }, (_, m) => j + m)); i = j; }
  return out;
}
const fin = (v: unknown, d: number): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : d;
};
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function sanitizeView(v: unknown): ViewState {
  const o = isObj(v) ? v : {};
  return { x: round(clamp(fin(o.x, 0), -COORD_MAX * 2, COORD_MAX * 2)), y: round(clamp(fin(o.y, 0), -COORD_MAX * 2, COORD_MAX * 2)), k: round(clamp(fin(o.k, 1), ZOOM_MIN, ZOOM_MAX)) };
}

/** `{ view, edgePresentation }` from the persisted data. Unknown shapes get the default values. */
export function readLayout(raw: unknown): { view: ViewState; edgePresentation: unknown; present: boolean } {
  const o = isObj(raw) ? raw : null;
  return { view: sanitizeView(o?.view), edgePresentation: o?.edgePresentation, present: !!o?.view };
}

export function layoutSnapshot(view: ViewState, edgePresentation: EdgePresentationState): LayoutSnapshot {
  return { view: { ...view }, edgePresentation };
}
