// training/dense-core.js — the quantisation-aware dense policy that every dense trainer optimises (FF and LIF share one
// arithmetic). The forward pass runs the exact integer contract of frontend/runtime/dense-policy.js on per-layer codes
// (training/quantize.js, ADR 0015). Every affine map gets its own scale, its own shift k and, for LIF, its own
// threshold. A straight-through estimator goes to float64 shadow parameters in real units that only the optimiser
// sees. So every reported number was measured with the exported integers.
// The forward pass works in the accumulator integers of each layer (W·2^k and b). The STE derivative of one of them
// with respect to its shadow is the `gain` of the region = scale·2^k.
// LIF gradients are full-episode BPTT through the retained membrane voltage. They use a triangular surrogate for the
// spike and STE for the leak floor. FF is the same module with ticks=1, threshold 1, leak_shift=0, and the voltage set
// to zero before every call.
// Tool layers (ADR 0010) run as the engine runs them. Segments of plain layers each run all ticks. A decision head
// comes after each segment (sampled during training, greedy at other times). The `call` of the trainer runs the chosen
// tool. BPTT stays within the same segments. The heads take policy gradients (headGradient). Nothing flows through a tool.
// No scenario content is here. Trainers give observations in and give gradients on the scores and heads back.
import { DENSE_FORMAT, validateDenseModel, callTool, isTool } from '../runtime/dense-policy.js';
import { quantizeRegion } from './quantize.js';
import { t } from '../i18n.js';

export const ADAM = Object.freeze({ beta1: 0.9, beta2: 0.999, eps: 1e-8 });
/** Largest tape (decisions × ticks × episodes × Σ hidden) that one epoch can retain for BPTT. Above this, the run is refused, not silently shrunk. */
const TAPE_BUDGET = 1 << 24;

export function rngOf(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
/** Per-purpose derived seed (salt 0: weights, 1: calibration, 1000+epoch: that epoch's episodes and sampling). */
export function mixSeed(seed, salt) { let h = (seed ^ 0x9e3779b9) >>> 0; h = Math.imul(h ^ (salt + 0x7f4a7c15), 0x85ebca6b) >>> 0; h ^= h >>> 13; return Math.imul(h, 0xc2b2ae35) >>> 0; }

/** softmax(scores[offset..offset+n) · inverseScale) into p[0..n). */
export function softmaxInto(p, scores, offset, n, inverseScale) {
  let max = -Infinity; for (let a = 0; a < n; a++) max = Math.max(max, scores[offset + a]);
  let sum = 0; for (let a = 0; a < n; a++) { const e = Math.exp((scores[offset + a] - max) * inverseScale); p[a] = e; sum += e; }
  for (let a = 0; a < n; a++) p[a] /= sum;
}
/** First index of the maximum in values[offset..offset+n) (ties → lowest), the on-chain argmax. */
export function argmax(values, offset, n) { let best = 0; for (let a = 1; a < n; a++) if (values[offset + a] > values[offset + best]) best = a; return best; }

export function assertTapeBudget(decisions, ticks, episodes, hidden) {
  const tape = decisions * ticks * episodes * hidden;
  if (tape > TAPE_BUDGET) throw new Error(t('训练规模超出浏览器预算：{decisions}×{ticks}×{episodes}×{hidden} = {tape} > {budget}。请减少 replicas、ticks 或 hidden', { decisions, ticks, episodes, hidden, tape, budget: TAPE_BUDGET }));
}

export function meanSpikeRate(records, ticks) {
  let sum = 0, n = 0;
  for (const rec of records) {
    for (const { counts } of rec.layers) {
      const H = counts.length / rec.B;
      for (let b = 0; b < rec.B; b++) { if (rec.mask && !rec.mask[b]) continue; for (let j = 0; j < H; j++) sum += counts[b * H + j]; n += H; }
    }
  }
  return n ? sum / n / ticks : 0;
}

const softplus = v => (v > 0 ? v + Math.log1p(Math.exp(-v)) : Math.log1p(Math.exp(v)));
const LOG_FLOOR = 1e-300;                                           // keeps log(p) finite for p = 0
export function safeLog(p) { return Math.log(p + LOG_FLOOR); }

export class QatPolicy {
  /** `structure` is the structure of the trained network (bundle.loop: {kind, inputs, layers, outputs, weightBits,
   *  ticks, leak_shift, reset}). `layers` holds plain layers `{ hidden }` and tool layers `{ tools, K, D, R }` (ADR 0010).
   *  Parameters are float64 tensors in blob order, in layer order: W | b of every plain layer and Wc | bc | Wd | bd of
   *  the decision head of every tool layer. Then W | b of the output layer come, unless the last layer is a tool layer.
   *  `regions` lists them as the quantiser sees them (W key, role, record name) with their current quantisation.
   *  Tool layers cut the network into segments (runs of plain layers) exactly as the engine does.
   *  `segments[s] = { width, layers, head }`: the width of its input bits (the observation, or `result ‖ the layer
   *  before` after a tool layer), its plain layers, and the head after it (null: the output layer).
   *  The voltages of B lanes are one Float64Array[B·state] (state = Σ hidden), layer after layer. The block of plain
   *  layer l starts at B·Σ_{m<l} H_m. */
  constructor(structure, surrogateWidth) {
    this.kind = structure.kind; this.inputs = structure.inputs; this.outputs = structure.outputs; this.weightBits = structure.weightBits;
    const ff = structure.kind === 'feedforward';
    this.ticks = ff ? 1 : structure.ticks; this.shift = ff ? 0 : structure.leak_shift; this.reset = ff ? 0 : structure.reset;
    this.leakKeep = 1 - 1 / (1 << this.shift);
    this.surrogateWidth = surrogateWidth;
    const sizes = [];
    this.plain = []; this.heads = []; this.order = []; this.segments = []; this.regions = []; this.state = 0;
    let seg = { width: this.inputs, layers: [], head: null };
    this.segments.push(seg);
    for (const [l, layer] of structure.layers.entries()) {
      const fanIn = seg.layers.length ? this.plain[seg.layers[seg.layers.length - 1]].H : seg.width;
      if (isTool(layer)) {
        // the head reads the segment's last layer's spike counts, biases × ticks, or (empty segment) its input bits
        const { K, D, R } = layer, factor = seg.layers.length ? this.ticks : 1;
        seg.head = this.heads.length; this.order.push({ head: seg.head });
        const head = { tools: layer.tools, K, D, R, fanIn, factor, key: sizes.length };
        this.heads.push(head);
        this.regions.push({ key: sizes.length, role: 'ff', name: `layers[${l}].choice` }, { key: sizes.length + 2, role: 'ff', name: `layers[${l}].data` });
        sizes.push(K * fanIn, K, D * fanIn, D);
        seg = { width: R + fanIn, layers: [], head: null };
        this.segments.push(seg);
      } else {
        seg.layers.push(this.plain.length); this.order.push({ plain: this.plain.length });
        this.regions.push({ key: sizes.length, role: ff ? 'ff' : 'lif', name: `layers[${l}]` });
        this.plain.push({ H: layer.hidden, fanIn, offset: this.state, key: sizes.length });
        this.state += layer.hidden; sizes.push(layer.hidden * fanIn, layer.hidden);
      }
    }
    this.trailing = isTool(structure.layers[structure.layers.length - 1]);   // its result bits are the output: no output layer
    if (this.trailing) this.segments.pop();
    else {
      this.outFanIn = this.plain[this.plain.length - 1].H; this.outKey = sizes.length;
      this.regions.push({ key: sizes.length, role: 'ff', name: 'output' });
      sizes.push(this.outputs * this.outFanIn, this.outputs);
    }
    this.widths = this.plain.map(L => L.H);
    const bank = () => sizes.map(size => new Float64Array(size));
    this.p = bank(); this.g = bank(); this.m = bank(); this.v = bank(); this.q = bank();
    this.step = 0;
    this.active = new Int32Array(Math.max(1, ...this.widths, ...this.segments.map(s => s.width)));   // scratch: indices of set bits
    this.first = new Float64Array(Math.max(1, ...this.widths));                                          // scratch: a segment's first-layer currents
    this.pChoice = new Float64Array(Math.max(1, ...this.heads.map(h => h.K)));                          // scratch: a head's choice probabilities
  }
  /** 1 / (ticks · gain of the output layer): integer scores → real-unit logits of the readout softmax. */
  get inverseScale() { return 1 / (this.ticks * this.gainOf(this.outKey)); }
  /** The current gain (scale·2^k) of the region whose W is parameter `key`. */
  gainOf(key) { return this.unit[key].gain; }
  /** Uniform(±√(3/fanIn)) weights and zero biases for every plain layer, every decision head (Wc, Wd) and the output
   *  layer. A head starts with logits of the same order of magnitude as the readout. So its first choices and data bits
   *  are spread, not decided. */
  init(rng) {
    const uniform = (W, fanIn) => { const a = Math.sqrt(3 / fanIn); for (let k = 0; k < W.length; k++) W[k] = (rng() * 2 - 1) * a; };
    for (const e of this.order) {
      if (e.plain !== undefined) { const L = this.plain[e.plain]; uniform(this.p[L.key], L.fanIn); this.p[L.key + 1].fill(0); continue; }
      const h = this.heads[e.head];
      uniform(this.p[h.key], h.fanIn); this.p[h.key + 1].fill(0); uniform(this.p[h.key + 2], h.fanIn); this.p[h.key + 3].fill(0);
    }
    if (!this.trailing) { uniform(this.p[this.outKey], this.outFanIn); this.p[this.outKey + 1].fill(0); }
    this.quantize();
  }
  /** Set the bias of each plain layer so that the median current of each neuron over `X` (N observations) is at
   *  initCurrent·threshold (FF: one accumulator unit. LIF: the threshold of the layer, 1.0 real). So no neuron is silent
   *  at init. Each layer gets what it sees on each observation from rest. That is the observation (first layer), the
   *  spike rates (counts / ticks) of the calibrated layer before it, or the `result ‖ layer before` bits (first layer
   *  after a tool layer). For these bits, the heads decide through `tools` (see decide). Head biases stay 0. */
  calibrateBias(X, N, initCurrent, tools = null) {
    const currents = new Float64Array(N);
    this.segments.forEach((seg, s) => seg.layers.forEach((l, i) => {
      const L = this.plain[l], { H, fanIn, key } = L, W = this.q[key];
      let input = X, rate = 1;
      if (s || i) {
        const rec = this.decide(N, X, new Float64Array(N * this.state), null, tools);
        if (i) { input = rec.layers[l - 1].counts; rate = 1 / this.ticks; } else input = rec.inputs[s];
      }
      for (let j = 0; j < H; j++) {
        for (let n = 0; n < N; n++) { let c = 0; const row = j * fanIn, base = n * fanIn; for (let k = 0; k < fanIn; k++) c += W[row + k] * input[base + k]; currents[n] = c * rate; }
        currents.sort();
        const median = N ? currents[Math.floor((N - 1) / 2)] : 0;
        this.p[key + 1][j] = (initCurrent * L.threshold - median) / L.gain;
      }
      this.quantize();
    }));
  }
  /** Quantise every region from its shadows (quantize.js). q holds the accumulator integers W·2^k and b. Each plain
   *  layer gets its fire threshold (FF 1, LIF 1.0 real), gain and surrogate half-width (FF surrogateWidth·gain, LIF
   *  surrogateWidth·threshold). Each head gets its sampling scales 1 / (factor·gain) per region. */
  quantize() {
    this.unit = {};
    for (const region of this.regions) {
      const { key, role } = region, r = quantizeRegion(this.p[key], this.p[key + 1], this.weightBits, role), shift = 2 ** r.k, q = this.q[key];
      for (let i = 0; i < q.length; i++) q[i] = r.W[i] * shift;
      this.q[key + 1].set(r.b);
      this.unit[key] = r;
    }
    for (const L of this.plain) {
      const r = this.unit[L.key];
      L.gain = r.gain; L.threshold = r.threshold ?? 1; L.width = this.surrogateWidth * (r.threshold ?? r.gain);
    }
    for (const h of this.heads) { h.invC = 1 / (h.factor * this.unit[h.key].gain); h.invD = 1 / (h.factor * this.unit[h.key + 2].gain); }
  }
  /** The quantisation record of the current integers, one entry per region in blob order (training result
   *  `evaluation.quantization`): `{ region, scale, k, threshold? (LIF), clippedWeights, clippedBiases }`. */
  quantization() {
    return this.regions.map(({ key, name }) => {
      const { scale, k, threshold, clippedWeights, clippedBiases } = this.unit[key];
      return { region: name, scale, k, ...(threshold === null ? {} : { threshold }), clippedWeights, clippedBiases };
    });
  }
  /** One decision for B episodes. X: Uint8Array[B·inputs]. V: Float64Array[B·state] integer voltages, updated in place.
   *  `mask` (Uint8Array[B], optional): lanes where the network runs this step. The other lanes keep their voltage and score 0.
   *  Each segment runs all ticks and passes the spikes of each tick from layer to layer. Then its tool layer decides on
   *  its logits. It runs the chosen tool through `tools.call(port, choice, data, b) → bits` (runtime callTool. The call
   *  advances the tool states of lane b). When `tools.rng` is set, the choice is sampled from softmax(logits·invC) and
   *  each data bit from sigmoid(logit·invD) (1 / (factor·gain) of the choice / data region of the head). If not, the
   *  decision is greedy as in the engine (first maximum, logit > 0). The scores of a trailing tool layer are +1 / −1 per
   *  result bit.
   *  Returns a tape record. `decisions[h]` = { logits[B·(K+D)], choice[B], data[B·D], result[B·R] } per tool layer. */
  decide(B, X, V, mask = null, tools = null) {
    const { outputs: O, ticks, shift, reset, plain, heads, segments, q, active, first } = this, divisor = 1 << shift, rng = tools?.rng ?? null;
    const layers = plain.map(({ H }) => ({ counts: new Float64Array(B * H), preSpike: new Float64Array(ticks * B * H), fired: new Uint8Array(ticks * B * H) }));
    const inputs = segments.map((seg, s) => (s ? new Uint8Array(B * seg.width) : X));
    const decisions = heads.map(({ K, D, R }) => ({ logits: new Float64Array(B * (K + D)), choice: new Int32Array(B), data: new Uint8Array(B * D), result: new Uint8Array(B * R) }));
    const scores = new Float64Array(B * O);
    for (let b = 0; b < B; b++) {
      if (mask && !mask[b]) continue;
      for (let s = 0; s < segments.length; s++) {
        const seg = segments[s], x = inputs[s], xBase = b * seg.width, n = seg.layers.length;
        if (n) {
          const L0 = plain[seg.layers[0]], W0 = q[L0.key], b0 = q[L0.key + 1];
          let m = 0; for (let i = 0; i < seg.width; i++) if (x[xBase + i]) active[m++] = i;   // input bits are sparse: sum only set inputs (same ascending order)
          for (let j = 0; j < L0.H; j++) { let c = b0[j]; const row = j * seg.width; for (let k = 0; k < m; k++) c += W0[row + active[k]]; first[j] = c; }
          for (let t = 0; t < ticks; t++) {
            for (let i = 0; i < n; i++) {
              const l = seg.layers[i], { H, fanIn, offset, key, threshold } = plain[l], { counts, preSpike, fired } = layers[l], vBase = B * offset + b * H, W = q[key], bias = q[key + 1];
              let spikes = 0;
              if (i) { const before = layers[l - 1].fired, base = (t * B + b) * fanIn; for (let k = 0; k < fanIn; k++) if (before[base + k]) active[spikes++] = k; }
              for (let j = 0; j < H; j++) {
                let c = first[j];
                if (i) { c = bias[j]; const row = j * fanIn; for (let k = 0; k < spikes; k++) c += W[row + active[k]]; }
                const idx = vBase + j;
                let v = V[idx];
                v = v - Math.floor(v / divisor) + c;
                const slot = (t * B + b) * H + j; preSpike[slot] = v;
                if (v >= threshold) { fired[slot] = 1; counts[b * H + j]++; v = reset; }
                V[idx] = v;
              }
            }
          }
        }
        if (seg.head === null) continue;
        const h = heads[seg.head], rec = decisions[seg.head], { K, D, R, fanIn, factor, key, invC, invD } = h;
        const prev = n ? layers[seg.layers[n - 1]].counts : x, pBase = n ? b * fanIn : xBase;
        const z = rec.logits, zBase = b * (K + D), Wc = q[key], bc = q[key + 1], Wd = q[key + 2], bd = q[key + 3];
        for (let k = 0; k < K; k++) { let c = factor * bc[k]; const row = k * fanIn; for (let i = 0; i < fanIn; i++) c += Wc[row + i] * prev[pBase + i]; z[zBase + k] = c; }
        for (let d = 0; d < D; d++) { let c = factor * bd[d]; const row = d * fanIn; for (let i = 0; i < fanIn; i++) c += Wd[row + i] * prev[pBase + i]; z[zBase + K + d] = c; }
        let choice = argmax(z, zBase, K);
        if (rng) { const p = this.pChoice; softmaxInto(p, z, zBase, K, invC); let u = rng(); choice = K - 1; for (let k = 0; k < K; k++) { u -= p[k]; if (u < 0) { choice = k; break; } } }
        const data = new Array(D);
        for (let d = 0; d < D; d++) data[d] = rng ? (rng() < 1 / (1 + Math.exp(-z[zBase + K + d] * invD)) ? 1 : 0) : (z[zBase + K + d] > 0 ? 1 : 0);
        const result = callTool(h, tools?.call ?? null, choice, data, b);
        rec.choice[b] = choice; rec.data.set(data, b * D); rec.result.set(result, b * R);
        if (s + 1 < segments.length) {
          const next = inputs[s + 1], nBase = b * segments[s + 1].width;
          for (let k = 0; k < R; k++) next[nBase + k] = result[k];
          for (let i = 0; i < fanIn; i++) next[nBase + R + i] = prev[pBase + i] > 0 ? 1 : 0;   // LIF: fired at least once. FF: the activations
        } else for (let k = 0; k < R; k++) scores[b * O + k] = result[k] ? 1 : -1;
      }
      if (this.trailing) continue;
      const H = this.outFanIn, counts = layers[layers.length - 1].counts, Wo = q[this.outKey], bo = q[this.outKey + 1];
      for (let a = 0; a < O; a++) { let s = ticks * bo[a]; const row = a * H, cBase = b * H; for (let j = 0; j < H; j++) s += Wo[row + j] * counts[cBase + j]; scores[b * O + a] = s; }
    }
    return { B, X, inputs, layers, decisions, scores, mask, gScores: null, gHeads: null };
  }
  /** Policy gradient of the decisions of tool layer `h` on lane `b` of `rec`. Writes dLoss/dlogits of
   *  loss = (−adv·log π(choice, data) − bonus·H(π))·weight into gz[b·(K+D)..]. H is the softmax entropy of the choice
   *  plus the Bernoulli entropy of each data bit. Returns `{ logProb, entropy }` of the decisions of the lane. */
  headGradient(rec, h, b, adv, bonus, weight, gz) {
    const { K, D, invC, invD } = this.heads[h], d = rec.decisions[h], z = d.logits, zBase = b * (K + D), p = this.pChoice, a = d.choice[b];
    softmaxInto(p, z, zBase, K, invC);
    let entropy = 0; for (let k = 0; k < K; k++) if (p[k] > 0) entropy -= p[k] * Math.log(p[k]);
    let logProb = safeLog(p[a]);
    for (let k = 0; k < K; k++) gz[zBase + k] = (-((k === a ? 1 : 0) - p[k]) * adv + (p[k] > 0 ? bonus * p[k] * (Math.log(p[k]) + entropy) : 0)) * weight * invC;
    for (let j = 0; j < D; j++) {
      const u = z[zBase + K + j] * invD, sigma = 1 / (1 + Math.exp(-u)), bit = d.data[b * D + j];
      logProb -= bit ? softplus(-u) : softplus(u);
      entropy += sigma * softplus(-u) + (1 - sigma) * softplus(u);
      gz[zBase + K + j] = (-(bit - sigma) * adv + bonus * sigma * (1 - sigma) * u) * weight * invD;
    }
    return { logProb, entropy };
  }
  /** Reverse one decision. rec.gScores: dLoss/dscores [B·O] (null: none, for example a trailing tool layer).
   *  rec.gHeads[h]: dLoss/dlogits [B·(K+D)] of tool layer h (null: none). gVNext: dLoss/d(voltage after this decision)
   *  or null. Segments reverse last to first. Nothing flows through a tool (its result bits are constants of the input
   *  of the next segment). The `layer before` bits that it gives on pass their gradient straight through to the spike
   *  counts of that layer. The gradient of every integer reaches its shadow × the gain of its region (STE).
   *  Returns dLoss/d(voltage before). */
  backward(rec, gVNext) {
    const { outputs: O, ticks, reset, leakKeep, plain, heads, segments, q, g, active } = this;
    const { B, inputs, layers, mask, gScores, gHeads } = rec;
    const gVIn = new Float64Array(B * this.state);
    // per lane: dLoss/d(spike at tick t) handed down, dLoss/d(current at tick t), dLoss/d(count) of a segment's last layer, dLoss/d(segment input)
    const gFire = plain.map(({ H }) => new Float64Array(ticks * H)), gTick = plain.map(({ H }) => new Float64Array(ticks * H));
    const gCount = plain.map(({ H }) => new Float64Array(H)), gIn = segments.map(seg => new Float64Array(seg.width)), gFirst = new Float64Array(this.first.length);
    for (let b = 0; b < B; b++) {
      if (mask && !mask[b]) {                                                    // the network did not run: its voltage passes through
        if (gVNext) for (const { H, offset } of plain) { const base = B * offset + b * H; for (let j = 0; j < H; j++) gVIn[base + j] = gVNext[base + j]; }
        continue;
      }
      for (const a of gIn) a.fill(0);
      for (let s = segments.length - 1; s >= 0; s--) {
        const seg = segments[s], n = seg.layers.length, x = inputs[s], xBase = b * seg.width;
        const gPrev = n ? gCount[seg.layers[n - 1]] : gIn[s];                    // what the output layer / head reads
        if (n) gPrev.fill(0);
        if (seg.head === null) {
          if (gScores) {
            const H = this.outFanIn, counts = layers[layers.length - 1].counts, Wo = q[this.outKey], gWo = g[this.outKey], gbo = g[this.outKey + 1], gain = this.gainOf(this.outKey);
            for (let a = 0; a < O; a++) {
              const gs = gScores[b * O + a]; if (gs === 0) continue;
              gbo[a] += ticks * gs * gain;
              const row = a * H, cBase = b * H;
              for (let j = 0; j < H; j++) { gWo[row + j] += gs * counts[cBase + j] * gain; gPrev[j] += gs * Wo[row + j]; }
            }
          }
        } else {
          const { K, D, R, fanIn, factor, key } = heads[seg.head], gz = gHeads?.[seg.head], zBase = b * (K + D);
          const prev = n ? layers[seg.layers[n - 1]].counts : x, pBase = n ? b * fanIn : xBase;
          if (gz) for (let r = 0; r < K + D; r++) {
            const gr = gz[zBase + r]; if (gr === 0) continue;
            const wKey = r < K ? key : key + 2, row = (r < K ? r : r - K) * fanIn, W = q[wKey], gW = g[wKey], gain = this.gainOf(wKey);
            g[wKey + 1][r < K ? r : r - K] += factor * gr * gain;
            for (let i = 0; i < fanIn; i++) { gW[row + i] += gr * prev[pBase + i] * gain; gPrev[i] += gr * W[row + i]; }
          }
          if (s + 1 < segments.length) { const gn = gIn[s + 1]; for (let i = 0; i < fanIn; i++) gPrev[i] += gn[R + i]; }
        }
        if (!n) continue;                                                        // an empty segment: gIn[s] is what its head read
        for (let i = n - 1; i >= 0; i--) {
          const l = seg.layers[i], { H, offset, threshold, width } = plain[l], { preSpike, fired } = layers[l], vBase = B * offset + b * H, last = i === n - 1, fire = gFire[l], tick = gTick[l];
          for (let j = 0; j < H; j++) {
            const k = vBase + j; let gV = gVNext ? gVNext[k] : 0, gI = 0; const gc = last ? gPrev[j] : 0;
            for (let t = ticks - 1; t >= 0; t--) {
              const slot = (t * B + b) * H + j, vp = preSpike[slot], f = fired[slot];
              const gf = (last ? gc : fire[t * H + j]) + gV * (reset - vp);       // count += f. V_next = V'(1−f) + reset·f (full BPTT through the hard reset)
              const distance = Math.abs(vp - threshold) / width, surrogate = distance < 1 ? (1 - distance) / width : 0;
              const gVp = gV * (1 - f) + gf * surrogate;                           // V' = V − floor(V/2^s) + I. STE through floor
              if (i) tick[t * H + j] = gVp; else gI += gVp;
              gV = gVp * leakKeep;
            }
            gVIn[k] = gV; if (!i) gFirst[j] = gI;
          }
          if (!i) continue;
          // current_l(t) = b + W·spikes_{l−1}(t): weight gradients and the spike gradient handed to the layer below
          const { fanIn, key, gain } = plain[l], W = q[key], gW = g[key], gb = g[key + 1], below = layers[l - 1].fired, into = gFire[l - 1];
          into.fill(0);
          for (let t = 0; t < ticks; t++) {
            const base = (t * B + b) * fanIn; let m = 0; for (let k = 0; k < fanIn; k++) if (below[base + k]) active[m++] = k;
            for (let j = 0; j < H; j++) {
              const gc = tick[t * H + j]; if (gc === 0) continue;
              const gs = gc * gain, row = j * fanIn; gb[j] += gs;
              for (let k = 0; k < m; k++) gW[row + active[k]] += gs;
              for (let k = 0; k < fanIn; k++) into[t * fanIn + k] += gc * W[row + k];
            }
          }
        }
        // the first layer of the segment: current = b + W·x, constant over the ticks. After a tool layer, the gradient of x goes on
        const L0 = plain[seg.layers[0]], W0 = q[L0.key], gW0 = g[L0.key], gb0 = g[L0.key + 1], wIn = seg.width, gx = s ? gIn[s] : null, gain0 = L0.gain;
        let m = 0; for (let i = 0; i < wIn; i++) if (x[xBase + i]) active[m++] = i;
        for (let j = 0; j < L0.H; j++) {
          const gc = gFirst[j]; if (gc === 0) continue;
          const gs = gc * gain0, row = j * wIn; gb0[j] += gs;
          for (let k = 0; k < m; k++) gW0[row + active[k]] += gs;
          if (gx) for (let i = 0; i < wIn; i++) gx[i] += gc * W0[row + i];
        }
      }
    }
    return gVIn;
  }
  zeroGrad() { for (const g of this.g) g.fill(0); }
  /** Global-norm clip, Adam step, requantise (no clamp: every layer's scale follows its weights). Returns the pre-clip gradient norm. */
  update(lr, gradClip) {
    let sq = 0; for (const g of this.g) for (let k = 0; k < g.length; k++) sq += g[k] * g[k];
    const norm = Math.sqrt(sq), factor = gradClip > 0 && norm > gradClip ? gradClip / norm : 1;
    this.step++; const t = this.step, c1 = 1 - ADAM.beta1 ** t, c2 = 1 - ADAM.beta2 ** t;
    for (let key = 0; key < this.p.length; key++) {
      const p = this.p[key], g = this.g[key], m = this.m[key], v = this.v[key];
      for (let k = 0; k < p.length; k++) {
        const gk = g[k] * factor;
        m[k] = ADAM.beta1 * m[k] + (1 - ADAM.beta1) * gk; v[k] = ADAM.beta2 * v[k] + (1 - ADAM.beta2) * gk * gk;
        p[k] -= lr * (m[k] / c1) / (Math.sqrt(v[k] / c2) + ADAM.eps);
      }
    }
    this.quantize();
    return norm;
  }
  /** The integer model (`dense-policy`, no task fields) that the chain and frontend/runtime/dense-policy.js run: the
   *  codes, int16 biases, scale and k of each region (and the threshold of a LIF layer) as quantised now. */
  export() {
    const rows = (flat, n, cols) => Array.from({ length: n }, (_, r) => Array.from(flat.subarray(r * cols, (r + 1) * cols)));
    const region = (key, n, cols) => { const u = this.unit[key]; return { W: rows(u.W, n, cols), b: Array.from(u.b), scale: u.scale, k: u.k }; };
    const layers = this.order.map(e => {
      if (e.plain !== undefined) {
        const { H, fanIn, key } = this.plain[e.plain], threshold = this.unit[key].threshold;
        return { hidden: H, ...region(key, H, fanIn), ...(threshold === null ? {} : { threshold }) };
      }
      const { tools, K, D, R, fanIn, key } = this.heads[e.head], c = region(key, K, fanIn), d = region(key + 2, D, fanIn);
      return { tools, K, D, R, Wc: c.W, bc: c.b, scale_c: c.scale, k_c: c.k, Wd: d.W, bd: d.b, scale_d: d.scale, k_d: d.k };
    });
    return validateDenseModel({ format: DENSE_FORMAT, kind: this.kind, inputs: this.inputs, outputs: this.outputs, weightBits: this.weightBits,
      leak_shift: this.shift, ticks: this.ticks, reset: this.reset,
      layers, ...(this.trailing ? {} : { output: region(this.outKey, this.outputs, this.outFanIn) }) });
  }
}
