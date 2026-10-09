// templates/index.js — the builtin template library: every `*.yaml` in this directory, parsed once on first use.
// Adding a template = dropping a YAML file here; nothing to register. Under Vite the files arrive through
// `import.meta.glob` (raw text, eager); under node (tests) they are read from disk — `process.getBuiltinModule` keeps
// `node:fs` out of the browser bundle's static imports.
import '../core/kinds/index.js';
import { parseTemplate } from '../core/template.js';

function sources() {
  if (import.meta.env) return import.meta.glob('./*.yaml', { query: '?raw', import: 'default', eager: true });
  const fs = process.getBuiltinModule('node:fs'), dir = new URL('./', import.meta.url);
  const out = {};
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.yaml')).sort()) out[`./${name}`] = fs.readFileSync(new URL(name, dir), 'utf8');
  return out;
}

let cache = null;
function load() {
  if (cache) return cache;
  cache = new Map();
  for (const [file, text] of Object.entries(sources())) {
    const template = parseTemplate(text);
    if (cache.has(template.id)) throw new Error(`builtin template id ${template.id} is defined twice (${file})`);
    cache.set(template.id, template);
  }
  return cache;
}

/** Every builtin template (canonical JSON), sorted by id. */
export function builtinTemplates() { return [...load().values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); }
/** One builtin template by id, or null. */
export function builtinTemplate(id) { return load().get(id) ?? null; }
