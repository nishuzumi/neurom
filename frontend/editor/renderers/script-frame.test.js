import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptDocument } from './script-frame.js';

test('a view script cannot close its own element, and its lines map back from the document', () => {
  const source = 'const tag = "</script><b>x</b>";\nthrow new Error("boom");';
  const { html, offset } = scriptDocument(source, { '--bg': '#000', 'bad;}': 'x' }, 'var Vue = { v: "</SCRIPT>" };');
  const lines = html.split('\n');
  assert.equal(lines[offset], 'const tag = "<\\/script><b>x</b>";', 'line 1 of the script is document line offset + 1');
  assert.equal(lines[offset + 1], 'throw new Error("boom");');
  assert.ok(html.includes('"<\\/SCRIPT>"'), 'the inlined Vue is escaped the same way');
  assert.equal(html.match(/<\/script>/g)?.length, 4, 'only the frame’s own four scripts close: guard, Vue, the script, the host part');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /:root\{--bg:#000;color-scheme:normal\}/, 'only custom-property names reach the stylesheet');
});
