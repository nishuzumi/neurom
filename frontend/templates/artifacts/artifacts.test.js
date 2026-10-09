// templates/artifacts/artifacts.test.js — the builtin artifacts against the current builtin templates: every artifact is
// bound to its template's environment (a template edit without generate.mjs breaks the presets), each one still scores
// what it scores today through the template's own evaluator (every network of the loop on its accepted artifact), and
// the combiner's policy calls the right tool with the right data. The scores are exact: they depend only on the template programs, the IR,
// the runner, the loop executor and the integer engines, so any drift in those is a behaviour change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModuleGraph } from '../../core/graph.js';
import { buildBundle } from '../../core/bundle.js';
import { instantiateInto } from '../../core/template.js';
import { evaluate } from '../../core/sessions/evaluator.js';
import { episodesOf } from '../../core/sessions/common.js';
import { runEpisodes, structureOf } from '../../core/loop.js';
import { builtinTemplate, builtinTemplates } from '../index.js';
import { builtinArtifacts } from './index.js';
import { PRESETS } from './generate.mjs';

const SCORES = {
  'arithmetic-add4': { exact: 1, bitAccuracy: 1 },
  'arithmetic-sub4': { exact: 1, bitAccuracy: 1 },
  'arithmetic-mul4': { exact: 1, bitAccuracy: 1 },
  'arithmetic-combiner-policy': { exact: 1 },
};

const all = await builtinArtifacts();
const byId = new Map(all.map(e => [e.artifact.id, e.artifact]));

/** The evaluator bundle of a fresh instance of preset `name`'s template running `artifact` on its trained network;
 *  every other network runs the artifact its template pins. */
function evaluatorBundle(name, artifact) {
  const preset = PRESETS[name], graph = new ModuleGraph();
  const { ids } = instantiateInto(graph, builtinTemplate(preset.template), { x: 0, y: 0 });
  for (const id of Object.values(ids)) {
    const n = graph.node(id), pinned = n.kind === 'candidates' ? n.config.accepted : n.kind === 'network' ? n.config.artifact : null;
    if (pinned) assert.ok(byId.has(pinned), `${preset.template} pins ${pinned}, which is no builtin artifact: copy the ids generate.mjs prints`);
  }
  graph.patchConfig(ids[preset.net], structureOf(artifact));
  graph.patchConfig(graph.producers(ids[preset.net], 'weights')[0].node, { accepted: artifact.id });
  const evaluators = Object.values(ids).filter(id => graph.node(id).kind === 'evaluator');
  assert.equal(evaluators.length, 1, `${preset.template} has one evaluator`);
  return { bundle: buildBundle(graph, evaluators[0], { artifacts: id => byId.get(id) ?? null }), ids };
}

test('every builtin artifact sits on its template\'s environment and scores exactly what it does today', async () => {
  assert.deepEqual(all.map(e => e.name).sort(), Object.keys(SCORES).sort());
  for (const { name, template, artifact } of all) {
    assert.equal(template.id, PRESETS[name].template, `${name} names its preset's template`);
    const { bundle } = evaluatorBundle(name, artifact);
    assert.deepEqual(artifact.bundle.env, bundle.env, `${name}: rerun node frontend/templates/artifacts/generate.mjs`);
    const report = await evaluate(bundle, 'test');
    for (const [metric, want] of Object.entries(SCORES[name])) assert.equal(report.metrics[metric].mean, want, `${name} ${metric}`);
  }
});

test('every template preset accepts builtin artifacts of its own template', () => {
  for (const tpl of builtinTemplates().filter(x => x.preset)) for (const [local, name] of Object.entries(tpl.preset.accept)) {
    const entry = all.find(e => e.name === name);
    assert.ok(entry, `${tpl.id} preset: no builtin artifact ${name}`);
    assert.equal(entry.template.id, tpl.id, `${tpl.id} preset: ${name} belongs to ${entry.template.id}`);
    assert.equal(tpl.modules[local].kind, 'candidates');
  }
});

test('the combiner policy\'s tool layer calls ADD4 for every +, SUB4 for every -, MUL4 for every * test question, handing it exactly a‖b', () => {
  const name = 'arithmetic-combiner-policy', { bundle, ids } = evaluatorBundle(name, byId.get(all.find(e => e.name === name).artifact.id));
  const tool = { '+': 0, '-': 1, '*': 2 }, bitsOf = (n, width) => Array.from({ length: width }, (_, k) => (n >> k) & 1);
  const builtin = n => all.find(e => e.name === `arithmetic-${n}`).artifact.model;
  assert.deepEqual(bundle.loop.nodes[ids.policy].tools.tools.map(t => t.model), [builtin('add4'), builtin('sub4'), builtin('mul4')], 'tools in wire order: ADD4, SUB4, MUL4');
  const results = runEpisodes(bundle, { episodes: episodesOf(bundle.partitions.test), trace: true });
  assert.equal(results.length, 154);
  for (const r of results) {
    const { op, a, b } = r.start, [step] = r.trace, call = step.tools[ids.policy].tools;
    assert.equal(call.choice, tool[op], `${op} ${a} ${b}: tool`);
    assert.deepEqual(call.data, [...bitsOf(a, 4), ...bitsOf(b, 4)], `${op} ${a} ${b}: data`);
    assert.equal(r.success, true, `${op} ${a} ${b}`);
  }
  assert.deepEqual([...new Set(results.map(r => r.start.op))].sort(), ['*', '+', '-']);
});
