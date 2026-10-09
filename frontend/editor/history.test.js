// editor/history.test.js — a network's `artifact` (ADR 0010 §8) survives what the editor does to a graph: undo /
// redo (applyGraphJSON), copy / paste (sliceGraphJSON → admit with fresh ids) and saving the workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workspace } from '../core/store.js';
import { ModuleGraph } from '../core/graph.js';
import { counterGraph } from '../core/fixtures/counter.js';
import { applyGraphJSON, sliceGraphJSON } from './history.ts';

const ARTIFACT = '0x' + 'c'.repeat(64);

test('undo, paste and save keep a network’s artifact', async () => {
  const { graph, ids } = counterGraph();
  for (const p of [graph.producers(ids.net, 'weights')[0], graph.consumers(ids.net, 'structure')[0]]) graph.disconnect(p.wire.id);   // a frozen network
  const before = graph.toJSON();
  graph.patchConfig(ids.net, { artifact: ARTIFACT });
  const after = graph.toJSON();
  applyGraphJSON(graph, before);
  assert.equal(graph.node(ids.net).config.artifact, null, 'undo');
  applyGraphJSON(graph, after);
  assert.equal(graph.node(ids.net).config.artifact, ARTIFACT, 'redo');
  const { ids: pasted } = graph.admit(sliceGraphJSON(graph, [ids.net]), { fresh: true, dx: 40, dy: 40, strict: false });
  assert.equal(graph.node(pasted.get(ids.net)).config.artifact, ARTIFACT, 'paste');
  const saved = await Workspace.restore(JSON.parse(JSON.stringify(new Workspace(graph).toJSON())));
  assert.equal(saved.graph.node(ids.net).config.artifact, ARTIFACT, 'save');
});

test('undoing the removal of a wire that types a record keeps the workspace loadable', () => {
  const graph = new ModuleGraph();
  const params = graph.addNode({ kind: 'params', config: { fields: { bonus: { type: 'number', default: 0.5 } } } });
  const relay = graph.addNode({ kind: 'code', config: { inputs: ['p'], source: 'export const out = p;' } });
  const user = graph.addNode({ kind: 'code', config: { inputs: ['b'], source: 'export const twice = b * 2;' } });
  const typing = graph.connect({ kind: 'value', from: { node: params.id, port: 'params' }, to: { node: relay.id, port: 'p' } });
  graph.connect({ kind: 'value', from: { node: relay.id, port: 'out.bonus' }, to: { node: user.id, port: 'b' } });   // reads the record `typing` types
  const before = graph.toJSON();
  graph.disconnect(typing.id);   // the field-path wire stays
  assert.deepEqual(applyGraphJSON(graph, before), [], 'undo');
  const back = ModuleGraph.fromJSON(JSON.parse(JSON.stringify(graph.toJSON())));
  assert.deepEqual(back.toJSON().wires.map(w => w.id).sort(), before.wires.map(w => w.id).sort(), 'save → load');
});
