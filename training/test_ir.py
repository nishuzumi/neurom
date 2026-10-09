"""training/ir.py must agree with frontend/ir bit for bit: replay the JS-generated fixtures (frontend/ir/fixtures/programs.json)
batched, with masks and mixed lanes, and cover the batched-runtime rules the fixtures cannot express."""
import json
import math
import unittest
from pathlib import Path

import numpy as np

import ir

FIXTURES = Path(__file__).resolve().parents[1] / 'frontend/ir/fixtures/programs.json'
N, B, S = {'type': 'number'}, {'type': 'boolean'}, {'type': 'string'}


def A(n, of): return {'type': 'array', 'length': n, 'of': of}


def R(**fields): return {'type': 'record', 'fields': fields}


def from_json(t, v):
    """JSON fixture value → plain Python value of type t ('-0' encodes negative zero)."""
    k = t['type']
    if k == 'number': return -0.0 if v == '-0' else float(v)
    if k in ('boolean', 'string'): return v
    if k == 'vector': return [from_json(N, x) for x in v]
    if k == 'array': return [from_json(t['of'], x) for x in v]
    if k == 'record': return {f: from_json(t['fields'][f], v[f]) for f in t['fields']}
    if k == 'table': return {'columns': {c: [float('nan') if x is None else from_json(N, x) for x in col] for c, col in v['columns'].items()}, 'lo': v['lo'], 'hi': v['hi']}
    raise AssertionError(k)


def same(t, a, b):
    """Bit-identical comparison of two plain values of type t (numbers: value and sign of zero)."""
    k = t['type']
    if k == 'number': return a == b and math.copysign(1.0, a) == math.copysign(1.0, b)
    if k in ('boolean', 'string'): return a == b and type(a) is type(b)
    if k == 'vector': return len(a) == len(b) and all(same(N, x, y) for x, y in zip(a, b))
    if k == 'array': return len(a) == len(b) and all(same(t['of'], x, y) for x, y in zip(a, b))
    if k == 'record': return set(a) == set(b) and all(same(t['fields'][f], a[f], b[f]) for f in t['fields'])
    raise AssertionError(k)


def batched_args(types, lanes):
    return [ir.to_batch(t, [from_json(t, lane['args'][i]) for lane in lanes]) for i, t in enumerate(types)]


class Differential(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = json.loads(FIXTURES.read_text())

    def test_static_results_match(self):
        for fx in self.fixtures:
            with self.subTest(fx['name']):
                info = ir.check(fx['program'], fx['paramTypes'], fx['exact'])
                self.assertEqual(info['result'], fx['result'])
                self.assertEqual(info['cost'], fx['cost'])

    def _replay(self, fx, lanes, mask=None):
        compiled = ir.compile(fx['program'], fx['paramTypes'], fx['exact'])
        return compiled.run(batched_args(fx['paramTypes'], lanes), len(lanes), mask)

    def test_successful_lanes_batched(self):
        for fx in self.fixtures:
            ok = [l for l in fx['lanes'] if 'result' in l]
            with self.subTest(fx['name']):
                out = self._replay(fx, ok)
                for i, lane in enumerate(ok):
                    got, want = ir.lane(fx['result'], out, i), from_json(fx['result'], lane['result'])
                    self.assertTrue(same(fx['result'], got, want), f"lane {i}: {got!r} != {want!r}")

    def test_masked_error_lanes_do_not_raise_and_results_match(self):
        for fx in self.fixtures:
            lanes = fx['lanes'] * 2
            mask = np.array(['result' in l for l in lanes])
            with self.subTest(fx['name']):
                out = self._replay(fx, lanes, mask)
                for i, lane in enumerate(lanes):
                    if not mask[i]: continue
                    got, want = ir.lane(fx['result'], out, i), from_json(fx['result'], lane['result'])
                    self.assertTrue(same(fx['result'], got, want), f"lane {i}: {got!r} != {want!r}")

    def test_error_lanes_raise_at_the_same_node(self):
        for fx in self.fixtures:
            bad = [l for l in fx['lanes'] if 'error' in l]
            if not bad: continue
            with self.subTest(fx['name']):
                with self.assertRaises(ir.ProgramError) as ctx:
                    self._replay(fx, fx['lanes'])
                self.assertIn(ctx.exception.node_id, {l['error']['nodeId'] for l in bad})
                for lane in bad:
                    with self.assertRaises(ir.ProgramError) as single:
                        self._replay(fx, [lane])
                    self.assertEqual(single.exception.node_id, lane['error']['nodeId'])
                    self.assertEqual(single.exception.op, lane['error']['op'])

    def test_all_lanes_masked_out_evaluates_nothing(self):
        for fx in self.fixtures:
            with self.subTest(fx['name']):
                out = self._replay(fx, fx['lanes'], np.zeros(len(fx['lanes']), dtype=bool))
                self.assertIsNotNone(out)


class Runtime(unittest.TestCase):
    def program(self, nodes, output, params=()):
        return {'format': 'neurom-program', 'params': list(params), 'nodes': nodes, 'output': output}

    def test_exact_tier_rejects_ln_and_cost_limit_is_enforced(self):
        p = self.program([{'id': 'x', 'op': 'param', 'inputs': [], 'name': 'x'}, {'id': 'l', 'op': 'ln', 'inputs': ['x']}], 'l', ['x'])
        with self.assertRaises(ir.ProgramError): ir.check(p, [N], exact=True)
        self.assertEqual(ir.check(p, [N], exact=False)['result'], N)
        body = {'params': ['e', 'i'], 'nodes': [{'id': 'e', 'op': 'param', 'inputs': [], 'name': 'e'}, {'id': 'one', 'op': 'constant', 'inputs': [], 'value': 1}, {'id': 'r', 'op': 'add', 'inputs': ['e', 'one']}], 'output': 'r'}
        big = self.program([{'id': 'g', 'op': 'param', 'inputs': [], 'name': 'g'}, {'id': 'm', 'op': 'map', 'inputs': ['g'], 'body': body}], 'm', ['g'])
        self.assertEqual(ir.check(big, [A(1000, N)])['cost'], 2 + 1000 * 3)
        with self.assertRaises(ir.ProgramError): ir.check(big, [A(4096, A(1000, N))])

    def test_structure_errors(self):
        with self.assertRaises(ir.ProgramError): ir.check(self.program([{'id': 'a', 'op': 'add', 'inputs': ['b', 'b']}, {'id': 'b', 'op': 'add', 'inputs': ['a', 'a']}], 'a'), [])
        with self.assertRaises(ir.ProgramError): ir.check(self.program([{'id': 'a', 'op': 'param', 'inputs': [], 'name': 'zz'}], 'a'), [])
        with self.assertRaises(ir.ProgramError): ir.check(self.program([{'id': 'a', 'op': 'constant', 'inputs': [], 'value': 1}], 'a'), [N])
        for name in ('x', 17):
            with self.assertRaisesRegex(ir.ProgramError, 'cannot carry name'): ir.check(self.program([{'id': 'a', 'op': 'constant', 'inputs': [], 'value': 1, 'name': name}], 'a'), [])
        for body in (None, []):
            with self.assertRaisesRegex(ir.ProgramError, 'cannot carry body'): ir.check(self.program([{'id': 'a', 'op': 'constant', 'inputs': [], 'value': 1, 'body': body}], 'a'), [])
        with self.assertRaisesRegex(ir.ProgramError, 'at least one node'): ir.check(self.program([], 'a'), [])

    def test_argument_validation_and_per_lane_table_bounds(self):
        p = self.program([{'id': 't', 'op': 'param', 'inputs': [], 'name': 't'}, {'id': 'i', 'op': 'param', 'inputs': [], 'name': 'i'},
                          {'id': 'a', 'op': 'tableAt', 'inputs': ['t', 'i'], 'name': 'p'}], 'a', ['t', 'i'])
        c = ir.compile(p, [{'type': 'table', 'columns': ['p']}, N])
        table = ir.table_view({'p': [10, 20, 30, 40]}, [0, 2], [1, 3])
        np.testing.assert_array_equal(c.run([table, np.array([1.0, 2.0])], 2), [20, 30])
        with self.assertRaises(ir.ProgramError) as ctx: c.run([table, np.array([2.0, 2.0])], 2)
        self.assertIn('lane(s) [0]', str(ctx.exception))
        np.testing.assert_array_equal(c.run([table, np.array([2.0, 2.0])], 2, np.array([False, True]))[1], 30)
        with self.assertRaises(ir.ProgramError): c.run([table, np.array([1.0])], 2)
        with self.assertRaises(ir.ProgramError): c.run([table, np.array([1.0, float('nan')])], 2)
        with self.assertRaises(ir.ProgramError): c.run([ir.table_view({'p': [1]}, 0, 1), np.array([0.0, 0.0])], 2)

    def test_record_and_list_arrays_select_per_lane(self):
        # select between records containing list-shaped arrays merges lane by lane
        nodes = [{'id': 'c', 'op': 'param', 'inputs': [], 'name': 'c'}, {'id': 'x', 'op': 'param', 'inputs': [], 'name': 'x'}, {'id': 'y', 'op': 'param', 'inputs': [], 'name': 'y'},
                 {'id': 's', 'op': 'select', 'inputs': ['c', 'x', 'y']}]
        T = A(2, R(v=N, n=S))
        c = ir.compile(self.program(nodes, 's', ['c', 'x', 'y']), [B, T, T])
        x = ir.to_batch(T, [[{'v': 1, 'n': 'a'}, {'v': 2, 'n': 'b'}]] * 2)
        y = ir.to_batch(T, [[{'v': 3, 'n': 'c'}, {'v': 4, 'n': 'd'}]] * 2)
        out = c.run([np.array([True, False]), x, y], 2)
        self.assertEqual(ir.lane(T, out, 0), [{'v': 1.0, 'n': 'a'}, {'v': 2.0, 'n': 'b'}])
        self.assertEqual(ir.lane(T, out, 1), [{'v': 3.0, 'n': 'c'}, {'v': 4.0, 'n': 'd'}])

    def test_deep_chain_does_not_hit_the_recursion_limit(self):
        nodes = [{'id': 'n0', 'op': 'param', 'inputs': [], 'name': 'x'}]
        for i in range(1, 4096): nodes.append({'id': f'n{i}', 'op': 'add', 'inputs': [f'n{i - 1}', 'n0']})
        c = ir.compile(self.program(nodes, 'n4095', ['x']), [N])
        np.testing.assert_array_equal(c.run([np.array([1.0, 2.0])], 2), [4096.0, 8192.0])


class CheckOptions(unittest.TestCase):
    def test_check_args_and_result_can_be_skipped_without_changing_semantics(self):
        p = {'format': 'neurom-program', 'params': ['v', 'i'], 'nodes': [
            {'id': 'v', 'op': 'param', 'inputs': [], 'name': 'v'}, {'id': 'i', 'op': 'param', 'inputs': [], 'name': 'i'},
            {'id': 'x', 'op': 'index', 'inputs': ['v', 'i']}], 'output': 'x'}
        types = [{'type': 'vector', 'width': 3}, N]
        strict, fast = ir.compile(p, types), ir.compile(p, types, check_args=False, check_result=False)
        v, i = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]), np.array([0.0, 2.0])
        np.testing.assert_array_equal(fast.run([v, i], 2), strict.run([v, i], 2))
        with self.assertRaises(ir.ProgramError): fast.run([v, np.array([0.0, 3.0])], 2)
        with self.assertRaises(ir.ProgramError): strict.run([v[:, :2], i], 2)


if __name__ == '__main__':
    unittest.main()
