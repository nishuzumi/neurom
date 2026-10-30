"""Python mirror of the neurom-program IR (frontend/ir/*.js, frontend/ir/program.schema.json).

Same static rules (structure, typing, tiers, limits, cost) and the same runtime semantics, evaluated over a batch of
lanes with a lane mask: `compile(program, param_types, exact).run(args, batch, mask)`.

Batched values:
    number       → float64 [B]
    boolean      → bool [B]
    string       → object [B]
    vector(w)    → float64 [B, w]
    array(n, T)  → ndarray [B, n, …] when T is itself ndarray-shaped, else a Python list of n batched T
    record       → dict
    table        → Table(columns shared, lo/hi int64 [B])
select/and/or evaluate branches only for the lanes that take them. Runtime errors raise ProgramError only for active
lanes. Exact-tier results are bit-identical to the JS interpreter.
"""
import builtins
import math
import numpy as np

PROGRAM_FORMAT = 'neurom-program'
LIMITS = {'maxNodes': 4096, 'maxCost': 2_000_000, 'maxVectorWidth': 4096, 'maxArrayLength': 4096, 'maxBitsWidth': 53, 'maxIdLength': 64, 'maxRecordFields': 256}
PROGRAM_KEYS = {'format', 'params', 'nodes', 'output'}
NODE_KEYS = {'id', 'op', 'inputs', 'value', 'name', 'body'}
BODY_KEYS = {'params', 'nodes', 'output'}
SCALARS = ('number', 'boolean', 'string')
LAZY = {'select': [1, 2], 'and': [1], 'or': [1]}
MASK32 = np.uint64(0xFFFFFFFF)
TWO32 = float(2 ** 32)

# op → (arity, has value, has name, body param count, approx tier). Arity 'variadic' = 1..n.
OPS = {
    'constant': (0, True, False, 0, False), 'param': (0, False, True, 0, False),
    'add': (2,) + (False,) * 4, 'sub': (2,) + (False,) * 4, 'mul': (2,) + (False,) * 4, 'div': (2,) + (False,) * 4, 'mod': (2,) + (False,) * 4, 'neg': (1,) + (False,) * 4,
    'min': (2,) + (False,) * 4, 'max': (2,) + (False,) * 4, 'abs': (1,) + (False,) * 4, 'floor': (1,) + (False,) * 4, 'ceil': (1,) + (False,) * 4, 'round': (1,) + (False,) * 4, 'clamp': (3,) + (False,) * 4,
    'sqrt': (1,) + (False,) * 4, 'ln': (1, False, False, 0, True), 'exp': (1, False, False, 0, True),
    'lt': (2,) + (False,) * 4, 'lte': (2,) + (False,) * 4, 'gt': (2,) + (False,) * 4, 'gte': (2,) + (False,) * 4, 'eq': (2,) + (False,) * 4, 'neq': (2,) + (False,) * 4,
    'and': (2,) + (False,) * 4, 'or': (2,) + (False,) * 4, 'not': (1,) + (False,) * 4, 'select': (3,) + (False,) * 4,
    'vector': ('variadic',) + (False,) * 4, 'concat': ('variadic',) + (False,) * 4, 'bits': (2,) + (False,) * 4, 'oneHot': (2,) + (False,) * 4, 'at': (2,) + (False,) * 4, 'slice': (3,) + (False,) * 4,
    'get': (1, False, True, 0, False), 'record': ('variadic', True, False, 0, False), 'set': (2, False, True, 0, False),
    'array': ('variadic',) + (False,) * 4, 'index': (2,) + (False,) * 4, 'update': (3,) + (False,) * 4, 'range': (0, True, False, 0, False),
    'map': (1, False, False, 2, False), 'fold': (2, False, False, 3, False), 'scan': (2, False, False, 3, False),
    'u32': (1,) + (False,) * 4, 'imul32': (2,) + (False,) * 4, 'add32': (2,) + (False,) * 4, 'sub32': (2,) + (False,) * 4, 'xor32': (2,) + (False,) * 4, 'and32': (2,) + (False,) * 4, 'or32': (2,) + (False,) * 4, 'shl32': (2,) + (False,) * 4, 'shr32': (2,) + (False,) * 4,
    'rand': (2,) + (False,) * 4,
    'bucket': (1, True, False, 0, False), 'thermometer': (1, True, False, 0, False),
    'tableAt': (2, False, True, 0, False), 'tableWindow': (2, True, True, 0, False),
    'sum': (1,) + (False,) * 4, 'minOf': (1,) + (False,) * 4, 'maxOf': (1,) + (False,) * 4, 'argminFirst': (1,) + (False,) * 4, 'argmaxFirst': (1,) + (False,) * 4,
    'any': (1,) + (False,) * 4, 'all': (1,) + (False,) * 4, 'count': (1,) + (False,) * 4,
}


class ProgramError(ValueError):
    """Program rejected statically, or a runtime rule violated in an active lane (never a silent fallback)."""

    def __init__(self, message, node_id=None, op=None):
        super().__init__(message)
        self.node_id, self.op = node_id, op


# ───────────────────────────── types ─────────────────────────────
def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_int(v, lo, hi):
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi or (isinstance(v, float) and v.is_integer() and lo <= v <= hi)


def valid_key(k):
    return isinstance(k, str) and 0 < len(k) <= 64 and k != '__proto__'


def canonical_type(t, where='type'):
    def bad(why): return ProgramError(f'{where} is not a valid type: {why}')
    if not isinstance(t, dict) or not isinstance(t.get('type'), str): raise bad('must be an object with a type field')
    kind = t['type']
    if kind in SCALARS: return {'type': kind}
    if kind == 'vector':
        if not _is_int(t.get('width'), 1, LIMITS['maxVectorWidth']): raise bad(f"vector width must be an integer 1..{LIMITS['maxVectorWidth']}")
        return {'type': 'vector', 'width': int(t['width'])}
    if kind == 'array':
        if not _is_int(t.get('length'), 1, LIMITS['maxArrayLength']): raise bad(f"array length must be an integer 1..{LIMITS['maxArrayLength']}")
        return {'type': 'array', 'length': int(t['length']), 'of': canonical_type(t.get('of'), where)}
    if kind == 'record':
        fields = t.get('fields')
        if not isinstance(fields, dict): raise bad('record needs a fields object')
        if len(fields) > LIMITS['maxRecordFields']: raise bad(f"records have at most {LIMITS['maxRecordFields']} fields")
        for k in fields:
            if not valid_key(k): raise bad(f'invalid field name {k!r}')
        return {'type': 'record', 'fields': {k: canonical_type(fields[k], where) for k in sorted(fields)}}
    if kind == 'table':
        cols = t.get('columns')
        if not isinstance(cols, list) or not cols or any(not valid_key(c) for c in cols): raise bad('table must declare at least one column name')
        if len(set(cols)) != len(cols): raise bad('duplicate table column')
        return {'type': 'table', 'columns': list(cols)}
    raise bad(f'unknown type {kind!r}')


def type_name(t):
    k = t['type']
    if k == 'vector': return f"vector({t['width']})"
    if k == 'array': return f"array({t['length']}, {type_name(t['of'])})"
    if k == 'record': return '{' + ', '.join(f'{n}: {type_name(t["fields"][n])}' for n in sorted(t['fields'])) + '}'
    if k == 'table': return f"table({', '.join(t['columns'])})"
    return k


def same_type(a, b):
    if a['type'] != b['type']: return False
    k = a['type']
    if k == 'vector': return a['width'] == b['width']
    if k == 'array': return a['length'] == b['length'] and same_type(a['of'], b['of'])
    if k == 'record': return sorted(a['fields']) == sorted(b['fields']) and all(same_type(a['fields'][n], b['fields'][n]) for n in a['fields'])
    if k == 'table': return a['columns'] == b['columns']
    return True


def _constant_type(v):
    if isinstance(v, bool): return {'type': 'boolean'}
    if isinstance(v, str): return {'type': 'string'}
    if _is_number(v): return {'type': 'number'}
    return None


NUMBER, BOOLEAN, STRING = {'type': 'number'}, {'type': 'boolean'}, {'type': 'string'}


def _vector(w): return {'type': 'vector', 'width': w}


def _array(n, of): return {'type': 'array', 'length': n, 'of': of}


def _record(fields): return {'type': 'record', 'fields': {k: fields[k] for k in sorted(fields)}}


class Table:
    """A batched table value: shared float64 columns plus per-lane inclusive row windows [lo, hi] (hi = lo - 1 empty)."""

    def __init__(self, columns, lo, hi):
        self.columns = columns
        self.lo, self.hi = lo, hi

    @property
    def rows(self):
        return next(iter(self.columns.values())).shape[0] if self.columns else 0


def table_view(columns, lo, hi):
    """columns: {name: 1-D numbers}. lo/hi: int or int array [B] (broadcast at run time)."""
    if not isinstance(columns, dict) or not columns: raise ProgramError('table_view needs a non-empty {column: values} dict')
    cols = {}
    rows = None
    for name, data in columns.items():
        if not valid_key(name): raise ProgramError(f'invalid column name {name!r}')
        arr = np.asarray(data, dtype=np.float64)
        if arr.ndim != 1: raise ProgramError(f'column {name!r} must be one-dimensional')
        if rows is None: rows = arr.shape[0]
        elif arr.shape[0] != rows: raise ProgramError(f'column {name!r} has {arr.shape[0]} rows, others {rows}')
        cols[name] = arr
    return Table(cols, np.asarray(lo, dtype=np.int64), np.asarray(hi, dtype=np.int64))


# ───────────────────────────── structure ─────────────────────────────
class Scope:
    def __init__(self, parent, params, output, owner):
        self.parent, self.params, self.output, self.owner = parent, params, output, owner
        self.order = []


class Entry:
    __slots__ = ('node', 'scope', 'body')

    def __init__(self, node, scope):
        self.node, self.scope, self.body = node, scope, None


def _err(message, node=None):
    return ProgramError(message, node['id'] if node else None, node['op'] if node else None)


def analyze_structure(program):
    """Ids unique program-wide, inputs resolve to the same or an enclosing scope, scopes acyclic. Returns (scopes, entries, root, order).
    A body may have no nodes of its own (its output is then an enclosing node). The program needs at least one."""
    if not isinstance(program, dict): raise ProgramError('program must be a JSON object')
    for k in program:
        if k not in PROGRAM_KEYS: raise ProgramError(f'program has unknown field {k!r}')
    if program.get('format') != PROGRAM_FORMAT: raise ProgramError(f'program format must be {PROGRAM_FORMAT}')
    params = program.get('params')
    if not isinstance(params, list) or any(not valid_key(p) for p in params) or len(set(params)) != len(params): raise ProgramError('params must be distinct parameter names')
    entries, scopes, count = {}, [], [0]

    def register(scope, nodes, output):
        if not isinstance(nodes, list) or (not nodes and scope.owner is None): raise _err('program needs at least one node', scope.owner)
        for node in nodes:
            if not isinstance(node, dict): raise _err('node must be a JSON object', scope.owner)
            nid, op, ins = node.get('id'), node.get('op'), node.get('inputs')
            if not isinstance(nid, str) or not 0 < len(nid) <= LIMITS['maxIdLength']: raise ProgramError(f"node id must be a string of 1..{LIMITS['maxIdLength']} chars")
            if nid in entries: raise ProgramError(f'duplicate node id {nid!r}', nid)
            count[0] += 1
            if count[0] > LIMITS['maxNodes']: raise ProgramError(f"at most {LIMITS['maxNodes']} nodes", nid)
            for k in node:
                if k not in NODE_KEYS: raise ProgramError(f'node has unknown field {k!r}', nid)
            if not isinstance(op, str) or op not in OPS: raise ProgramError(f'unknown op {op!r}', nid)
            arity, has_value, has_name, body_params, _ = OPS[op]
            if not isinstance(ins, list) or any(not isinstance(x, str) for x in ins): raise _err('inputs must be a list of node ids', node)
            if arity == 'variadic':
                if not ins: raise _err(f'{op} needs at least one input', node)
            elif len(ins) != arity: raise _err(f'{op} needs {arity} inputs, got {len(ins)}', node)
            if ('value' in node) != has_value: raise _err(f'{op} {"needs" if has_value else "cannot carry"} value', node)
            if (not isinstance(node.get('name'), str)) if has_name else ('name' in node): raise _err(f'{op} {"needs" if has_name else "cannot carry"} name', node)
            if (not isinstance(node.get('body'), dict)) if body_params else ('body' in node): raise _err(f'{op} {"needs" if body_params else "cannot carry"} body', node)
            entry = Entry(node, scope)
            entries[nid] = entry
            if body_params:
                body = node['body']
                for k in body:
                    if k not in BODY_KEYS: raise _err(f'body has unknown field {k!r}', node)
                bp = body.get('params')
                if not isinstance(bp, list) or len(bp) != body_params or any(not valid_key(p) for p in bp) or len(set(bp)) != body_params: raise _err(f'{op} body needs {body_params} distinct parameter names', node)
                inner = Scope(scope, bp, body.get('output'), node)
                entry.body = inner
                scopes.append(inner)
                register(inner, body.get('nodes'), body.get('output'))
        if not isinstance(output, str): raise _err(f'output node {output!r} does not exist', scope.owner)

    root = Scope(None, params, program.get('output'), None)
    scopes.append(root)
    register(root, program.get('nodes'), program.get('output'))
    for scope in scopes:   # a scope's output is one of its own nodes or (a body returning a closure value) an enclosing scope's
        target = entries.get(scope.output)
        s = scope
        while target is not None and s is not None and s is not target.scope: s = s.parent
        if target is None or s is None: raise _err(f'output node {scope.output!r} does not exist', scope.owner)
    for e in entries.values():
        for inp in e.node['inputs']:
            target = entries.get(inp)
            if target is None: raise _err(f"node {e.node['id']!r} references missing node {inp!r}", e.node)
            s = e.scope
            while s is not None and s is not target.scope: s = s.parent
            if s is None: raise _err(f"node {e.node['id']!r} references node {inp!r} inside another body", e.node)
    state, order = {}, []
    for root_id in entries:
        if root_id in state: continue
        stack, state[root_id] = [[root_id, 0]], 1
        while stack:
            frame = stack[-1]
            e = entries[frame[0]]
            deps = e.node['inputs'] + ([e.node['body']['output']] if e.body else [])
            if frame[1] < len(deps):
                nxt = deps[frame[1]]
                frame[1] += 1
                s = state.get(nxt)
                if s == 1: raise ProgramError(f'node {nxt!r} closes a cycle', nxt, entries[nxt].node['op'])
                if s is None:
                    state[nxt] = 1
                    stack.append([nxt, 0])
            else:
                state[frame[0]] = 2
                e.scope.order.append(frame[0])
                order.append(frame[0])
                stack.pop()
    return scopes, entries, root, order


# ───────────────────────────── typing ─────────────────────────────
class Info:
    pass


def analyze(program, param_types, exact=False):
    scopes, entries, root, order = analyze_structure(program)
    if not isinstance(param_types, list) or len(param_types) != len(root.params): raise ProgramError(f'{len(param_types) if isinstance(param_types, list) else 0} parameter types for {len(root.params)} parameters')
    root_types = [canonical_type(t, f'type of parameter {root.params[i]!r}') for i, t in enumerate(param_types)]
    types, scope_param_types, param_refs = {}, {id(root): root_types}, {}

    def type_scope(scope):
        for nid in scope.order:
            types[nid] = _type_of(entries[nid], entries, types, scope, scope_param_types, param_refs, type_scope, exact)

    type_scope(root)

    def cost_of(scope):
        total = 0
        for nid in scope.order:
            e = entries[nid]
            total += 1
            if e.body: total += types[e.node['inputs'][0]]['length'] * cost_of(e.body)
        return total

    cost = cost_of(root)
    if cost > LIMITS['maxCost']: raise ProgramError(f"worst case {cost} node evaluations exceeds {LIMITS['maxCost']}", root.output)
    info = Info()
    info.scopes, info.entries, info.root, info.order = scopes, entries, root, order
    info.types, info.param_types, info.param_refs, info.cost, info.result = types, root_types, param_refs, cost, types[root.output]
    return info


def _const_input(e, entries, index, what, lo, hi):
    node = e.node
    ref = entries[node['inputs'][index]].node
    if ref['op'] != 'constant' or not _is_number(ref['value']): raise _err(f"{node['op']} {what} must be a numeric constant node", node)
    if not _is_int(ref['value'], lo, hi): raise _err(f"{node['op']} {what} must be an integer {lo}..{hi}, got {ref['value']}", node)
    return int(ref['value'])


def _edges(node):
    v = node['value']
    if not isinstance(v, list) or not v or len(v) > LIMITS['maxVectorWidth'] or any(not _is_number(x) for x in v): raise _err(f"{node['op']} edges must be a non-empty list of finite numbers", node)
    for i in range(1, len(v)):
        if not v[i] > v[i - 1]: raise _err(f"{node['op']} edges must be strictly ascending", node)
    return v


def _type_of(e, entries, types, scope, scope_param_types, param_refs, type_scope, exact):
    node = e.node
    nid, op, ins = node['id'], node['op'], node['inputs']

    def ty(i): return types[ins[i]]

    def expect(i, kind):
        if ty(i)['type'] != kind: raise _err(f'{op} input {i + 1} must be {kind}, got {type_name(ty(i))}', node)
        return ty(i)

    def same(a, b, what):
        if not same_type(a, b): raise _err(f'{op} {what} types must match: {type_name(a)} vs {type_name(b)}', node)

    def numbers():
        for i in range(len(ins)): expect(i, 'number')
        return NUMBER

    if OPS[op][4] and exact: raise _err(f'{op} is not allowed in the exact tier', node)
    if op == 'constant':
        t = _constant_type(node['value'])
        if t is None: raise _err('constant value must be a finite number, boolean or string', node)
        return t
    if op == 'param':
        s = scope
        while s is not None:
            if node['name'] in s.params:
                idx = s.params.index(node['name'])
                param_refs[nid] = (s, idx)
                return scope_param_types[id(s)][idx]
            s = s.parent
        raise _err(f"undefined parameter {node['name']!r}", node)
    if op in ('add', 'sub', 'mul', 'div', 'mod', 'min', 'max', 'neg', 'abs', 'floor', 'ceil', 'round', 'clamp', 'sqrt', 'ln', 'exp',
              'u32', 'imul32', 'add32', 'sub32', 'xor32', 'and32', 'or32', 'shl32', 'shr32', 'rand'):
        return numbers()
    if op in ('lt', 'lte', 'gt', 'gte'):
        numbers()
        return BOOLEAN
    if op in ('eq', 'neq'):
        if ty(0)['type'] not in SCALARS: raise _err(f'{op} compares numbers, booleans or strings only, got {type_name(ty(0))}', node)
        same(ty(0), ty(1), 'operand')
        return BOOLEAN
    if op in ('and', 'or'):
        expect(0, 'boolean'); expect(1, 'boolean')
        return BOOLEAN
    if op == 'not':
        expect(0, 'boolean')
        return BOOLEAN
    if op == 'select':
        expect(0, 'boolean'); same(ty(1), ty(2), 'branch')
        return ty(1)
    if op == 'vector':
        numbers()
        if len(ins) > LIMITS['maxVectorWidth']: raise _err(f"vectors have at most {LIMITS['maxVectorWidth']} elements", node)
        return _vector(len(ins))
    if op == 'concat':
        width = 0
        for i in range(len(ins)):
            t = ty(i)
            if t['type'] == 'vector': width += t['width']
            elif t['type'] == 'array' and t['of']['type'] == 'number': width += t['length']
            elif t['type'] == 'array' and t['of']['type'] == 'vector': width += t['length'] * t['of']['width']
            else: raise _err(f'concat input {i + 1} must be a vector or numeric array, got {type_name(t)}', node)
        if width > LIMITS['maxVectorWidth']: raise _err(f"concatenated width {width} exceeds {LIMITS['maxVectorWidth']}", node)
        return _vector(width)
    if op == 'bits':
        expect(0, 'number')
        return _vector(_const_input(e, entries, 1, 'width', 1, LIMITS['maxBitsWidth']))
    if op == 'oneHot':
        expect(0, 'number')
        return _vector(_const_input(e, entries, 1, 'width', 1, LIMITS['maxVectorWidth']))
    if op == 'at':
        expect(0, 'vector'); expect(1, 'number')
        return NUMBER
    if op == 'slice':
        width = expect(0, 'vector')['width']
        start = _const_input(e, entries, 1, 'start', 0, width - 1)
        end = _const_input(e, entries, 2, 'end', start + 1, width)
        return _vector(end - start)
    if op == 'get':
        fields = expect(0, 'record')['fields']
        if node['name'] not in fields: raise _err(f"record {type_name(ty(0))} has no field {node['name']!r}", node)
        return fields[node['name']]
    if op == 'record':
        keys = node['value']
        if not isinstance(keys, list) or len(keys) != len(ins) or any(not valid_key(k) for k in keys) or len(set(keys)) != len(keys): raise _err('record value must list one distinct key per input', node)
        if len(keys) > LIMITS['maxRecordFields']: raise _err(f"records have at most {LIMITS['maxRecordFields']} fields", node)
        return _record({k: ty(i) for i, k in enumerate(keys)})
    if op == 'set':
        t = expect(0, 'record')
        if node['name'] not in t['fields']: raise _err(f"record {type_name(t)} has no field {node['name']!r}", node)
        same(t['fields'][node['name']], ty(1), f"field {node['name']!r}")
        return t
    if op == 'array':
        for i in range(1, len(ins)): same(ty(0), ty(i), 'element')
        if len(ins) > LIMITS['maxArrayLength']: raise _err(f"arrays have at most {LIMITS['maxArrayLength']} elements", node)
        return _array(len(ins), ty(0))
    if op == 'index':
        t = ty(0)
        if t['type'] not in ('array', 'vector'): raise _err(f'index input 1 must be an array or vector, got {type_name(t)}', node)
        expect(1, 'number')
        return t['of'] if t['type'] == 'array' else NUMBER
    if op == 'update':
        t = expect(0, 'array'); expect(1, 'number'); same(t['of'], ty(2), 'element')
        return t
    if op == 'range':
        if not _is_int(node['value'], 1, LIMITS['maxArrayLength']): raise _err(f"range value must be an integer 1..{LIMITS['maxArrayLength']}", node)
        return _array(int(node['value']), NUMBER)
    if op in ('map', 'fold', 'scan'):
        arr = expect(0, 'array')
        inner = e.body
        init = None if op == 'map' else ty(1)
        scope_param_types[id(inner)] = [arr['of'], NUMBER] if op == 'map' else [init, arr['of'], NUMBER]
        type_scope(inner)
        result = types[inner.output]
        if op == 'map': return _array(arr['length'], result)
        same(init, result, 'accumulator and body result')
        return init if op == 'fold' else _array(arr['length'], init)
    if op in ('sum', 'minOf', 'maxOf', 'argminFirst', 'argmaxFirst'):
        t = ty(0)
        if t['type'] != 'vector' and not (t['type'] == 'array' and t['of']['type'] == 'number'): raise _err(f'{op} input must be a vector or numeric array, got {type_name(t)}', node)
        return NUMBER
    if op in ('any', 'all', 'count'):
        t = ty(0)
        if t['type'] != 'array' or t['of']['type'] != 'boolean': raise _err(f'{op} input must be a boolean array, got {type_name(t)}', node)
        return NUMBER if op == 'count' else BOOLEAN
    if op == 'bucket':
        expect(0, 'number'); _edges(node)
        return NUMBER
    if op == 'thermometer':
        expect(0, 'number')
        return _vector(len(_edges(node)))
    if op in ('tableAt', 'tableWindow'):
        table = expect(0, 'table'); expect(1, 'number')
        if node['name'] not in table['columns']: raise _err(f"table {type_name(table)} has no column {node['name']!r}", node)
        if op == 'tableAt': return NUMBER
        if not _is_int(node['value'], 1, LIMITS['maxVectorWidth']): raise _err(f"tableWindow length must be an integer 1..{LIMITS['maxVectorWidth']}", node)
        return _vector(int(node['value']))
    raise _err(f'unknown op {op!r}', node)


def check(program, param_types, exact=False):
    info = analyze(program, param_types, exact)
    return {'result': info.result, 'cost': info.cost}


# ───────────────────────────── batched values ─────────────────────────────
def is_nd(t):
    """Whether batched values of this type are one ndarray ([B, …]) rather than a list/dict/Table."""
    k = t['type']
    return k in SCALARS or k == 'vector' or (k == 'array' and is_nd(t['of']))


def _dtype(t):
    k = t['type']
    while k == 'array': t = t['of']; k = t['type']
    return bool if k == 'boolean' else object if k == 'string' else np.float64


def _shape(t):
    k = t['type']
    if k == 'vector': return (t['width'],)
    if k == 'array': return (t['length'],) + _shape(t['of'])
    return ()


def empty(t, B):
    """A neutral batched value of type t (zeros / False / '' / lo=0,hi=-1 tables), used for lanes that never evaluate."""
    k = t['type']
    if is_nd(t):
        if _dtype(t) is object: return np.full((B,) + _shape(t), '', dtype=object)
        return np.zeros((B,) + _shape(t), dtype=_dtype(t))
    if k == 'array': return [empty(t['of'], B) for _ in range(t['length'])]
    if k == 'record': return {f: empty(t['fields'][f], B) for f in t['fields']}
    return None  # table: no columns to invent. `where` keeps the other side


def where(mask, a, b, t):
    """Lane-wise select between two batched values of type t (None = absent side)."""
    if a is None: return b
    if b is None: return a
    k = t['type']
    if is_nd(t): return np.where(mask.reshape((-1,) + (1,) * (a.ndim - 1)), a, b)
    if k == 'array': return [where(mask, x, y, t['of']) for x, y in zip(a, b)]
    if k == 'record': return {f: where(mask, a[f], b[f], t['fields'][f]) for f in t['fields']}
    if a.columns is b.columns or (a.columns.keys() == b.columns.keys() and all(a.columns[c] is b.columns[c] for c in a.columns)):
        return Table(a.columns, np.where(mask, a.lo, b.lo), np.where(mask, a.hi, b.hi))
    raise ProgramError('cannot select between tables with different columns per lane')


def take(arr, t, i):
    """Element i of a batched array value of array type t."""
    return arr[:, i] if is_nd(t) else arr[i]


def stack(items, t):
    """Batched array of element type t from batched elements."""
    return np.stack(items, axis=1) if is_nd(t) else list(items)


def to_batch(t, values):
    """Batched value from a list of per-lane plain (JSON) values."""
    k, B = t['type'], len(values)
    if k == 'number': return np.asarray(values, dtype=np.float64)
    if k == 'boolean': return np.asarray(values, dtype=bool)
    if k == 'string':
        out = np.empty(B, dtype=object)
        for i, v in enumerate(values): out[i] = v
        return out
    if k == 'vector': return np.asarray(values, dtype=np.float64).reshape(B, t['width'])
    if k == 'array': return stack([to_batch(t['of'], [v[i] for v in values]) for i in range(t['length'])], t['of'])
    if k == 'record': return {f: to_batch(t['fields'][f], [v[f] for v in values]) for f in t['fields']}
    if k == 'table':
        first = values[0]
        for v in values:
            if v['columns'] is first['columns']: continue
            if v['columns'].keys() != first['columns'].keys() or any(not np.array_equal(np.asarray(v['columns'][c], dtype=np.float64), np.asarray(first['columns'][c], dtype=np.float64), equal_nan=True) for c in first['columns']):
                raise ProgramError('table lanes must share columns')
        return table_view(first['columns'], [v['lo'] for v in values], [v['hi'] for v in values])
    raise ProgramError(f'unknown type {k!r}')


def lane(t, value, i):
    """Plain (JSON-like) value of lane i from a batched value."""
    k = t['type']
    if k == 'number': return float(value[i])
    if k == 'boolean': return bool(value[i])
    if k == 'string': return str(value[i])
    if k == 'vector': return [float(x) for x in value[i]]
    if k == 'array': return [lane(t['of'], take(value, t, j), i) for j in range(t['length'])]
    if k == 'record': return {f: lane(t['fields'][f], value[f], i) for f in t['fields']}
    if k == 'table': return {'columns': {c: value.columns[c].tolist() for c in t['columns']}, 'lo': int(value.lo[i]), 'hi': int(value.hi[i])}
    raise ProgramError(f'unknown type {k!r}')


def _validate(t, v, B, mask, path):
    """Shape check of a batched value against t. Finiteness is checked only in active lanes. Returns the normalised value."""
    k = t['type']

    def bad(what): return ProgramError(f'{path}: {what}' if path else what)

    if k == 'number':
        a = np.asarray(v)
        if a.shape != (B,) or a.dtype == object or a.dtype == bool: raise bad(f'must be a float array [{B}]')
        a = a.astype(np.float64, copy=False)
        if not np.all(np.isfinite(a[mask])): raise bad('must be finite')
        return a
    if k == 'boolean':
        a = np.asarray(v)
        if a.shape != (B,) or a.dtype != bool: raise bad(f'must be a bool array [{B}]')
        return a
    if k == 'string':
        a = np.asarray(v, dtype=object)
        if a.shape != (B,) or any(not isinstance(x, str) for x in a[mask]): raise bad(f'must be an object array [{B}] of str')
        return a
    if k == 'vector':
        a = np.asarray(v)
        if a.shape != (B, t['width']) or a.dtype == object or a.dtype == bool: raise bad(f"must be a float array [{B}, {t['width']}]")
        a = a.astype(np.float64, copy=False)
        if not np.all(np.isfinite(a[mask])): raise bad('must be finite')
        return a
    if k == 'array':
        if is_nd(t):
            a = np.asarray(v)
            if a.shape != (B,) + _shape(t): raise bad(f'must be an array of shape {(B,) + _shape(t)}')
            if _dtype(t) is np.float64:
                if a.dtype == object or a.dtype == bool: raise bad('must be numeric')
                a = a.astype(np.float64, copy=False)
                if not np.all(np.isfinite(a[mask])): raise bad('must be finite')
            elif a.dtype != _dtype(t) and not (_dtype(t) is object): raise bad(f'must have dtype {_dtype(t)}')
            return a
        if not isinstance(v, list) or len(v) != t['length']: raise bad(f"must be a list of {t['length']} batched elements")
        return [_validate(t['of'], x, B, mask, f'{path}[{i}]') for i, x in enumerate(v)]
    if k == 'record':
        if not isinstance(v, dict): raise bad('must be a dict')
        for f in v:
            if f not in t['fields']: raise bad(f'unexpected field {f!r}')
        out = {}
        for f in t['fields']:
            if f not in v: raise bad(f'missing field {f!r}')
            out[f] = _validate(t['fields'][f], v[f], B, mask, f'{path}.{f}' if path else f)
        return out
    if k == 'table':
        if v is None and not _nz(mask): return None
        if not isinstance(v, Table): raise bad('must be a Table from table_view')
        rows = v.rows
        for c in t['columns']:
            if c not in v.columns: raise bad(f'missing column {c!r}')
        lo, hi = np.broadcast_to(v.lo, (B,)).astype(np.int64), np.broadcast_to(v.hi, (B,)).astype(np.int64)
        ok = (lo >= 0) & (hi < rows) & (hi >= lo - 1)
        if not np.all(ok[mask]): raise bad(f'view bounds exceed {rows} rows')
        return Table(v.columns, lo, hi)
    raise bad(f'unknown type {k!r}')


def _expand(v, t, k):
    """Repeat every lane k times (lane b → lanes b·k .. b·k+k-1)."""
    if v is None or k == 1: return v
    if is_nd(t): return np.repeat(v, k, axis=0)
    kind = t['type']
    if kind == 'array': return [_expand(x, t['of'], k) for x in v]
    if kind == 'record': return {f: _expand(v[f], t['fields'][f], k) for f in t['fields']}
    return Table(v.columns, np.repeat(v.lo, k), np.repeat(v.hi, k))


def _interleave(items, t, B, n):
    """n batched values of type t ([B, …] each) → one [B·n, …] value with lane b·n+i = items[i] lane b."""
    if is_nd(t): return np.stack(items, axis=1).reshape((B * n,) + items[0].shape[1:])
    kind = t['type']
    if kind == 'array': return [_interleave([x[j] for x in items], t['of'], B, n) for j in range(t['length'])]
    if kind == 'record': return {f: _interleave([x[f] for x in items], t['fields'][f], B, n) for f in t['fields']}
    return Table(items[0].columns, np.stack([x.lo for x in items], axis=1).reshape(-1), np.stack([x.hi for x in items], axis=1).reshape(-1))


def _split(v, t, B, n, i):
    """Element i (lanes b·n+i) of a [B·n, …] value of type t as a [B, …] value."""
    if is_nd(t): return v.reshape((B, n) + v.shape[1:])[:, i]
    kind = t['type']
    if kind == 'array': return [_split(x, t['of'], B, n, i) for x in v]
    if kind == 'record': return {f: _split(v[f], t['fields'][f], B, n, i) for f in t['fields']}
    return Table(v.columns, v.lo.reshape(B, n)[:, i], v.hi.reshape(B, n)[:, i])


def _deinterleave(v, t, B, n):
    """Inverse of _interleave: a [B·n, …] value of element type t → batched array(n, t) value."""
    if is_nd(t): return v.reshape((B, n) + v.shape[1:])
    return [_split(v, t, B, n, i) for i in range(n)]


def _stack_leaves(items, t):
    """list of n batched values of type t → same structure with every leaf stacked to [B, n, …]."""
    if is_nd(t): return np.stack(items, axis=1)
    kind = t['type']
    if kind == 'array': return [_stack_leaves([x[j] for x in items], t['of']) for j in range(t['length'])]
    if kind == 'record': return {f: _stack_leaves([x[f] for x in items], t['fields'][f]) for f in t['fields']}
    return Table(items[0].columns, np.stack([x.lo for x in items], axis=1), np.stack([x.hi for x in items], axis=1))


def _gather(stacked, t, lanes, ints):
    """Leaf-wise stacked[lanes, ints] over a structure of element type t."""
    if is_nd(t): return stacked[lanes, ints]
    kind = t['type']
    if kind == 'array': return [_gather(x, t['of'], lanes, ints) for x in stacked]
    if kind == 'record': return {f: _gather(stacked[f], t['fields'][f], lanes, ints) for f in t['fields']}
    return Table(stacked.columns, stacked.lo[lanes, ints], stacked.hi[lanes, ints])


def _elements(arr, t_arr, B, n):
    """Batched array value → [B·n] batch of its elements."""
    if is_nd(t_arr): return arr.reshape((B * n,) + arr.shape[2:])
    return _interleave(arr, t_arr['of'], B, n)


def _nz(mask):
    """Fast `mask.any()`: count_nonzero skips the ufunc-reduce machinery, which costs more on small masks."""
    return np.count_nonzero(mask) != 0


def _rounded(a):
    c = np.ceil(a)
    return np.where(c - 0.5 <= a, c, c - 1.0)  # Math.round: ties toward +inf, signed zero preserved


# ───────────────────────────── code generation ─────────────────────────────
# A checked program becomes one generated Python function over numpy:
# - Every scope (the program, each map/fold/scan body) is a nested function. It evaluates its eager nodes straight-line
#   in the JS post-order, so the first failing node matches the closure interpreter.
# - Lazy select/and/or branches are nested functions. The code calls them under the lane mask that takes them.
# - Map bodies run once over B·n lanes. Fold/scan bodies loop over elements.
# Generated source contains only generated identifiers, repr() of JSON constants and references to the helpers below.
# exec() runs it in a namespace that holds nothing else (no builtins).

def _raise(nid, op, message, rows, factor):
    rows = sorted(set((np.flatnonzero(rows) // factor).tolist()))
    raise ProgramError(f"node {nid!r} ({op}): {message} in lane(s) {rows[:8]}", nid, op)


def _check(bad, m, nid, op, F, message):
    if _nz(bad):
        bad = m & bad
        if _nz(bad): _raise(nid, op, message, bad, F)


def _finite(r, m, nid, op, F):
    ok = np.isfinite(r)
    if not ok.all():
        bad = m & ~ok
        if _nz(bad): _raise(nid, op, 'result is not finite', bad, F)
    return r


def _int_index(idx, length, m, nid, op, F):
    ints = idx.astype(np.int64)                      # non-finite values never round-trip, so they fail the equality test
    bad = (ints != idx) | (ints < 0) | (ints >= length)
    if _nz(bad):
        active = m & bad
        if _nz(active): _raise(nid, op, f'index out of range 0..{length - 1}', active, F)
        ints = np.where(bad, 0, ints)                # inactive lanes can hold anything. Keep the gather in bounds
    return ints


def _u32_in(a, m, index, nid, op, F):
    bad = m & ((a != np.floor(a)) | (a < 0) | (a >= TWO32))
    if _nz(bad): _raise(nid, op, f'input {index} is not an integer in 0..2^32-1', bad, F)
    return np.where(m, a, 0).astype(np.uint64)


def _str_const(B, v):
    out = np.empty(B, dtype=object); out[:] = v
    return out


def _index_list(v, t_of, ints, lanes):
    return _gather(_stack_leaves(v, t_of), t_of, lanes, ints)


def rand_hash(key, counter):
    """uint64 arrays holding u32 values → float64 in [0, 1). Mirrors frontend/ir/compile.js randHash bit for bit."""
    h = (key ^ ((counter * np.uint64(0x9e3779b9)) & MASK32)) & MASK32
    h = h ^ (h >> np.uint64(16))
    h = (h * np.uint64(0x7feb352d)) & MASK32
    h = h ^ (h >> np.uint64(15))
    h = (h * np.uint64(0x846ca68b)) & MASK32
    h = h ^ (h >> np.uint64(16))
    return h.astype(np.float64) / TWO32


_NAMESPACE = dict(np=np, _nz=_nz, _check=_check, _finite=_finite, _int_index=_int_index, _u32_in=_u32_in, _str_const=_str_const, _index_list=_index_list,
                  where=where, take=take, stack=stack, _expand=_expand, _elements=_elements, _deinterleave=_deinterleave,
                  _stack_leaves=_stack_leaves, _gather=_gather, _rounded=_rounded, rand_hash=rand_hash, MASK32=MASK32,
                  range=range, float=float, dict=dict, bool=bool, __builtins__={})

_BINARY = {'lt': '<', 'lte': '<=', 'gt': '>', 'gte': '>='}
_UNARY = {'neg': 'np.negative', 'abs': 'np.abs', 'floor': 'np.floor', 'ceil': 'np.ceil', 'round': '_rounded'}


class _Ctx:
    """One generated function: its scope, static lane factor relative to the program, the nodes already bound to a local
    (here or in an enclosing function) and the enclosing-scope values already expanded to this scope's lane count."""

    def __init__(self, scope, factor, parent):
        self.scope, self.factor, self.parent = scope, factor, parent
        self.avail = set()
        self.expanded = {}

    def owner_of(self, nid):
        """The enclosing function context that bound `nid` to a local, or None."""
        c = self
        while c is not None:
            if nid in c.avail: return c
            c = c.parent
        return None

    def has(self, nid): return self.owner_of(nid) is not None

    def expansion(self, key):
        c = self
        while c is not None:
            if key in c.expanded: return c.expanded[key]
            if c.parent is not None and c.parent.factor != c.factor: return None   # the enclosing function runs at another lane count
            c = c.parent
        return None


class _Gen:
    def __init__(self, info):
        self.info, self.entries, self.types = info, info.entries, info.types
        self.lines, self.consts, self.counter = [], [], 0
        self.names = {nid: f'v{i}' for i, nid in enumerate(info.order)}
        self.pname = {}
        for i, scope in enumerate(info.scopes):
            for j in range(len(scope.params)): self.pname[(id(scope), j)] = f'p{i}_{j}'
        # list-shaped arrays indexed dynamically get a leaf-stacked twin right after they are bound
        self.outer = {}
        # Per scope S: a body under S can read nodes of S other than through the eager path of the body. S binds these
        # nodes lazily through a memoised thunk (JS evaluates them on demand in the frame of S), because S does not
        # always compute them before that point. Thunks live at the top of S's function.
        self.thunks = {id(scope): [] for scope in info.scopes}
        by_scope = {}
        for e in self.entries.values(): by_scope.setdefault(id(e.scope), []).append(e)
        def subtree(scope):
            out = list(by_scope.get(id(scope), []))
            for e in out[:]:
                if e.body is not None: out += subtree(e.body)
            return out
        for e in self.entries.values():
            if e.body is None: continue
            S, hoisted = e.scope, set(self.outer_refs(e.body))
            for inner in subtree(e.body):
                for inp in inner.node['inputs'] + ([inner.body.output] if inner.body is not None else []) + ([e.body.output] if inner is e else []):
                    target = self.entries[inp]
                    if target.scope is S and inp not in hoisted and target.node['op'] not in ('param', 'constant') and inp not in self.thunks[id(S)]:
                        self.thunks[id(S)].append(inp)
        # A node that two or more lazy branches of its scope read (and that is not on the eager path) is also a thunk.
        # So it is evaluated once per activation, like the memoised lazy sharing of JS, and not once per branch that takes it.
        for scope in info.scopes:
            eager = set(self.eager_order(scope, scope.output, lambda n: False))
            counts = {}
            for e in by_scope.get(id(scope), []):
                lazy = LAZY.get(e.node['op'])
                if lazy is None: continue
                for i in lazy:
                    for n in self.eager_order(scope, e.node['inputs'][i], lambda n: n in eager): counts[n] = counts.get(n, 0) + 1
            for n, c in counts.items():
                if c >= 2 and n not in self.thunks[id(scope)] and self.entries[n].node['op'] not in ('param', 'constant'): self.thunks[id(scope)].append(n)
        self.stacked = set()
        for e in self.entries.values():
            node = e.node
            if node['op'] in ('at', 'index'):
                src = self.types[node['inputs'][0]]
                if src['type'] == 'array' and not is_nd(src) and self._static_index(node, src['length']) is None: self.stacked.add(node['inputs'][0])

    def outer_refs(self, scope):
        """Nodes outside `scope` that its eager evaluation reads (through nested bodies too), in first-use order."""
        cached = self.outer.get(id(scope))
        if cached is not None: return cached
        refs, seen, stack = [], set(), [scope.output]
        while stack:
            nid = stack.pop()
            if nid in seen: continue
            seen.add(nid)
            e = self.entries[nid]
            if e.scope is not scope:
                if nid not in refs: refs.append(nid)
                continue
            node = e.node
            lazy = LAZY.get(node['op'])
            for i, inp in enumerate(node['inputs']):
                if lazy is None or i not in lazy: stack.append(inp)
            if e.body is not None:
                for r in self.outer_refs(e.body):
                    if self.entries[r].scope is scope: stack.append(r)
                    elif r not in refs: refs.append(r)
        self.outer[id(scope)] = refs
        return refs

    # -- emission helpers
    def emit(self, indent, line): self.lines.append('    ' * indent + line)

    def const(self, value):
        self.consts.append(value)
        return f'_K{len(self.consts) - 1}'

    def tmp(self):
        self.counter += 1
        return f't{self.counter}'

    def _static_index(self, node, length):
        ref = self.entries[node['inputs'][1]].node
        v = ref.get('value')
        return int(v) if ref['op'] == 'constant' and _is_int(v, 0, length - 1) else None

    def _bounded_index(self, node, length):
        ref = self.entries[node['inputs'][1]].node
        if ref['op'] != 'param': return False
        scope, index = self.info.param_refs[ref['id']]
        owner = scope.owner
        if owner is None: return False
        arr, n = self.entries[owner['inputs'][0]].node, self.types[owner['inputs'][0]]['length']
        elem = 0 if owner['op'] == 'map' else 1
        if index == elem + 1: return n <= length
        return index == elem and arr['op'] == 'range' and arr['value'] <= length

    # -- references
    def ref_raw(self, ctx, indent, nid):
        """(expression, k, bound): node `nid` at the lane count it is bound with (k = ctx lanes per bound lane). `bound`
        is its local name when a function bound it, else None (thunk result / inline param or constant)."""
        e, name = self.entries[nid], self.names[nid]
        owner = ctx.owner_of(nid)
        if owner is not None: return name, ctx.factor // owner.factor, name
        cached = ctx.expansion(('raw', nid))
        if cached is not None: return cached
        op = e.node['op']
        if op == 'param': result = (self.param_ref(ctx, indent, nid), 1, None)
        elif op == 'constant':
            tmp = self.tmp()
            self.node(_Ctx(ctx.scope, ctx.factor, ctx), indent, nid, tmp)
            result = (tmp, 1, None)
        else:
            a = ctx
            while a.scope is not e.scope: a = a.parent          # the function of the node's own scope: it defines the thunk
            k, tmp = ctx.factor // a.factor, self.tmp()
            mask = 'm'
            if k != 1:
                mask = ctx.expansion(('mask', k))
                if mask is None:
                    mask = self.tmp()
                    self.emit(indent, f'{mask} = np.any(m.reshape(-1, {k}), axis=1)')
                    ctx.expanded[('mask', k)] = mask
            self.emit(indent, f'{tmp} = lz_{name}({mask})')
            result = (tmp, k, None)
        ctx.expanded[('raw', nid)] = result
        return result

    def ref(self, ctx, indent, nid):
        """Expression for node `nid`'s value at ctx's lane count."""
        expr, k, _ = self.ref_raw(ctx, indent, nid)
        return self.expanded(ctx, indent, nid, expr, self.types[nid], k)

    def expanded(self, ctx, indent, key, expr, t, k):
        if k == 1: return expr
        cached = ctx.expansion(key)
        if cached is not None: return cached
        name = self.tmp()
        self.emit(indent, f'{name} = _expand({expr}, {self.const(t)}, {k})')
        ctx.expanded[key] = name
        return name

    def param_ref(self, ctx, indent, nid):
        scope, index = self.info.param_refs[nid]
        name = self.pname[(id(scope), index)]
        c = ctx
        while c.scope is not scope: c = c.parent   # the function binding that parameter
        return self.expanded(ctx, indent, ('param', id(scope), index), name, self.types[nid], ctx.factor // c.factor)

    # -- schedules
    def eager_order(self, scope, start, avail):
        """Post-order (inputs left to right, then a body's outer reads) over non-lazy edges from `start`, skipping nodes
        already bound. Nodes of enclosing scopes that are not bound yet are computed here, at this function's lane count."""
        plan, seen, stack = [], set(), [(start, 0)]
        while stack:
            nid, phase = stack.pop()
            if phase == 0:
                if nid in seen or avail(nid): continue
                e = self.entries[nid]
                if e.scope is not scope: continue        # enclosing-scope values are bound there or reached through thunks
                seen.add(nid)
                lazy = LAZY.get(e.node['op'])
                deps = [inp for i, inp in enumerate(e.node['inputs']) if lazy is None or i not in lazy]
                if e.body is not None: deps += [r for r in self.outer_refs(e.body) if self.entries[r].scope is not e.body]
                stack.append((nid, 1))
                for inp in reversed(deps): stack.append((inp, 0))
            else: plan.append(nid)
        return plan

    def block(self, ctx, indent, start):
        """Emit every node needed for `start` in ctx (thunked nodes other than `start` are called, not recomputed)."""
        thunks = self.thunks[id(ctx.scope)]
        for nid in self.eager_order(ctx.scope, start, lambda n: n != start and (ctx.has(n) or n in thunks)):
            self.node(ctx, indent, nid)
            ctx.avail.add(nid)
        return self.ref(ctx, indent, start)

    def branch(self, ctx, indent, start):
        """A lazily evaluated input: a nested function of the mask when it needs computation, else its expression."""
        if ctx.has(start) or self.entries[start].scope is not ctx.scope or start in self.thunks[id(ctx.scope)]: return None, self.ref(ctx, indent, start)
        fn, inner = self.tmp(), _Ctx(ctx.scope, ctx.factor, ctx)
        self.emit(indent, f'def {fn}(m):')
        value = self.block(inner, indent + 1, start)
        self.emit(indent + 1, f'return {value}')
        return fn, None

    def scope_function(self, ctx, indent, name, params):
        scope = ctx.scope
        self.emit(indent, f'def {name}({", ".join(params)}):')
        self.emit(indent + 1, 'ar = np.arange(B)')
        for nid in self.thunks[id(scope)]: self.thunk(ctx, indent + 1, nid)
        value = self.block(ctx, indent + 1, scope.output)
        self.emit(indent + 1, f'return {value}')

    def thunk(self, ctx, indent, nid):
        """`lz_v(m)`: node `nid` for the lanes in m, memoised across calls within one activation of ctx's function."""
        name, t = self.names[nid], self.types[nid]
        E = lambda line: self.emit(indent, line)
        E(f'lz_{name}_m = [None, None]')
        E(f'def lz_{name}(m):')
        E(f'    d = lz_{name}_m[1]')
        E('    if d is not None: m = m & ~d')
        E('    if _nz(m):')
        value = self.block(_Ctx(ctx.scope, ctx.factor, ctx), indent + 2, nid)
        E(f'        lz_{name}_m[0] = {value} if d is None else where(m, {value}, lz_{name}_m[0], {self.const(t)})')
        E(f'        lz_{name}_m[1] = m if d is None else d | m')
        E(f'    return lz_{name}_m[0]')

    # -- nodes
    def node(self, ctx, indent, nid, target=None):
        e = self.entries[nid]
        node, v, t = e.node, target or self.names[nid], self.types[nid]
        op, ins = node['op'], node['inputs']
        E = lambda line: self.emit(indent, line)
        R = lambda i: self.ref(ctx, indent, ins[i])
        err = f'{node["id"]!r}, {op!r}, {ctx.factor}'
        if op == 'constant':
            c = node['value']
            if isinstance(c, bool): E(f'{v} = np.full(B, {c!r}, dtype=bool)')
            elif isinstance(c, str): E(f'{v} = _str_const(B, {c!r})')
            else: E(f'{v} = np.full(B, {float(c)!r}, dtype=np.float64)')
        elif op == 'param': E(f'{v} = {self.param_ref(ctx, indent, nid)}')
        elif op in ('add', 'sub', 'mul'):
            sym = {'add': '+', 'sub': '-', 'mul': '*'}[op]
            E(f'{v} = _finite({R(0)} {sym} {R(1)}, m, {err})')
        elif op in ('div', 'mod'):
            d = self.tmp()
            E(f'{d} = {R(1)}')
            E(f"_check({d} == 0, m, {err}, 'division by zero')")
            E(f'{v} = _finite({R(0)} / {d}, m, {err})' if op == 'div' else f'{v} = _finite(np.fmod({R(0)}, {d}), m, {err})')
        elif op in _UNARY: E(f'{v} = {_UNARY[op]}({R(0)})')
        elif op in ('min', 'max'):   # a 0 / -0 tie keeps the JS sign (min → -0, max → +0). numpy leaves it to the platform
            a, b = self.tmp(), self.tmp()
            E(f'{a}, {b} = {R(0)}, {R(1)}')
            tie = f'np.where(np.signbit({a}), {a}, {b})' if op == 'min' else f'np.where(np.signbit({a}), {b}, {a})'
            E(f'{v} = np.where(({a} == 0) & ({b} == 0), {tie}, np.{"minimum" if op == "min" else "maximum"}({a}, {b}))')
        elif op == 'clamp':
            x, lo, hi = self.tmp(), self.tmp(), self.tmp()
            E(f'{x}, {lo}, {hi} = {R(0)}, {R(1)}, {R(2)}')
            E(f"_check({lo} > {hi}, m, {err}, 'clamp lower bound exceeds upper bound')")
            E(f'{v} = np.where({x} < {lo}, {lo}, np.where({x} > {hi}, {hi}, {x}))')
        elif op == 'sqrt':
            a = self.tmp()
            E(f'{a} = {R(0)}')
            E(f"_check({a} < 0, m, {err}, 'sqrt of a negative number')")
            E(f'{v} = np.sqrt(np.where(m, {a}, 0.0))')
        elif op == 'ln':
            a = self.tmp()
            E(f'{a} = {R(0)}')
            E(f"_check({a} <= 0, m, {err}, 'ln of a non-positive number')")
            E(f'{v} = np.log(np.where(m, {a}, 1.0))')
        elif op == 'exp': E(f'{v} = _finite(np.exp({R(0)}), m, {err})')
        elif op in _BINARY: E(f'{v} = {R(0)} {_BINARY[op]} {R(1)}')
        elif op == 'eq': E(f'{v} = np.asarray({R(0)} == {R(1)}, dtype=bool)')
        elif op == 'neq': E(f'{v} = ~np.asarray({R(0)} == {R(1)}, dtype=bool)')
        elif op == 'not': E(f'{v} = ~{R(0)}')
        elif op in ('and', 'or'):
            a, cont = self.tmp(), self.tmp()
            E(f'{a} = {R(0)}')
            E(f'{cont} = m & {a}' if op == 'and' else f'{cont} = m & ~{a}')
            fn, expr = self.branch(ctx, indent, ins[1])
            rhs = f'{fn}({cont})' if fn else expr
            E(f'{v} = np.where(m & ~{cont}, {a}, {rhs} if _nz({cont}) else np.zeros(B, dtype=bool))')
        elif op == 'select':
            c, tm, em = self.tmp(), self.tmp(), self.tmp()
            E(f'{c} = {R(0)}')
            E(f'{tm} = m & {c}')
            E(f'{em} = m & ~{c}')
            fa, ea = self.branch(ctx, indent, ins[1])
            fb, eb = self.branch(ctx, indent, ins[2])
            a = f'({fa}({tm}) if _nz({tm}) else None)' if fa else ea
            b = f'({fb}({em}) if _nz({em}) else None)' if fb else eb
            E(f'{v} = where({tm}, {a}, {b}, {self.const(t)})')
        elif op == 'vector': E(f'{v} = np.stack([{", ".join(R(i) for i in range(len(ins)))}], axis=1)')
        elif op == 'array': E(f'{v} = stack([{", ".join(R(i) for i in range(len(ins)))}], {self.const(t["of"])})')
        elif op == 'concat': E(f'{v} = np.concatenate([{", ".join(f"{R(i)}.reshape(B, -1)" for i in range(len(ins)))}], axis=1)')
        elif op == 'bits':
            width, n, ints = t['width'], self.tmp(), self.tmp()
            E(f'{n} = {R(0)}')
            E(f"_check(({n} != np.floor({n})) | ({n} < 0) | ({n} >= {float(1 << width)!r}), m, {err}, 'bits input must be an integer in 0..2^{width}-1')")
            E(f'{ints} = np.where(m, {n}, 0).astype(np.int64)')
            E(f'{v} = (({ints}[:, None] >> {self.const(np.arange(width, dtype=np.int64))}) & 1).astype(np.float64)')
        elif op == 'oneHot':
            width, n, ints = t['width'], self.tmp(), self.tmp()
            E(f'{n} = {R(0)}')
            E(f"_check(({n} != np.floor({n})) | ({n} < 0) | ({n} >= {width}), m, {err}, 'oneHot input must be an integer in 0..{width - 1}')")
            E(f'{ints} = np.where(m, {n}, 0).astype(np.int64)')
            E(f'{v} = np.zeros((B, {width}))')
            E(f'{v}[ar, {ints}] = 1.0')
        elif op in ('at', 'index'):
            src = self.types[ins[0]]
            length = src['width'] if src['type'] == 'vector' else src['length']
            k = self._static_index(node, length)
            if k is not None:
                E(f'{v} = take({R(0)}, {self.const(src)}, {k})' if src['type'] == 'array' else f'{v} = {R(0)}[:, {k}]')
            else:
                ints = self.tmp()
                if self._bounded_index(node, length): E(f'{ints} = {R(1)}.astype(np.int64)')
                else: E(f'{ints} = _int_index({R(1)}, {length}, m, {err})')
                raw, k, bound = self.ref_raw(ctx, indent, ins[0])
                lanes = 'ar' if k == 1 else f'(ar // {k})'
                if src['type'] == 'vector' or is_nd(src): E(f'{v} = {raw}[{lanes}, {ints}]')
                elif bound: E(f'{v} = _gather(s_{bound}, {self.const(src["of"])}, {lanes}, {ints})')
                else: E(f'{v} = _index_list({raw}, {self.const(src["of"])}, {ints}, {lanes})')
        elif op == 'slice':
            s, e2 = int(self.entries[ins[1]].node['value']), int(self.entries[ins[2]].node['value'])
            E(f'{v} = {R(0)}[:, {s}:{e2}]')
        elif op == 'get':   # read the field at the record's own lane count, expand only the field
            expr, k, _ = self.ref_raw(ctx, indent, ins[0])
            field = f'{expr}[{node["name"]!r}]'
            E(f'{v} = {field}' if k == 1 else f'{v} = _expand({field}, {self.const(t)}, {k})')
        elif op == 'record': E(f'{v} = {{{", ".join(f"{k!r}: {R(i)}" for i, k in enumerate(node["value"]))}}}')
        elif op == 'set':
            E(f'{v} = dict({R(0)})')
            E(f'{v}[{node["name"]!r}] = {R(1)}')
        elif op == 'update':
            src, ints = self.types[ins[0]], self.tmp()
            k = self._static_index(node, src['length'])
            if k is not None: E(f'{ints} = np.full(B, {k}, dtype=np.int64)')
            else: E(f'{ints} = _int_index({R(1)}, {src["length"]}, m, {err})')
            if is_nd(src):
                E(f'{v} = {R(0)}.copy()')
                E(f'{v}[ar, {ints}] = {R(2)}')
            else:
                a, val = self.tmp(), self.tmp()
                E(f'{a}, {val} = {R(0)}, {R(2)}')
                E(f'{v} = [where(m & ({ints} == j), {val}, {a}[j], {self.const(src["of"])}) for j in range({src["length"]})]')
        elif op == 'range': E(f'{v} = np.tile({self.const(np.arange(int(node["value"]), dtype=np.float64))}, (B, 1))')
        elif op in ('map', 'fold', 'scan'): self.loop(ctx, indent, nid)
        elif op == 'u32':
            a = self.tmp()
            E(f'{a} = {R(0)}')
            E(f"_check(({a} != np.floor({a})) | (np.abs({a}) >= 9007199254740992.0), m, {err}, 'u32 input is not a safe integer')")
            E(f'{v} = (np.where(m, {a}, 0).astype(np.int64) & np.int64(0xFFFFFFFF)).astype(np.float64)')
        elif op in ('imul32', 'add32', 'sub32', 'xor32', 'and32', 'or32'):
            a, b = self.tmp(), self.tmp()
            E(f'{a} = _u32_in({R(0)}, m, 1, {err})')
            E(f'{b} = _u32_in({R(1)}, m, 2, {err})')
            expr = {'imul32': f'({a} * {b}) & MASK32', 'add32': f'({a} + {b}) & MASK32', 'sub32': f'({a} - {b}) & MASK32', 'xor32': f'{a} ^ {b}', 'and32': f'{a} & {b}', 'or32': f'{a} | {b}'}[op]
            E(f'{v} = ({expr}).astype(np.float64)')
        elif op in ('shl32', 'shr32'):
            a, s, sh = self.tmp(), self.tmp(), self.tmp()
            E(f'{a} = _u32_in({R(0)}, m, 1, {err})')
            E(f'{s} = {R(1)}')
            E(f"_check(({s} != np.floor({s})) | ({s} < 0) | ({s} > 31), m, {err}, 'shift count is not an integer in 0..31')")
            E(f'{sh} = np.where(m, {s}, 0).astype(np.uint64)')
            E(f'{v} = (({a} << {sh}) & MASK32).astype(np.float64)' if op == 'shl32' else f'{v} = ({a} >> {sh}).astype(np.float64)')
        elif op == 'rand': E(f'{v} = rand_hash(_u32_in({R(0)}, m, 1, {err}), _u32_in({R(1)}, m, 2, {err}))')
        elif op == 'bucket': E(f"{v} = np.searchsorted({self.const(np.asarray(node['value'], dtype=np.float64))}, {R(0)}, side='right').astype(np.float64)")
        elif op == 'thermometer': E(f'{v} = ({R(0)}[:, None] >= {self.const(np.asarray(node["value"], dtype=np.float64))}[None, :]).astype(np.float64)')
        elif op == 'tableAt':
            tb, i, ints, col = self.tmp(), self.tmp(), self.tmp(), self.tmp()
            E(f'{tb}, {i} = {R(0)}, {R(1)}')
            E(f"_check(({i} != np.floor({i})) | ({i} < {tb}.lo) | ({i} > {tb}.hi), m, {err}, 'row outside the table view')")
            E(f'{ints} = np.where(m, {i}, {tb}.lo).astype(np.int64)')
            E(f'{col} = {tb}.columns[{node["name"]!r}]')
            E(f'{v} = _finite({col}[np.clip({ints}, 0, {col}.shape[0] - 1)], m, {err})')
        elif op == 'tableWindow':
            k = int(node['value'])
            tb, end, ints, col, rows = self.tmp(), self.tmp(), self.tmp(), self.tmp(), self.tmp()
            E(f'{tb}, {end} = {R(0)}, {R(1)}')
            E(f"_check(({end} != np.floor({end})) | ({end} - {k - 1} < {tb}.lo) | ({end} > {tb}.hi), m, {err}, 'window outside the table view')")
            E(f'{ints} = np.where(m, {end}, {tb}.lo + {k - 1}).astype(np.int64)')
            E(f'{col} = {tb}.columns[{node["name"]!r}]')
            E(f'{rows} = np.clip({ints}[:, None] - {k - 1} + {self.const(np.arange(k, dtype=np.int64))}[None, :], 0, {col}.shape[0] - 1)')
            E(f'{v} = {col}[{rows}]')
            E(f"_check(~np.all(np.isfinite({v}), axis=1), m, {err}, 'table cell is not finite')")
        elif op == 'sum': E(f'{v} = _finite(np.add.accumulate({R(0)}, axis=1)[:, -1], m, {err})')
        elif op in ('minOf', 'maxOf'):   # the first extreme by strict </> (argmin/argmax), so a signed zero keeps the JS sign
            a = self.tmp()
            E(f'{a} = {R(0)}')
            E(f'{v} = {a}[ar, np.{"argmin" if op == "minOf" else "argmax"}({a}, axis=1)]')
        elif op == 'argminFirst': E(f'{v} = np.argmin({R(0)}, axis=1).astype(np.float64)')
        elif op == 'argmaxFirst': E(f'{v} = np.argmax({R(0)}, axis=1).astype(np.float64)')
        elif op == 'any': E(f'{v} = np.any({R(0)}, axis=1)')
        elif op == 'all': E(f'{v} = np.all({R(0)}, axis=1)')
        elif op == 'count': E(f'{v} = np.count_nonzero({R(0)}, axis=1).astype(np.float64)')
        else: raise ProgramError(f'op {op!r} has no code generator', node['id'], op)
        if nid in self.stacked: E(f's_{v} = _stack_leaves({v}, {self.const(t["of"])})')

    def loop(self, ctx, indent, nid):
        e = self.entries[nid]
        node, v = e.node, self.names[nid]
        op, ins, body = node['op'], node['inputs'], e.body
        t_arr = self.types[ins[0]]
        n, arr = t_arr['length'], self.tmp()
        E = lambda line: self.emit(indent, line)
        E(f'{arr} = {self.ref(ctx, indent, ins[0])}')
        inner = _Ctx(body, ctx.factor * (n if op == 'map' else 1), ctx)
        fn = self.tmp()
        params = [self.pname[(id(body), j)] for j in range(len(body.params))]
        self.scope_function(inner, indent, fn, ['m', 'B'] + params)
        if op == 'map':
            idx = self.const(np.arange(n, dtype=np.float64))
            E(f'{v} = _deinterleave({fn}(np.repeat(m, {n}), B * {n}, _elements({arr}, {self.const(t_arr)}, B, {n}), np.tile({idx}, B)), {self.const(self.types[body.output])}, B, {n})')
            return
        acc = self.tmp()
        E(f'{acc} = {self.ref(ctx, indent, ins[1])}')
        if op == 'scan': E(f'{v} = []')
        E(f'for i in range({n}):')
        E(f'    {acc} = {fn}(m, B, {acc}, take({arr}, {self.const(t_arr)}, i), np.full(B, float(i)))')
        if op == 'scan':
            E(f'    {v}.append({acc})')
            E(f'{v} = stack({v}, {self.const(self.types[ins[1]])})')
        else: E(f'{v} = {acc}')

    def program(self):
        root = self.info.root
        ctx = _Ctx(root, 1, None)
        params = [self.pname[(id(root), j)] for j in range(len(root.params))]
        self.scope_function(ctx, 0, 'run', ['m', 'B'] + params)
        return '\n'.join(self.lines) + '\n'


def generate(info):
    """Generated source and the constant namespace for a checked program (exposed for inspection / debugging)."""
    gen = _Gen(info)
    source = gen.program()
    ns = dict(_NAMESPACE)
    for i, c in enumerate(gen.consts): ns[f'_K{i}'] = c
    return source, ns


class Compiled:
    """A checked program compiled to one numpy function. `run(args, batch, mask=None)` → batched result of `self.result`."""

    def __init__(self, program, param_types, exact=False, check_args=True, check_result=True):
        info = analyze(program, param_types, exact)
        self.info, self.check_args, self.check_result = info, check_args, check_result
        self.result, self.cost, self.params, self.param_types = info.result, info.cost, list(info.root.params), info.param_types
        self.source, ns = generate(info)
        exec(builtins.compile(self.source, '<neurom-program>', 'exec'), ns)
        self._run = ns['run']

    def run(self, args, batch, mask=None):
        B = int(batch)
        if len(args) != len(self.params): raise ProgramError(f'{len(self.params)} arguments expected, got {len(args)}')
        mask = np.ones(B, dtype=bool) if mask is None else np.asarray(mask, dtype=bool)
        if mask.shape != (B,): raise ProgramError(f'mask must be [{B}]')
        values = [_validate(t, v, B, mask, f'argument {name!r}') for t, v, name in zip(self.param_types, args, self.params)] if self.check_args else list(args)
        if not _nz(mask): return empty(self.result, B)
        with np.errstate(all='ignore'):   # inactive lanes can hold garbage. Every rule checks only active lanes
            out = self._run(mask, B, *values)
        return _validate(self.result, out, B, mask, 'result') if self.check_result else out


def compile(program, param_types, exact=False, check_args=True, check_result=True):
    """check_args / check_result=False skip the structural walks over arguments / result (only when the caller guarantees
    the batched shapes, for example values that are themselves IR results). Every runtime rule still applies."""
    return Compiled(program, param_types, exact, check_args, check_result)
