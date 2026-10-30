// training/train.js — `trainBundle(bundle, options)`. It validates a `neurom-bundle` trainer snapshot against the
// requirements of its method (core/kinds/trainer.js METHODS, checked on the trained network of the loop and its
// readout). Then it sends the snapshot to the trainer of the method. Result `{ model, evaluation, provenance }`.
// Browser cancellation terminates the training worker (training/client.js).
import { bundleProblem, bundleHash as hashBundle } from '../core/bundle.js';
import { readoutProblem } from '../core/readout.js';
import { METHODS, requiredReadout, toolLayerProblem } from '../core/kinds/trainer.js';
import { trainedOf, refWidth } from '../core/loop.js';
import { modelProblem } from '../core/sessions/executor.js';
import { trainReinforce } from './reinforce.js';
import { trainCrossEntropy } from './cross-entropy.js';
import { trainHinge } from './hinge.js';
import { t } from '../i18n.js';

const TRAINERS = Object.freeze({ reinforce: trainReinforce, 'cross-entropy': trainCrossEntropy, hinge: trainHinge });

const positive = n => Number.isInteger(n) && n >= 1;
/** A bundle's dense layer entry: a plain layer `{ hidden }` or a tool layer `{ tools, K, D, R }` with its widths resolved. */
const denseLayer = L => (L && Object.hasOwn(L, 'tools') ? typeof L.tools === 'string' && positive(L.K) && positive(L.D) && positive(L.R) : positive(L?.hidden));

/** Why a trainer bundle cannot be trained. '' when it satisfies the requirements of its method. */
export function trainingProblem(bundle) {
  const shape = bundleProblem(bundle);
  if (shape) return shape;
  if (!bundle.env || !bundle.loop) return t('必需输入 {port} 尚未连接', { port: 'loop' });
  const method = bundle.recipe?.method, need = METHODS[method];
  if (!need || !TRAINERS[method]) return t('尚无训练配方：{task}', { task: String(method) });
  const trained = trainedOf(bundle.loop), { objective, partitions } = bundle;
  if (!trained || !trained.readout) return t('训练快照没有要训练的网络或它的读出');
  if (!objective || !partitions) return t('训练快照缺少 objective 或 partitions');
  const network = trained.structure, readout = trained.readout;
  const tooled = toolLayerProblem(method, network.layers);
  if (tooled) return tooled;
  if (network.engine !== need.engine) return t('{method} 需要 {engine} 引擎', { method, engine: need.engine });
  if (objective.kind !== need.objective || !objective.program) return t('{method} 需要 {kind} 目标', { method, kind: need.objective });
  const ro = readoutProblem(readout, null);
  if (ro) return ro;
  const mode = requiredReadout(method, network.layers);
  if (readout.mode !== mode) return t('{method} 需要 {mode} 读出', { method, mode });
  if (readout.width !== network.outputs) return t('网络输出 {outputs} 与读出宽度 {width} 不一致', { outputs: network.outputs, width: readout.width });
  const width = refWidth(bundle.loop, bundle.loop.nodes[trained.id].in);
  if (width !== network.inputs) return t('网络输入 {inputs} 位与接入的 {width} 位不一致', { inputs: network.inputs, width: String(width) });
  for (const [id, n] of Object.entries(bundle.loop.nodes)) if (n.kind === 'network' && id !== trained.id && !n.model) return t('网络 {name} 没有已接受的权重', { name: id });
  const start = bundle.init ? modelProblem(bundle.init.model, network) : '';
  if (start) return t('init 的模型不适合训练的网络：{problem}', { problem: start });
  if (!partitions.training) return t('必需输入 {port} 尚未连接', { port: 'training' });
  if (network.engine === 'dense-policy' && !(Array.isArray(network.layers) && network.layers.length && network.layers.every(denseLayer))) return t('稠密网络的每一层必须是 hidden 为正整数的普通层，或宽度已定的工具层');
  if (network.engine === 'threshold-layers' && !(Array.isArray(network.layers) && network.layers.length)) return t('阈值层网络需要 layers');
  return '';
}

/**
 * Train a bundle to completion. `tables` maps dataset id → `{ column: number[] }` for envs that read a table.
 * Resolves `{ model, evaluation, provenance }`.
 */
export async function trainBundle(bundle, { onProgress = () => {}, tables = {} } = {}) {
  const problem = trainingProblem(bundle);
  if (problem) throw new Error(problem);
  const bundleHash = await hashBundle(bundle);
  return TRAINERS[bundle.recipe.method](bundle, { onProgress, tables, bundleHash });
}
