// core/store.js — the `neurom-workbench` workspace: the module graph, user templates, runs,
// artifacts (`neurom-module`), dataset metadata and settings. Everything mutates through validating
// methods and notifies subscribers. `toJSON` / `restore` round-trip through the same validation: a corrupt file is
// rejected, never half-loaded, and nothing is rewritten. A save that cannot be restored throws a RestoreError. The
// error says which format the save has and where it failed (ADR 0008).
import { ModuleGraph } from './graph.js';
import { parseTemplate } from './template.js';
import { canonicalJSON, canonicalize, hashOf, isHash, deepFreeze } from './canonical.js';
import { bundleProblem } from './bundle.js';
import { trainedOf } from './loop.js';
import { modelProblem } from './sessions/executor.js';
import { t } from '../i18n.js';

export const WORKSPACE_FORMAT = 'neurom-workbench';
export const ARTIFACT_FORMAT = 'neurom-module';
const RUN_STATUS = Object.freeze(['queued', 'running', 'done', 'failed', 'cancelled']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class StoreError extends Error {
  constructor(message) { super(message); this.name = 'StoreError'; }
}

/** `['graph', 'nodes', 2, 'config']` → `graph.nodes[2].config` */
const jsonPath = path => path.map((key, i) => typeof key === 'number' ? `[${key}]` : i ? `.${key}` : key).join('');

/** A workspace that cannot be restored. `reason`: the `format` found (null when absent), `path` (where in the JSON it
 *  failed: `graph.nodes[2].config`, empty for the text as a whole) and `message`. */
export class RestoreError extends StoreError {
  constructor(reason) {
    const values = { path: reason.path, message: reason.message, format: reason.format ?? '—' };
    super(reason.path
      ? t('{path}：{message}（格式 {format}）', values)
      : t('{message}（格式 {format}）', values));
    this.name = 'RestoreError'; this.reason = Object.freeze(reason);
  }
}

// ------------------------------------------------------------------ artifacts (docs/design.md §6)
/** Derived spec of the trained network (its structure and readout): what executors and deployment need to know
 *  without reading the bundle. */
export function artifactSpec(artifact) {
  const trained = trainedOf(artifact.bundle?.loop);
  if (!trained) throw new StoreError(t('产物的训练快照没有网络结构'));
  const n = trained.structure;
  return canonicalize({ engine: n.engine, kind: n.kind, inputs: n.inputs, outputs: n.outputs, weightBits: n.weightBits, layers: n.layers, ...(n.ticks !== undefined ? { ticks: n.ticks, leak_shift: n.leak_shift, reset: n.reset } : {}), readout: trained.readout });
}
/** `{ format, bundle, model, provenance, evaluation, id }`, id = sha256 of the rest (canonical). Frozen. */
export async function makeArtifact({ bundle, model, provenance = {}, evaluation = {} }) {
  const problem = bundleProblem(bundle);
  if (problem) throw new StoreError(problem);
  if (!trainedOf(bundle.loop)) throw new StoreError(t('产物的训练快照没有网络结构'));
  if (!plain(model)) throw new StoreError(t('产物需要 model'));
  const payload = canonicalize({ format: ARTIFACT_FORMAT, bundle, model, provenance, evaluation });
  return deepFreeze({ ...payload, id: await hashOf(payload) });
}
/** A stored or imported artifact, checked: content id, bundle, and a model the trained network can run. */
export async function validateArtifact(artifact) {
  if (!plain(artifact) || artifact.format !== ARTIFACT_FORMAT) throw new StoreError(t('需要 {format} 产物', { format: ARTIFACT_FORMAT }));
  const { id, ...payload } = artifact;
  if (!isHash(id) || (await hashOf(payload)) !== id) throw new StoreError(t('模型产物摘要不匹配：文件已被修改'));
  if (!plain(payload.model)) throw new StoreError(t('产物缺少训练快照里的网络或模型'));
  const format = modelProblem(payload.model);
  if (format) throw new StoreError(format);
  const problem = bundleProblem(payload.bundle);
  if (problem) throw new StoreError(problem);
  const trained = trainedOf(payload.bundle.loop);
  if (!trained) throw new StoreError(t('产物缺少训练快照里的网络或模型'));
  const fits = modelProblem(payload.model, trained.structure);
  if (fits) throw new StoreError(fits);
  return deepFreeze(canonicalize({ ...payload, id }));
}

// ------------------------------------------------------------------ validation of the small records
function checkRun(run) {
  if (!plain(run) || typeof run.id !== 'string' || !run.id) throw new StoreError(t('运行记录需要 id'));
  if (typeof run.trainer !== 'string') throw new StoreError(t('运行记录 {id} 需要 trainer 模块 id', { id: run.id }));
  if (!isHash(run.bundleHash)) throw new StoreError(t('运行记录 {id} 需要快照哈希', { id: run.id }));
  if (!RUN_STATUS.includes(run.status)) throw new StoreError(t('运行记录 {id} 的状态 {status} 未知', { id: run.id, status: String(run.status) }));
  if (!Array.isArray(run.candidates ?? []) || (run.candidates ?? []).some(c => !isHash(c))) throw new StoreError(t('运行记录 {id} 的候选必须是产物 id', { id: run.id }));
  return canonicalize({ candidates: [], ...run });
}
function checkDataset(ds) {
  if (!plain(ds) || typeof ds.id !== 'string' || !ds.id) throw new StoreError(t('数据集记录需要 id'));
  if (typeof ds.name !== 'string' || !isHash(ds.hash)) throw new StoreError(t('数据集 {id} 需要 name 和内容哈希', { id: ds.id }));
  if (!Array.isArray(ds.columns) || !ds.columns.every(c => typeof c === 'string') || !Number.isInteger(ds.rows) || ds.rows < 0) throw new StoreError(t('数据集 {id} 需要 columns 和 rows', { id: ds.id }));
  return canonicalize({ id: ds.id, name: ds.name, hash: ds.hash, columns: ds.columns, rows: ds.rows });
}
function checkSettings(settings) {
  if (!plain(settings)) throw new StoreError(t('settings 必须是对象'));
  try { canonicalJSON(settings); } catch { throw new StoreError(t('settings 必须是纯 JSON 数据')); }
  return structuredClone(settings);
}

export class Workspace {
  constructor(graph = new ModuleGraph()) {
    this.graph = graph;
    this.templates = new Map(); this.runs = new Map(); this.artifacts = new Map(); this.datasets = new Map();
    this.settings = {};
    this._listeners = new Set();
    this.graph.subscribe(() => this._changed('graph'));
  }
  subscribe(listener) { this._listeners.add(listener); return () => this._listeners.delete(listener); }
  _changed(what) { for (const listener of this._listeners) listener(what, this); }

  // templates: keyed `id@revision`. `template(id)` returns the latest revision.
  addTemplate(input) {
    const template = parseTemplate(input);
    const key = `${template.id}@${template.revision}`;
    if (this.templates.has(key)) throw new StoreError(t('模板 {key} 已存在', { key }));
    this.templates.set(key, template); this._changed('templates');
    return template;
  }
  template(id, revision = null) {
    if (revision !== null) return this.templates.get(`${id}@${revision}`) ?? null;
    let best = null;
    for (const tpl of this.templates.values()) if (tpl.id === id && (!best || tpl.revision > best.revision)) best = tpl;
    return best;
  }
  removeTemplate(id, revision) { if (!this.templates.delete(`${id}@${revision}`)) throw new StoreError(t('模板 {key} 不存在', { key: `${id}@${revision}` })); this._changed('templates'); }

  addRun(run) { const checked = checkRun(run); if (this.runs.has(checked.id)) throw new StoreError(t('运行记录 {id} 已存在', { id: checked.id })); this.runs.set(checked.id, checked); this._changed('runs'); return checked; }
  updateRun(id, patch) { const run = this.runs.get(id); if (!run) throw new StoreError(t('运行记录 {id} 不存在', { id })); const next = checkRun({ ...run, ...patch, id }); this.runs.set(id, next); this._changed('runs'); return next; }
  removeRun(id) { if (!this.runs.delete(id)) throw new StoreError(t('运行记录 {id} 不存在', { id })); this._changed('runs'); }

  async addArtifact(artifact) { const checked = await validateArtifact(artifact); this.artifacts.set(checked.id, checked); this._changed('artifacts'); return checked; }
  artifact(id) { return this.artifacts.get(id) ?? null; }
  removeArtifact(id) { if (!this.artifacts.delete(id)) throw new StoreError(t('产物 {id} 不存在', { id })); this._changed('artifacts'); }

  addDataset(meta) { const checked = checkDataset(meta); this.datasets.set(checked.id, checked); this._changed('datasets'); return checked; }
  removeDataset(id) { if (!this.datasets.delete(id)) throw new StoreError(t('数据集 {id} 不存在', { id })); this._changed('datasets'); }

  updateSettings(patch) { this.settings = checkSettings({ ...this.settings, ...patch }); this._changed('settings'); return this.settings; }

  toJSON() {
    return {
      format: WORKSPACE_FORMAT,
      templates: [...this.templates.values()],
      graph: this.graph.toJSON(),
      runs: [...this.runs.values()],
      artifacts: [...this.artifacts.values()],
      datasets: [...this.datasets.values()],
      settings: structuredClone(this.settings),
    };
  }

  /** A workspace from the text of a save or file: `restore` of its JSON. Text that is not JSON throws a RestoreError too. */
  static async parse(text) {
    let json; try { json = JSON.parse(text); }
    catch (error) { throw new RestoreError({ format: null, path: '', message: t('不是 JSON：{error}', { error: error.message }) }); }
    return Workspace.restore(json);
  }

  /** Rebuild a workspace from JSON. Every part is validated (artifacts by hash). Throws RestoreError. */
  static async restore(json) {
    const format = plain(json) && typeof json.format === 'string' ? json.format : null;
    const fail = (path, message) => { throw new RestoreError({ format, path: jsonPath(path), message }); };
    if (format !== WORKSPACE_FORMAT) fail(['format'], t('需要 {format} 工作区', { format: WORKSPACE_FORMAT }));
    for (const key of ['templates', 'runs', 'artifacts', 'datasets']) if (!Array.isArray(json[key])) fail([key], t('工作区缺少数组 {key}', { key }));
    // a graph's refusal names where inside it failed (`at`). Other parts' messages name the item.
    const part = async (path, fn) => {
      try { return await fn(); }
      catch (error) { fail([...path, ...(error.at ?? [])], error.message); }
    };
    const ws = new Workspace(await part(['graph'], () => ModuleGraph.fromJSON(json.graph)));
    for (const [i, tpl] of json.templates.entries()) await part(['templates', i], () => ws.addTemplate(tpl));
    for (const [i, run] of json.runs.entries()) await part(['runs', i], () => ws.addRun(run));
    for (const [i, artifact] of json.artifacts.entries()) await part(['artifacts', i], () => ws.addArtifact(artifact));
    for (const [i, ds] of json.datasets.entries()) await part(['datasets', i], () => ws.addDataset(ds));
    ws.settings = await part(['settings'], () => checkSettings(json.settings ?? {}));
    for (const [i, { id }] of json.runs.entries()) for (const [j, c] of ws.runs.get(id).candidates.entries()) {
      if (!ws.artifacts.has(c)) fail(['runs', i, 'candidates', j], t('运行记录 {id} 引用了不存在的产物 {artifact}', { id, artifact: c }));
    }
    return ws;
  }
}
