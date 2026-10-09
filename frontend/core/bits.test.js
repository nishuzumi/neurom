import { test } from 'node:test';
import assert from 'node:assert/strict';
import './kinds/index.js';
import { ModuleGraph } from './graph.js';

/** A code module exporting `b`: `width` zero bits. */
const constBits = (g, width) => g.addNode({ kind: 'code', config: { source: `export const b = bits(0, ${width});` } });

function wired(parts, widths) {
  const g = new ModuleGraph();
  const node = g.addNode({ kind: 'bits', config: { parts } });
  for (const [port, width] of Object.entries(widths)) {
    const src = constBits(g, width);
    g.connect({ kind: 'value', from: { node: src.id, port: 'b' }, to: { node: node.id, port } });
  }
  return { g, node };
}

test('bits: input ports are the distinct part ports in order; the output is a binary vector as wide as the parts', () => {
  const { g, node } = wired([{ port: 'hi', offset: 4, width: 4 }, { port: 'lo', offset: 0, width: 3 }, { port: 'hi', offset: 0, width: 1 }], { hi: 8, lo: 3 });
  const ports = g.ports(node.id);
  assert.deepEqual(ports.inputs.map(p => p.id), ['hi', 'lo']);
  assert.deepEqual(ports.outputs.find(p => p.id === 'bits').type, { type: 'vector', width: 8, binary: true });
  assert.deepEqual(g.problems(), []);
});

test('bits: an unwired part port is an incomplete problem; a slice past the wired width is an error the connect refuses', () => {
  const { g, node } = wired([{ port: 'a', offset: 0, width: 2 }, { port: 'b', offset: 0, width: 2 }], { a: 4 });
  const problems = g.problems();
  assert.equal(problems.length, 1);
  assert.equal(problems[0].incomplete, true);
  assert.equal(problems[0].port, 'b');
  g.patchConfig(node.id, { parts: [{ port: 'a', offset: 3, width: 2 }] });
  assert.match(g.problems()[0].message, /a 只有 4 位，切片 \[3, 5\) 越界/);
  const narrow = constBits(g, 2);
  g.patchConfig(node.id, { parts: [{ port: 'c', offset: 0, width: 3 }] });
  assert.throws(() => g.connect({ kind: 'value', from: { node: narrow.id, port: 'b' }, to: { node: node.id, port: 'c' } }), /c 只有 2 位，切片 \[0, 3\) 越界/);
});
