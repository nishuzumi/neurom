// ir/docs.js — what the parts of the values of a program mean. The docs go along the IR, as TS carries property docs
// along types. A doc tree is `{ text?, fields?: {key: tree}, of?: tree }` (the fields of a record, the elements of an
// array). The params of the program start with the trees that their callers / producers give. Every node that keeps
// the structure of a value passes its tree on:
//   - `get` / `index` read a part.
//   - A record literal builds one (the own JSDoc of a key first, then the tree of the value put there).
//   - `{...base, k}` replaces one field.
//   - `c ? a : b` takes the parts of a over the parts of b.
//   - map / reduce / scan give element and accumulator trees to their callbacks.
// Computed values (arithmetic, helpers) carry none. Pure: no types necessary, never throws on a well-formed program.

/** Two trees as one: `a` wins wherever both say something. */
export function mergeDocs(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const out = { ...b, ...a };
  if (!a.text && b.text) out.text = b.text;
  if (a.fields || b.fields) {
    out.fields = { ...b.fields };
    for (const [k, d] of Object.entries(a.fields ?? {})) out.fields[k] = mergeDocs(d, b.fields?.[k]);
  }
  if (a.of || b.of) out.of = mergeDocs(a.of, b.of);
  return out;
}

/** The part of `tree` at `path` (field keys), or null. */
export function docAt(tree, path) {
  let at = tree ?? null;
  for (const key of path) at = at?.fields?.[key] ?? null;
  return at;
}

/**
 * Doc trees of every node of `program` (node id → tree. Nodes without one are absent). `paramDocs[name]` documents a
 * program param. `keyDocs[nodeId][key]` is the JSDoc of a record literal key (the keyDocs of parseModule).
 */
export function flowDocs(program, paramDocs = {}, keyDocs = {}) {
  const docs = new Map(), get = id => docs.get(id) ?? null;
  const own = (id, key) => { const text = keyDocs[id]?.[key]; return text ? { text } : null; };
  const visit = (nodes, lookup) => {
    for (const node of nodes) {
      const d = docOf(node, lookup);
      if (d) docs.set(node.id, d);
    }
  };
  /** a map / fold / scan body: the trees of its params, then its nodes. Returns the tree of the body output */
  const body = (node, trees, lookup) => {
    const names = node.body.params, inner = name => { const i = names.indexOf(name); return i >= 0 ? trees[i] ?? null : lookup(name); };
    visit(node.body.nodes, inner);
    return get(node.body.output);
  };
  const docOf = (node, lookup) => {
    const [a, b, c] = node.inputs.map(get);
    switch (node.op) {
      case 'param': return lookup(node.name);
      case 'get': return a?.fields?.[node.name] ?? null;
      case 'index': return a?.of ?? null;
      case 'record': {
        const fields = {};
        node.value.forEach((key, i) => { const d = mergeDocs(own(node.id, key), get(node.inputs[i])); if (d) fields[key] = d; });
        return Object.keys(fields).length ? { fields } : null;
      }
      case 'set': {
        const d = mergeDocs(own(node.id, node.name), mergeDocs(b, a?.fields?.[node.name]));
        return d ? { ...a, fields: { ...a?.fields, [node.name]: d } } : a;
      }
      case 'select': return mergeDocs(b, c);
      case 'array': { const of = node.inputs.map(get).reduce((acc, d) => mergeDocs(acc, d), null); return of ? { of } : null; }
      case 'update': return mergeDocs(a, c ? { of: c } : null);
      case 'map': { const out = body(node, [a?.of ?? null, null], lookup); return out ? { of: out } : null; }
      case 'fold': return mergeDocs(b, body(node, [b, a?.of ?? null, null], lookup));
      case 'scan': { const acc = mergeDocs(b, body(node, [b, a?.of ?? null, null], lookup)); return acc ? { of: acc } : null; }
      default: return null;
    }
  };
  visit(program.nodes, name => paramDocs[name] ?? null);
  return docs;
}
