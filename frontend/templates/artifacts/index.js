// templates/artifacts/index.js — the builtin preset artifacts: every `*.json` in this directory is one complete
// `neurom-module` artifact whose bundle is a builtin template's trainer bundle (`provenance.template` names it) and
// whose `provenance.name` is the file stem. Rebind them to the current templates with `node frontend/templates/artifacts/generate.mjs`.
// Loading mirrors templates/index.js: Vite globs the files, node reads the directory; each artifact is hash-verified.
import { validateArtifact } from '../../core/store.js';

function sources() {
  if (import.meta.env) return import.meta.glob('./*.json', { query: '?raw', import: 'default', eager: true });
  const fs = process.getBuiltinModule('node:fs'), dir = new URL('./', import.meta.url);
  const out = {};
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) out[`./${name}`] = fs.readFileSync(new URL(name, dir), 'utf8');
  return out;
}

let cache = null;
async function load() {
  if (cache) return cache;
  const entries = new Map();
  for (const [file, text] of Object.entries(sources())) {
    const name = file.replace(/^\.\//, '').replace(/\.json$/, '');
    const artifact = await validateArtifact(JSON.parse(text));
    const template = artifact.provenance.template;
    if (!template || typeof template.id !== 'string' || !Number.isInteger(template.revision)) throw new Error(`builtin artifact ${file} does not name its template (provenance.template)`);
    if (entries.has(name)) throw new Error(`builtin artifact ${name} is defined twice`);
    entries.set(name, Object.freeze({ name, template: Object.freeze({ id: template.id, revision: template.revision }), artifact }));
  }
  cache = entries;
  return cache;
}

/** Every builtin artifact as `{ name, template:{id, revision}, artifact }`, sorted by name. */
export async function builtinArtifacts() { return [...(await load()).values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); }
