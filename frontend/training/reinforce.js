// training/reinforce.js — REINFORCE over the whole loop of a bundle. B episodes per epoch run in lockstep
// (core/loop.js createLockstep). This file decides for the trained network. Every other network runs frozen. The
// parts of the method:
//   - softmax(scores/(ticks·gain)) sampling over the O slots of its readout (gain: the codes per real unit of the
//     output layer, ADR 0015)
//   - the sampled slot goes back as the result of the readout
//   - the compiled reward objective settles the reward of every step
//   - return-to-go with a per-step EMA baseline over the lanes that ran the network
//   - BPTT through the LIF voltage across the episode (FF sets it to zero at each decision).
// Steps where the loop did not demand the trained network contribute no decision. Calibration rollouts use uniform
// random slots (random bits).
// Tool layers (ADR 0010 §6): each tool layer samples its choice and data bits (dense-core decide). It runs the chosen
// tool through the tool caller of the loop. The log-probabilities of every tool decision and of the readout slot go
// into one policy gradient on the advantage of the step. The entropy bonus `recipe.entropy` covers all of them. The
// result bits of a trailing tool layer are the action (given to the bits readout as they are). In that case, only its
// decisions carry log-probabilities.
// Each lane keeps the states of its network tools (the potentials of a LIF tool, the states of the own tools of a
// tool). They are reset with the voltages of the lane at the start of its episode. They advance only when the tool is
// chosen (ADR 0014). Calibration calls tools from their rest state.
// The sampled decisions go to the loop with the result of the step, so the `transition.loop` of the reward reads them.
import { createLockstep, toolCaller, trainedOf } from '../core/loop.js';
import { denseStateWidth } from '../runtime/dense-policy.js';
import { QatPolicy, rngOf, mixSeed, softmaxInto, assertTapeBudget, meanSpikeRate, safeLog } from './dense-core.js';
import { Run, epochEpisodes, epochSize, drawEpisodes, selectionOf, validateGreedy, validationEpisodes, finishResult } from './run.js';

/** Calibration observations: the trained network's input bits over `episodes` driven by uniform random slots (a
 *  trailing tool layer: uniform random result bits). */
function calibration(lockstep, episodes, rng, I, O, trailing) {
  const rows = [];
  lockstep.run(episodes, { decide(x, lanes) {
    const results = [];
    for (let b = 0; b < lanes.length; b++) {
      if (!lanes[b]) continue;
      rows.push(x.subarray(b * I, (b + 1) * I));
      results[b] = trailing ? { bits: Array.from({ length: O }, () => (rng() < 0.5 ? 1 : 0)) } : { slot: Math.floor(rng() * O) };
    }
    return results;
  } });
  const X = new Uint8Array(rows.length * I); rows.forEach((row, n) => X.set(row, n * I));
  return { X, N: rows.length };
}

export async function trainReinforce(bundle, { onProgress, isCancelled, tables, bundleHash } = {}) {
  const recipe = bundle.recipe, { id: node, structure: net } = trainedOf(bundle.loop), ff = net.kind === 'feedforward';
  const H = denseStateWidth(net), I = net.inputs, O = net.outputs, ticks = ff ? 1 : net.ticks;
  const selection = selectionOf(bundle);
  const training = bundle.partitions.training;
  const B = epochSize(training, recipe);
  assertTapeBudget(bundle.env.budget, ticks, B, H);
  const run = new Run(recipe.epochs, { onProgress, isCancelled });
  run.report({ phase: 'init', epoch: 0, loss: null, metric: null, metricName: selection.name });

  const policy = new QatPolicy(net, recipe.surrogateWidth), { trailing, heads } = policy;
  const box = heads.length ? toolCaller(node, bundle.loop.nodes[node]) : null, last = heads.length - 1;
  const toolStates = box ? Array.from({ length: B }, () => new Array(box.width).fill(0)) : null;
  const call = box ? (port, choice, data, b) => box.call(port, choice, data, toolStates[b]) : null;
  const restCall = box ? (port, choice, data) => box.call(port, choice, data, new Array(box.width).fill(0)) : null;
  /** Lane `b`'s tool layer record of decision `rec` (the executor's `{ <port>: { choice, data, result } }`). */
  const toolsOf = (rec, b) => Object.fromEntries(heads.map(({ tools, D, R }, h) => {
    const d = rec.decisions[h];
    return [tools, { choice: d.choice[b], data: Array.from(d.data.subarray(b * D, (b + 1) * D)), result: Array.from(d.result.subarray(b * R, (b + 1) * R)) }];
  }));
  policy.init(rngOf(mixSeed(recipe.seed, 0)));
  const lockstep = createLockstep(bundle, { tables });
  {
    const rng = rngOf(mixSeed(recipe.seed, 1));
    const { X, N } = calibration(lockstep, drawEpisodes(training, recipe.calibrationEpisodes, rng), rng, I, O, trailing);
    policy.calibrateBias(X, N, recipe.initCurrent, { call: restCall, rng });
  }
  await run.tick();
  const validation = validationEpisodes(bundle);
  const curves = { loss: [], metric: [], trainReturn: [], trainSuccess: [], spikeRate: [], gradNorm: [], entropy: [] }, evaluations = [], baseline = [];
  const p = new Float64Array(O), V = new Float64Array(B * H), succeeded = new Uint8Array(B);
  let best = null;
  for (let epoch = 0; epoch < recipe.epochs; epoch++) {
    const rng = rngOf(mixSeed(recipe.seed, 1000 + epoch));
    const inverseScale = trailing ? 0 : policy.inverseScale;                         // real-unit logits of this epoch's integers (the output layer's scale)
    const episodes = epochEpisodes(training, recipe, rng);
    succeeded.fill(0);
    const records = [], rewards = [], lives = [], actions = [], probs = [];
    let epochReturn = 0, entropySum = 0, decisions = 0, decided = null;
    V.fill(0); toolStates?.forEach(s => s.fill(0));
    lockstep.run(episodes, {
      decide(X, ran) {                                                                // X: the step's record keeps it for backward
        if (ff) V.fill(0);
        const rec = policy.decide(B, X, V, ran, { call, rng }), results = [];
        const act = new Uint8Array(B), prob = trailing ? null : new Float64Array(B * O);
        for (let b = 0; b < B; b++) {
          if (!ran[b]) continue;
          decisions++;
          if (trailing) results[b] = { bits: rec.decisions[last].result.subarray(b * O, (b + 1) * O) };   // the tool's result bits are the action
          else {
            softmaxInto(p, rec.scores, b * O, O, inverseScale); prob.set(p, b * O);
            let u = rng(), a = O - 1; for (let k = 0; k < O; k++) { u -= p[k]; if (u < 0) { a = k; break; } }
            act[b] = a;                                                               // the sampled slot: the REINFORCE log π(a) is taken on it
            results[b] = { slot: a }; for (let k = 0; k < O; k++) if (p[k] > 0) entropySum -= p[k] * Math.log(p[k]);
          }
          if (heads.length) results[b].tools = toolsOf(rec, b);
        }
        decided = { rec, ran, act, prob };
        return results;                                                               // the readout maps the slot / bits to its action. The loop finishes the step
      },
      onStep(steps) {                                                                 // a step no lane decided keeps its place in the return-to-go
        const r = new Float64Array(B);
        for (let b = 0; b < B; b++) {
          const step = steps[b];
          if (!step) continue;                                                        // a terminal state is not another policy decision
          r[b] = step.reward; epochReturn += r[b];
          if (step.transition.done && step.transition.success) succeeded[b] = 1;
        }
        records.push(decided?.rec ?? null); rewards.push(r); lives.push(decided?.ran ?? new Uint8Array(B)); actions.push(decided?.act ?? null); probs.push(decided?.prob ?? null);
        decided = null;
      },
    });
    // return-to-go, per-step EMA baseline over the lanes that ran the network, advantage → dLoss/dscores and dLoss/dlogits of
    // every tool layer. loss = −Σ (logπ(slot) + Σ logπ(tool decisions))·adv / B (− entropy bonus over all of them)
    const T = records.length, G = new Float64Array(B); let loss = 0;
    for (let t = T - 1; t >= 0; t--) {
      const wasLive = lives[t]; let sum = 0, n = 0;
      for (let b = 0; b < B; b++) { G[b] = rewards[t][b] + recipe.gamma * G[b]; if (wasLive[b]) { sum += G[b]; n++; } }
      if (n) { const mean = sum / n; baseline[t] = baseline[t] === undefined ? mean : recipe.baselineDecay * baseline[t] + (1 - recipe.baselineDecay) * mean; }
      const rec = records[t], prob = probs[t], act = actions[t], gScores = trailing ? null : new Float64Array(B * O);
      if (!rec) continue;                                                             // no lane decided: nothing to reverse
      rec.gHeads = heads.map(({ K, D }) => new Float64Array(B * (K + D)));
      for (let b = 0; b < B; b++) {
        if (!wasLive[b]) continue;
        const adv = G[b] - baseline[t];
        for (let h = 0; h < heads.length; h++) {
          const { logProb, entropy: e } = policy.headGradient(rec, h, b, adv, recipe.entropy, 1 / B, rec.gHeads[h]);
          loss -= logProb * adv / B; entropySum += e;
        }
        if (trailing) continue;
        const a = act[b]; loss -= safeLog(prob[b * O + a]) * adv / B;
        for (let k = 0; k < O; k++) gScores[b * O + k] = -((k === a ? 1 : 0) - prob[b * O + k]) * adv / B * inverseScale;
        if (recipe.entropy > 0) {                                                     // d(−H)/dscores = −(1/B)·p_k·(−log p_k − H)·inverseScale, scaled by the bonus weight
          let h = 0; for (let k = 0; k < O; k++) { const pk = prob[b * O + k]; if (pk > 0) h -= pk * Math.log(pk); }
          for (let k = 0; k < O; k++) { const pk = prob[b * O + k]; if (pk > 0) gScores[b * O + k] += recipe.entropy * pk * (Math.log(pk) + h) / B * inverseScale; }
        }
      }
      rec.gScores = gScores;
    }
    policy.zeroGrad();
    let gV = null; for (let t = T - 1; t >= 0; t--) if (records[t]) gV = policy.backward(records[t], ff ? null : gV);   // an undecided step keeps the voltage
    const gradNorm = policy.update(recipe.lr, recipe.gradClip);
    let successes = 0; for (let b = 0; b < B; b++) successes += succeeded[b];
    const trainReturn = epochReturn / B, trainSuccess = successes / B, entropy = decisions ? entropySum / decisions : 0;
    curves.loss.push(loss); curves.trainReturn.push(trainReturn); curves.trainSuccess.push(trainSuccess);
    curves.spikeRate.push(meanSpikeRate(records.filter(Boolean), ticks)); curves.gradNorm.push(gradNorm); curves.entropy.push(entropy);

    const evaluate = (epoch + 1) % recipe.evalEvery === 0 || epoch + 1 === recipe.epochs;
    let metric = best?.metric ?? null;
    if (evaluate) {
      const model = policy.export(), summary = validateGreedy(bundle, model, validation, { tables, selection });
      metric = summary.metric;
      curves.metric.push(metric); evaluations.push({ epoch: epoch + 1, loss, trainReturn, metric, validationMeanReturn: summary.meanReturn, validationSuccessRate: summary.successRate });
      if (!best || metric > best.metric) best = { epoch, model, quantization: policy.quantization(), metric, summary };
    }
    if (run.shouldReport(epoch, evaluate)) run.report({ phase: evaluate ? 'eval' : 'train', epoch: epoch + 1, loss, metric, metricName: selection.name,
      trainReturn, trainSuccess, spikeRate: curves.spikeRate[epoch], gradNorm, selectedEpoch: best ? best.epoch + 1 : null });
    await run.tick();
  }
  run.report({ phase: 'select', epoch: recipe.epochs, loss: curves.loss.at(-1), metric: best.metric, metricName: selection.name, selectedEpoch: best.epoch + 1 });
  return finishResult({ bundle, run, recipe, best, curves, evaluations, validation: best.summary, selection, bundleHash,
    extra: { selection: { epoch: best.epoch + 1, rule: 'greedy integer executor on the validation partition; strict improvement' }, quantization: best.quantization,
      details: { episodesPerEpoch: B, gamma: recipe.gamma, baselineDecay: recipe.baselineDecay, entropy: recipe.entropy, surrogateWidth: recipe.surrogateWidth, gradClip: recipe.gradClip, initCurrent: recipe.initCurrent } } });
}
