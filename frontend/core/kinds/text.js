// core/kinds/text.js — a note on the canvas. Its only output is a `text` handle so a template can wire it to a
// documentation slot. Nothing evaluates it.
import { registerKind } from '../registry.js';
import { valueOut } from './common.js';
import { handle } from '../types.js';

registerKind({
  kind: 'text',
  label: '文字',
  config: { defaults: { text: '' }, schema: { text: { type: 'string', max: 20000 } } },
  ports() { return { inputs: [], outputs: [valueOut('text', handle('text'))] }; },
  infer() { return { text: handle('text') }; },
  problems() { return []; },
});
