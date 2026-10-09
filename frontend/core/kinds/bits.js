// core/kinds/bits.js — bit wiring between bit lines: `bits` = the concatenation of `parts`, each a slice
// `[offset, offset+width)` of one input port. One part = a slice, several = a concatenation (or any permutation).
// Pure wiring: the loop executor (core/loop.js) evaluates it inside a loop body.
import { registerKind } from '../registry.js';
import { valueIn, valueOut } from './common.js';
import { bits, binaryVector, MAX_BITS } from '../types.js';
import { t } from '../../i18n.js';

/** Distinct input port names, in first-use order. */
export const partPorts = parts => [...new Set(parts.map(p => p.port))];
/** Output width of a parts list. */
export const partsWidth = parts => parts.reduce((s, p) => s + p.width, 0);

registerKind({
  kind: 'bits',
  label: '位线',
  config: {
    defaults: { parts: [{ port: 'in', offset: 0, width: 8 }] },
    schema: {
      parts: { type: 'list', min: 1, max: MAX_BITS, of: { type: 'object', fields: {
        port: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', max: 32 },
        offset: { type: 'int', min: 0, max: MAX_BITS - 1 },
        width: { type: 'int', min: 1, max: MAX_BITS },
      } } },
    },
  },
  ports(node) {
    const width = partsWidth(node.config.parts);
    return {
      inputs: partPorts(node.config.parts).map(id => valueIn(id, binaryVector(1, MAX_BITS), { required: true })),
      outputs: [valueOut('bits', width <= MAX_BITS ? bits(width) : null)],
    };
  },
  infer(node) {
    const width = partsWidth(node.config.parts);
    return { bits: width <= MAX_BITS ? bits(width) : null };
  },
  problems(node, ctx) {
    const out = [], parts = node.config.parts;
    const width = partsWidth(parts);
    if (width > MAX_BITS) out.push({ port: 'bits', message: t('位线总宽 {width} 超过 {max}', { width, max: MAX_BITS }) });
    for (const port of partPorts(parts)) {
      const T = ctx.inType(node.id, port);
      if (!T || T.type !== 'vector') continue;
      for (const p of parts) if (p.port === port && p.offset + p.width > T.width) out.push({ port, message: t('{port} 只有 {have} 位，切片 [{offset}, {end}) 越界', { port, have: T.width, offset: p.offset, end: p.offset + p.width }) });
    }
    return out;
  },
});
