// training/hinge.js — threshold-layers training of the trained network of a bundle. Its objective returns the exact
// output bits target(state[, table]) → bits[O].
// The training set is exhaustive and fixed. Each episode of the training partition is rolled out once through its
// loop in lockstep (core/loop.js createLockstep, every other network frozen). The trained network is teacher-forced
// with the target bits as the bits of its readout. Every step that demands the network becomes one (X, Y) row
// (X = its input bits). The rows are in episode order.
// Then the training uses:
//   - full-batch hinge loss (margin from the recipe)
//   - a straight-through estimator (|z| < surrogateWidth) through the step activations
//   - global-norm clip of the mean gradients (gradClip, 0 = off)
//   - Adam
//   - QAT with a scale per layer (training/quantize.js, the weightBits of the network) in the forward pass. So the
//     measured integer layers are the exported ones.
// z is in real units (the integer sum of the layer × its accumulator unit). The training stops early when the
// validation partition is exact. The reported loss is the hinge loss itself, as training/bundle_train.py reports it:
// the mean over rows of Σ_j max(0, margin − t_j·z_j), t = ±1 from the target bit, z the output pre-activation.
import { createLockstep, trainedOf } from '../core/loop.js';
import { episodesOf } from '../core/sessions/common.js';
import { THRESHOLD_FORMAT } from '../runtime/threshold-layers.js';
import { ADAM, rngOf } from './dense-core.js';
import { quantizeRegion } from './quantize.js';
import { Run, selectionOf, validateGreedy, validationEpisodes, finishResult, always } from './run.js';
import { t } from '../i18n.js';

/** Roll every episode out with the teacher. Rows are `{ X: number[], Y: number[] }`, episode by episode. */
function teacherRows(bundle, episodes, tables, I, O) {
  const rows = episodes.map(() => []);
  createLockstep(bundle, { tables }).run(episodes, { decide(x, lanes, y) {
    const results = [];
    for (let b = 0; b < lanes.length; b++) {
      if (!lanes[b]) continue;
      const Y = Array.from(y.subarray(b * O, (b + 1) * O));
      rows[b].push({ X: Array.from(x.subarray(b * I, (b + 1) * I)), Y });
      results[b] = { bits: Y };
    }
    return results;
  } });
  return rows.flat();
}

/** Float shadow layers (real units) with QAT forward. `sizes` = [I, …hidden, O]. Every layer is quantised on its own
 *  (quantize.js, role 'threshold': th = 1 − b stays int16). Nothing is clamped. Clipped biases are counted. */
export class ThresholdNet {
  constructor(sizes, seed, weightBits) {
    const r = rngOf(seed);
    this.weightBits = weightBits; this.t = 0; this.L = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const n = sizes[l + 1], m = sizes[l], W = new Float64Array(n * m), a = Math.sqrt(3 / m);
      for (let k = 0; k < W.length; k++) W[k] = (r() * 2 - 1) * a;
      this.L.push({ n, m, W, b: new Float64Array(n), mW: new Float64Array(n * m), vW: new Float64Array(n * m), mb: new Float64Array(n), vb: new Float64Array(n) });
    }
  }
  /** The QAT integers of every layer (quantizeRegion: W codes, b codes, k, gain, scale, clipped counts). */
  quantized() { return this.L.map(l => quantizeRegion(l.W, l.b, this.weightBits, 'threshold')); }
  /** Activations per layer (acts[0] = input) and pre-activations z per layer in real units, on the integers `q`
   *  (quantized()). The integer sum (Σ W·x)·2^k + b fires when > 0. z = sum / gain. */
  forward(x, q) {
    const acts = [x], zs = []; let h = x;
    for (let l = 0; l < this.L.length; l++) {
      const { n, m } = this.L[l], { W, b, k, gain } = q[l], shift = 2 ** k, z = new Float64Array(n), a = new Uint8Array(n);
      for (let j = 0; j < n; j++) { let s = 0; const row = j * m; for (let i = 0; i < m; i++) if (h[i]) s += W[row + i]; s = s * shift + b[j]; z[j] = s / gain; a[j] = s > 0 ? 1 : 0; }
      zs.push(z); acts.push(a); h = a;
    }
    return { acts, zs };
  }
  /** One full-batch epoch: hinge on the output pre-activations, STE (|z| < width) through hidden steps, global-norm
   *  clip of the mean gradients to `gradClip` (0 = off), Adam. Returns `{ loss, accuracy }`: the mean hinge loss over
   *  the rows and the fraction of rows with every bit right (float). */
  epoch(rows, lr, margin, width, gradClip) {
    const L = this.L, q = this.quantized(), grads = L.map(l => ({ W: new Float64Array(l.n * l.m), b: new Float64Array(l.n) }));
    let correct = 0, loss = 0;
    for (const { X, Y } of rows) {
      const { acts, zs } = this.forward(X, q), out = zs[zs.length - 1];
      let delta = new Float64Array(out.length), ok = true;
      for (let j = 0; j < out.length; j++) { const tgt = Y[j] ? 1 : -1, gap = margin - tgt * out[j]; if (gap > 0) loss += gap; delta[j] = gap > 0 ? -tgt : 0; if ((out[j] > 0 ? 1 : 0) !== Y[j]) ok = false; }
      if (ok) correct++;
      for (let l = L.length - 1; l >= 0; l--) {
        const inp = acts[l], layer = L[l], nd = new Float64Array(layer.m);
        for (let j = 0; j < layer.n; j++) {
          const d = delta[j]; if (!d) continue;
          grads[l].b[j] += d; const row = j * layer.m;
          for (let i = 0; i < layer.m; i++) { if (inp[i]) grads[l].W[row + i] += d; nd[i] += d * layer.W[row + i]; }
        }
        if (l > 0) { const z = zs[l - 1]; for (let i = 0; i < nd.length; i++) if (Math.abs(z[i]) >= width) nd[i] = 0; delta = nd; }
      }
    }
    const N = rows.length;
    let sq = 0; for (const g of grads) for (const v of [g.W, g.b]) for (let k = 0; k < v.length; k++) sq += (v[k] / N) ** 2;
    const norm = Math.sqrt(sq), clip = gradClip > 0 && norm > gradClip ? gradClip / norm : 1;
    this.t++; const { beta1: b1, beta2: b2, eps } = ADAM, tt = this.t, c1 = 1 - b1 ** tt, c2 = 1 - b2 ** tt;
    const adam = (p, g, m, v) => { for (let k = 0; k < p.length; k++) { const gk = g[k] / N * clip; m[k] = b1 * m[k] + (1 - b1) * gk; v[k] = b2 * v[k] + (1 - b2) * gk * gk; p[k] -= lr * (m[k] / c1) / (Math.sqrt(v[k] / c2) + eps); } };
    for (let l = 0; l < L.length; l++) { adam(L[l].W, grads[l].W, L[l].mW, L[l].vW); adam(L[l].b, grads[l].b, L[l].mb, L[l].vb); }
    return N ? { loss: loss / N, accuracy: correct / N } : { loss: 0, accuracy: 0 };
  }
  /** `threshold-layers` and its per-layer quantisation record: W codes, th = 1 − b (int16), the scale and shift k of
   *  the layer. So act = (Σ W·x)·2^k ≥ th ⇔ the QAT sum > 0. */
  export(inputs, outputs) {
    const q = this.quantized();
    const layers = q.map(({ W, b, scale, k }, l) => { const { n, m } = this.L[l]; return { W: Array.from({ length: n }, (_, j) => Array.from(W.subarray(j * m, (j + 1) * m))), th: Array.from(b, v => 1 - v), scale, k }; });
    const quantization = q.map(({ scale, k, clippedWeights, clippedBiases }, l) => ({ region: `layers[${l}]`, scale, k, clippedWeights, clippedBiases }));
    return { model: { format: THRESHOLD_FORMAT, inputs, outputs, weightBits: this.weightBits, layers }, quantization };
  }
}

export async function trainHinge(bundle, { onProgress, isCancelled, tables, bundleHash } = {}) {
  const recipe = bundle.recipe, { structure: net } = trainedOf(bundle.loop), I = net.inputs, O = net.outputs;
  const selection = selectionOf(bundle);
  const run = new Run(recipe.epochs, { onProgress, isCancelled });
  run.report({ phase: 'init', epoch: 0, loss: null, metric: null, metricName: selection.name });
  const data = teacherRows(bundle, episodesOf(bundle.partitions.training), tables, I, O);
  if (!data.length) throw new Error(t('分区没有任何回合'));
  const validation = validationEpisodes(bundle);
  const trainer = new ThresholdNet([I, ...net.layers, O], recipe.seed, net.weightBits);
  await run.tick();

  const curves = { loss: [], metric: [], accuracy: [] }, evaluations = [];
  let best = null, epochsRun = 0;
  for (let epoch = 0; epoch < recipe.epochs; epoch++) {
    const { loss, accuracy: floatAccuracy } = trainer.epoch(data, recipe.lr, recipe.margin, recipe.surrogateWidth, recipe.gradClip); epochsRun = epoch + 1;
    curves.loss.push(loss); curves.accuracy.push(floatAccuracy);
    const evaluate = (epoch + 1) % recipe.evalEvery === 0 || epoch + 1 === recipe.epochs || floatAccuracy === 1;
    let metric = best?.metric ?? null;
    if (evaluate) {
      const { model, quantization } = trainer.export(I, O), summary = validateGreedy(bundle, model, validation, { tables, selection, labelled: always });
      metric = summary.metric;
      curves.metric.push(metric); evaluations.push({ epoch: epoch + 1, floatAccuracy, metric, validationAccuracy: summary.accuracy });
      if (!best || metric > best.metric) best = { epoch, model, quantization, metric, summary, floatAccuracy, loss };
    }
    if (run.shouldReport(epoch, evaluate)) run.report({ phase: evaluate ? 'eval' : 'train', epoch: epoch + 1, loss, metric, metricName: selection.name, accuracy: floatAccuracy, selectedEpoch: best ? best.epoch + 1 : null });
    await run.tick();
    if (!selection.custom && best?.metric === 1) break;                              // exact on the whole validation partition: the finite task is solved
  }
  run.report({ phase: 'select', epoch: epochsRun, loss: best.loss, metric: best.metric, metricName: selection.name, selectedEpoch: best.epoch + 1 });
  return finishResult({ bundle, run, recipe, best, curves, evaluations, validation: best.summary, selection, bundleHash,
    extra: { selection: { epoch: best.epoch + 1, epochsRun, rule: 'exact-bits accuracy of the integer layers on the validation partition; strict improvement; stops early once exact' }, quantization: best.quantization,
      details: { samples: data.length, margin: recipe.margin, surrogateWidth: recipe.surrogateWidth, gradClip: recipe.gradClip, floatAccuracy: best.floatAccuracy } } });
}
