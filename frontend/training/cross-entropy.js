// training/cross-entropy.js — supervised training of the trained network of a bundle. Its objective is a target mask
// target(state[, table]) → bits[O], taken on the state before each step. Every training episode × replicas runs in
// lockstep (core/loop.js createLockstep). This file decides for the trained network. Every other network runs frozen.
// The behaviour is teacher-forced:
//   - On a labelled step (mask has ≥ 1 bit), the readout receives a uniformly random correct slot with probability
//     1 − exploration. If not, it receives a uniform slot over O.
//   - Unlabelled steps (all-zero mask) receive a uniform random slot and carry no loss.
//   - Steps where the loop does not demand the network have no decision.
// Loss = cross-entropy of softmax(scores/(ticks·gain)) against the normalised mask, on labelled steps only (gain: the
// codes per real unit of the output layer, ADR 0015). LIF gradients are BPTT through the voltage across the whole
// episode. So a target revealed earlier can reach later decisions.
import { createLockstep, trainedOf } from '../core/loop.js';
import { denseStateWidth } from '../runtime/dense-policy.js';
import { QatPolicy, rngOf, mixSeed, softmaxInto, argmax, assertTapeBudget, meanSpikeRate, safeLog } from './dense-core.js';
import { Run, epochEpisodes, epochSize, drawEpisodes, selectionOf, validateGreedy, validationEpisodes, finishResult, anySet } from './run.js';

/**
 * Roll `episodes` out in lockstep with the teacher. Returns per decided step `{X, Y, M, D}` (intercepted input bits,
 * normalised target rows, labelled mask, lanes that ran the network) plus the total labelled steps. `exploration` = 1
 * gives the uniform random calibration policy.
 */
function teacherBatch(lockstep, episodes, rng, exploration, I, O) {
  const B = episodes.length, steps = [];
  let labelled = 0;
  lockstep.run(episodes, { decide(X, D, mask) {
    const Y = new Float64Array(B * O), M = new Uint8Array(B), results = [];
    for (let b = 0; b < B; b++) {
      if (!D[b]) continue;
      let n = 0; for (let k = 0; k < O; k++) if (mask[b * O + k]) n++;
      if (n === 0) { results[b] = { slot: Math.floor(rng() * O) }; continue; }
      M[b] = 1; labelled++;
      for (let k = 0; k < O; k++) Y[b * O + k] = mask[b * O + k] ? 1 / n : 0;
      let choice;
      if (rng() < exploration) choice = Math.floor(rng() * O);
      else { let pick = Math.floor(rng() * n); choice = 0; for (let k = 0; k < O; k++) if (mask[b * O + k]) { if (pick === 0) { choice = k; break; } pick--; } }
      results[b] = { slot: choice };
    }
    steps.push({ X, Y, M, D });
    return results;
  } });
  return { B, steps, labelled };
}

export async function trainCrossEntropy(bundle, { onProgress, isCancelled, tables, bundleHash } = {}) {
  const recipe = bundle.recipe, { structure: net } = trainedOf(bundle.loop), ff = net.kind === 'feedforward';
  const H = denseStateWidth(net), I = net.inputs, O = net.outputs, ticks = ff ? 1 : net.ticks;
  const selection = selectionOf(bundle);
  const training = bundle.partitions.training;
  const B = epochSize(training, recipe);
  assertTapeBudget(bundle.env.budget, ticks, B, H);
  const run = new Run(recipe.epochs, { onProgress, isCancelled });
  run.report({ phase: 'init', epoch: 0, loss: null, metric: null, metricName: selection.name });

  const policy = new QatPolicy(net, recipe.surrogateWidth);
  policy.init(rngOf(mixSeed(recipe.seed, 0)));
  const lockstep = createLockstep(bundle, { tables });
  {
    const rng = rngOf(mixSeed(recipe.seed, 1));
    const calibration = teacherBatch(lockstep, drawEpisodes(training, recipe.calibrationEpisodes, rng), rng, 1, I, O);
    const rows = calibration.steps.flatMap(step => Array.from({ length: calibration.B }, (_, b) => b).filter(b => step.D[b]).map(b => step.X.subarray(b * I, (b + 1) * I)));
    const X = new Uint8Array(rows.length * I); rows.forEach((row, n) => X.set(row, n * I));
    policy.calibrateBias(X, rows.length, recipe.initCurrent);
  }
  await run.tick();
  const validation = validationEpisodes(bundle);

  const curves = { loss: [], metric: [], agreement: [], spikeRate: [], gradNorm: [] }, evaluations = [];
  const p = new Float64Array(O), V = new Float64Array(B * H);
  let best = null;
  for (let epoch = 0; epoch < recipe.epochs; epoch++) {
    const rng = rngOf(mixSeed(recipe.seed, 1000 + epoch));
    const { steps, labelled } = teacherBatch(lockstep, epochEpisodes(training, recipe, rng), rng, recipe.exploration, I, O);
    const records = [], inverseScale = policy.inverseScale; let loss = 0, agree = 0;     // real-unit logits of this epoch's integers
    V.fill(0);
    for (const { X, Y, M, D } of steps) {
      if (ff) V.fill(0);
      const rec = policy.decide(B, X, V, D), gScores = new Float64Array(B * O);
      for (let b = 0; b < B; b++) {
        if (!M[b]) continue;
        softmaxInto(p, rec.scores, b * O, O, inverseScale);
        if (Y[b * O + argmax(rec.scores, b * O, O)] > 0) agree++;
        for (let a = 0; a < O; a++) { const y = Y[b * O + a]; if (y > 0) loss -= y * safeLog(p[a]); gScores[b * O + a] = (p[a] - y) / labelled * inverseScale; }
      }
      rec.gScores = gScores; records.push(rec);
    }
    if (labelled) loss /= labelled;
    policy.zeroGrad();
    let gV = null; for (let t = records.length - 1; t >= 0; t--) gV = policy.backward(records[t], ff ? null : gV);
    const gradNorm = policy.update(recipe.lr, recipe.gradClip);
    const agreement = labelled ? agree / labelled : 0;
    curves.loss.push(loss); curves.agreement.push(agreement); curves.spikeRate.push(meanSpikeRate(records, ticks)); curves.gradNorm.push(gradNorm);

    const evaluate = (epoch + 1) % recipe.evalEvery === 0 || epoch + 1 === recipe.epochs;
    let metric = best?.metric ?? null;
    if (evaluate) {
      const model = policy.export(), summary = validateGreedy(bundle, model, validation, { tables, selection, labelled: anySet });
      metric = summary.metric;
      curves.metric.push(metric); evaluations.push({ epoch: epoch + 1, loss, agreement, metric, validationAccuracy: summary.accuracy, validationSuccessRate: summary.successRate });
      if (!best || metric > best.metric) best = { epoch, model, quantization: policy.quantization(), metric, summary };
    }
    if (run.shouldReport(epoch, evaluate)) run.report({ phase: evaluate ? 'eval' : 'train', epoch: epoch + 1, loss, metric, metricName: selection.name,
      agreement, spikeRate: curves.spikeRate[epoch], gradNorm, selectedEpoch: best ? best.epoch + 1 : null });
    await run.tick();
  }
  run.report({ phase: 'select', epoch: recipe.epochs, loss: curves.loss.at(-1), metric: best.metric, metricName: selection.name, selectedEpoch: best.epoch + 1 });
  return finishResult({ bundle, run, recipe, best, curves, evaluations, validation: best.summary, selection, bundleHash,
    extra: { selection: { epoch: best.epoch + 1, rule: 'greedy integer executor on the validation partition; strict improvement' }, quantization: best.quantization,
      details: { episodesPerEpoch: B, exploration: recipe.exploration, surrogateWidth: recipe.surrogateWidth, gradClip: recipe.gradClip, initCurrent: recipe.initCurrent } } });
}
