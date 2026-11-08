// replay/scene.js — the tank scene of the template, for replays. The page rebuilds the states of an episode from the
// seed and the actions of the events (contract-interface.md `client.replay`), with the same scene functions that the
// script module 坦克对战 of the template calls: `battle({ seed })` and `play(state, a0, a1)`. The rules stay in the
// template. The replay view script of the template draws the states (see ScriptFrame.vue).
import { ModuleGraph } from '../../../frontend/core/graph.js';
import { instantiateInto } from '../../../frontend/core/template.js';
import { builtinTemplate } from '../../../frontend/templates/index.js';
import { scriptCalls } from '../../../frontend/core/script-calls.js';

let cached = null;
/** The scene of the template: `{ battle(seed), play(state, a0, a1), viewScript }`. Built once. */
export function tankScene() {
  if (cached) return cached;
  const template = builtinTemplate('tank-battle');
  const graph = new ModuleGraph();
  const { ids } = instantiateInto(graph, template);
  const calls = scriptCalls(graph, graph.resolved(), ids.vs_battle, { artifacts: () => null });
  cached = {
    battle: seed => calls.call('battle', [{ seed }]),
    play: (state, a0, a1) => calls.call('play', [state, a0, a1]),
    /** The replay view script of the template (the view 回放 of stage 1). */
    viewScript: graph.node(ids.s1_a_replay).config.script,
  };
  return cached;
}

/**
 * The states of one episode: `states[0]` is the start of `seed`, `states[k]` the state after the k-th action pair.
 * `actions` is `[[a0, a1], ...]` as the client gives them (each side's action on its own map).
 */
export function episodeStates(scene, { seed, actions }) {
  const states = [scene.battle(seed)];
  for (const [a0, a1] of actions) {
    const last = states[states.length - 1];
    if (last.end >= 0) break;
    states.push(scene.play(last, a0, a1));
  }
  return states;
}
