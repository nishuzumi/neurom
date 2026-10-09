// core/sessions/dataset.js — imports CSV / JSON into a dataset. Every column is numeric and rows are rectangular. The
// content hash is sha256 of the canonical `{ columns, rows }`, so the same data gets the same hash for any source
// format or column order. Rows live in a dataset store (IndexedDB in the browser, a Map anywhere else) under a dataset
// id derived from that hash. So the rows of an id never change once written. The workspace keeps the metadata. The
// dataset node declares id + columns + hash, so bundles can name the table (`env.tables:[{id, hash, columns}]`) and
// the runner can find the data (pinned.js tablesFor).
import { canonicalize, hashOf } from '../canonical.js';
import { observable } from './common.js';
import { t } from '../../i18n.js';

export const LIMITS = Object.freeze({ maxColumns: 256, maxRows: 1_000_000, maxCells: 20_000_000 });
const COLUMN = /^[A-Za-z_][\w]*$/;

export class DatasetError extends Error {
  constructor(message) { super(message); this.name = 'DatasetError'; }
}

/** One RFC-4180-ish CSV line: quoted fields with doubled quotes, `,` separators (also `;` / tab when no comma). */
function splitLine(line, sep) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  if (q) throw new DatasetError(t('CSV 引号未闭合'));
  out.push(cur);
  return out.map(s => s.trim());
}

/** CSV text → `{ columns, rows }` (rows = arrays of numbers, header required). */
export function parseCSV(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim().length);
  if (lines.length < 2) throw new DatasetError(t('CSV 需要表头和至少一行数据'));
  const sep = lines[0].includes(',') ? ',' : lines[0].includes(';') ? ';' : lines[0].includes('\t') ? '\t' : ',';
  const columns = splitLine(lines[0], sep);
  const rows = lines.slice(1).map((line, i) => {
    const cells = splitLine(line, sep);
    if (cells.length !== columns.length) throw new DatasetError(t('第 {row} 行有 {n} 个值，但表头有 {columns} 列', { row: i + 2, n: cells.length, columns: columns.length }));
    return cells.map((cell, k) => toNumber(cell, i + 2, columns[k]));
  });
  return { columns, rows };
}

/** JSON text/value → `{ columns, rows }`: an array of records, `{columns, rows}` or `{col: [values]}` columns. */
export function parseJSON(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  if (Array.isArray(data)) {
    if (!data.length) throw new DatasetError(t('JSON 数据集没有行'));
    if (!data.every(r => r && typeof r === 'object' && !Array.isArray(r))) throw new DatasetError(t('JSON 数组的每一项必须是记录'));
    const columns = Object.keys(data[0]);
    return { columns, rows: data.map((r, i) => { if (Object.keys(r).length !== columns.length || columns.some(c => !(c in r))) throw new DatasetError(t('第 {row} 行的字段与第一行不同', { row: i + 1 })); return columns.map(c => toNumber(r[c], i + 1, c)); }) };
  }
  if (data && typeof data === 'object') {
    if (Array.isArray(data.columns) && Array.isArray(data.rows)) return { columns: data.columns.map(String), rows: data.rows.map((r, i) => { if (!Array.isArray(r) || r.length !== data.columns.length) throw new DatasetError(t('第 {row} 行有 {n} 个值，但表头有 {columns} 列', { row: i + 1, n: r?.length ?? 0, columns: data.columns.length })); return r.map((v, k) => toNumber(v, i + 1, data.columns[k])); }) };
    const columns = Object.keys(data);
    if (columns.length && columns.every(c => Array.isArray(data[c]))) {
      const n = data[columns[0]].length;
      if (columns.some(c => data[c].length !== n)) throw new DatasetError(t('各列长度不一致'));
      return { columns, rows: Array.from({ length: n }, (_, i) => columns.map(c => toNumber(data[c][i], i + 1, c))) };
    }
  }
  throw new DatasetError(t('JSON 数据集必须是记录数组、带 columns 和 rows 的对象，或按列的数组对象'));
}

function toNumber(v, row, column) {
  const n = typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'string' ? (v.trim() === '' ? NaN : Number(v)) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new DatasetError(t('第 {row} 行的列 {column} 不是有限数：{value}', { row, column, value: String(v) }));
  return n;
}

/** Column-name and size rules. Throws DatasetError. */
function checkTable({ columns, rows }) {
  if (!columns.length) throw new DatasetError(t('数据集尚未导入（没有列）'));
  if (columns.length > LIMITS.maxColumns) throw new DatasetError(t('最多 {max} 列，得到 {n}', { max: LIMITS.maxColumns, n: columns.length }));
  for (const c of columns) if (!COLUMN.test(c)) throw new DatasetError(t('列名 {name} 不合法。列名用字母或下划线开头，只能包含字母、数字和下划线。', { name: c }));
  if (new Set(columns).size !== columns.length) throw new DatasetError(t('数据集列名重复'));
  if (!rows.length) throw new DatasetError(t('数据集没有行'));
  if (rows.length > LIMITS.maxRows) throw new DatasetError(t('最多 {max} 行，得到 {n}', { max: LIMITS.maxRows, n: rows.length }));
  if (rows.length * columns.length > LIMITS.maxCells) throw new DatasetError(t('单元格总数超过 {max}', { max: LIMITS.maxCells }));
  return { columns, rows };
}

/** sha256 of the canonical `{columns, rows}` with columns sorted (so column order does not change the identity). */
export async function datasetHash({ columns, rows }) {
  const order = columns.map((c, i) => [c, i]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, i]) => i);
  return hashOf(canonicalize({ columns: order.map(i => columns[i]), rows: rows.map(r => order.map(i => r[i])) }));
}

/** Column-major `{ column: Float64Array }` for the runner / IR tableView. */
function columnsOf({ columns, rows }) {
  const out = {};
  columns.forEach((c, k) => { const col = new Float64Array(rows.length); for (let i = 0; i < rows.length; i++) col[i] = rows[i][k]; out[c] = col; });
  return out;
}

/** Parse `text` as `format` ('csv' | 'json' | 'auto'), validate and hash: `{ columns, rows, hash, table }`. */
export async function importDataset(text, { format = 'auto' } = {}) {
  const kind = format === 'auto' ? (/^\s*[\[{]/.test(String(text)) ? 'json' : 'csv') : format;
  const parsed = checkTable(kind === 'json' ? parseJSON(text) : parseCSV(text));
  return { ...parsed, hash: await datasetHash(parsed), table: columnsOf(parsed) };
}

// ------------------------------------------------------------------ store
// A stored record is `{ id, columns, hash, rows, writtenAt }`. `writtenAt` is when `put` wrote it (`now()`, ms), and
// reclaimDatasets reads it.
/** In-memory dataset store (node tests, or when IndexedDB is unavailable). */
export function createMemoryDatasetStore({ now = Date.now } = {}) {
  const map = new Map();
  return {
    kind: 'memory',
    async put(id, { columns, rows, hash }) { map.set(id, { id, columns: columnsOf({ columns, rows }), hash, rows: rows.length, writtenAt: now() }); },
    async get(id) { return map.get(id) ?? null; },
    async remove(id) { map.delete(id); },
    async ids() { return [...map.keys()]; },
  };
}

/** IndexedDB-backed store (object store `datasets`, key = id, value = `{ id, columns:{name:number[]}, hash, rows, writtenAt }`). */
function createIndexedDatasetStore(indexedDB = globalThis.indexedDB, name = 'neurom-datasets', now = Date.now) {
  if (!indexedDB) return createMemoryDatasetStore({ now });
  const open = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('datasets')) req.result.createObjectStore('datasets', { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const store = db.transaction('datasets', mode).objectStore('datasets');
        const req = fn(store);
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  };
  return {
    kind: 'indexeddb',
    async put(id, { columns, rows, hash }) { const cols = columnsOf({ columns, rows }); await tx('readwrite', s => s.put({ id, columns: Object.fromEntries(Object.entries(cols).map(([c, v]) => [c, Array.from(v)])), hash, rows: rows.length, writtenAt: now() })); },
    async get(id) { const r = await tx('readonly', s => s.get(id)); return r ? { ...r, columns: Object.fromEntries(Object.entries(r.columns).map(([c, v]) => [c, Float64Array.from(v)])) } : null; },
    async remove(id) { await tx('readwrite', s => s.delete(id)); },
    async ids() { return tx('readonly', s => s.getAllKeys()); },
  };
}

export const createDatasetStore = (options = {}) => (options.indexedDB ?? globalThis.indexedDB ? createIndexedDatasetStore(options.indexedDB, options.name, options.now) : createMemoryDatasetStore({ now: options.now }));

/**
 * Import `text` into the dataset node `nodeId`. Rows go to `store` under the content id `ds-<hash>`. Metadata goes to
 * the workspace and the node config (`datasetId`, `name`, `columns`, `rows`, `hash`). Re-importing points the node at
 * the new content. The rows of the old id stay in the store for whatever pinned them (a copied node, a run, an undo).
 * The workspace metadata of the old id goes when no dataset node declares it. A refused import changes nothing a node
 * declares.
 */
export async function importInto({ workspace, store, nodeId, text, name = null, format = 'auto' }) {
  const graph = workspace.graph, node = graph.node(nodeId);
  if (node.kind !== 'dataset') throw new DatasetError(t('{title} 不是数据集模块', { title: node.title }));
  const data = await importDataset(text, { format });
  const id = `ds-${data.hash.slice(2, 14)}`, previous = node.config.datasetId;
  await store.put(id, data);                                           // content-addressed: rewriting an id rewrites the same rows
  const meta = { id, name: name ?? (node.config.name || node.title), hash: data.hash, columns: data.columns, rows: data.rows.length };
  graph.patchConfig(nodeId, { datasetId: id, name: meta.name, columns: data.columns, rows: data.rows.length, hash: data.hash });
  workspace.addDataset(meta);
  if (previous && previous !== id && workspace.datasets.has(previous) && ![...graph.nodes.values()].some(n => n.kind === 'dataset' && n.config.datasetId === previous)) workspace.removeDataset(previous);
  return meta;
}

/** How long unreferenced rows are kept after they were written. Every tab shares the store, and another tab may hold
 *  a fresh import only in memory (not yet saved) for some time. */
export const RECLAIM_AFTER_MS = 10 * 60 * 1000;

/**
 * Delete the stored rows that no part of `workspace` references: its dataset modules, its dataset metadata and the
 * tables named by the bundles of its runs and artifacts. Delete only rows written more than RECLAIM_AFTER_MS ago. Call
 * it when a workspace is adopted (startup, opening a file), never during a session. An undo history may still point a
 * module back at rows nothing references now, and that history does not outlive the workspace. Returns the deleted ids.
 */
export async function reclaimDatasets(workspace, store, { now = Date.now } = {}) {
  const keep = new Set(workspace.datasets.keys());
  for (const n of workspace.graph.nodes.values()) if (n.kind === 'dataset' && n.config.datasetId) keep.add(n.config.datasetId);
  for (const { bundle } of [...workspace.runs.values(), ...workspace.artifacts.values()]) for (const tb of bundle?.env?.tables ?? []) keep.add(tb.id);
  const cutoff = now() - RECLAIM_AFTER_MS, gone = [];                 // deleted only when written more than RECLAIM_AFTER_MS ago
  for (const id of await store.ids()) {
    if (keep.has(id)) continue;
    const record = await store.get(id);
    if (record && record.writtenAt >= cutoff) continue;
    await store.remove(id); gone.push(id);
  }
  return gone;
}

/** Dataset session for one node: snapshot `{ nodeId, dead, meta, loaded, preview }`, `import(text, opts)`, `preview(n)`. */
export function createDatasetSession({ workspace, store, nodeId }) {
  const graph = workspace.graph;
  let loaded = null, error = null, disposed = false;
  const view = observable(build);
  const off = workspace.subscribe(() => { if (!disposed) view.notify('workspace'); });
  const node = () => (graph.hasNode(nodeId) && graph.node(nodeId).kind === 'dataset' ? graph.node(nodeId) : null);
  function build() {
    const n = node();
    if (!n || disposed) return { nodeId, dead: disposed ? t('数据集会话已释放') : t('数据集模块已不存在'), meta: null, loaded: null, error };
    const c = n.config;
    return { nodeId, dead: null, meta: c.datasetId ? { id: c.datasetId, name: c.name, columns: [...c.columns], rows: c.rows, hash: c.hash } : null, loaded, error };
  }
  return {
    snapshot: view.snapshot, subscribe: view.subscribe,
    async import(text, opts = {}) {
      if (disposed) throw new DatasetError(t('数据集会话已释放'));
      error = null;
      try { const meta = await importInto({ workspace, store, nodeId, text, ...opts }); loaded = { hash: meta.hash, rows: meta.rows }; return meta; }
      catch (e) { error = e.message; throw e; }
      finally { view.notify('import'); }
    },
    /** First `n` rows of the stored table (for a preview grid). [] when nothing is stored. */
    async preview(n = 10) {
      const c = node()?.config; if (!c?.datasetId) return { columns: [], rows: [] };
      const data = await store.get(c.datasetId); if (!data) return { columns: [...c.columns], rows: [] };
      const count = Math.min(n, data.rows);
      return { columns: [...c.columns], rows: Array.from({ length: count }, (_, i) => c.columns.map(col => data.columns[col][i])) };
    },
    dispose() { if (disposed) return; disposed = true; off(); view.notify('dispose'); view.clear(); },
  };
}
