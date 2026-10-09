// editor/tool-canvas.js — the tool layers of a network card (ADR 0010 §9), pure over the ModuleGraph. For each tool
// layer, in layer order, it tells which tools the card draws inside its 「工具层 · <port>」 sub-canvas. It also tells
// which tools stay on the outer canvas (shown inside as a label that jumps to them). Presentation only: membership
// comes from the wires, and nothing is stored.

import { toolLayers as declaredLayers } from '../core/kinds/network.js';

/** @typedef {import('./workbench-context').ModuleGraph} ModuleGraph */
/**
 * @typedef {object} ToolUnit
 * @property {string} node      the card's module: the tool itself, or the frozen network of a bits readout tool
 * @property {string|null} readout the bits readout whose `run` is the tool (a frozen network's unit), else null
 * @property {string} tool      the module wired into the tool port (a code module, or that readout)
 */
/**
 * @typedef {object} ToolLayer
 * @property {string} port      the tool port the layer declares
 * @property {ToolUnit[]} inside drawn inside the sub-canvas as full cards, in wire order
 * @property {string[]} outside tools also wired elsewhere, in wire order (the module wired into the port)
 */

/**
 * The tool layers of network `networkId`, in layer order (the first entry of each valid port, and none unless dense).
 * One rule decides what goes inside. A module goes inside when every wire of it goes into this network's tool port
 * `port`. A frozen network with its bits readout also goes inside as one unit. The readout's wires must be its
 * `scores` from that network and its `run` into `port`. The network's only wires must feed that readout. Any other
 * tool stays outside. `drawn(id)` says whether a module can be drawn inside at all (the editor: not held in a
 * collapsed group). A module that it rejects stays outside.
 * @param {ModuleGraph} graph
 * @param {string} networkId
 * @param {(id: string) => boolean} [drawn]
 * @returns {ToolLayer[]}
 */
export function toolLayers(graph, networkId, drawn = () => true) {
  const net = graph.node(networkId);
  if (net.kind !== 'network') return [];
  const into = (/** @type {string} */ port) => (/** @type {import('./workbench-context').Wire} */ w) => w.to.node === networkId && w.to.port === port;
  return declaredLayers(net.config).map(L => {
    const port = /** @type {string} */ (L.tools), here = into(port);
    const layer = { port, inside: /** @type {ToolUnit[]} */ ([]), outside: /** @type {string[]} */ ([]) };
    for (const tool of [...new Set(graph.producers(networkId, port).map(p => p.node))]) {
      const unit = unitOf(graph, networkId, tool, here);
      if (unit && drawn(unit.node) && (!unit.readout || drawn(unit.readout))) layer.inside.push(unit);
      else layer.outside.push(tool);
    }
    return layer;
  });
}

/** The unit `tool` forms inside the tool port `here` tests for, or null when it is wired elsewhere too. */
function unitOf(/** @type {ModuleGraph} */ graph, /** @type {string} */ host, /** @type {string} */ tool, /** @type {(w: import('./workbench-context').Wire) => boolean} */ here) {
  const wires = graph.wiresOf(tool);
  if (wires.every(w => w.from.node === tool && here(w))) return { node: tool, readout: null, tool };
  const node = graph.node(tool);
  if (node.kind !== 'readout' || node.config.mode !== 'bits') return null;
  const feeds = wires.filter(w => w.to.node === tool);
  const source = feeds.length === 1 && feeds[0].to.port === 'scores' ? feeds[0].from.node : null;
  if (!source || source === host || graph.node(source).kind !== 'network') return null;
  const rest = wires.filter(w => w.to.node !== tool);
  if (!rest.every(w => w.from.node === tool && w.from.port === 'run' && here(w))) return null;
  if (!graph.wiresOf(source).every(w => w.from.node === source && w.to.node === tool)) return null;
  return { node: source, readout: tool, tool };
}
