// Wires are told apart by colour: no two wires on one node share a palette entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { colorEdges, WIRE_COLORS } from './wire-palette.js';

const edge = (id, source, target) => ({ id, source, target });

test('wires touching the same node never share a colour; unrelated wires may', () => {
  const fan = [edge('a', 'src', 't1'), edge('b', 'src', 't2'), edge('c', 'src', 't3'), edge('d', 'other', 't3'), edge('e', 'x', 'y')];
  const c = colorEdges(fan);
  assert.equal(new Set(['a', 'b', 'c'].map(id => c.get(id))).size, 3, 'three wires out of one node: three colours');
  assert.notEqual(c.get('c'), c.get('d'), 'two wires into one node differ too');
  assert.equal(c.get('e'), 0, 'a wire with no neighbours takes the first colour again');
  const crowd = Array.from({ length: WIRE_COLORS + 2 }, (_, i) => edge(`w${i}`, 'hub', `t${i}`));
  const cc = colorEdges(crowd);
  assert.equal(new Set(crowd.slice(0, WIRE_COLORS).map(e => cc.get(e.id))).size, WIRE_COLORS, 'the whole palette is used before any repeat');
  assert.ok([...cc.values()].every(i => i >= 0 && i < WIRE_COLORS), 'overflow wraps inside the palette');
});
