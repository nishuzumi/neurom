// core/sessions/network.js — the runtime behind the artifact picker of one network node (ADR 0010 §8). It lists the
// artifacts the network can run (the workspace's and the builtin ones) with name, metric and compatibility. It checks
// compatibility against the network as it sits in the graph (core/loop.js networkCompatibility). It selects one into
// the node's `artifact` and imports a builtin one into the workspace first. It also imports a `neurom-module` JSON
// artifact.
//
//   snapshot() → { nodeId, dead, trained, weightsWired, locked, artifact, current, choices:[Choice] }
//                `locked`: why the network takes no artifact of its own (a trainer trains it, or weights are wired)
//                Choice = { id, name, builtin, metric, metricName, engine, kind, inputs, outputs, layers, readout,
//                           selected, compatible:{ ok, reason } }. `current` is the selected Choice, or
//                { id, missing: true } when the workspace does not hold it
//   select(id|null) → Promise · adopt(id) → Promise<artifact> (an offered one, in the workspace) · importArtifact(json) → Promise<artifact> (selected) · subscribe(fn) · dispose()
import { validateArtifact, ARTIFACT_FORMAT } from '../store.js';
import { trainedOf, networkShape, networkCompatibility } from '../loop.js';
import { observable, SessionError } from './common.js';
import { t } from '../../i18n.js';

/** `builtins()` → `[{ name, artifact }]` (sync or a promise, templates/artifacts/index.js builtinArtifacts). */
export function createNetworkSession({ workspace, nodeId, builtins = () => [] }) {
  const graph = workspace.graph;
  let disposed = false, builtin = [];
  const view = observable(build);
  const off = workspace.subscribe(() => { if (!disposed) view.notify('workspace'); });
  Promise.resolve(builtins()).then(list => { builtin = list; if (!disposed) view.notify('builtins'); }, () => {});

  const node = () => (graph.hasNode(nodeId) && graph.node(nodeId).kind === 'network' ? graph.node(nodeId) : null);
  const builtinOf = id => builtin.find(e => e.artifact.id === id) ?? null;
  /** Every artifact on offer: the workspace's, then the builtin ones it does not hold yet. */
  const offered = () => [...workspace.artifacts.values(), ...builtin.map(e => e.artifact).filter(a => !workspace.artifacts.has(a.id))];

  function build() {
    const n = node();
    if (!n || disposed) return { nodeId, dead: disposed ? t('网络会话已释放') : t('网络模块已不存在'), trained: false, weightsWired: false, locked: null, artifact: null, current: null, choices: [] };
    const shape = networkShape(graph, graph.resolved(), n), selected = n.config.artifact ?? null;
    const choices = offered().map(a => {
      const trained = trainedOf(a.bundle.loop), net = trained?.structure ?? {};
      return {
        id: a.id, name: builtinOf(a.id)?.name ?? a.provenance?.name ?? null, builtin: !!builtinOf(a.id),
        metric: a.evaluation?.metric ?? null, metricName: a.evaluation?.metricName ?? null,
        engine: net.engine, kind: net.kind, inputs: net.inputs, outputs: net.outputs, layers: net.layers, readout: trained?.readout ?? null,
        selected: a.id === selected, compatible: shape.structure ? networkCompatibility(a, shape) : { ok: null, reason: t('网络的输入或输出宽度尚未确定') },
      };
    }).sort((a, b) => rank(a) - rank(b) || String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)));
    const trained = graph.consumers(nodeId, 'structure').some(x => graph.node(x.node).kind === 'trainer'), weightsWired = graph.producers(nodeId, 'weights').length > 0;
    return {
      nodeId, dead: null, trained, weightsWired,
      locked: trained ? t('训练器训练的网络从候选取权重，所以不能选产物') : weightsWired ? t('网络的权重来自接入 weights 的候选：先断开 weights 再选产物') : null,
      artifact: selected, current: selected ? choices.find(c => c.id === selected) ?? { id: selected, missing: true } : null, choices,
    };
  }
  const rank = c => (c.compatible.ok === true ? 0 : c.compatible.ok === null ? 1 : 2);

  function requireNode() { const n = node(); if (!n) throw new SessionError(t('网络模块已不存在')); return n; }
  /** Select artifact `id` (null clears). A builtin artifact not in the workspace is imported first. A network with a
   *  weights wire or a trainer takes no artifact of its own (the network kind's problems): the call is refused. */
  async function select(id) {
    requireNode();
    const locked = view.snapshot().locked;
    if (id !== null && locked) throw new SessionError(locked);
    if (id !== null) await adopt(id);
    graph.patchConfig(nodeId, { artifact: id });
    return view.snapshot();
  }
  /** The offered artifact `id`, imported into the workspace first when it is a builtin one it does not hold. */
  async function adopt(id) {
    if (workspace.artifacts.has(id)) return workspace.artifacts.get(id);
    const entry = builtinOf(id);
    if (!entry) throw new SessionError(t('产物 {id} 不存在', { id }));
    await workspace.addArtifact(entry.artifact);
    return workspace.artifacts.get(id);
  }
  /** Import a `neurom-module` artifact (object or JSON text) into the workspace and select it. */
  async function importArtifact(input) {
    requireNode();
    let json = input;
    if (typeof input === 'string') { try { json = JSON.parse(input); } catch { throw new SessionError(t('不是合法的 JSON')); } }
    if (json?.format !== ARTIFACT_FORMAT) throw new SessionError(t('需要 {format} 产物', { format: ARTIFACT_FORMAT }));
    const artifact = await validateArtifact(json);
    const { locked } = view.snapshot();
    if (locked) throw new SessionError(locked);
    if (!workspace.artifacts.has(artifact.id)) await workspace.addArtifact(artifact);
    await select(artifact.id);
    return artifact;
  }
  function dispose() { if (disposed) return; disposed = true; off(); view.notify('dispose'); view.clear(); }
  return { snapshot: view.snapshot, subscribe: view.subscribe, select, adopt, importArtifact, dispose };
}
