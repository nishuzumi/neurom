import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinTemplates } from '../templates/index.js';
import { ModuleGraph } from './graph.js';
import { instantiateInto } from './template.js';
import { docsOf } from './docs.js';

const mining = () => {
  const graph = new ModuleGraph();
  const { ids } = instantiateInto(graph, builtinTemplates().find(t => t.id === 'mining-task'));
  return { graph, ids, docs: () => docsOf(graph, graph.resolved()) };
};

test('a consumer’s refs mean what its scenario says; an input means what its wire carries', () => {
  const { ids, docs } = mining();
  const d = docs();
  // State is init's result (its record key JSDoc), as the trainer running the scenario sees it
  assert.match(d.ref(ids.trainer, 'State').fields.x.text, /x 坐标/, "State fields: the JSDoc on init's returned record keys");
  // Start is the episode record of the trainer's training partition
  assert.ok(d.ref(ids.trainer, 'Start').fields.seed.text, 'a seed partition documents its episodes’ seed');
  // a scenario input means what its wire carries (the params module declaration)
  assert.match(d.input(ids.scene, 'params').fields.baseX.text, /^基地 X\nint · 0\.\.grid - 1 · 默认 0$/, 'input fields: the params module declaration');
  // Transition: the runner's record around State twice (init's record key JSDoc) and the step's action and flags
  const tr = d.ref(ids.trainer, 'Transition');
  assert.deepEqual(Object.keys(tr.fields).sort(), ['action', 'done', 'next', 'prev', 'success', 'truncated']);
  assert.match(tr.fields.next.fields.targetReached.text, /目标价值/);
  assert.match(tr.fields.next.fields.invalid.text, /无效/, 'a step flag the scenario keeps in its state is a State field');
  assert.ok(tr.fields.done.text, 'runner fields are documented by the runner protocol');
});
