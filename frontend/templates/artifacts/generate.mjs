// templates/artifacts/generate.mjs — trains the builtin preset artifacts on the CURRENT builtin templates: each one
// by the JS trainer on its template's trainer bundle, seed pinned by the template's trainer config, so every run
// writes the same artifact. Run after a template or the weight format changes: node frontend/templates/artifacts/generate.mjs
// Frozen networks run the artifacts generated before them, named in `frozen` (their `artifact` is set to those ids in
// the scratch instance). The printed ids must be copied into the templates that pin them (arithmetic-combiner.yaml:
// the tool networks' `artifact`, the policy candidates' `accepted`).
import fs from 'node:fs';
import { ModuleGraph } from '../../core/graph.js';
import { makeArtifact } from '../../core/store.js';
import { buildBundle } from '../../core/bundle.js';
import { instantiateInto } from '../../core/template.js';
import { trainBundle } from '../../training/train.js';
import { builtinTemplate } from '../index.js';

const here = new URL('.', import.meta.url);
const file = name => new URL(`./${name}.json`, here);
const read = name => (fs.existsSync(file(name)) ? JSON.parse(fs.readFileSync(file(name), 'utf8')) : null);

/** Builtin presets, in generation order: the template, and the local ids inside it of the trained network and its
 *  trainer. `frozen` = { networkLocalId: presetName } for a trained preset whose loop runs other presets. */
export const PRESETS = Object.freeze({
  'arithmetic-add4': { template: 'arithmetic-add4', net: 'net', trainer: 'trainer' },
  'arithmetic-sub4': { template: 'arithmetic-sub4', net: 'net', trainer: 'trainer' },
  'arithmetic-mul4': { template: 'arithmetic-mul4', net: 'net', trainer: 'trainer' },
  'arithmetic-combiner-policy': { template: 'arithmetic-combiner', net: 'policy', trainer: 'trainer',
    frozen: { add4: 'arithmetic-add4', sub4: 'arithmetic-sub4', mul4: 'arithmetic-mul4' } },
});

/** A fresh instance of `template` whose node ids are the template's local ids (bundles key loop nodes by node id, so
 *  the artifact — and its id — would otherwise change on every run): frozen networks set to `frozen`
 *  ({ networkLocalId: artifactId }). */
function instance(template, { frozen = {} }) {
  const scratch = new ModuleGraph();
  const { ids: fresh } = instantiateInto(scratch, builtinTemplate(template), { x: 0, y: 0 });
  let text = JSON.stringify(scratch.toJSON());
  for (const [local, id] of Object.entries(fresh)) text = text.replaceAll(JSON.stringify(id), JSON.stringify(local));
  const graph = ModuleGraph.fromJSON(JSON.parse(text)), ids = Object.fromEntries(Object.keys(fresh).map(local => [local, local]));
  for (const [local, id] of Object.entries(frozen)) graph.patchConfig(ids[local], { artifact: id });
  const errors = graph.problems().filter(p => !p.incomplete);
  if (errors.length) throw new Error(`${template}: ${errors.map(p => p.message).join('; ')}`);
  return { graph, ids };
}

/** The trainer bundle of preset `name`'s template; `made` = the artifacts generated so far, by name. */
function trainerBundle(name, made) {
  const preset = PRESETS[name];
  const frozen = Object.fromEntries(Object.entries(preset.frozen ?? {}).map(([local, dep]) => [local, made.get(dep).id]));
  const byId = new Map([...made.values()].map(a => [a.id, a]));
  const { graph, ids } = instance(preset.template, { frozen });
  return buildBundle(graph, ids[preset.trainer], { artifacts: id => byId.get(id) ?? null });
}

/** Preset `name` trained on the current template; `made` = the artifacts generated so far, by name. */
async function generate(name, made) {
  const preset = PRESETS[name], template = builtinTemplate(preset.template), bundle = trainerBundle(name, made);
  const { model, evaluation, provenance: { startedAt, durationMs, ...run } } = await trainBundle(bundle);
  const provenance = { ...run, name, source: 'builtin', template: { id: template.id, revision: template.revision }, note: 'trained by frontend/templates/artifacts/generate.mjs' };
  return makeArtifact({ bundle, model, provenance, evaluation });
}

/** Every preset, in order; writes each file. */
async function generateAll() {
  const made = new Map();
  for (const name of Object.keys(PRESETS)) {
    const before = read(name)?.id ?? null, artifact = await generate(name, made);
    made.set(name, artifact);
    fs.writeFileSync(file(name), JSON.stringify(artifact) + '\n');
    const { metricName, metric, selectedEpoch, quantization } = artifact.evaluation, clipped = quantization.reduce((n, q) => n + q.clippedWeights + q.clippedBiases, 0);
    console.log(`${name}.json ${artifact.id}${artifact.id === before ? '' : ` (was ${before})`} → ${artifact.provenance.template.id} validation ${metricName} ${metric} at epoch ${selectedEpoch}, ${clipped} clipped`);
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) await generateAll();
