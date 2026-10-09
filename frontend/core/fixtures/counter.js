// core/fixtures/counter.js — a tiny hand-written task used by the core tests: the agent counts up to `target`
// within `budget` steps. Action 0 = stay, 1 = up. Reward 1 per upward move. Success = reached the target. One loop:
// loop.input → net → readout → loop.action, trained by `trainer`, evaluated by `evaluator`, stepped by `execution`.
import '../kinds/index.js';
import { ModuleGraph } from '../graph.js';
import { parseTemplate, instantiateInto } from '../template.js';

export const COUNTER_YAML = `
format: neurom-template
id: counter-task
revision: 1
name: counter game
kind: composite
modules:
  params:
    kind: params
    config:
      fields:
        target: { type: int, min: 1, max: 10, default: 3 }
        budget: { type: int, min: 1, max: 100, default: 5 }
  reward:
    kind: code
    config:
      source: |-
        export function reward(transition) {
          return transition.action > 0 ? 1 : 0;
        }
  steps:
    kind: code
    config:
      source: |-
        export function steps(episode) {
          return episode.steps;
        }
  seeds: { kind: partition }
  scene:
    kind: code
    title: counter scene
    config:
      inputs: [params]
      source: |-
        export const actions = ["stay", "up"];
        export const budget = params.budget;

        export function init(start) {
          return { count: 0, seed: start.seed };
        }
        export function input(state) {
          return thermometer(state.count, [1, 2, 3]);
        }
        export function step(state, action) {
          const next = state.count + action;
          return { state: { count: next, seed: state.seed }, done: next >= params.target, success: next >= params.target };
        }
  loop: { kind: loop }
  readout: { kind: readout, config: { mode: argmax, map: [0, 1] } }
  net: { kind: network, config: { inputs: 3, layers: [{ hidden: 8 }] } }
  trainer: { kind: trainer, config: { method: reinforce, epochs: 10 } }
  cands: { kind: candidates }
  evaluator: { kind: evaluator }
  execution: { kind: execution }
wires:
  value:
    - params.params→scene.params
    - scene.actions→readout.actions
    - loop.input→net.in
    - net.scores→readout.scores
    - readout.action→loop.action
    - loop.loop→trainer.loop
    - loop.loop→evaluator.loop
    - loop.loop→execution.loop
    - seeds.training→trainer.training
    - seeds.validation→trainer.validation
    - seeds.test→evaluator.partition
    - seeds.test→execution.partition
    - net.structure→trainer.structure
    - trainer.run→cands.run
    - cands.weights→net.weights
  call:
    - scene.module→loop.scenario
    - reward→trainer.objective
    - steps→evaluator.metrics
groups:
  box: { title: loop, loop: loop, members: [loop, net, readout] }
`;

/** A graph holding one counter task. Returns `{ graph, ids, group, groupIds }` (ids: template local id → node id). */
export function counterGraph() {
  const graph = new ModuleGraph();
  const { ids, group, groupIds } = instantiateInto(graph, parseTemplate(COUNTER_YAML), { x: 0, y: 0 });
  return { graph, ids, group, groupIds };
}
