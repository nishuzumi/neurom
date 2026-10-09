// training/run.js — what every bundle trainer shares:
//   - the cooperative scheduler (bounded progress, cancellation)
//   - episode sources over bundle partitions
//   - the selection program
//   - greedy validation through the lockstep runner (core/loop.js runEpisodes) on the integer engines. So the
//     validation measures the exported model exactly as it will run, inside its loop.
import { runEpisodes, trainedOf } from '../core/loop.js';
import { episodeType } from '../core/kinds/scenario.js';
import { compileEntry, episodesOf } from '../core/sessions/common.js';
import { t } from '../i18n.js';

const PROGRESS_POINTS = 400, CURVE_POINTS = 256;
const YIELD_EVERY_MS = 40;                                          // a trainer yields to the event loop this often
const VALIDATION_SEEDS = 64;                                        // seed partitions validate on this many episodes when none is wired

export function abortError() { const error = new Error(t('训练已取消')); error.name = 'AbortError'; return error; }
function subsample(values) { if (values.length <= CURVE_POINTS) return values; const step = values.length / CURVE_POINTS; return Array.from({ length: CURVE_POINTS }, (_, i) => values[Math.floor(i * step)]); }

/** Cooperative scheduler hooks shared by every method: bounded progress messages and cancellation. */
export class Run {
  constructor(epochs, { onProgress = () => {}, isCancelled = () => false } = {}) {
    this.onProgress = onProgress; this.isCancelled = isCancelled;
    this.started = performance.now(); this.startedAt = new Date().toISOString(); this.lastYield = this.started; this.epochs = epochs;
    this.stride = Math.max(1, Math.floor(epochs / PROGRESS_POINTS));
  }
  elapsed() { return Math.round(performance.now() - this.started); }
  report(progress) { this.onProgress({ epochs: this.epochs, elapsed: this.elapsed(), ...progress }); }
  shouldReport(epoch, evaluated) { return evaluated || epoch === 0 || (epoch + 1) % this.stride === 0 || epoch + 1 === this.epochs; }
  async tick() {
    if (this.isCancelled()) throw abortError();
    const now = performance.now();
    if (now - this.lastYield > YIELD_EVERY_MS) { this.lastYield = now; await new Promise(resolve => setTimeout(resolve, 0)); if (this.isCancelled()) throw abortError(); }
  }
}

// ───────────────────────────── episode sources over bundle partitions ─────────────────────────────
/** Draw `n` episodes with `rng` from a partition: seed partitions sample the seed range directly, the others sample
 *  their enumerated episodes uniformly. */
export function drawEpisodes(partition, n, rng) {
  if (partition.kind === 'seed') return Array.from({ length: n }, () => ({ seed: partition.seed + Math.floor(rng() * partition.count) }));
  const all = episodesOf(partition);
  if (!all.length) throw new Error(t('分区没有任何回合'));
  return Array.from({ length: n }, () => all[Math.floor(rng() * all.length)]);
}
/** The training episodes of one epoch. Seed partitions draw episodesPerEpoch × replicas fresh seeds. Enumerate / window
 *  partitions replay every episode × replicas (a balanced epoch). */
export function epochEpisodes(partition, recipe, rng) {
  if (partition.kind === 'seed') return drawEpisodes(partition, epochSize(partition, recipe), rng);
  const all = episodesOf(partition);
  if (!all.length) throw new Error(t('分区没有任何回合'));
  const out = [];
  for (let r = 0; r < recipe.replicas; r++) out.push(...all);
  return out;
}
/** The number of episodes epochEpisodes returns for `partition`. */
export function epochSize(partition, recipe) {
  if (partition.kind === 'seed') return recipe.episodesPerEpoch * recipe.replicas;
  const n = episodesOf(partition).length;
  if (!n) throw new Error(t('分区没有任何回合'));
  return n * recipe.replicas;
}
/** The validation partition, or the training partition when none is wired (seed partitions capped at VALIDATION_SEEDS). */
export function validationEpisodes(bundle) {
  if (bundle.partitions.validation) return episodesOf(bundle.partitions.validation);
  const training = bundle.partitions.training;
  return episodesOf(training.kind === 'seed' ? { ...training, count: Math.min(training.count, VALIDATION_SEEDS) } : training);
}

// ───────────────────────────── selection ─────────────────────────────
/** Selection metric over Episode summaries: the bundle's `selection` program, else the method default. */
export function selectionOf(bundle) {
  if (bundle.selection) return { name: 'validationMetric', fn: compileEntry(bundle.selection, [episodeType(bundle.env.types.State)], 'metric'), custom: true };
  return bundle.objective.kind === 'reward' ? { name: 'validationMeanReturn', fn: null, custom: false } : { name: 'validationAccuracy', fn: null, custom: false };
}

/**
 * Greedy validation of `model` as the trained network, every other network frozen (core/loop.js runEpisodes). A target
 * objective counts accuracy on the steps where the trained network ran. It compares against the target read on the
 * state before the step. `labelled(mask)` decides which of those steps count (hinge: all. cross-entropy: any bit set).
 * A reward objective sums returns. Returns `{ episodes, meanReturn, successRate, meanSteps, accuracy, labelledSteps, metric }`.
 */
export function validateGreedy(bundle, model, episodes, { tables, selection, labelled = anySet } = {}) {
  const { id, readout, readoutId: R } = trainedOf(bundle.loop), target = bundle.objective?.kind === 'target';
  let correct = 0, labelledSteps = 0;
  const onStep = target ? steps => {
    for (const step of steps) {
      if (!step?.target || !labelled(step.target)) continue;
      labelledSteps++;
      const mask = step.target, bits = step.values[`${R}.bits`];
      if (readout.mode === 'argmax' ? mask[bits.indexOf(1)] === 1 : sameBits(mask, bits)) correct++;
    }
  } : null;
  const results = runEpisodes(bundle, { models: { [id]: model }, episodes, tables, onStep });
  const n = results.length, sum = f => results.reduce((s, r) => s + f(r), 0);
  const summary = { episodes: n, meanReturn: n ? sum(r => r.return) / n : 0, successRate: n ? sum(r => (r.success ? 1 : 0)) / n : 0, meanSteps: n ? sum(r => r.steps) / n : 0,
    accuracy: target ? (labelledSteps ? correct / labelledSteps : 0) : null, labelledSteps: target ? labelledSteps : null };
  summary.metric = selection?.fn ? (n ? sum(r => selection.fn({ initial: r.initial, final: r.final, steps: r.steps, success: r.success, return: r.return })) / n : 0) : target ? summary.accuracy : summary.meanReturn;
  return summary;
}
export const anySet = mask => { for (let k = 0; k < mask.length; k++) if (mask[k]) return true; return false; };
export const always = () => true;
function sameBits(a, b) { for (let k = 0; k < a.length; k++) if ((a[k] ? 1 : 0) !== (b[k] ? 1 : 0)) return false; return true; }

/** Shared result assembly. */
export function finishResult({ bundle, run, recipe, best, curves, evaluations, validation, selection, bundleHash, extra = {} }) {
  const evaluation = { metricName: selection.name, metric: best.metric, selectedEpoch: best.epoch + 1,
    curves: Object.fromEntries(Object.entries(curves).map(([key, values]) => [key, subsample(values)])), evaluations: subsample(evaluations), validation, ...extra };
  const provenance = { method: recipe.method, backend: 'browser', seed: recipe.seed, epochs: recipe.epochs, bundleHash, recipe: { ...recipe }, startedAt: run.startedAt, durationMs: run.elapsed(),
    optimizer: 'Adam(β=0.9,0.999, ε=1e-8)', quantization: 'QAT from step 0: forward on integer weights, straight-through estimator; exported integers are the evaluated weights',
    partitions: { training: bundle.partitions.training, validation: bundle.partitions.validation ?? null } };
  return { model: best.model, evaluation, provenance };
}
