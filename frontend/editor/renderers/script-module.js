// editor/renderers/script-module.js — the page side of the script module loader (ADR 0019). The page parses each file
// with @babel/parser and never runs it. It rewrites the `import` and `export` statements of the file into calls of
// the loader in the sandbox (script-module-runtime.js). The imports move to the start of line 1, so they run first, as
// in a module. Their own lines stay as empty lines, and every other character stays where it was. So a line of the
// rewritten file is the same line of the source, and an error reports the line the author sees.
//
// A rewritten file is the body of `function (__nm_import, __nm_exports, __nm_star)`:
// - `__nm_import(name)` returns the exports of a file (by its name in the module) or of the built-in `@ui`.
// - `__nm_exports` receives one getter per export, defined first. So a file that imports a function from a file that
//   imports it back sees the function. An imported name holds the value at the time of the import. So two files that
//   import each other cannot read a `const` of the other file before that file has run.
// - `__nm_star(exports)` copies the getters of `export * from`.
// The names that start with `__nm_` belong to the loader.
import { parse } from '@babel/parser';

/** the built-in module of every script (script-module-runtime.js) */
const UI_MODULE = '@ui';

/**
 * Rewrite the files of a script module for the loader in the sandbox.
 * @param {{ name: string, source: string }[]} files
 * @returns {{ modules: Record<string, string> } | { error: { file: string, line: number | null, code: string, params?: Record<string, string>, message?: string } }}
 *   `code`: `syntax` (with the parser's `message`), `missing` (no file `params.file`), `import` (an import names no file)
 */
export function compileScript(files) {
  const names = new Set(files.map(f => f.name));
  if (!names.has('main.js')) return { error: { file: 'main.js', line: null, code: 'missing', params: { file: 'main.js' } } };
  /** @type {Record<string, string>} */
  const modules = {};
  for (const { name, source } of files) {
    const out = rewrite(name, source, names);
    if ('error' in out) return out;
    modules[name] = out.code;
  }
  return { modules };
}

/** `./a.js`, `a.js` and `./a` all name the file `a.js`. null: no such file. */
function resolve(spec, names) {
  if (spec === UI_MODULE) return spec;
  const bare = spec.replace(/^\.\//, '');
  return names.has(bare) ? bare : names.has(`${bare}.js`) ? `${bare}.js` : null;
}

/** every name a binding pattern declares (`const { a, b: [c] } = …` → a, c) */
function bound(pattern, out = []) {
  if (!pattern) return out;
  switch (pattern.type) {
    case 'Identifier': out.push(pattern.name); break;
    case 'ObjectPattern': for (const p of pattern.properties) bound(p.type === 'RestElement' ? p.argument : p.value, out); break;
    case 'ArrayPattern': for (const p of pattern.elements) bound(p, out); break;
    case 'RestElement': bound(pattern.argument, out); break;
    case 'AssignmentPattern': bound(pattern.left, out); break;
  }
  return out;
}
const exportName = n => (n.type === 'Identifier' ? n.name : n.value);

function rewrite(file, source, names) {
  let ast;
  try { ast = parse(source, { sourceType: 'module' }); }
  catch (e) { return { error: { file, line: e.loc?.line ?? null, code: 'syntax', message: String(e.message).replace(/\s*\(\d+:\d+\)$/, '') } }; }
  /** @type {{ start: number, end: number, text: string }[]} */
  const edits = [];
  /** export name → the expression its getter returns */
  const getters = [];
  let refs = 0;
  /** imports and re-exports, in source order: they run before the rest of the file, as in a module */
  const hoisted = [];
  /** move the statement `node` to the head as `text`, keeping its line breaks in place */
  const hoist = (node, text) => {
    hoisted.push(text);
    edits.push({ start: node.start, end: node.end, text: '\n'.repeat(node.loc.end.line - node.loc.start.line) });
  };
  const target = (node) => {
    const name = resolve(node.source.value, names);
    return name ? { name } : { error: { file, line: node.loc.start.line, code: 'import', params: { name: String(node.source.value) } } };
  };
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration') {
      const to = target(node); if (to.error) return to;
      const call = `__nm_import(${JSON.stringify(to.name)})`;
      const parts = node.specifiers.map(s => (s.type === 'ImportDefaultSpecifier' ? `${s.local.name} = ${call}.default`
        : s.type === 'ImportNamespaceSpecifier' ? `${s.local.name} = ${call}` : `${s.local.name} = ${call}[${JSON.stringify(exportName(s.imported))}]`));
      hoist(node, parts.length ? `const ${parts.join(', ')};` : `${call};`);
    } else if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const d = node.declaration;
      const declared = d.type === 'VariableDeclaration' ? d.declarations.flatMap(v => bound(v.id)) : [d.id.name];
      for (const n of declared) getters.push([n, n]);
      edits.push({ start: node.start, end: d.start, text: '' });
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.source) {
        const to = target(node); if (to.error) return to;
        const ref = `__nm_r${refs++}`;
        for (const s of node.specifiers) getters.push([exportName(s.exported), s.type === 'ExportNamespaceSpecifier' ? ref : `${ref}[${JSON.stringify(exportName(s.local))}]`]);
        hoist(node, `const ${ref} = __nm_import(${JSON.stringify(to.name)});`);
      } else {
        for (const s of node.specifiers) getters.push([exportName(s.exported), s.local.name]);
        hoist(node, '');
      }
    } else if (node.type === 'ExportAllDeclaration') {
      const to = target(node); if (to.error) return to;
      hoist(node, `__nm_star(__nm_import(${JSON.stringify(to.name)}));`);
    } else if (node.type === 'ExportDefaultDeclaration') {
      const d = node.declaration;
      if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) {
        getters.push(['default', d.id.name]);
        edits.push({ start: node.start, end: d.start, text: '' });
      } else {
        getters.push(['default', '__nm_default']);
        edits.push({ start: node.start, end: d.start, text: 'const __nm_default = ' });
        if (source[node.end - 1] !== ';') edits.push({ start: node.end, end: node.end, text: ';' });
      }
    }
  }
  const head = `"use strict";Object.defineProperties(__nm_exports, {${getters.map(([n, e]) => `${JSON.stringify(n)}: { enumerable: true, get: () => ${e} }`).join(', ')}});${hoisted.join('')}`;
  let code = source;
  for (const e of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, e.start) + e.text + code.slice(e.end);
  return { code: `${head}${code}\n//# sourceURL=neurom-script/${file}` };
}
