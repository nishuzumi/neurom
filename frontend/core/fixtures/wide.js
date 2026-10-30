// core/fixtures/wide.js — a task wider than 256 everywhere (ADR 0021): 1020 input bits, a network layer of 300
// neurons and 300 actions. The agent must give action 297 − count on each of 3 steps. The input is the phase as a
// one-hot of 4 bits, then the count as a one-hot of 1016 bits at 300·count + 7. Cross-entropy trains the network on
// the one-hot target. Tests in JS and the Python parity corpus (training/fixtures/bundle-env.mjs) share it.
import '../kinds/index.js';
import { ModuleGraph } from '../graph.js';
import { parseTemplate, instantiateInto } from '../template.js';

export const WIDE_INPUTS = 1020, WIDE_HIDDEN = 300, WIDE_ACTIONS = 300;

const WIDE_YAML = `
format: neurom-template
id: wide-task
revision: 1
name: wide task
kind: composite
modules:
  target:
    kind: code
    config:
      source: |-
        export function target(state) {
          return oneHot(297 - state.count, ${WIDE_ACTIONS});
        }
  metric:
    kind: code
    config:
      source: |-
        export function metric(episode) {
          return episode.success ? 1 : 0;
        }
  split:
    kind: partition
    config: { kind: enumerate, enumerate: { axes: { phase: [0, 1, 2, 3] }, roles: { training: all, validation: all, test: all } } }
  scene:
    kind: code
    config:
      source: |-
        export const budget = 3;

        export function init(start) {
          return { count: 0, phase: start.phase };
        }
        export function input(state) {
          return concat(oneHot(state.phase, 4), oneHot(state.count * 300 + 7, ${WIDE_INPUTS - 4}));
        }
        export function step(state, action) {
          const right = action === 297 - state.count;
          const next = state.count + 1;
          return { state: { count: next, phase: state.phase }, done: !right || next >= 3, success: right && next >= 3 };
        }
  loop: { kind: loop }
  readout: { kind: readout, config: { mode: argmax, map: [${Array.from({ length: WIDE_ACTIONS }, (_, a) => a).join(', ')}] } }
  net: { kind: network, config: { inputs: ${WIDE_INPUTS}, layers: [{ hidden: ${WIDE_HIDDEN} }], kind: feedforward, ticks: 1, leak_shift: 0, reset: 0 } }
  trainer: { kind: trainer, config: { method: cross-entropy, epochs: 20, evalEvery: 5, lr: 0.05, replicas: 1, episodesPerEpoch: 4, calibrationEpisodes: 4 } }
  evaluator: { kind: evaluator }
wires:
  value:
    - split.training→trainer.training
    - split.validation→trainer.validation
    - split.test→evaluator.partition
    - loop.loop→trainer.loop
    - loop.loop→evaluator.loop
    - loop.input→net.in
    - net.scores→readout.scores
    - readout.action→loop.action
    - net.structure→trainer.structure
  call:
    - scene.module→loop.scenario
    - target→trainer.objective
    - metric→evaluator.metrics
`;

/** A graph holding one wide task. Returns `{ graph, ids }` (ids: template local id → node id). */
export function wideGraph() {
  const graph = new ModuleGraph();
  const { ids } = instantiateInto(graph, parseTemplate(WIDE_YAML), { x: 0, y: 0 });
  return { graph, ids };
}
