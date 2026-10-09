// mining-network.mjs — the trained mining network shared by the benchmarks: train mining-task with the template
// defaults (seed 1, the browser trainer run in Node), then play test episode 0 locally.
import { ModuleGraph } from '../frontend/core/graph.js';
import { instantiateInto } from '../frontend/core/template.js';
import { builtinTemplate } from '../frontend/templates/index.js';
import { buildBundle } from '../frontend/core/bundle.js';
import { trainBundle } from '../frontend/training/train.js';
import { makeArtifact } from '../frontend/core/store.js';
import { episodesOf } from '../frontend/core/sessions/common.js';
import { createExecutor } from '../frontend/core/sessions/executor.js';
import { createEnv } from '../frontend/core/runner.js';
import { trainedOf } from '../frontend/core/loop.js';
import { readout } from '../frontend/core/readout.js';

/** Train mining-task (about 35 s) → its artifact. */
export async function trainMining() {
  const graph = new ModuleGraph(), { ids } = instantiateInto(graph, builtinTemplate('mining-task'), { x: 0, y: 0 });
  const bundle = buildBundle(graph, ids.trainer), r = await trainBundle(bundle);
  return makeArtifact({ bundle, model: r.model, provenance: r.provenance, evaluation: r.evaluation });
}

/** Test episode 0 (seeds.test of mining-task.yaml) played by `artifact` → `{ inputs, scores, success }`, one entry per step. */
export function testEpisode(artifact) {
  const tr = trainedOf(artifact.bundle.loop);
  const start = episodesOf({ kind: 'seed', seed: 300000000, count: 256 })[0];
  const env = createEnv(artifact.bundle.env), ex = createExecutor(artifact.model, tr.structure);
  env.reset(start);
  const steps = [];
  while (!env.done) {
    const input = env.input(), { scores } = ex.step(input);
    const { success } = env.step(readout(tr.readout, scores).action);
    steps.push({ input, scores, success });
  }
  return steps;
}
