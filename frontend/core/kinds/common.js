// core/kinds/common.js — port constructors shared by every kind file.
//
//   value input   { id, wire:'value', type: Type|Constraint|null, required, many, loop? }   (null: any type, inferred from
//                 the wire. loop: a value cycle may close into this port — its value is not computed in the same pass:
//                 a loop's next-step action, a network's weights an earlier training run produced)
//   call input    { id, wire:'call', signature:{params, names, result, exact, name?, docs?, returns?, stub?}, when?, required, many }
//                 (names: the default parameter names — a stub's header, the help's labels. An implementation names
//                 its parameters as it likes. Only their count and types are the protocol. name: the default function
//                 name of a stub (else the port's id). docs: one line per parameter. returns: what the result means.
//                 stub: a body that compiles, inserted by the editor and by a prefab slot's create entry (prefab.js).
//                 when: who calls it and when — raw Chinese texts, translated where shown)
//   value output  { id, wire:'value', type: Type|null }             (null: not yet inferred)
//   fn output     { id, wire:'call' }                                (typed at every call site)
export const valueIn = (id, type = null, { required = false, many = false, loop = false } = {}) => ({ id, wire: 'value', type, required, many, ...(loop ? { loop: true } : {}) });
export const callIn = (id, signature, { required = false, many = false, when = null } = {}) => {
  if (!Array.isArray(signature.names) || signature.names.length !== signature.params.length) throw new Error(`call port ${id}: signature.names must name every parameter`);
  return { id, wire: 'call', signature: { exact: false, ...signature }, required, many, ...(when ? { when } : {}) };
};
export const valueOut = (id, type = null) => ({ id, wire: 'value', type });
export const fnOut = (id = 'fn') => ({ id, wire: 'call' });
/** a whole code module (its file) travels on a call wire as a `module` handle, to a kind that calls its functions by role */
export const moduleOut = (id = 'module') => ({ id, wire: 'call', handle: 'module' });
export const moduleIn = (id, { required = true } = {}) => ({ id, wire: 'call', handle: 'module', required, many: false });

/** The single type flowing into a non-`many` port, or null. */
export const single = (inTypes, id) => (Array.isArray(inTypes[id]) ? inTypes[id][0] ?? null : inTypes[id] ?? null);
