// training/fixtures/parity.mjs — the browser side of the runner / loop executor parity corpus: each function runs one
// case of training/fixtures/bundle-env.json (or replays.json) on the browser code and returns exactly what the fixture
// records for it. bundle-env.mjs / replays.mjs record the cases with them, bundle-env.test.mjs re-runs every committed
// case through them, and training/test_bundle_env.py / test_bundle_train.py replay the same cases in Python.
import { createEnv } from '../../frontend/core/runner.js';
import { createLoop, createLockstep, runEpisodes } from '../../frontend/core/loop.js';
import { compileEntry } from '../../frontend/core/sessions/common.js';
import { validateGreedy, always, anySet, validationEpisodes, selectionOf } from '../../frontend/training/run.js';
import { quantizeRegion } from '../../frontend/training/quantize.js';

/** `envs`: scripted episodes of the runner (lane i plays `scripts[i]` round robin) → per lane `{ start, initial, steps:
 *  [{ input, transition, t, target? }], final }`, the target read on the state before the step. */
export function envTrace({ env: envB, objective, tables, starts, scripts }) {
  const env = createEnv(envB, { tables: tables ?? {} });
  const target = objective.kind === 'target' ? compileEntry(objective, [envB.types.State, ...(envB.types.table ? [envB.types.table] : [])], 'target') : null;
  return starts.map((start, lane) => {
    const script = scripts[lane], initial = env.reset(start), steps = [];
    for (let i = 0; !env.done; i++) {
      const input = env.input(), y = target ? Array.from(target(env.state, ...(env.table ? [env.table] : []))) : undefined;
      const transition = env.step(script[i % script.length]);
      steps.push({ input, transition, t: env.t, ...(y ? { target: y } : {}) });
    }
    return { start, initial, steps, final: env.state };
  });
}

/** `loops`: greedy episodes of a whole loop, one lane at a time on the executor → `{ lanes: [{ start, initial, steps:
 *  [{ bits, action, values, ran, tools, transition, voltages }], final }], summaries }` (summaries: the lockstep runner's). */
export function loopTrace({ bundle, starts }) {
  const env = createEnv(bundle.env), loop = createLoop(bundle.loop);
  const lanes = starts.map(start => {
    const initial = env.reset(start), steps = [];
    loop.reset();
    while (!env.done) {
      const bits = env.input(), r = loop.step(bits), transition = env.step(r.action);
      steps.push({ bits, action: r.action, values: r.values, ran: [...r.ran].sort(), tools: r.tools, transition, voltages: loop.states() });
    }
    return { start, initial, steps, final: env.state };
  });
  const summaries = runEpisodes(bundle, { episodes: starts }).map(({ start, success, steps, return: ret }) => ({ start, success, steps, return: ret }));
  return { lanes, summaries };
}

/** `intercepted`: lockstep episodes of a trainer bundle whose trained network `resultOf(lane, step, x, y)` decides →
 *  per lane `{ start, steps: [{ x, y, result, action, transition, reward }] }`: the input bits and target bits handed to
 *  the decider, its result, and what the step settled (the Transition with `loop`, the reward or null). Throws what the
 *  runner throws (the `errors` cases). */
export function interceptTrace({ bundle, tables, starts }, resultOf) {
  const lanes = starts.map(start => ({ start, steps: [] })), given = [];
  let k = 0;
  createLockstep(bundle, { tables: tables ?? {} }).run(starts, {
    decide(x, on, y) {
      const B = on.length, I = x.length / B, O = y ? y.length / B : 0, results = [];
      for (let b = 0; b < B; b++) {
        if (!on[b]) continue;
        const xb = Array.from(x.subarray(b * I, (b + 1) * I)), yb = y ? Array.from(y.subarray(b * O, (b + 1) * O)) : null;
        results[b] = resultOf(b, k, xb, yb);
        given[b] = { x: xb, y: yb, result: results[b] };
      }
      return results;
    },
    onStep(steps) {
      steps.forEach((s, b) => { if (s) lanes[b].steps.push({ ...(given[b] ?? { x: null, y: null, result: null }), action: s.action, transition: s.transition, reward: s.reward }); given[b] = null; });
      k++;
    },
  });
  return lanes;
}

/** `validations`: greedy validation of `model` on the bundle's validation episodes, accuracy labelled on `any` set
 *  target bit (cross-entropy) or on `all` decided steps (hinge) → validateGreedy's summary. */
export function validation({ bundle, model, labelled, tables }) {
  return validateGreedy(bundle, model, validationEpisodes(bundle), { tables: tables ?? {}, selection: selectionOf(bundle), labelled: labelled === 'all' ? always : anySet });
}

/** `replays`: `model` as the trained network, greedily on the validation episodes → `{ summary, decisions }`
 *  (validateGreedy's summary; per episode every step's action and tool layer records). */
export function replay(bundle, model) {
  const episodes = validationEpisodes(bundle);
  const decisions = runEpisodes(bundle, { models: { [bundle.loop.trained]: model }, episodes, trace: true })
    .map(r => ({ start: r.start, steps: r.trace.map(s => ({ action: s.action, tools: s.tools })) }));
  return { summary: validateGreedy(bundle, model, episodes, { selection: selectionOf(bundle) }), decisions };
}

/** `quantizations`: one region through the browser quantiser (frontend/training/quantize.js) → its codes (W as rows),
 *  scale, shift k, clipped counts and, for a LIF layer, its threshold — what bundle_train.quantize_region must return. */
export function quantization({ W, b, bits, role }) {
  const r = quantizeRegion(W, b, bits, role), cols = W[0].length;
  return { W: W.map((_, j) => Array.from(r.W.subarray(j * cols, (j + 1) * cols))), b: Array.from(r.b), scale: r.scale, k: r.k,
    clippedWeights: r.clippedWeights, clippedBiases: r.clippedBiases, ...(r.threshold === null ? {} : { threshold: r.threshold }) };
}
