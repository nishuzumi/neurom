#!/usr/bin/env python3
"""Python trainers over `neurom-bundle` trainer bundles (twin of frontend/training/*.js).

    python3 training/bundle_train.py --run-dir DIR        # reads DIR/bundle.json (+ DIR/tables.json, DIR/run.json), prints
                                                          # {"type":"progress",…} JSON lines, writes DIR/result.json
    train_bundle(bundle, on_progress=None, tables=None, bundle_hash=None) → {model, evaluation, provenance}

Every method runs the whole loop (ADR 0009 §2). Per step, the batched env gives the input bits of the loop. The loop
executor (training/bundle_loop.py) runs every other network frozen with its accepted integer model. It intercepts the
trained network `loop.trained`: the trainer gets the `in` bits of that network and returns its readout result. Only the
trained network learns. Steps (lanes) where the loop did not demand it carry no loss.
Methods (bundle.recipe.method). validate_bundle checks their requirements against the trained network and its readout:
    reinforce      dense engine · reward objective fn(Transition)→number (with `loop.<title>.<port>` when the loop has tool
                   layers) · argmax readout (bits when the last layer is a tool layer: its result bits are the action).
                   B episodes per epoch run in lockstep. The policy samples the readout slots from
                   softmax(scores/(ticks·gain_out)). It samples the choice of each tool layer from softmax and each data
                   bit from a Bernoulli. Only the chosen tool runs, from the tool state of that lane. That state is zero
                   at each episode start and advances only on the steps that choose the tool. All of these
                   log-probabilities go into one policy gradient. Return-to-go (the reward of every live step) uses a
                   per-step EMA baseline over the lanes that decided. An entropy bonus covers every decision. BPTT goes
                   through the LIF voltage. This is the only method for a network with tool layers (ADR 0010 §6).
    cross-entropy  dense engine · target objective fn(State[, table])→bits[O] (mask of acceptable slots, on the state
                   before the step) · argmax readout. Behaviour = teacher slot (random among set bits), with
                   `exploration` uniform random. Loss = mean over labelled decisions of −Σ_k y_k log softmax_k
                   (y = mask normalised). Unlabelled decisions (no bit set) carry no loss, but the voltage flows (BPTT).
    hinge          threshold engine · target objective fn(State[, table])→bits[O] (exact output bits) · bits readout.
                   Rows = (intercepted input bits, target) of every decision. Behaviour = the target bits (the
                   teacher). The trainer rolls out every episode of the training partition once (recipe
                   episodesPerEpoch / replicas do not apply, as in the browser). Loss = mean Σ_k max(0, margin −
                   (2y_k−1)·z_k/gain) on the output pre-activation, with boxcar STE through hidden layers. One
                   full-batch Adam step per epoch. Training stops early when the default validation accuracy is exact.
All forward passes are quantisation-aware (ADR 0015). Parameters are real-unit shadows. On each forward, quantize_region
quantises every region (one affine map) to weightBits 8 | 16 codes with its own scale s = Q / max|W| and shift k (its
biases int16 at s·2^k, gain = s·2^k). The region then runs on its accumulator integers through a straight-through
estimator. So the exported integers are the weights that every reported number was measured with
(evaluation.quantization lists the scale, k, clipped counts and LIF threshold of each region). Validation = the greedy
integer loop (bundle_loop.run_episodes, the trained network given its candidate model) on the validation partition.
The selection metric is the `selection` program of the bundle (mean over Episode summaries). Without that program, the
metric is mean return (reward) or the accuracy of the trained readout on labelled validation decisions (target).
Checkpoints are kept on strict improvement.
"""
import argparse, json, math, os, platform, sys, time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ir  # noqa: E402
from bundle_env import BoundProgram, RunnerError, compile_entry, create_env, episode_summary_type  # noqa: E402
from bundle_loop import DENSE_FORMAT, THRESHOLD_FORMAT, create_loop, is_tool, run_episodes, transition_type  # noqa: E402

BUNDLE_FORMAT = 'neurom-bundle'
DENSE, THRESHOLD = 'dense-policy', 'threshold-layers'
METHODS = {
    'reinforce': {'engine': DENSE, 'readout': 'argmax', 'objective': 'reward'},
    'cross-entropy': {'engine': DENSE, 'readout': 'argmax', 'objective': 'target'},
    'hinge': {'engine': THRESHOLD, 'readout': 'bits', 'objective': 'target'},
}
ENGINES = (DENSE, THRESHOLD)
INT16_MIN, INT16_MAX, INT32_MAX = -32768, 32767, 2147483647
CODE_MAX = {8: 127, 16: 32767}                          # Q: weight codes per weightBits lie in [−Q, Q]
K_MAX = 20                                              # a region's accumulator shift k ∈ 0..K_MAX
MAX_BITS = 65535                                        # ports, actions and layer widths (ADR 0021, core/types.js MAX_BITS)
MODEL_KEYS = {DENSE: {'format', 'kind', 'inputs', 'outputs', 'weightBits', 'ticks', 'leak_shift', 'reset', 'layers', 'output'},
              THRESHOLD: {'format', 'inputs', 'outputs', 'weightBits', 'layers'}}
PROGRESS_POINTS, CURVE_POINTS = 400, 256
ADAM = {'betas': (0.9, 0.999), 'eps': 1e-8}
TAPE_BUDGET = 1 << 26                                    # decisions × ticks × episodes × hidden retained for BPTT
NUMBER = {'type': 'number'}
# recipe field → (lo, hi, integer). Mirrors the schema in core/kinds/trainer.js.
RECIPE_FIELDS = {'epochs': (1, 100000, True), 'lr': (1e-6, 1, False), 'replicas': (1, 64, True), 'seed': (0, 0xffffffff, True), 'evalEvery': (1, 100000, True),
                 'entropy': (0, 10, False), 'gamma': (0, 1, False), 'margin': (0, 1e6, False), 'exploration': (0, 1, False),
                 'baselineDecay': (0, 1, False), 'gradClip': (0, 1e6, False), 'surrogateWidth': (1e-6, 1e6, False), 'initCurrent': (-1e6, 1e6, False),
                 'episodesPerEpoch': (1, 4096, True), 'calibrationEpisodes': (1, 4096, True)}
RECIPE_DEFAULTS = {'epochs': 300, 'lr': 0.01, 'replicas': 8, 'seed': 1, 'evalEvery': 10, 'entropy': 0, 'gamma': 1, 'margin': 1,
                   'exploration': 0.25, 'baselineDecay': 0.9, 'gradClip': 1, 'surrogateWidth': 1, 'initCurrent': 0.5, 'episodesPerEpoch': 32, 'calibrationEpisodes': 32}


class BundleError(ValueError):
    """The bundle cannot be trained: malformed, unmet method requirements, or programs that do not type-check."""


def now(): return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _torch():
    import torch
    return torch


def capabilities():
    return {'methods': sorted(METHODS), 'engines': list(ENGINES), 'backend': 'python'}


# ───────────────────────────── validation ─────────────────────────────
def _num(v, name, lo, hi, integer):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi or (integer and int(v) != v):
        raise BundleError(f'recipe.{name} must be {"an integer" if integer else "a number"} in {lo}..{hi}')
    return int(v) if integer else float(v)


def normalize_recipe(recipe):
    if not isinstance(recipe, dict) or recipe.get('method') not in METHODS: raise BundleError(f'recipe.method must be one of {sorted(METHODS)}')
    out = {'method': recipe['method']}
    for name, (lo, hi, integer) in RECIPE_FIELDS.items():
        out[name] = _num(recipe.get(name, RECIPE_DEFAULTS[name]), name, lo, hi, integer)
    out['backend'] = 'python'
    return out


def _program_entry(entry, what):
    if not isinstance(entry, dict) or not isinstance(entry.get('program'), dict): raise BundleError(f'{what} must be a program entry {{program, bound, boundTypes, exact}}')


def _int(v, lo, hi): return not isinstance(v, bool) and isinstance(v, int) and lo <= v <= hi
def _bits(v): return not isinstance(v, bool) and isinstance(v, int) and v in CODE_MAX


def _dense_layer(L):
    """A plain layer {hidden: 1..MAX_BITS} or a tool layer {tools: port, K, D, R: 1..MAX_BITS}."""
    if not isinstance(L, dict): return False
    if 'tools' in L: return isinstance(L['tools'], str) and bool(L['tools']) and all(_int(L.get(k), 1, MAX_BITS) for k in ('K', 'D', 'R'))
    return _int(L.get('hidden'), 1, MAX_BITS)


def validate_structure(net, what):
    """A network entry's fields are within the executors' bounds."""
    if net.get('engine') not in ENGINES: raise BundleError(f'{what}.engine must be one of {list(ENGINES)}')
    for name, lo, hi in (('inputs', 1, MAX_BITS), ('outputs', 1, MAX_BITS)):
        if not _int(net.get(name), lo, hi): raise BundleError(f'{what}.{name} must be an integer in {lo}..{hi}')
    if not _bits(net.get('weightBits')): raise BundleError(f'{what}.weightBits must be 8 or 16')
    if net['engine'] == DENSE:
        if net.get('kind') not in ('feedforward', 'lif'): raise BundleError(f'{what}.kind must be feedforward or lif')
        for name, lo, hi in (('ticks', 1, 64), ('leak_shift', 0, 10), ('reset', INT16_MIN, INT16_MAX)):
            if not _int(net.get(name), lo, hi): raise BundleError(f'{what}.{name} must be an integer in {lo}..{hi}')
        layers = net.get('layers')
        if not isinstance(layers, list) or not 1 <= len(layers) <= 8 or not all(_dense_layer(L) for L in layers): raise BundleError(f'{what}.layers must be 1..8 plain layers {{hidden: 1..{MAX_BITS}}} or tool layers {{tools, K, D, R: 1..{MAX_BITS}}}')
        if is_tool(layers[-1]) and net['outputs'] != layers[-1]['R']: raise BundleError(f'{what}.outputs must equal the result width R of its last (tool) layer')
    else:
        layers = net.get('layers')
        if not isinstance(layers, list) or not 1 <= len(layers) <= 8 or any(not _int(h, 1, MAX_BITS) for h in layers): raise BundleError(f'{what}.layers must be 1..8 integers in 1..{MAX_BITS}')


def required_readout(method, net):
    """The readout mode `method` needs on network `net` (core/kinds/trainer.js requiredReadout): a trailing tool layer's
    result bits are the output, read back by a bits readout."""
    need = METHODS[method]['readout']
    return 'bits' if need == 'argmax' and net.get('engine') == DENSE and is_tool(net['layers'][-1]) else need


def trained_parts(bundle):
    """(networkId, network structure, readoutId, readout spec) of the loop's trained network."""
    loop = bundle['loop']
    nid = loop.get('trained')
    nodes = loop.get('nodes') or {}
    if not isinstance(nid, str) or (nodes.get(nid) or {}).get('kind') != 'network': raise BundleError('loop.trained must name a network of the loop')
    readouts = [rid for rid, n in nodes.items() if n.get('kind') == 'readout' and (n.get('scores') or {}).get('node') == nid]
    if len(readouts) != 1: raise BundleError(f'the trained network {nid} needs exactly one readout in the loop, found {len(readouts)}')
    return nid, nodes[nid]['structure'], readouts[0], nodes[readouts[0]]['readout']


def objective_params(bundle, kind):
    """The objective's parameter types: the loop's Transition (reward) or State[, table] (target)."""
    types = bundle['env']['types']
    if kind == 'reward': return [transition_type(types['Transition'], bundle['loop'])]
    return [types['State']] + ([types['table']] if types.get('table') else [])


def _validate_tools(n, what):
    """Every network tool wired into `n`'s tool layers (recursively, through a tool's own `tools`) has a valid structure
    and accepted weights."""
    for port, tools in (n.get('tools') or {}).items():
        for k, tool in enumerate(tools if isinstance(tools, list) else []):
            if isinstance(tool, dict) and tool.get('kind') == 'net':
                name = f'{what}.{port}[{k}]'
                validate_structure(tool.get('structure') or {}, f'tool {name}')
                if tool.get('model') is None: raise BundleError(f'tool {name} has no accepted weights')
                validate_model(tool['model'], tool['structure'])
                _validate_tools(tool, name)


def validate_bundle(bundle, tables=None):
    """Structure, method requirements and program checks (env programs compile through bundle_env, the loop through
    bundle_loop, objective and selection through training/ir.py). Returns the normalised recipe. Raises BundleError."""
    if not isinstance(bundle, dict) or bundle.get('format') != BUNDLE_FORMAT: raise BundleError(f'bundle.format must be {BUNDLE_FORMAT}')
    for key in ('env', 'loop', 'objective', 'partitions', 'recipe'):
        if not isinstance(bundle.get(key), dict): raise BundleError(f'trainer bundle lacks {key}')
    recipe = normalize_recipe(bundle['recipe'])
    need = METHODS[recipe['method']]
    objective = bundle['objective']
    nid, net, _, readout = trained_parts(bundle)
    for other, n in bundle['loop']['nodes'].items():
        if n.get('kind') != 'network': continue
        validate_structure(n.get('structure') or {}, f'network {other}')
        if other != nid:
            if n.get('model') is None: raise BundleError(f'network {other} has no accepted weights')
            validate_model(n['model'], n['structure'])
        _validate_tools(n, other)
    init = bundle.get('init')                                            # the start of the run (ADR 0020): the model of an accepted artifact
    if init is not None:
        if not isinstance(init, dict) or not isinstance(init.get('model'), dict): raise BundleError('init must be {artifactId, model}')
        try: validate_model(init['model'], net)
        except BundleError as e: raise BundleError(f'init does not fit the trained network: {e}') from e
    if net.get('engine') != need['engine']: raise BundleError(f"{recipe['method']} needs the {need['engine']} engine, got {net.get('engine')!r}")
    if net['engine'] == DENSE and recipe['method'] != 'reinforce' and any(is_tool(L) for L in net['layers']): raise BundleError(f"a network with tool layers trains by reinforce only, not {recipe['method']} (ADR 0010 §6)")
    mode = required_readout(recipe['method'], net)
    if readout.get('mode') != mode: raise BundleError(f"{recipe['method']} needs the {mode} readout, got {readout.get('mode')!r}")
    if objective.get('kind') != need['objective']: raise BundleError(f"{recipe['method']} needs a {need['objective']} objective, got {objective.get('kind')!r}")
    _program_entry(objective, 'objective')
    O = net['outputs']
    if readout['mode'] == 'argmax':
        m = readout.get('map')
        if not isinstance(m, list) or len(m) != O or any(a is not None and (isinstance(a, bool) or not isinstance(a, int) or a < 0) for a in m): raise BundleError('readout.map must hold O action indices or null')
        actions = bundle['env'].get('actions')
        if isinstance(actions, list):
            for a in m:
                if a is not None and a >= len(actions): raise BundleError(f'readout.map points at action {a} but the env has {len(actions)}')
    else:
        if readout.get('width') != O or readout.get('decode') != 'lsb-int' or O > 53: raise BundleError('bits readout needs width O ≤ 53 and lsb-int decoding')
    if not isinstance(bundle['partitions'].get('training'), dict): raise BundleError('partitions.training is required')
    for role in ('training', 'validation'):
        p = bundle['partitions'].get(role)
        if p is not None and p.get('kind') not in ('seed', 'enumerate', 'window'): raise BundleError(f'partitions.{role}.kind is unknown')
    tbs = bundle['env'].get('tables')
    if tbs is not None and (not isinstance(tbs, list) or any(not isinstance(tb, dict) or not isinstance(tb.get('id'), str) or not isinstance(tb.get('columns', []), list) for tb in tbs)):
        raise BundleError('env.tables must be a list of {id, hash, columns}')
    try:
        # programs must compile even when the dataset rows are not at hand: an empty table of the declared columns suffices
        check_tables = tables if tables is not None else {tb['id']: {c: [] for c in tb.get('columns', [])} for tb in bundle['env'].get('tables') or []}
        env = create_env(bundle['env'], tables=check_tables)
        lx = create_loop(bundle['loop'])
    except RunnerError as e: raise BundleError(f'env: {e}') from e
    if lx.I != env.I: raise BundleError(f'loop.I {lx.I} differs from the environment input width {env.I}')
    if lx.width(bundle['loop']['nodes'][nid]['in']) != net['inputs']: raise BundleError(f"network {nid}.inputs {net['inputs']} differs from the width of its input")
    types = bundle['env']['types']
    try:
        prog = BoundProgram(objective, objective_params(bundle, need['objective']), 'objective')
        if need['objective'] == 'reward' and prog.result != NUMBER: raise BundleError(f'reward objective must return a number, got {ir.type_name(prog.result)}')
        if need['objective'] == 'target' and (prog.result.get('type') != 'vector' or prog.result.get('width') != O): raise BundleError(f'target objective must return a vector of width {O}, got {ir.type_name(prog.result)}')
        if bundle.get('selection') is not None:
            _program_entry(bundle['selection'], 'selection')
            sel = BoundProgram(bundle['selection'], [episode_summary_type(types['State'])], 'selection')
            if sel.result != NUMBER: raise BundleError(f'selection metric must return a number, got {ir.type_name(sel.result)}')
    except RunnerError as e: raise BundleError(str(e)) from e
    return recipe


# ───────────────────────────── episodes over partitions ─────────────────────────────
def _product(axes):
    out = [{}]
    for name in axes: out = [{**partial, name: value} for partial in out for value in axes[name]]
    return [{'index': i, **ep} for i, ep in enumerate(out)]


def _select(all_eps, selection):
    if selection == 'all': return all_eps
    if selection == 'even': return [e for e in all_eps if e['index'] % 2 == 0]
    if selection == 'odd': return [e for e in all_eps if e['index'] % 2 == 1]
    if isinstance(selection, dict): return [e for e in all_eps if e['index'] % selection['mod'] in selection['rem']]
    return [all_eps[i] for i in selection]


def episodes_of(partition, rows=None):
    if partition['kind'] == 'seed': return [{'seed': partition['seed'] + i} for i in range(partition['count'])]
    if partition['kind'] == 'enumerate': return _select(_product(partition['axes']), partition['select'])
    rng = partition.get('range')
    if not rng: return []
    n = rows if rows is not None else partition.get('rows', 0)
    lo = math.floor(rng[0] * n) + (partition.get('embargo', 0) if rng[0] > partition.get('first', rng[0]) else 0)
    hi = math.floor(rng[1] * n)
    return [{'start': s, 'length': partition['length']} for s in range(lo, hi - partition['length'] + 1, partition['stride'])]


def draw_episodes(partition, n, rng, rows=None):
    if partition['kind'] == 'seed': return [{'seed': int(partition['seed'] + rng.integers(0, partition['count']))} for _ in range(n)]
    all_eps = episodes_of(partition, rows)
    if not all_eps: raise BundleError('the partition has no episodes')
    return [all_eps[int(rng.integers(0, len(all_eps)))] for _ in range(n)]


def epoch_episodes(partition, recipe, rng, rows=None):
    if partition['kind'] == 'seed': return draw_episodes(partition, recipe['episodesPerEpoch'] * recipe['replicas'], rng, rows)
    all_eps = episodes_of(partition, rows)
    if not all_eps: raise BundleError('the partition has no episodes')
    return all_eps * recipe['replicas']


def validation_episodes(bundle, rows=None):
    if bundle['partitions'].get('validation'): return episodes_of(bundle['partitions']['validation'], rows)
    training = bundle['partitions']['training']
    return episodes_of({**training, 'count': min(training['count'], 64)} if training['kind'] == 'seed' else training, rows)


def table_rows(bundle, tables):
    ids = bundle['env'].get('tables') or []
    if not ids: return None
    cols = (tables or {}).get(ids[0]['id'])
    if not cols: raise BundleError(f"missing data for dataset {ids[0]['id']}")
    return max((len(c) for c in cols.values()), default=0)


# ───────────────────────────── quantiser (ADR 0015) ─────────────────────────────
def _code(x): return np.floor(x + 0.5)                   # round half up (JS Math.floor(x + 0.5)), not banker's rounding


def quantize_region(W, b, bits, role):
    """One region's integers (twin of frontend/training/quantize.js quantizeRegion). Inputs: W [rows][cols] real weights,
    b [rows] real biases, bits 8 | 16, role 'ff' (any dense region but a LIF plain layer), 'lif' or 'threshold'.
    Scale s = Q / max|W| (Q when W is all zero). Codes W = code(w·s) in [−Q, Q]. k = the largest shift in 0..20 at which
    every bias code code(b·s·2^k) fits the bias range and, for 'lif', code(s·2^k) fits int32. When even k = 0 fails,
    k = 0. The bias range is [−32766, 32767] for 'threshold' (so th = 1 − b is int16), else int16. Biases
    b = code(b·s·2^k), clamped into the range. gain = s·2^k is the accumulator codes per real unit (Wq·2^k and bq are
    the accumulator integers). Returns {W, b (int64 arrays), scale, k, threshold ('lif': max(1, min(2^31−1,
    code(gain)))), clippedWeights, clippedBiases, gain}."""
    W, b = np.asarray(W, dtype=np.float64), np.asarray(b, dtype=np.float64)
    Q = CODE_MAX[bits]
    m = float(np.abs(W).max()) if W.size else 0.0
    s = Q / m if m > 0 else float(Q)
    codes = _code(W * s)
    lo, hi = (INT16_MIN + 2, INT16_MAX) if role == 'threshold' else (INT16_MIN, INT16_MAX)
    k = 0
    for c in range(K_MAX, -1, -1):
        g = s * (1 << c)
        bc = _code(b * g)
        if np.all((bc >= lo) & (bc <= hi)) and (role != 'lif' or _code(g) <= INT32_MAX):
            k = c
            break
    gain = s * (1 << k)
    bc = _code(b * gain)
    out = {'W': np.clip(codes, -Q, Q).astype(np.int64), 'b': np.clip(bc, lo, hi).astype(np.int64), 'scale': s, 'k': k,
           'clippedWeights': int((np.abs(codes) > Q).sum()), 'clippedBiases': int(((bc < lo) | (bc > hi)).sum()), 'gain': gain}
    if role == 'lif': out['threshold'] = int(max(1.0, min(float(INT32_MAX), _code(gain))))
    return out


def _ste(torch, ints, p, gain):
    """The accumulator integers `ints` as a float64 tensor whose gradient with respect to the real shadow p is × gain
    (straight through): ints + (p − p)·gain is exactly ints in value."""
    return torch.from_numpy(np.asarray(ints, dtype=np.float64)) + (p - p.detach()) * gain


def quantization_report(names, regions):
    """evaluation.quantization: one entry per region in blob order."""
    out = []
    for name, r in zip(names, regions):
        e = {'region': name, 'scale': r['scale'], 'k': r['k'], 'clippedWeights': r['clippedWeights'], 'clippedBiases': r['clippedBiases']}
        if 'threshold' in r: e['threshold'] = r['threshold']
        out.append(e)
    return out


# ───────────────────────────── QAT models (torch) ─────────────────────────────
def build_dense(net, surrogate_width):
    """Dense QAT model of a layer list (frontend/training/dense-core.js QatPolicy): plain layers `{hidden}` and tool
    layers `{tools, K, D, R}` whose decision heads read the layer before. Parameters are real-unit float64 shadows in blob
    order (W | b per plain layer, Wc | bc | Wd | bd per head, then W | b of the output layer unless the last layer is a
    tool layer). On each forward, quantize_region quantises every region (weightBits, a scale and shift k per region).
    The region then runs on its accumulator integers Wq·2^k and bq (straight-through, gradient × gain). So the forward is
    bit-exact with bundle_loop.dense_step. Tool layers cut the network into segments exactly as the integer engine does.
    Each segment runs all ticks (FF = ticks 1, fire at 1, leak 0, voltage zeroed each decision. LIF plain layer l fires
    at its own threshold_l). BPTT stays within the segments. The `layer before` bits that a tool layer hands on pass
    their gradient straight through to the spike counts of that layer. No gradient flows through a tool (its result
    bits are constants)."""
    torch = _torch()
    nn = torch.nn
    ff = net['kind'] == 'feedforward'
    ticks, shift, reset = (1, 0, 0) if ff else (net['ticks'], net['leak_shift'], net['reset'])
    bits, I, O = net['weightBits'], net['inputs'], net['outputs']
    sw = float(surrogate_width)
    trailing = is_tool(net['layers'][-1])
    shapes, roles, names, plain, heads, segments, order = [], [], [], [], [], [], []
    seg, state = {'width': I, 'layers': [], 'head': None}, 0
    segments.append(seg)
    for n, L in enumerate(net['layers']):
        fan_in = plain[seg['layers'][-1]]['H'] if seg['layers'] else seg['width']
        if is_tool(L):
            factor = ticks if seg['layers'] else 1
            seg['head'] = len(heads); order.append(('head', len(heads)))
            heads.append({'tools': L['tools'], 'K': L['K'], 'D': L['D'], 'R': L['R'], 'factor': factor, 'key': len(shapes)})
            shapes += [(L['K'], fan_in), (L['K'],), (L['D'], fan_in), (L['D'],)]
            roles += ['ff', 'ff']; names += [f'layers[{n}].choice', f'layers[{n}].data']
            seg = {'width': L['R'] + fan_in, 'layers': [], 'head': None}
            segments.append(seg)
        else:
            seg['layers'].append(len(plain)); order.append(('plain', len(plain)))
            plain.append({'H': L['hidden'], 'offset': state, 'key': len(shapes)})
            state += L['hidden']; shapes += [(L['hidden'], fan_in), (L['hidden'],)]
            roles.append('ff' if ff else 'lif'); names.append(f'layers[{n}]')
    if trailing: segments.pop()
    out_key = None if trailing else len(shapes)
    if not trailing:
        shapes += [(O, plain[-1]['H']), (O,)]; roles.append('ff'); names.append('output')

    class SpikeFn(torch.autograd.Function):
        @staticmethod
        def forward(ctx, v, thr, width):
            ctx.save_for_backward(v); ctx.thr, ctx.width = thr, width
            return (v >= thr).to(v.dtype)

        @staticmethod
        def backward(ctx, g):
            (v,) = ctx.saved_tensors
            return g * torch.clamp(1.0 - (v - ctx.thr).abs() / ctx.width, min=0.0) / ctx.width, None, None

    def ste_floor(x): return x + (torch.floor(x) - x).detach()

    class Dense(nn.Module):
        def __init__(self):
            super().__init__()
            self.ticks, self.shift, self.reset, self.bits, self.I, self.O = ticks, shift, reset, bits, I, O
            self.H, self.plain, self.heads, self.segments, self.order, self.trailing, self.out_key = state, plain, heads, segments, order, trailing, out_key
            self.roles, self.names = roles, names
            self.P = nn.ParameterList([nn.Parameter(torch.zeros(s, dtype=torch.float64)) for s in shapes])
            self.start = None                                            # the regions of a start model until the first step (restore)

        def quantized(self):
            """Every region quantised from the current shadows, as a dict. t: the accumulator integers (Wq·2^k, bq) as
            tensors in parameter order, with gradient × the gain of the region. regions: the quantize_region results
            (region r = P[2r], P[2r+1]). Before the first step of a restored model, the regions are its start integers."""
            t, regions = [], []
            for r, role in enumerate(self.roles):
                W, b = self.P[2 * r], self.P[2 * r + 1]
                rq = self.start[r] if self.start is not None else quantize_region(W.detach().numpy(), b.detach().numpy(), self.bits, role)
                t += [_ste(torch, rq['W'] * (1 << rq['k']), W, rq['gain']), _ste(torch, rq['b'], b, rq['gain'])]
                regions.append(rq)
            return {'t': t, 'regions': regions}

        @torch.no_grad()
        def restore(self, model):
            """Start from `model` (a dense-policy model of this structure: the start of a run, ADR 0020), not from
            init_dense (dense-core.js QatPolicy.restore). The integers are exactly those of the model until the first
            step (_step): its codes, biases, scale, k and LIF threshold. The shadows get its real values: codes / scale
            and biases / (scale·2^k)."""
            entries = []
            for L in model['layers']:
                if is_tool(L): entries += [(L['Wc'], L['bc'], L['scale_c'], L['k_c'], None), (L['Wd'], L['bd'], L['scale_d'], L['k_d'], None)]
                else: entries.append((L['W'], L['b'], L['scale'], L['k'], L.get('threshold')))
            if not self.trailing: entries.append((model['output']['W'], model['output']['b'], model['output']['scale'], model['output']['k'], None))
            self.start = []
            for r, (W, b, scale, k, threshold) in enumerate(entries):
                W, b, gain = np.asarray(W, dtype=np.int64).reshape(tuple(self.P[2 * r].shape)), np.asarray(b, dtype=np.int64), scale * (1 << k)
                self.P[2 * r].copy_(torch.from_numpy(W / scale)); self.P[2 * r + 1].copy_(torch.from_numpy(b / gain))
                rq = {'W': W, 'b': b, 'scale': scale, 'k': k, 'clippedWeights': 0, 'clippedBiases': 0, 'gain': gain}
                if threshold is not None: rq['threshold'] = threshold
                self.start.append(rq)

        def fire(self, q, P):
            """(fire threshold, surrogate half-width) of plain layer P in its accumulator units: FF 1 and
            surrogateWidth·gain, LIF threshold_l and surrogateWidth·threshold_l."""
            r = q['regions'][P['key'] // 2]
            return (1.0, sw * r['gain']) if ff else (float(r['threshold']), sw * r['threshold'])

        def decide(self, x, V, q=None, lanes=None, call=None, sample=None, S=None):
            """x [B,I] float64 bits, V [B,state] integer-valued voltages, q = quantized(). Tool layers decide greedily
            (first maximum, logit > 0) or, with `sample` (a torch.Generator), sample the choice from
            softmax(logits·inv_c) and each data bit from sigmoid(logit·inv_d) (inv = 1/(factor·gain) of that region). The
            chosen tool runs through `call(port, choice, data, S)` (bundle_loop.ToolCaller) on the rows of `lanes` (others
            read zeros), from and into those rows of the tool states S [B, call.width] int64 (None: the rest state). Returns
            {logits (scores / (ticks·gain_out), None when trailing), scores, counts [B,state], V, layers (per plain layer
            counts), inputs (per segment input), decisions [{zc, zd, inv_c, inv_d, choice, data, result}]}."""
            q = self.quantized() if q is None else q
            t, regions = q['t'], q['regions']
            B = x.shape[0]
            rows = np.ones(B, dtype=bool) if lanes is None else lanes
            Vs = [V[:, L['offset']:L['offset'] + L['H']] for L in self.plain]
            counts_of, inputs, decisions = [None] * len(self.plain), [], []
            h, scores = x, None
            for s, seg in enumerate(self.segments):
                inputs.append(h)
                ls = seg['layers']
                if ls:
                    L0 = self.plain[ls[0]]
                    cur0 = h @ t[L0['key']].t() + t[L0['key'] + 1]
                    fires = [self.fire(q, self.plain[l]) for l in ls]
                    cnt = [torch.zeros(B, self.plain[l]['H'], dtype=torch.float64) for l in ls]
                    for _ in range(self.ticks):
                        spikes = None
                        for i, l in enumerate(ls):
                            P = self.plain[l]
                            cur = cur0 if i == 0 else spikes @ t[P['key']].t() + t[P['key'] + 1]
                            v = Vs[l] - ste_floor(Vs[l] / (1 << self.shift)) + cur
                            f = SpikeFn.apply(v, *fires[i])
                            cnt[i] = cnt[i] + f
                            Vs[l] = v * (1.0 - f) + self.reset * f
                            spikes = f
                    for i, l in enumerate(ls): counts_of[l] = cnt[i]
                if seg['head'] is None: continue
                hd = self.heads[seg['head']]
                prev = counts_of[ls[-1]] if ls else h
                k = hd['key']
                zc = prev @ t[k].t() + hd['factor'] * t[k + 1]
                zd = prev @ t[k + 2].t() + hd['factor'] * t[k + 3]
                inv_c, inv_d = 1.0 / (hd['factor'] * regions[k // 2]['gain']), 1.0 / (hd['factor'] * regions[k // 2 + 1]['gain'])
                if sample is None:
                    choice = np.argmax(zc.detach().numpy(), axis=1)
                    data = (zd.detach().numpy() > 0).astype(np.int64)
                else:
                    with torch.no_grad():
                        choice = torch.multinomial(torch.softmax(zc * inv_c, dim=1), 1, generator=sample).squeeze(1).numpy()
                        data = (torch.rand(zd.shape, generator=sample, dtype=torch.float64) < torch.sigmoid(zd * inv_d)).to(torch.int64).numpy()
                if call is None: raise RunnerError(f"the network has tool layer {hd['tools']} but no tools are wired")
                result = np.zeros((B, hd['R']), dtype=np.int64)
                if rows.any():
                    sub = S[rows] if S is not None else None
                    result[rows] = call(hd['tools'], choice[rows], data[rows], sub)
                    if S is not None: S[rows] = sub
                decisions.append({'zc': zc, 'zd': zd, 'inv_c': inv_c, 'inv_d': inv_d, 'choice': choice, 'data': data, 'result': result})
                rt = torch.from_numpy(result.astype(np.float64))
                if s + 1 < len(self.segments):
                    fired = prev + ((prev > 0).to(prev.dtype) - prev).detach()         # LIF: fired at least once. FF: the activations
                    h = torch.cat([rt, fired], dim=1)
                else: scores = 2 * rt - 1
            V = torch.cat(Vs, dim=1) if Vs else V
            counts = torch.cat(counts_of, dim=1) if counts_of else torch.zeros(B, 0, dtype=torch.float64)
            logits = None
            if not self.trailing:
                scores = counts_of[-1] @ t[self.out_key].t() + self.ticks * t[self.out_key + 1]
                logits = scores / (self.ticks * regions[self.out_key // 2]['gain'])
            return {'logits': logits, 'scores': scores, 'counts': counts, 'V': V, 'layers': counts_of, 'inputs': inputs, 'decisions': decisions}

        def new_state(self, B): return torch.zeros(B, self.H, dtype=torch.float64)

        @torch.no_grad()
        def export(self):
            rs = self.quantized()['regions']
            layers = []
            for kind, j in self.order:
                if kind == 'plain':
                    r = rs[self.plain[j]['key'] // 2]
                    L = {'hidden': self.plain[j]['H'], 'W': r['W'].tolist(), 'b': r['b'].tolist(), 'scale': r['scale'], 'k': r['k']}
                    if not ff: L['threshold'] = r['threshold']
                    layers.append(L)
                else:
                    hd = self.heads[j]; c, d = rs[hd['key'] // 2], rs[hd['key'] // 2 + 1]
                    layers.append({'tools': hd['tools'], 'K': hd['K'], 'D': hd['D'], 'R': hd['R'], 'Wc': c['W'].tolist(), 'bc': c['b'].tolist(), 'scale_c': c['scale'], 'k_c': c['k'],
                                   'Wd': d['W'].tolist(), 'bd': d['b'].tolist(), 'scale_d': d['scale'], 'k_d': d['k']})
            model = {'format': DENSE_FORMAT, 'kind': net['kind'], 'inputs': I, 'outputs': O, 'weightBits': bits, 'ticks': ticks, 'leak_shift': shift, 'reset': reset, 'layers': layers}
            if not self.trailing:
                r = rs[self.out_key // 2]
                model['output'] = {'W': r['W'].tolist(), 'b': r['b'].tolist(), 'scale': r['scale'], 'k': r['k']}
            return model

        @torch.no_grad()
        def quantization(self): return quantization_report(self.names, self.quantized()['regions'])

    return Dense()


def head_terms(torch, d):
    """log π and entropy per lane of one tool layer decision record (decide's `decisions[h]`): the sampled choice under
    softmax(zc·inv_c) and each data bit under sigmoid(zd·inv_d) (dense-core.js headGradient)."""
    logp_c = torch.log_softmax(d['zc'] * d['inv_c'], dim=1)
    choice = torch.from_numpy(np.asarray(d['choice'], dtype=np.int64))
    u = d['zd'] * d['inv_d']
    bit = torch.from_numpy(np.asarray(d['data'], dtype=np.float64))
    sp_pos, sp_neg = torch.nn.functional.softplus(u), torch.nn.functional.softplus(-u)
    logp = logp_c.gather(1, choice[:, None]).squeeze(1) - (bit * sp_neg + (1 - bit) * sp_pos).sum(1)
    sigma = torch.sigmoid(u)
    entropy = -(logp_c.exp() * logp_c).sum(1) + (sigma * sp_neg + (1 - sigma) * sp_pos).sum(1)
    return logp, entropy


def init_dense(model, seed, init_current, X, call=None, sample=None):
    """Uniform(±√(3/fanIn)) real weights and zero biases for every plain layer, decision head and the output layer. Then
    the bias of each plain layer, in order, so that the median current of each neuron over the calibration inputs X [N,I]
    sits at init_current × its integer fire threshold thr (FF 1, LIF threshold_l): bias = (init_current·thr −
    median(current_int)) / gain. current_int uses the accumulator integers of the region. This gives no silent neurons
    at init. The next forward re-quantises the bias. A layer gets the input that it sees from rest:
        first layer                       X
        other layers                      the spike rates (counts / ticks) of the calibrated layer before it
        first layer after a tool layer    `result ‖ before`, the heads sampling through `call` with `sample`, every
                                          tool from its rest state
    Head biases stay 0."""
    torch = _torch()
    g = torch.Generator().manual_seed(int(seed))
    with torch.no_grad():
        for p in model.P:
            if p.dim() == 2: p.copy_((torch.rand(p.shape, generator=g, dtype=torch.float64) * 2 - 1) * (3.0 / p.shape[1]) ** 0.5)
            else: p.zero_()
        N = X.shape[0]
        if not N: return
        Xt = torch.from_numpy(X.astype(np.float64))
        for s, seg in enumerate(model.segments):
            for i, l in enumerate(seg['layers']):
                P = model.plain[l]
                inp, rate = Xt, 1.0
                if s or i:
                    rec = model.decide(Xt, model.new_state(N), lanes=np.ones(N, dtype=bool), call=call, sample=sample)
                    inp, rate = (rec['layers'][l - 1], 1.0 / model.ticks) if i else (rec['inputs'][s], 1.0)
                r = model.quantized()['regions'][P['key'] // 2]
                current = inp @ torch.from_numpy((r['W'] * (1 << r['k'])).astype(np.float64)).t()
                med = torch.median(current * rate, dim=0).values
                thr = r['threshold'] if 'threshold' in r else 1        # the layer's integer fire threshold: FF 1, LIF threshold_l
                model.P[P['key'] + 1].copy_((init_current * thr - med) / r['gain'])


def build_threshold(net, surrogate_width):
    """Layers of threshold units with QAT. On every forward, quantize_region (role 'threshold') quantises each layer as one
    region. The layer runs on its accumulator integers Wq·2^k and bq (straight-through, gradient × gain), with a boxcar
    surrogate |z·u| < surrogate_width for hidden layers (u = 1/gain of that layer: z·u is in real units). The forward is
    bit-exact with layers_scores: z = Σ W·h·2^k + bq is that score + 1 (exported th = 1 − bq), fire ⇔ z > 0."""
    torch = _torch()
    nn = torch.nn
    bits = net['weightBits']
    sizes = [net['inputs'], *net['layers'], net['outputs']]
    names = [f'layers[{i}]' for i in range(len(sizes) - 1)]

    class FireFn(torch.autograd.Function):
        @staticmethod
        def forward(ctx, z, u):
            ctx.save_for_backward(z); ctx.u = u
            return (z > 0).to(z.dtype)

        @staticmethod
        def backward(ctx, g):
            (z,) = ctx.saved_tensors
            return g * ((z * ctx.u).abs() < surrogate_width).to(z.dtype), None

    class Threshold(nn.Module):
        def __init__(self):
            super().__init__()
            self.bits, self.sizes = bits, sizes
            self.W = nn.ParameterList([nn.Parameter(torch.zeros(o, i, dtype=torch.float64)) for i, o in zip(sizes[:-1], sizes[1:])])
            self.b = nn.ParameterList([nn.Parameter(torch.zeros(o, dtype=torch.float64)) for o in sizes[1:]])
            self.start = None                                            # the regions of a start model until the first step (restore)

        def quantized(self):
            """Per layer (quantize_region result, Wq·2^k tensor, bq tensor), gradients × gain. Before the first step of a
            restored model, the results are its start integers."""
            out = []
            for l, (W, b) in enumerate(zip(self.W, self.b)):
                rq = self.start[l] if self.start is not None else quantize_region(W.detach().numpy(), b.detach().numpy(), self.bits, 'threshold')
                out.append((rq, _ste(torch, rq['W'] * (1 << rq['k']), W, rq['gain']), _ste(torch, rq['b'], b, rq['gain'])))
            return out

        @torch.no_grad()
        def restore(self, model):
            """Start from `model` (a threshold-layers model of these sizes: the start of a run, ADR 0020), not from
            init_threshold (hinge.js ThresholdNet.restore). The integers are exactly those of the model until the first
            step (_step). The shadows get its real values: W = codes / scale and b = (1 − th) / (scale·2^k)."""
            self.start = []
            for l, L in enumerate(model['layers']):
                Wq, bq, gain = np.asarray(L['W'], dtype=np.int64), 1 - np.asarray(L['th'], dtype=np.int64), L['scale'] * (1 << L['k'])
                self.W[l].copy_(torch.from_numpy(Wq / L['scale'])); self.b[l].copy_(torch.from_numpy(bq / gain))
                self.start.append({'W': Wq, 'b': bq, 'scale': L['scale'], 'k': L['k'], 'clippedWeights': 0, 'clippedBiases': 0, 'gain': gain})

        def forward(self, x):
            """x [N,I] float64 bits → (z, u): the integer pre-activations z of the output layer (fire ⇔ z > 0) and
            u = 1/gain of the output layer (z·u in real units)."""
            h, z, u = x, None, None
            for rq, Wt, bq in self.quantized():
                if z is not None: h = FireFn.apply(z, u)
                z, u = h @ Wt.t() + bq, 1.0 / rq['gain']
            return z, u

        @torch.no_grad()
        def export(self):
            layers = [{'W': rq['W'].tolist(), 'th': (1 - rq['b']).tolist(), 'scale': rq['scale'], 'k': rq['k']} for rq, _, _ in self.quantized()]   # fire ⇔ Σ·2^k + b > 0 ⇔ Σ·2^k ≥ 1 − b
            return {'format': THRESHOLD_FORMAT, 'inputs': sizes[0], 'outputs': sizes[-1], 'weightBits': bits, 'layers': layers}

        @torch.no_grad()
        def quantization(self): return quantization_report(names, [rq for rq, _, _ in self.quantized()])

    return Threshold()


def init_threshold(model, seed):
    torch = _torch()
    g = torch.Generator().manual_seed(int(seed))
    with torch.no_grad():
        for W, b in zip(model.W, model.b):
            W.copy_((torch.rand(W.shape, generator=g, dtype=torch.float64) * 2 - 1) * (3.0 / W.shape[1]) ** 0.5); b.zero_()


# ───────────────────────────── shared run machinery ─────────────────────────────
class Run:
    def __init__(self, epochs, on_progress):
        self.epochs, self.on_progress = epochs, on_progress
        self.started_at, self.t0 = now(), time.perf_counter()
        self.every = max(1, math.ceil(epochs / PROGRESS_POINTS))

    def elapsed_ms(self): return int((time.perf_counter() - self.t0) * 1000)

    def should_report(self, epoch, evaluated): return epoch % self.every == 0 or epoch == self.epochs or (evaluated and self.epochs <= PROGRESS_POINTS)

    def report(self, **fields):
        if self.on_progress is not None: self.on_progress({'epochs': self.epochs, 'elapsed': self.elapsed_ms(), **fields})


def subsample(values):
    if len(values) <= CURVE_POINTS: return list(values)
    step = len(values) / CURVE_POINTS
    return [values[int(i * step)] for i in range(CURVE_POINTS)]


class Session:
    """Everything a method shares for one bundle: env, loop executor, trained network and readout, compiled objective /
    selection, validation."""

    def __init__(self, bundle, tables):
        self.bundle = bundle
        self.recipe = validate_bundle(bundle, tables)
        self.trained, self.net, self.readout_id, self.readout = trained_parts(bundle)
        self.types = bundle['env']['types']
        self.O, self.I = self.net['outputs'], self.net['inputs']
        self.rows = table_rows(bundle, tables)
        self.env = create_env(bundle['env'], tables=tables)
        self.lx = create_loop(bundle['loop'])
        self.call = self.lx.callers.get(self.trained)            # the trained network's tools (None without tool layers)
        kind = METHODS[self.recipe['method']]['objective']
        objective = BoundProgram(bundle['objective'], objective_params(bundle, kind), 'objective')
        self.reward, self.target = (objective, None) if kind == 'reward' else (None, objective)
        self.selection = compile_entry(bundle.get('selection'), [episode_summary_type(self.types['State'])], 'selection')
        self.metric_name = 'validationMetric' if self.selection is not None else ('validationMeanReturn' if self.reward is not None else 'validationAccuracy')
        self.argmax = self.readout['mode'] == 'argmax'
        self.validation = validation_episodes(bundle, self.rows)
        if not self.validation: raise BundleError('the validation partition has no episodes')

    def training_episodes(self, epoch):
        rng = np.random.default_rng([self.recipe['seed'], 1000 + epoch])
        return epoch_episodes(self.bundle['partitions']['training'], self.recipe, rng, self.rows), rng

    def rewards(self, tr, out):
        """Each lane's reward of step result `tr` (the loop's Transition: with `loop` when it has tool layers)."""
        active = tr['active']
        r = self.reward.run([self.lx.transition(tr, out)], self.env.B, active)
        return r if active.all() else np.where(active, r, 0.0)

    def targets(self, state, active):
        """Target bits [B,O] (0/1 float64) for `state` (the state before the step). Inactive lanes read 0."""
        y = np.asarray(self.target.run([state] + self.env.full_table(), self.env.B, active), dtype=np.float64)
        if y.ndim != 2 or y.shape[1] != self.O: raise RunnerError(f'target objective must return {self.O} 0/1 bits')
        live = y[active]
        if not np.all((live == 0) | (live == 1)): raise RunnerError(f'target objective must return {self.O} 0/1 bits')
        return np.where(active[:, None], y, 0.0)

    def run_steps(self, episodes, intercept, before=None, record=False):
        """The lockstep runner of whole-loop training (loop.js createLockstep with `decide`): run `episodes` to done
        through env + loop, the trained network intercepted. `before()` runs before each step. `intercept(x, lanes, y)`
        is the trained network: its input bits x [B, I] valid on `lanes`, and y the target bits [B, O] read on the state
        before the step on those lanes (target objectives, else None). Returns the per-step (tr, ran, out) list with
        `record`, else None."""
        env, lx = self.env, self.lx
        env.reset(episodes); lx.reset(env.B)

        def decide(x, lanes): return intercept(x, lanes, self.targets(env.state, lanes) if self.target is not None else None)
        steps = [] if record else None
        while not env.done.all():
            active = ~env.done
            if before is not None: before()
            out = lx.step(env.input(), active, (self.trained, decide))
            tr = env.step(out['action'])
            if record: steps.append((tr, out['ran'][self.trained] & active, out))
        return steps

    def validate(self, model, labelled_any=True):
        """Greedy integer loop on the validation episodes, the trained network running `model`. Returns the summary dict."""
        env = self.env
        lx = create_loop(self.bundle['loop'], models={self.trained: model})
        acc = {'correct': 0, 'labelled': 0}

        def on_step(state, out, tr):
            lanes = tr['active'] & out['ran'][self.trained]              # like JS validateGreedy: only steps the trained network decided
            if not lanes.any(): return
            y = self.targets(state, lanes)
            lab = lanes & (y.any(axis=1) if labelled_any else True)
            bits = out['values'][f'{self.readout_id}.bits']
            hit = (y * bits).sum(axis=1) == 1 if self.argmax else np.all(bits == y, axis=1)
            acc['labelled'] += int(lab.sum()); acc['correct'] += int((hit & lab).sum())

        ep = run_episodes(env, lx, self.validation, reward=self.reward, on_step=on_step if self.target is not None else None)
        labelled = acc['labelled']
        summary = {'episodes': env.B, 'meanReturn': float(ep['return'].mean()), 'successRate': float(ep['success'].mean()), 'meanSteps': float(ep['steps'].mean()),
                   'accuracy': (acc['correct'] / labelled if labelled else 0.0) if self.target is not None else None, 'labelledSteps': labelled if self.target is not None else None}
        if self.selection is not None: summary['metric'] = float(np.asarray(self.selection.run([ep], env.B), dtype=np.float64).mean())
        else: summary['metric'] = summary['accuracy'] if self.target is not None else summary['meanReturn']
        return summary

    def finish(self, run, best, curves, evaluations, bundle_hash, extra):
        evaluation = {'metricName': self.metric_name, 'metric': best['metric'], 'selectedEpoch': best['epoch'] + 1,
                      'curves': {k: subsample(v) for k, v in curves.items()}, 'evaluations': subsample(evaluations), 'validation': best['summary'],
                      'quantization': best['quantization'], **extra}
        provenance = {'method': self.recipe['method'], 'backend': 'python', 'seed': self.recipe['seed'], 'epochs': self.recipe['epochs'], 'bundleHash': bundle_hash,
                      'recipe': dict(self.recipe), 'startedAt': run.started_at, 'durationMs': run.elapsed_ms(),
                      'optimizer': 'Adam(β=0.9,0.999, ε=1e-8)', 'quantization': f"QAT from step 0: every region quantised to int{self.net['weightBits']} codes with its own scale and shift on every forward, straight-through estimator; exported integers are the evaluated weights",
                      'partitions': {'training': self.bundle['partitions']['training'], 'validation': self.bundle['partitions'].get('validation')},
                      'versions': {'python': platform.python_version(), 'numpy': np.__version__, 'torch': _torch().__version__}}
        return {'model': best['model'], 'evaluation': evaluation, 'provenance': provenance}


def _better(best, epoch, metric, model, summary, quantization):
    if best is None or metric > best['metric']: return {'epoch': epoch, 'metric': metric, 'model': model, 'summary': summary, 'quantization': quantization}
    return best


def _start(s, run, model, evaluations, **validate_kw):
    """The start of a run from `init` (ADR 0020), before the first epoch (run.js startEvaluation): the start model
    validated as epoch 0, in the evaluations and one 'eval' progress message. It is the first best, so an epoch must
    beat it strictly to be selected. None without init."""
    if s.bundle.get('init') is None: return None
    mj = model.export()
    summary = s.validate(mj, **validate_kw)
    evaluations.append({'epoch': 0, **summary})
    run.report(phase='eval', epoch=0, loss=None, metric=summary['metric'], metricName=s.metric_name, selectedEpoch=0)
    return _better(None, -1, summary['metric'], mj, summary, model.quantization())


def _random_readout(s, rng, B):
    """A uniform readout result for every lane: a slot (argmax) or random bits."""
    return {'slot': rng.integers(0, s.O, size=B)} if s.argmax else {'bits': rng.integers(0, 2, size=(B, s.O)).astype(np.float64)}


def _calibration(s, rng):
    """Intercepted input bits of `calibrationEpisodes` random-choice episodes (uniform over the readout results)."""
    rows = []

    def intercept(x, lanes, _y):
        rows.append(x[lanes])
        return _random_readout(s, rng, x.shape[0])

    s.run_steps(draw_episodes(s.bundle['partitions']['training'], s.recipe['calibrationEpisodes'], rng, s.rows), intercept)
    return np.concatenate(rows, 0) if rows else np.zeros((0, s.I))


def _dense_setup(s, run):
    torch = _torch()
    recipe, net = s.recipe, s.net
    torch.manual_seed(recipe['seed'])
    model = build_dense(net, recipe['surrogateWidth'])
    if s.bundle.get('init') is not None: model.restore(s.bundle['init']['model'])   # the start of the run: no random weights, no calibration (ADR 0020)
    else:
        X = _calibration(s, np.random.default_rng([recipe['seed'], 1]))
        init_dense(model, recipe['seed'], recipe['initCurrent'], X, call=s.call, sample=torch.Generator().manual_seed(recipe['seed'] + 1))
    opt = torch.optim.Adam(model.parameters(), lr=recipe['lr'], **ADAM)
    return torch, model, opt


def _check_tape(s, model, B):
    if s.env.budget * model.ticks * B * model.H > TAPE_BUDGET: raise BundleError(f'training tape {s.env.budget}×{model.ticks}×{B}×{model.H} exceeds {TAPE_BUDGET}; reduce replicas, ticks or the layer width')


class _DenseLanes:
    """The trained dense network inside the loop: per-lane voltages that advance only on the lanes it runs on. Its tool
    layers call the loop's tools for that network on those lanes, each lane from its own tool states (zero at the
    start, advanced only where a tool is chosen)."""

    def __init__(self, torch, model, B, call):
        self.torch, self.model, self.q, self.V, self.call = torch, model, model.quantized(), model.new_state(B), call
        self.S = call.state(B) if call is not None else None

    def decide(self, x, lanes, sample=None):
        torch = self.torch
        out = self.model.decide(torch.from_numpy(x), self.V, self.q, lanes=lanes, call=self.call, sample=sample, S=self.S)
        L = torch.from_numpy(lanes)
        self.V = torch.where(L[:, None], out['V'], self.V)
        return out, L


def tool_records(model, out):
    """The executor's tool layer records {port: {choice, data, result}} of a decide result (full-batch arrays)."""
    return {hd['tools']: {'choice': d['choice'], 'data': d['data'], 'result': d['result']} for hd, d in zip(model.heads, out['decisions'])}


def _step(torch, model, opt, loss, grad_clip):
    opt.zero_grad(set_to_none=True)
    loss.backward()
    gn = float(torch.nn.utils.clip_grad_norm_(model.parameters(), grad_clip if grad_clip > 0 else float('inf')))
    opt.step()
    model.start = None                                                   # from now on the shadows give the integers
    return gn


# ───────────────────────────── methods ─────────────────────────────
def train_reinforce(s, run, bundle_hash):
    torch, model, opt = _dense_setup(s, run)
    recipe = s.recipe
    sampler = torch.Generator().manual_seed(recipe['seed'])
    baseline = []
    curves = {k: [] for k in ('loss', 'metric', 'trainReturn', 'trainSuccess', 'spikeRate', 'gradNorm', 'entropy')}
    evaluations = []
    best = _start(s, run, model, evaluations)
    for epoch in range(recipe['epochs']):
        episodes, _ = s.training_episodes(epoch)
        B = len(episodes)
        _check_tape(s, model, B)
        net = _DenseLanes(torch, model, B, s.call)
        zero = torch.zeros(B, dtype=torch.float64)
        logps, ents, rates = [], [], []                 # per step, summed over the (disjoint) lanes the trained net ran on

        def intercept(x, lanes, _y):
            out, L = net.decide(x, lanes, sample=sampler)
            for d in out['decisions']:                  # every tool decision (choice, each data bit) enters the one policy gradient
                lp, e = head_terms(torch, d)
                logps[-1] = logps[-1] + torch.where(L, lp, zero); ents[-1] = ents[-1] + torch.where(L, e, zero)
            if out['counts'].shape[1]: rates.append(float(out['counts'].detach().numpy()[lanes].mean()) / model.ticks)
            tools = tool_records(model, out) if model.heads else None
            if model.trailing: return {'bits': out['decisions'][-1]['result'], 'tools': tools}      # the tool's result bits are the action
            logp_all = torch.log_softmax(out['logits'], dim=1)
            probs = logp_all.exp()
            choice = torch.multinomial(probs, 1, generator=sampler).squeeze(1)
            logps[-1] = logps[-1] + torch.where(L, logp_all.gather(1, choice[:, None]).squeeze(1), zero)
            ents[-1] = ents[-1] + torch.where(L, -(probs * logp_all).sum(1), zero)
            return {'slot': choice.numpy(), 'tools': tools}

        def before():
            logps.append(zero); ents.append(zero)

        steps = s.run_steps(episodes, intercept, before, record=True)
        rews = [s.rewards(tr, out) for tr, _, out in steps]
        success = np.zeros(B, dtype=bool)
        for tr, _, _ in steps: success = np.where(tr['active'], tr['success'], success)
        T = len(rews)
        Rn, Mn = np.stack(rews), np.stack([ran for _, ran, _ in steps]).astype(np.float64)
        # return-to-go over every live step, per-step EMA baseline over the lanes that decided, advantage (plain numpy)
        G = np.zeros_like(Rn); acc = np.zeros(B)
        for t in range(T - 1, -1, -1):
            acc = Rn[t] + recipe['gamma'] * acc; G[t] = acc
        while len(baseline) < T: baseline.append(None)
        adv = np.zeros_like(G)
        for t in range(T):
            n = Mn[t].sum()
            if n > 0:
                mean_t = float((G[t] * Mn[t]).sum() / n)
                baseline[t] = mean_t if baseline[t] is None else recipe['baselineDecay'] * baseline[t] + (1 - recipe['baselineDecay']) * mean_t
                adv[t] = (G[t] - baseline[t]) * Mn[t]
        LP, E, M = torch.stack(logps), torch.stack(ents), torch.from_numpy(Mn)
        loss = -(LP * torch.from_numpy(adv)).sum() / B
        if recipe['entropy']: loss = loss - recipe['entropy'] * (E * M).sum() / B
        gn = _step(torch, model, opt, loss, recipe['gradClip']) if loss.requires_grad else 0.0
        live = float(Mn.sum())
        curves['loss'].append(float(loss.detach())); curves['trainReturn'].append(float(Rn.sum(0).mean())); curves['trainSuccess'].append(float(success.mean()))
        curves['spikeRate'].append(float(np.mean(rates)) if rates else 0.0); curves['gradNorm'].append(gn); curves['entropy'].append(float((E.detach() * M).sum() / max(live, 1.0)))
        best, evaluated = _evaluate(s, run, model, epoch, best, curves, evaluations)
        if run.should_report(epoch + 1, evaluated):
            run.report(phase='eval' if evaluated else 'train', epoch=epoch + 1, loss=curves['loss'][-1], metric=best['metric'] if best else None, metricName=s.metric_name,
                       trainReturn=curves['trainReturn'][-1], trainSuccess=curves['trainSuccess'][-1], spikeRate=curves['spikeRate'][-1], gradNorm=gn, selectedEpoch=best['epoch'] + 1 if best else None)
    extra = {'selection': {'epoch': best['epoch'] + 1, 'rule': 'greedy integer loop on the validation partition; strict improvement'},
             'details': {'gamma': recipe['gamma'], 'baselineDecay': recipe['baselineDecay'], 'entropy': recipe['entropy'], 'surrogateWidth': recipe['surrogateWidth'], 'gradClip': recipe['gradClip'], 'initCurrent': recipe['initCurrent']}}
    return s.finish(run, best, curves, evaluations, bundle_hash, extra)


def _evaluate(s, run, model, epoch, best, curves, evaluations, force=False, **validate_kw):
    recipe = s.recipe
    evaluated = force or (epoch + 1) % recipe['evalEvery'] == 0 or epoch + 1 == recipe['epochs']
    if evaluated:
        mj = model.export()
        summary = s.validate(mj, **validate_kw)
        evaluations.append({'epoch': epoch + 1, **summary})
        best = _better(best, epoch, summary["metric"], mj, summary, model.quantization())
    curves['metric'].append(evaluations[-1]['metric'] if evaluations else None)
    return best, evaluated


def _teacher_choice(y, rng, exploration, O):
    """Behaviour slot per lane: random among the set target bits (uniform random where none is set), else uniform with prob `exploration`."""
    B = y.shape[0]
    teach = np.argmax(y + rng.random(y.shape) * (y > 0), axis=1)
    unlabelled = ~y.any(axis=1)
    explore = (rng.random(B) < exploration) | unlabelled
    return np.where(explore, rng.integers(0, O, size=B), teach)


def train_cross_entropy(s, run, bundle_hash):
    torch, model, opt = _dense_setup(s, run)
    recipe, O = s.recipe, s.O
    curves = {k: [] for k in ('loss', 'metric', 'agreement', 'labelledSteps', 'spikeRate', 'gradNorm')}
    evaluations = []
    best = _start(s, run, model, evaluations)
    for epoch in range(recipe['epochs']):
        episodes, rng = s.training_episodes(epoch)
        B = len(episodes)
        _check_tape(s, model, B)
        net = _DenseLanes(torch, model, B, s.call)
        cur = {'loss': torch.zeros((), dtype=torch.float64), 'agree': 0.0, 'n': 0.0}
        rates = []

        def intercept(x, lanes, y):                                       # y: the targets of the state before the step, on the lanes that decide
            teach = _teacher_choice(y, rng, recipe['exploration'], O)
            out, _ = net.decide(x, lanes)
            logits, counts = out['logits'], out['counts']
            lab = lanes & y.any(axis=1)
            logp = torch.log_softmax(logits, dim=1)
            Y = torch.from_numpy(y / np.maximum(y.sum(axis=1, keepdims=True), 1.0)); L = torch.from_numpy(lab.astype(np.float64))
            cur['loss'] = cur['loss'] - ((logp * Y).sum(1) * L).sum()
            greedy = logits.detach().argmax(1).numpy()
            cur['agree'] += float((y[np.arange(B), greedy] * lab).sum()); cur['n'] += float(lab.sum())
            rates.append(float(counts.detach().numpy()[lanes].mean()) / model.ticks)
            return {'slot': teach}

        s.run_steps(episodes, intercept)
        n_lab = cur['n']
        if n_lab == 0: raise BundleError('the target objective labelled no step in this epoch')
        loss = cur['loss'] / n_lab
        gn = _step(torch, model, opt, loss, recipe['gradClip'])
        curves['loss'].append(float(loss.detach())); curves['agreement'].append(cur['agree'] / n_lab); curves['labelledSteps'].append(n_lab)
        curves['spikeRate'].append(float(np.mean(rates))); curves['gradNorm'].append(gn)
        best, evaluated = _evaluate(s, run, model, epoch, best, curves, evaluations)
        if run.should_report(epoch + 1, evaluated):
            run.report(phase='eval' if evaluated else 'train', epoch=epoch + 1, loss=curves['loss'][-1], metric=best['metric'] if best else None, metricName=s.metric_name,
                       agreement=curves['agreement'][-1], spikeRate=curves['spikeRate'][-1], gradNorm=gn, selectedEpoch=best['epoch'] + 1 if best else None)
    extra = {'selection': {'epoch': best['epoch'] + 1, 'rule': 'greedy integer loop accuracy on labelled validation decisions; strict improvement'},
             'details': {'exploration': recipe['exploration'], 'surrogateWidth': recipe['surrogateWidth'], 'gradClip': recipe['gradClip'], 'initCurrent': recipe['initCurrent']}}
    return s.finish(run, best, curves, evaluations, bundle_hash, extra)


def train_hinge(s, run, bundle_hash):
    torch = _torch()
    recipe = s.recipe
    torch.manual_seed(recipe['seed'])
    model = build_threshold(s.net, recipe['surrogateWidth'])
    if s.bundle.get('init') is not None: model.restore(s.bundle['init']['model'])   # the start of the run (ADR 0020)
    else: init_threshold(model, recipe['seed'])
    opt = torch.optim.Adam(model.parameters(), lr=recipe['lr'], **ADAM)
    episodes = episodes_of(s.bundle['partitions']['training'], s.rows)  # every episode once: the same rows every epoch
    if not episodes: raise BundleError('the partition has no episodes')
    xs, ys = [], []

    def intercept(x, lanes, y):                                          # teacher-forced: the readout is given the target bits
        xs.append(x[lanes]); ys.append(y[lanes])
        return {'bits': y}

    s.run_steps(episodes, intercept)
    if not xs: raise BundleError('the trained network made no decision')
    X, Y = torch.from_numpy(np.concatenate(xs, 0)), torch.from_numpy(np.concatenate(ys, 0))
    curves = {k: [] for k in ('loss', 'metric', 'accuracy', 'samples', 'gradNorm')}
    evaluations, epochs_run = [], 0
    best = _start(s, run, model, evaluations, labelled_any=False)
    for epoch in range(recipe['epochs']):
        z, u = model(X)
        z = z * u                                                         # real units: u = 1/gain of the output layer
        target = 2 * Y - 1
        loss = torch.clamp(recipe['margin'] - target * z, min=0.0).sum(1).mean()
        gn = _step(torch, model, opt, loss, recipe['gradClip'])
        with torch.no_grad(): acc = float(((model(X)[0] > 0).to(torch.float64) == Y).all(1).to(torch.float64).mean())
        curves['loss'].append(float(loss.detach())); curves['accuracy'].append(acc); curves['samples'].append(int(X.shape[0])); curves['gradNorm'].append(gn)
        epochs_run = epoch + 1
        best, evaluated = _evaluate(s, run, model, epoch, best, curves, evaluations, force=acc == 1, labelled_any=False)
        done = s.selection is None and best is not None and best['metric'] == 1     # exact on the whole validation partition: the finite task is solved
        if done or run.should_report(epoch + 1, evaluated):
            run.report(phase='eval' if evaluated else 'train', epoch=epoch + 1, loss=curves['loss'][-1], metric=best['metric'] if best else None, metricName=s.metric_name,
                       accuracy=acc, gradNorm=gn, selectedEpoch=best['epoch'] + 1 if best else None)
        if done: break
    extra = {'selection': {'epoch': best['epoch'] + 1, 'epochsRun': epochs_run, 'rule': 'threshold integer loop exact-bits accuracy on validation decisions; strict improvement; stops early once exact'},
             'details': {'margin': recipe['margin'], 'surrogateWidth': recipe['surrogateWidth'], 'gradClip': recipe['gradClip']}}
    return s.finish(run, best, curves, evaluations, bundle_hash, extra)


TRAINERS = {'reinforce': train_reinforce, 'cross-entropy': train_cross_entropy, 'hinge': train_hinge}


def train_bundle(bundle, on_progress=None, tables=None, bundle_hash=None):
    """Train `bundle` (a trainer bundle) → {model, evaluation, provenance}. Raises BundleError (invalid bundle) or RunnerError
    (a program failed at run time)."""
    s = Session(bundle, tables)
    run = Run(s.recipe['epochs'], on_progress)
    run.report(phase='init', epoch=0, loss=None, metric=None, metricName=s.metric_name)
    return TRAINERS[s.recipe['method']](s, run, bundle_hash)


# ───────────────────────────── result validation (import path) ─────────────────────────────
def validate_model(model, network):
    """The exported integer model matches the bundle's network structure (weightBits included) and the runtime
    executors' bounds: weight codes within weightBits, int16 biases / thresholds, a shift k in 0..20 and a finite scale > 0
    per region, LIF plain layers their own threshold in 1..2^31−1. A top-level key that the engine does not define is
    refused."""
    def ints(values, shape, name, lo=INT16_MIN, hi=INT16_MAX):
        a = np.asarray(values)
        if a.shape != shape or a.dtype.kind not in 'iu' and not (a.dtype.kind == 'f' and np.all(a == np.round(a))): raise BundleError(f'model.{name} must be integers of shape {shape}')
        if a.size and (a.min() < lo or a.max() > hi): raise BundleError(f'model.{name} must lie in {lo}..{hi}')

    def region(R, rows, cols, name, W='W', b='b', scale='scale', k='k'):
        half = 1 << (network['weightBits'] - 1)
        ints(R.get(W), (rows, cols), f'{name}.{W}', -half, half - 1); ints(R.get(b), (rows,), f'{name}.{b}')
        s = R.get(scale)
        if isinstance(s, bool) or not isinstance(s, (int, float)) or not math.isfinite(s) or s <= 0: raise BundleError(f'model.{name}.{scale} must be a finite number > 0')
        if not _int(R.get(k), 0, K_MAX): raise BundleError(f'model.{name}.{k} must be an integer in 0..{K_MAX}')

    if not isinstance(model, dict): raise BundleError('model must be an object')
    unknown = sorted(set(model) - MODEL_KEYS[network['engine']])
    if unknown: raise BundleError(f'model has an unknown field {unknown[0]!r}')
    if model.get('weightBits') != network['weightBits']: raise BundleError(f"model.weightBits {model.get('weightBits')!r} differs from the network structure {network['weightBits']!r}")
    if network['engine'] == DENSE:
        if model.get('format') != DENSE_FORMAT: raise BundleError(f'model.format must be {DENSE_FORMAT}')
        lif = network['kind'] == 'lif'
        for k in ('kind', 'inputs', 'outputs', 'ticks', 'leak_shift', 'reset'):
            expected = network[k] if lif or k not in ('ticks', 'leak_shift', 'reset') else {'ticks': 1, 'leak_shift': 0, 'reset': 0}[k]
            if model.get(k) != expected: raise BundleError(f'model.{k} {model.get(k)!r} differs from the network structure {expected!r}')
        layers, output = model.get('layers'), model.get('output')
        shape = lambda L: {'tools': L.get('tools'), 'K': L.get('K'), 'D': L.get('D'), 'R': L.get('R')} if isinstance(L, dict) and 'tools' in L else {'hidden': L.get('hidden') if isinstance(L, dict) else None}
        want = [shape(L) for L in network['layers']]
        got = [shape(L) for L in layers] if isinstance(layers, list) else None
        if got != want: raise BundleError(f'model.layers {got!r} differ from the network structure {want!r}')
        width = network['inputs']
        for k, L in enumerate(layers):
            if is_tool(L):
                region(L, L['K'], width, f'layers[{k}]', 'Wc', 'bc', 'scale_c', 'k_c'); region(L, L['D'], width, f'layers[{k}]', 'Wd', 'bd', 'scale_d', 'k_d')
                width += L['R']
                continue
            region(L, L['hidden'], width, f'layers[{k}]'); width = L['hidden']
            if lif and not _int(L.get('threshold'), 1, INT32_MAX): raise BundleError(f'model.layers[{k}].threshold must be an integer in 1..{INT32_MAX}')
            if not lif and 'threshold' in L: raise BundleError(f'model.layers[{k}].threshold must be absent in a feedforward model (it fires at 1)')
        if is_tool(layers[-1]):
            if output is not None: raise BundleError('model.output must be absent when the last layer is a tool layer')
        else:
            if not isinstance(output, dict): raise BundleError('model.output must be an object')
            region(output, network['outputs'], width, 'output')
    else:
        if model.get('format') != THRESHOLD_FORMAT: raise BundleError(f'model.format must be {THRESHOLD_FORMAT}')
        if model.get('inputs') != network['inputs'] or model.get('outputs') != network['outputs']: raise BundleError('model widths differ from the network structure')
        sizes = [network['inputs'], *network['layers'], network['outputs']]
        layers = model.get('layers')
        if not isinstance(layers, list) or len(layers) != len(sizes) - 1: raise BundleError(f'model.layers must hold {len(sizes) - 1} layers')
        for k, (L, i, o) in enumerate(zip(layers, sizes[:-1], sizes[1:])):
            if not isinstance(L, dict): raise BundleError(f'model.layers[{k}] must be an object')
            region(L, o, i, f'layers[{k}]', b='th')
    return model


def validate_result(bundle, model, evaluation, provenance):
    validate_model(model, trained_parts(bundle)[1])
    if not isinstance(evaluation, dict) or not isinstance(provenance, dict): raise BundleError('evaluation and provenance must be objects')
    return model


# ───────────────────────────── child process ─────────────────────────────
def write_json(path, value):
    """Atomic JSON write (temp file + rename)."""
    tmp = f'{path}.tmp'
    with open(tmp, 'w') as f: json.dump(value, f)
    os.replace(tmp, path)


def run_job(run_dir, emit):
    """Train the bundle snapshot in run_dir (bundle.json, optional tables.json, run.json for the hash). Writes result.json."""
    run_dir = Path(run_dir)
    with open(run_dir / 'bundle.json') as f: bundle = json.load(f)
    tables = None
    if (run_dir / 'tables.json').is_file():
        with open(run_dir / 'tables.json') as f: tables = json.load(f)
    bundle_hash = None
    if (run_dir / 'run.json').is_file():
        with open(run_dir / 'run.json') as f: bundle_hash = json.load(f).get('bundleHash')
    result = train_bundle(bundle, on_progress=lambda p: emit({'type': 'progress', 'progress': p}), tables=tables, bundle_hash=bundle_hash)
    write_json(run_dir / 'result.json', result)
    return result


def _watch_parent(parent_pid):
    """Exit if the workspace service disappears: a job without a parent can never be published."""
    import threading

    def loop():
        while True:
            time.sleep(1.0)
            if os.getppid() != parent_pid: os._exit(2)
    threading.Thread(target=loop, daemon=True, name='parent-watchdog').start()


def main(argv=None):
    ap = argparse.ArgumentParser(description='Workspace job child: train the bundle snapshot in --run-dir (used by training/workspace.py).')
    ap.add_argument('--run-dir', required=True)
    ap.add_argument('--parent-pid', type=int, help='exit when this process is no longer the parent (set by workspace.py)')
    ap.add_argument('--threads', type=int, default=0, help='torch intra-op threads (0 = torch default)')
    a = ap.parse_args(argv)
    if a.parent_pid: _watch_parent(a.parent_pid)
    if a.threads > 0: _torch().set_num_threads(a.threads)

    def emit(event):
        sys.stdout.write(json.dumps(event) + '\n'); sys.stdout.flush()

    try:
        run_job(a.run_dir, emit)
    except Exception as e:                                     # the parent reads this line and marks the run failed
        emit({'type': 'error', 'error': f'{type(e).__name__}: {e}'})
        sys.exit(1)


if __name__ == '__main__':
    main()
