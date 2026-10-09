// ir/index.js — public API of the neurom-program IR:
//   - source → IR: parseModule for a code module file of consts and exported functions, parseCode / parseFunction for
//     one function body
//   - static check (typeNodes: best-effort typing for editor hovers)
//   - doc flow (flowDocs: what the parts of each value mean)
//   - closure compile, table values, limits and the two error classes.
export { check, typeNodes } from './check.js';
export { flowDocs, mergeDocs, docAt } from './docs.js';
export { compile } from './compile.js';
export { parseFunction, parseCode, parseModule, ProgramSourceError, HELPERS, RESERVED } from './parse.js';
export { ProgramError, LIMITS, tableView } from './types.js';
