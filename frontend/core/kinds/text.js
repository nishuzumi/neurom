// core/kinds/text.js — a note on the canvas. It has no ports. Nothing evaluates it.
import { registerKind } from '../registry.js';

registerKind({
  kind: 'text',
  label: '文字',
  config: { defaults: { text: '' }, schema: { text: { type: 'string', max: 20000 } } },
  ports() { return { inputs: [], outputs: [] }; },
  infer() { return {}; },
  problems() { return []; },
});
