// core/sessions/candidates.js — the runtime behind one candidates node. It shows the artifacts of every run wired into
// `run`, plus artifacts imported here. It does preview / accept and import / export of `neurom-module` JSON. It also
// checks each artifact against the current loop of the node. Compatible means the same env, network structure and
// readout as the trainer that feeds the node. `accepted` (node config) is the artifact whose weights flow out of
// `weights` / `artifact`.
//
//   snapshot() → { nodeId, dead, accepted, preview, reference:{trainer, envHash, problem}|null,
//                  candidates:[{ id, run, imported, method, backend, metric, metricName, engine, kind, inputs, outputs, layers,
//                                createdAt, accepted, previewed, compatible:{ ok:boolean|null, reason:string } }] }
//   accept(id) · clearAccepted() · preview(id|null) · importArtifact(json) → Promise<artifact> · exportArtifact(id) → string
//   remove(id) · subscribe(fn) · dispose()
import { bundleHash } from '../bundle.js';
import { validateArtifact, ARTIFACT_FORMAT } from '../store.js';
import { canonicalJSON } from '../canonical.js';
import { trainedOf, networkCompatibility } from '../loop.js';
import { observable, SessionError, deepEqual, shortId } from './common.js';
import { workspaceBundles } from './pinned.js';
import { t } from '../../i18n.js';

/** Why `artifact` does not fit `reference` (a trainer bundle of the current graph): same env, and the trained network's
 *  structure and readout agree (networkCompatibility). */
export function compatibility(artifact, reference) {
  if (!reference) return { ok: null, reason: t('没有可对照的训练器，所以无法判断兼容性') };
  if (!deepEqual(artifact.bundle.env, reference.env)) return { ok: false, reason: t('环境不同：产物的回路与当前环境不是同一个') };
  return networkCompatibility(artifact, trainedOf(reference.loop));
}

export function createCandidatesSession({ workspace, nodeId }) {
  const graph = workspace.graph;
  let previewId = null, disposed = false, reference = { hash: null, bundle: null, trainer: null, problem: null };
  const bundles = workspaceBundles(workspace);
  const view = observable(build);
  const off = workspace.subscribe(() => { if (!disposed) view.notify('workspace'); });

  const node = () => (graph.hasNode(nodeId) && graph.node(nodeId).kind === 'candidates' ? graph.node(nodeId) : null);
  const trainers = () => graph.producers(nodeId, 'run').map(p => graph.node(p.node)).filter(n => n.kind === 'trainer');
  /** Runs feeding this node: those of wired trainers plus imports recorded against the node itself. */
  const runs = () => { const ids = new Set([nodeId, ...trainers().map(n => n.id)]); return [...workspace.runs.values()].filter(r => ids.has(r.trainer)); };
  function referenceBundle() {
    const trainer = trainers()[0] ?? null;
    if (!trainer) return { bundle: null, trainer: null, problem: null };
    return { ...bundles.get(trainer.id), trainer: trainer.id };
  }
  function build() {
    const n = node();
    if (!n || disposed) return { nodeId, dead: disposed ? t('候选会话已释放') : t('候选模块已不存在'), accepted: null, preview: null, reference: null, candidates: [] };
    reference = referenceBundle();
    const accepted = n.config.accepted ?? null;
    const candidates = [];
    for (const run of runs().sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))) {
      for (const id of run.candidates) {
        const a = workspace.artifact(id); if (!a) continue;
        const net = trainedOf(a.bundle.loop).structure;
        candidates.push({
          id, run: run.id, imported: !!run.imported, method: a.provenance?.method ?? run.method ?? null, backend: a.provenance?.backend ?? run.backend ?? null,
          metric: a.evaluation?.metric ?? null, metricName: a.evaluation?.metricName ?? null, engine: net.engine, kind: net.kind, inputs: net.inputs, outputs: net.outputs,
          layers: net.layers, createdAt: run.finishedAt ?? run.startedAt ?? null,
          accepted: id === accepted, previewed: id === previewId, compatible: compatibility(a, reference.bundle),
        });
      }
    }
    return { nodeId, dead: null, accepted, preview: previewId, reference: reference.trainer ? { trainer: reference.trainer, problem: reference.problem } : null, candidates };
  }
  function requireCandidate(id) {
    if (!node()) throw new SessionError(t('候选模块已不存在'));
    if (!view.snapshot().candidates.some(c => c.id === id)) throw new SessionError(t('产物 {id} 不属于这个候选模块', { id: shortId(id) }));
    return workspace.artifact(id);
  }
  function accept(id) {
    requireCandidate(id);
    const c = compatibility(workspace.artifact(id), reference.bundle);
    if (c.ok === false) throw new SessionError(t('不能接受不兼容的产物：{reason}', { reason: c.reason }));
    graph.patchConfig(nodeId, { accepted: id });
    return view.snapshot();
  }
  function clearAccepted() { if (!node()) throw new SessionError(t('候选模块已不存在')); graph.patchConfig(nodeId, { accepted: null }); return view.snapshot(); }
  function preview(id) { if (id !== null) requireCandidate(id); previewId = id; view.notify('preview'); return view.snapshot(); }
  /** Import a `neurom-module` artifact (object or JSON text). The session records it as an imported run of this node. */
  async function importArtifact(input) {
    if (!node()) throw new SessionError(t('候选模块已不存在'));
    let json = input;
    if (typeof input === 'string') { try { json = JSON.parse(input); } catch { throw new SessionError(t('不是合法的 JSON')); } }
    if (json?.format !== ARTIFACT_FORMAT) throw new SessionError(t('需要 {format} 产物', { format: ARTIFACT_FORMAT }));
    const artifact = await validateArtifact(json);
    const already = runs().find(r => r.candidates.includes(artifact.id));
    if (already) return artifact;
    if (!workspace.artifacts.has(artifact.id)) await workspace.addArtifact(artifact);
    const now = Date.now();
    workspace.addRun({ id: `import-${artifact.id.slice(2, 14)}-${nodeId}`, trainer: nodeId, bundleHash: await bundleHash(artifact.bundle), status: 'done', candidates: [artifact.id], imported: true, startedAt: now, finishedAt: now, method: artifact.provenance?.method ?? null, backend: artifact.provenance?.backend ?? null });
    return artifact;
  }
  function exportArtifact(id) { return canonicalJSON(requireCandidate(id)); }
  /** Remove a candidate from its run (and the artifact when nothing else references it). The accepted one stays. */
  function remove(id) {
    requireCandidate(id);
    if (node().config.accepted === id) throw new SessionError(t('先取消接受再删除'));
    for (const run of runs()) if (run.candidates.includes(id)) workspace.updateRun(run.id, { candidates: run.candidates.filter(c => c !== id) });
    const referenced = [...workspace.runs.values()].some(r => r.candidates.includes(id)) || [...graph.nodes.values()].some(n => n.config?.accepted === id || n.config?.artifact === id);
    if (!referenced) workspace.removeArtifact(id);
    if (previewId === id) previewId = null;
    return view.snapshot();
  }
  function dispose() { if (disposed) return; disposed = true; off(); view.notify('dispose'); view.clear(); }
  return { snapshot: view.snapshot, subscribe: view.subscribe, accept, clearAccepted, preview, importArtifact, exportArtifact, remove, dispose };
}
