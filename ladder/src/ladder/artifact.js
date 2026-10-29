// ladder/artifact.js — an imported model artifact, checked before the deployment: its content id (validateArtifact of
// the workbench store) and the facts the ladder cares about (shape, weight size, tools). The limits themselves come
// from the contract configuration. The page compares here only to say the refusal before any transaction.
import { validateArtifact } from '../../../frontend/core/store.js';
import { deploymentOf } from '../../../frontend/module-chain.js';
import { t } from '../i18n.js';

/** Parse and check `input` (an object or JSON text) → `{ artifact, id, engine, inputs, outputs, weightBytes, tools }`. */
export async function inspectArtifact(input) {
  let json = input;
  if (typeof input === 'string') {
    try { json = JSON.parse(input); } catch { throw new Error(t('不是合法的 JSON')); }
  }
  const artifact = await validateArtifact(json);
  const d = deploymentOf(artifact);
  return { artifact, id: artifact.id, engine: d.engine, inputs: d.inputs, outputs: d.outputs, weightBytes: (d.weights.length - 2) / 2, tools: d.tools.length };
}

/** The refusal the contract would give for `summary` under `config` (the contract Config), or null. */
export function registrationProblem(summary, config) {
  if (!config) return null;
  if (summary.inputs !== 572 || summary.outputs !== 9) return 'WrongShape';
  if (summary.tools > 0) return 'HasTools';
  if (summary.weightBytes > config.maxWeightBytes) return 'TooLarge';
  return null;
}
