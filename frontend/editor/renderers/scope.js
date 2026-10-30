// editor/renderers/scope.js — what a view renders and how it finds it. A view names a `path` into a scope (the
// execution snapshot or an evaluator report) and `marks` (name → path or literal). Nothing here knows a scenario:
// the grid renderer draws whatever State record a template points it at, for example
// `path: state.map, marks: { x: state.x, y: state.y, baseX: state.baseX, … }`. A view script (ADR 0013) gets a `ctx`
// instead: the same run data plus its training module's static values by title (scriptContext, trainingModuleValues).
//
// Path rules: `a.b.c` walks records. A segment applied to an array maps over its elements (`history.event.reward`
// → one number per step, `report.groups.rows.key` → the group keys). A numeric segment indexes.
// Mark rules:
// - `"a,b"` → array of parts.
// - a part that is a number literal → number.
// - a part that resolves in the scope → its value.
// - anything else stays a literal string (colours, labels).
import { staticPorts, staticValue } from '../../core/bundle.js';
import { trainingModuleOf } from '../../core/resolve.js';

const SEGMENT = /^[A-Za-z_]\w*$/;

/** Walk `path` from `scope`. Returns undefined when a step is missing. */
export function resolvePath(scope, path) {
  if (!path) return scope;
  let cur = scope;
  for (const seg of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (/^\d+$/.test(seg)) { cur = cur[Number(seg)]; continue; }
      cur = cur.map(x => (x === null || x === undefined ? undefined : x[seg]));
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

const isPath = text => String(text).split('.').every(s => SEGMENT.test(s) || /^\d+$/.test(s));

function resolvePart(scope, part) {
  const s = part.trim();
  if (s === '') return undefined;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (isPath(s)) { const v = resolvePath(scope, s); if (v !== undefined) return v; }
  return s;
}

/** One mark value: a comma list becomes an array, and a single part becomes its value. */
export function resolveMark(scope, text) {
  if (text === null || text === undefined) return undefined;
  if (typeof text !== 'string') return text;
  const parts = text.split(',');
  return parts.length === 1 ? resolvePart(scope, parts[0]) : parts.map(p => resolvePart(scope, p));
}

/** Every mark resolved, or `{}` when there are none. */
function resolveMarks(scope, marks) {
  const out = {};
  for (const [k, v] of Object.entries(marks ?? {})) out[k] = resolveMark(scope, v);
  return out;
}

// ------------------------------------------------------------------ scopes

/** Scope of an execution snapshot at history step `at` (null = live state). `values` are the loop executor's
 *  per-step outputs (`'<node>.<port>'` keys), `ran` the modules that ran on that step.
 *  @param {any} snap  @param {number|null} at */
export function executionScope(snap, at = null) {
  if (!snap) return null;
  const history = snap.history ?? [];
  const entry = at !== null && at >= 0 && at < history.length ? history[at] : (snap.last ?? null);
  const live = at === null || at >= history.length - 1;
  const state = live ? snap.state ?? entry?.next ?? null : entry?.next ?? null;
  return {
    execution: snap, state, episode: snap.episode ?? null,
    t: live ? snap.t ?? history.length : at + 1, done: live ? !!snap.done : false, success: live ? snap.success ?? null : null, budget: snap.budget ?? null,
    history: live ? history : history.slice(0, at + 1), last: entry, step: entry,
    input: entry?.input ?? null, values: entry?.values ?? null, ran: entry?.ran ?? null, voltages: live ? snap.voltages ?? null : null,
    action: entry?.action ?? null, actionName: entry?.actionName ?? null, actions: snap.actions ?? null,
  };
}

/** Scope of an evaluator report. */
export function reportScope(report) {
  if (!report) return null;
  return { report, metrics: report.metrics ?? null, groups: report.groups ?? null, episodes: report.episodes ?? null, role: report.role ?? null };
}

/**
 * `ctx.modules` / `ctx.errors` of a view script (ADR 0013). `modules` holds every member node of the view's nearest
 * training module (the nearest group that carries a prefab record), keyed by title. It also holds the scenario module
 * of each of its loops that sits outside it (an environment that several training modules share, core/resolve.js
 * trainingModuleOf). Each node has the static value of each of its static output ports (core/bundle.js staticValue). A
 * static port that cannot be evaluated is listed in `errors` instead. Outside a training module, both are empty.
 * @param {any} graph  @param {any} res  @param {string} viewId
 * @returns {{ modules: Record<string, Record<string, unknown>>, errors: { module: string, port: string, message: string }[] }}
 */
export function trainingModuleValues(graph, res, viewId) {
  /** @type {Record<string, Record<string, unknown>>} */
  const modules = {};
  /** @type {{ module: string, port: string, message: string }[]} */
  const errors = [];
  const tm = trainingModuleOf(graph, viewId);
  if (!tm) return { modules, errors };
  for (const id of tm.members) {
    const node = graph.node(id), values = /** @type {Record<string, unknown>} */ ({});
    for (const port of staticPorts(graph, id)) {
      try { values[port] = staticValue(graph, res, id, port); } catch (e) { errors.push({ module: node.title, port, message: /** @type {Error} */ (e).message }); }
    }
    modules[node.title] = values;
  }
  return { modules, errors };
}

/** Run-data fields a view script's ctx takes from an execution scope (at the scrubbed step) or a report scope. */
const EXECUTION_FIELDS = ['state', 'history', 't', 'done', 'success', 'budget', 'actions', 'episode', 'input', 'action', 'actionName', 'values', 'ran'];
const REPORT_FIELDS = ['report', 'metrics', 'groups', 'episodes', 'role'];
/**
 * A view script's `ctx` (ADR 0013): the run data of what the view is wired to, plus the training module's values. The
 * run data comes from an execution at the scrubbed step (`live` when it follows the run) or from a report. It is plain
 * data: the host posts it into the script's frame by structured clone.
 * @param {Record<string, unknown> | null} scope executionScope / reportScope
 * @param {'execution' | 'evaluator' | null} kind  @param {boolean} live
 * @param {{ modules: Record<string, unknown>, errors: unknown[] }} values trainingModuleValues
 */
export function scriptContext(scope, kind, live, values) {
  const fields = kind === 'execution' ? EXECUTION_FIELDS : kind === 'evaluator' ? REPORT_FIELDS : [];
  /** @type {Record<string, unknown>} */
  const ctx = { source: kind === 'evaluator' ? 'report' : kind, live: kind === 'execution' ? live : false, modules: values.modules, errors: values.errors };
  for (const f of fields) ctx[f] = scope?.[f] ?? null;
  return ctx;
}

// ------------------------------------------------------------------ renderer models

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const pair = v => (Array.isArray(v) && v.length >= 2 && isNum(v[0]) && isNum(v[1]) ? [v[0], v[1]] : null);
const pairOf = (m, key, kx, ky) => pair(m[key]) ?? (isNum(m[kx]) && isNum(m[ky]) ? [m[kx], m[ky]] : null);
/** tile value → fill when a template sets no `colors` mark: 0 is the empty tile, higher values a neutral ramp */
const DEFAULT_COLORS = ['var(--bg)', 'var(--soft)', 'var(--line-strong)', 'var(--muted)', 'var(--ink)'];

/**
 * Grid model: tiles (from the value at `path` when it is a flat number array, else empty), size, agent / base /
 * target tiles, visibility radius, trail. `marks.order` = 'xy' (index = x·H + y) | 'yx' (index = y·W + x).
 * The trail is derived from the history: the agent mark evaluated on every step's `next` state.
 */
export function gridModel(scope, path, marks) {
  const value = resolvePath(scope, path);
  const m = resolveMarks(scope, marks);
  const tiles = Array.isArray(value) && value.every(isNum) ? value : null;
  const order = m.order === 'yx' ? 'yx' : 'xy';
  let width = isNum(m.width) ? Math.floor(m.width) : null, height = isNum(m.height) ? Math.floor(m.height) : null;
  if (tiles) {
    const n = tiles.length, side = Math.round(Math.sqrt(n));
    if (!width && !height) { width = height = side; }
    else if (!width) width = Math.max(1, Math.floor(n / height));
    else if (!height) height = Math.max(1, Math.floor(n / width));
  }
  if (!width || !height) return { problem: tiles ? null : 'size', width: width ?? 0, height: height ?? 0, tiles: null, agent: null, base: null, target: null, radius: null, trail: [], colors: DEFAULT_COLORS };
  const agent = pairOf(m, 'agent', 'x', 'y');
  const base = pairOf(m, 'base', 'baseX', 'baseY');
  const target = pairOf(m, 'target', 'targetX', 'targetY');
  const radius = isNum(m.radius) && m.radius >= 0 ? m.radius : null;
  const colors = Array.isArray(m.colors) && m.colors.every(c => typeof c === 'string') ? m.colors : DEFAULT_COLORS;
  const trail = [];
  const agentMark = marks?.agent ?? null, xMark = marks?.x ?? null, yMark = marks?.y ?? null;
  if ((agentMark || (xMark && yMark)) && Array.isArray(scope?.history) && scope.history.length) {
    const at = state => { const sub = { ...scope, state }; const r = resolveMarks(sub, agentMark ? { agent: agentMark } : { x: xMark, y: yMark }); return pairOf(r, 'agent', 'x', 'y'); };
    const first = scope.history[0]?.prev; if (first) { const p = at(first); if (p) trail.push(p); }
    for (const h of scope.history) { if (h?.next) { const p = at(h.next); if (p) trail.push(p); } }
  }
  const index = (x, y) => (order === 'xy' ? x * height + y : y * width + x);
  return { problem: null, width, height, tiles, index, agent, base, target, radius, trail, colors };
}

/**
 * Series model: `{ series:[{name, values:number[]}], labels:string[]|null, min, max }`. The value at `path` is one
 * line (number[]) or several (record of number[]). Every non-reserved mark that resolves to number[] adds a line.
 * `marks.x` labels the x axis. `marks.min` / `marks.max` pin the y range.
 */
export function seriesModel(scope, path, marks) {
  const value = resolvePath(scope, path);
  const m = resolveMarks(scope, marks);
  /** @type {{ name: string, values: number[] }[]} */
  const series = [];
  /** @returns {number[]|null} — nulls / NaN become gaps. An all-number array is used as is */
  const nums = v => (Array.isArray(v) && v.length && v.every(x => typeof x === 'number' || x === null) ? (v.includes(null) ? v.map(x => (x === null ? NaN : x)) : v) : null);
  const base = path ? String(path).split('.').at(-1) ?? 'value' : 'value';
  const own = nums(value);
  if (own) series.push({ name: base, values: own });
  else if (value && typeof value === 'object' && !Array.isArray(value)) for (const [k, v] of Object.entries(value)) { const xs = nums(v); if (xs) series.push({ name: k, values: xs }); }
  for (const [k, v] of Object.entries(m)) { if (['x', 'min', 'max'].includes(k)) continue; const xs = nums(v); if (xs) series.push({ name: k, values: xs }); }
  const labels = Array.isArray(m.x) ? m.x.map(String) : null;
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const x of s.values) if (Number.isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x; }
  const min = isNum(m.min) ? m.min : lo <= hi ? lo : 0;
  const max = isNum(m.max) ? m.max : lo <= hi ? hi : 1;
  return { series, labels, min, max: max === min ? min + 1 : max };
}

const scalar = v => v === null || ['number', 'string', 'boolean'].includes(typeof v);
const flatKeys = (row, prefix = '') => {
  const out = [];
  for (const [k, v] of Object.entries(row ?? {})) {
    if (scalar(v)) out.push(prefix + k);
    else if (v && typeof v === 'object' && !Array.isArray(v) && !prefix) out.push(...flatKeys(v, `${k}.`));
    else if (!prefix) out.push(k);
  }
  return out;
};

/**
 * Table model: `{ columns:[{key, label, path}], rows:[[cell…]] }` over the array of records at `path`. Non-reserved
 * marks name the columns (label → path relative to the row). Without them, the columns are the scalar keys (nested
 * records flattened one level).
 */
export function tableModel(scope, path, marks, limit = 200) {
  const value = resolvePath(scope, path);
  const rows = Array.isArray(value) ? value.filter(r => r && typeof r === 'object') : [];
  const named = Object.entries(marks ?? {}).filter(([k]) => k !== 'limit');
  const columns = named.length ? named.map(([label, p]) => ({ key: label, label, path: String(p) })) : (() => {
    const keys = new Set(); for (const r of rows.slice(0, 50)) for (const k of flatKeys(r)) keys.add(k);
    return [...keys].map(k => ({ key: k, label: k, path: k }));
  })();
  const max = Number.isFinite(Number(marks?.limit)) ? Number(marks.limit) : limit;
  return { columns, total: rows.length, rows: rows.slice(0, max).map(r => columns.map(c => resolvePath(r, c.path))) };
}

/** Key/value model: `[{key, value}]` of the record at `path`, nested records flattened with dots (depth 2). */
export function kvModel(scope, path, marks) {
  const value = resolvePath(scope, path);
  const named = Object.entries(marks ?? {});
  if (named.length) return named.map(([key, p]) => ({ key, value: resolveMark(scope, p) }));
  const out = [];
  const walk = (v, prefix, depth) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) { for (const [k, x] of Object.entries(v)) walk(x, prefix ? `${prefix}.${k}` : k, depth + 1); return; }
    out.push({ key: prefix || (path ? String(path).split('.').at(-1) : 'value'), value: v });
  };
  walk(value, '', 0);
  return out;
}

/** `v` with at most `digits` decimals, trailing zeros dropped (integers as they are). */
export const trimNumber = (v, digits) => (Number.isInteger(v) ? String(v) : v.toFixed(digits).replace(/0+$/, '').replace(/\.$/, ''));

/** Compact text for any value (numbers trimmed, arrays abbreviated). */
export function formatCell(v, digits = 4) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return trimNumber(v, digits);
  if (typeof v === 'boolean') return v ? '✓' : '✗';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    if (v.length <= 64 && v.every(x => x === 0 || x === 1)) return v.join('');
    return v.length <= 16 ? `[${v.map(x => formatCell(x, 3)).join(' ')}]` : `[${v.slice(0, 8).map(x => formatCell(x, 3)).join(' ')} … ${v.length}]`;
  }
  const keys = Object.keys(v);
  return keys.length <= 6 ? `{${keys.map(k => `${k}: ${formatCell(v[k], 3)}`).join(', ')}}` : `{… ${keys.length}}`;
}
