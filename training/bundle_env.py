"""Batched Python twin of frontend/core/runner.js: runs a bundle's `env` (ADR 0009 §1) over B independent lanes with masks.

    env = create_env(bundle['env'], tables={datasetId: {column: values}})
    env.reset(starts)            # list of B plain Start records ({seed} | {index, axis…} | {start, length})
    env.input()                  # float64 [B, I] of 0/1 bits: input(state, rows ≤ cursor)
    env.step(actions)            # actions [B]. Done lanes are masked (never evaluated). Returns the batched Transition
    env.done, env.t, env.state   # bool [B], int64 [B], batched State
    env.full_table()             # [full table view] or [] — the table argument targets receive

Per lane, the semantics are exactly the semantics of the browser runner:
    reset     → state = init ? init(start) : start, t = 0
    step(a)   → r = step(state, a, rows ≤ cursor + 1)
                truncated = !r.done && t + 1 ≥ budget
                done = r.done || truncated
                Transition = {prev: state, action: a, next: r.state, done, truncated, success: r.success}
                state = r.state, t += 1
A step on a lane that is done does nothing on that lane. A step when every lane is done is an error.
cursor = start.start + t for window episodes, else t. Scenario parameters are not the runner's: each program carries
the file-level values it reads as bound values.

Batched values follow training/ir.py: number/boolean → ndarray [B], vector → [B, w], record → dict, array → [B, n, …] or
list, table → ir.Table with per-lane bounds. `ir.lane(T, value, i)` turns lane i back into plain JSON.
"""
import numpy as np

import ir

NUMBER, BOOLEAN = {'type': 'number'}, {'type': 'boolean'}


class RunnerError(ValueError):
    """The bundle is malformed, a program returned a value outside its declared type, or the runner was misused."""


def constant_batch(t, value, B):
    """A plain JSON value replicated over B lanes."""
    return ir.to_batch(t, [value] * B)


class BoundProgram:
    """A bundle program entry `{program, bound, boundTypes, exact}` compiled for a positional signature. The bound
    names (the file-level values the program reads) are appended as per-batch constants."""

    def __init__(self, entry, param_types, name):
        program = entry.get('program') if isinstance(entry, dict) else None
        if not isinstance(program, dict): raise RunnerError(f'program {name} is missing')
        params = program.get('params', [])
        bound_names = params[len(param_types):]
        bound = entry.get('bound') or {}
        bound_types = entry.get('boundTypes') or {}
        for n in bound_names:
            if n not in bound: raise RunnerError(f'program {name}: parameter {n!r} has no bound value')
            if n not in bound_types: raise RunnerError(f'program {name}: parameter {n!r} has no bound type')
        self.bound_types = [bound_types[n] for n in bound_names]
        self.bound_values = [bound[n] for n in bound_names]
        try: self.compiled = ir.compile(program, list(param_types) + self.bound_types, exact=entry.get('exact', True) is not False, check_args=False, check_result=False)   # callers validate (runner `ensure`)
        except ir.ProgramError as e: raise RunnerError(f'program {name} does not type-check: {e}') from e
        self.result, self.cost, self.name = self.compiled.result, self.compiled.cost, name
        self._cache = (None, None)

    def _constants(self, B):
        if self._cache[0] != B: self._cache = (B, [constant_batch(t, v, B) for t, v in zip(self.bound_types, self.bound_values)])
        return self._cache[1]

    def run(self, args, B, mask=None):
        try: return self.compiled.run(list(args) + self._constants(B), B, mask)
        except ir.ProgramError as e: raise RunnerError(f'{self.name}: {e}') from e


def compile_entry(entry, param_types, name):
    """BoundProgram for a bundle entry (objective, metrics, selection …), or None when the entry is absent."""
    return None if entry is None else BoundProgram(entry, param_types, name)


def ensure(t, v, B, mask, what):
    try: return ir._validate(t, v, B, mask, what)
    except ir.ProgramError as e: raise RunnerError(str(e)) from e


def copy_value(v):
    if isinstance(v, np.ndarray): return v.copy()
    if isinstance(v, dict): return {k: copy_value(x) for k, x in v.items()}
    if isinstance(v, list): return [copy_value(x) for x in v]
    if isinstance(v, ir.Table): return ir.Table(v.columns, v.lo.copy(), v.hi.copy())
    return v


class BundleEnv:
    def __init__(self, env_bundle, tables=None):
        if not isinstance(env_bundle, dict): raise RunnerError('env bundle must be an object')
        programs, types = env_bundle.get('programs'), env_bundle.get('types')
        if not isinstance(programs, dict) or not isinstance(types, dict): raise RunnerError('the env bundle lacks programs or types')
        budget = env_bundle.get('budget')
        if isinstance(budget, bool) or not isinstance(budget, int) or budget < 1: raise RunnerError(f'budget must be a positive integer, got {budget!r}')
        if env_bundle.get('start') not in ('seed', 'enumerate', 'window'): raise RunnerError(f"env.start must be seed, enumerate or window, got {env_bundle.get('start')!r}")
        for key in ('Start', 'State', 'Transition', 'I'):
            if key not in types: raise RunnerError(f'env types lack {key}')
        self.bundle, self.types, self.budget = env_bundle, types, budget
        self.Start, self.State, self.I = types['Start'], types['State'], types['I']
        self.window = env_bundle['start'] == 'window'
        self.Tbl = types.get('table')
        tbl = [self.Tbl] if self.Tbl else []
        self.columns, self.rows = None, 0
        if env_bundle.get('tables'):
            tid = env_bundle['tables'][0]['id']
            if not tables or tid not in tables: raise RunnerError(f'missing data for dataset {tid}')
            cols = {name: np.asarray(col, dtype=np.float64) for name, col in tables[tid].items()}
            if not cols: raise RunnerError(f'dataset {tid} has no columns')
            self.columns = cols
            self.rows = max(c.shape[0] for c in cols.values())
            if self.Tbl is None: raise RunnerError('env reads a table but types.table is missing')
        for name in ('input', 'step'):
            if programs.get(name) is None: raise RunnerError(f'the env bundle lacks program {name}')
        self.fn = {
            'init': compile_entry(programs.get('init'), [self.Start], 'init'),
            'input': compile_entry(programs['input'], [self.State] + tbl, 'input'),
            'step': compile_entry(programs['step'], [self.State, NUMBER] + tbl, 'step'),
        }
        if self.fn['init'] is None and not ir.same_type(ir.canonical_type(self.Start), ir.canonical_type(self.State)): raise RunnerError('without init the State type must be the Start type')
        self.B = None
        self.state = self.start = None
        self.t = self.done = None
        self._start = None

    @property
    def cursor(self):
        return self._start + self.t

    def _view(self, hi):
        """Table view rows 0..min(hi, rows-1) per lane (empty when the table has no rows)."""
        return ir.Table(self.columns, np.zeros(self.B, dtype=np.int64), np.minimum(np.asarray(hi, dtype=np.int64), self.rows - 1))

    def _table_args(self, hi):
        return [self._view(hi)] if self.columns is not None else []

    def full_table(self):
        """The table argument of a target objective: every row (empty list when the env reads no table)."""
        return self._table_args(np.full(self.B, self.rows - 1, dtype=np.int64))

    # -- runner API
    def reset(self, starts):
        """starts: list of plain Start records, one per lane. B = len(starts): the env rebinds to the lane count of each
        reset (train and validation batches can have different sizes)."""
        if not isinstance(starts, (list, tuple)) or not starts: raise RunnerError('reset needs a non-empty list of start records')
        B = self.B = len(starts)
        ones = np.ones(B, dtype=bool)
        try: st = ir.to_batch(self.Start, list(starts))
        except (ir.ProgramError, KeyError, TypeError, ValueError) as e: raise RunnerError(f'start records do not match {ir.type_name(self.Start)}: {e}') from e
        self.start = ensure(self.Start, st, B, ones, 'start')
        self._start = self.start['start'].astype(np.int64) if self.window else np.zeros(B, dtype=np.int64)
        self.state = ensure(self.State, self.fn['init'].run([self.start], B), B, ones, 'init') if self.fn['init'] else copy_value(self.start)
        self.t = np.zeros(B, dtype=np.int64)
        self.done = np.zeros(B, dtype=bool)
        return self.state

    # `check` types IR results statically, and the IR runtime checks every node for finite values. So this code does not
    # walk IR results again, unlike inputs from outside. Only the binary constraint on input bits needs a runtime test.
    def input(self):
        """Input bits [B, I] for the current state, evaluated in live lanes (every lane once all are done: programs then
        run on neutral lanes)."""
        if self.state is None: raise RunnerError('call reset first')
        mask = ~self.done
        if not mask.any(): mask = np.ones(self.B, dtype=bool)
        bits = self.fn['input'].run([self.state] + self._table_args(self.cursor), self.B, mask)
        live = bits if mask.all() else bits[mask]
        if not ((live == 0) | (live == 1)).all(): raise RunnerError('input must return 0/1 bits')
        return bits

    def step(self, actions):
        """Advance every live lane by one step. Returns the batched Transition `{prev, action, next, done, truncated,
        success, active}`. `active` marks the lanes that the step advanced. Values of other lanes are neutral, and callers must ignore them."""
        if self.state is None: raise RunnerError('call reset first')
        B = self.B
        active = ~self.done
        all_active = active.all()
        if not all_active and not active.any(): raise RunnerError('every lane is done; reset before stepping again')
        a = np.asarray(actions)
        if a.shape != (B,) or a.dtype == object or a.dtype == bool: raise RunnerError(f'actions must be a numeric array [{B}]')
        a = a.astype(np.float64, copy=False)
        if not np.isfinite(a if all_active else a[active]).all(): raise RunnerError('actions must be finite numbers')
        r = self.fn['step'].run([self.state, a] + self._table_args(self.cursor + 1), B, active)
        nxt = r['state'] if all_active else ir.where(active, r['state'], self.state, self.State)
        truncated = ~r['done'] & ((self.t + 1) >= self.budget) & active
        done = (r['done'] & active) | truncated
        tr = {'prev': self.state, 'action': np.where(active, a, 0.0), 'next': nxt, 'done': done, 'truncated': truncated, 'success': r['success'] & active, 'active': active}
        self.state = nxt
        self.t = self.t + active
        self.done = self.done | done
        return tr


def create_env(env_bundle, tables=None):
    return BundleEnv(env_bundle, tables=tables)


def transition(tr):
    """The Transition record of a batched step result (without the runner's `active` mask)."""
    return {k: tr[k] for k in ('prev', 'action', 'next', 'done', 'truncated', 'success')}


def episode_summary_type(state_type):
    """Type of the Episode summary metrics receive (Episode = {initial, final, steps, success, return})."""
    return {'type': 'record', 'fields': {'initial': state_type, 'final': state_type, 'steps': NUMBER, 'success': BOOLEAN, 'return': NUMBER}}
