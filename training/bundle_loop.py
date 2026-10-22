"""Batched Python twin of frontend/core/loop.js: the loop executor (ADR 0009 §2, ADR 0010) over B lanes, and the one
greedy episode runner every Python validation uses.

    lx = create_loop(bundle['loop'], models={networkId: model})
    lx.reset(B)                                     # zero every network's executor state (its tools' states included)
    out = lx.step(bits, mask, intercept=None)       # {action [B], values {'<node>.<port>': [B, …]}, ran {node: bool [B]},
                                                    #  tools {network: {port: {choice [B], data [B, D], result [B, R]}}}}
    lx.states()                                     # {network: [B, W]}: each network's state (own potentials ‖ tool states)
    lx.transition(tr, out)                          # the Transition record the reward reads (+ `loop` with tool layers)

Evaluation is demand-driven from `loop.action`, per lane. A node runs on a lane iff that lane demands one of its
outputs, at most once per step (memo). Frozen networks run the integer executors:
    dense-policy        integerStep, layer lists with tool layers
    threshold-layers    layersStep
`intercept = (networkId, fn)` replaces one network. `fn(x, lanes)` gets its `in` bits [B, w] (valid on `lanes`) and
returns one of these results:
    {'scores': [B, O]}     decoded by the readout as usual
    {'slot': [B]}          the argmax slot its readout reports: an integer in 0..O-1
    {'bits': [B, O]}       the bits its bits readout reports: exactly O wide, coerced to 0/1
Each result can also have `'tools'` (the records of its tool layers, in the shape of the executor). The executor checks
the results as loop.js checks them. The executor can call fn more than once per step, on disjoint lanes. Values of
lanes a node did not run on are neutral zeros, and so are their tool records.
A network with tool layers carries `tools: {port: [Tool…]}` (wire order). Each Tool is one of these entries:
    {kind: 'net', structure, model, readout, tools?}    a frozen network of any kind, read through its readout (bits:
                                                        score ≥ 0; argmax: one-hot of the first maximum).
                                                        It reads the first `inputs` data bits. It has `tools` iff its
                                                        structure has tool layers (the same shape).
    {kind: 'program', program, bound, boundTypes, exact}    typed at bits[D]
Only the chosen tool runs on each lane (ToolCaller). A network's state (width W) is its own LIF potentials (FF: none)
followed by the state of each tool in tool-layer order then wire order. The state of a network tool is its own W
(recursively). A code tool has no state. A network tool's state advances only on the lanes and steps it is chosen on.
It resets with the state of the calling network (ADR 0010, CONTEXT.md Tool).
"""
import numpy as np

from bundle_env import NUMBER, BoundProgram, RunnerError, copy_value, ensure, transition

INPUT = '$input'
INVALID_ACTION = -1
DENSE_FORMAT, THRESHOLD_FORMAT = 'dense-policy', 'threshold-layers'
BODY_KINDS = ('network', 'readout', 'bits')


# ───────────────────────────── integer executors (numpy) ─────────────────────────────
def is_tool(layer): return 'tools' in layer


def dense_state_width(model):
    """Length of a dense model's own voltages (and counts): the widths of its plain layers, one after another (FF
    voltages are not state: its own state width is 0, see own_state_width)."""
    return sum(L['hidden'] for L in model['layers'] if not is_tool(L))


def own_state_width(model):
    """The part of a network's state that is its own: the potentials of a LIF dense model. FF and threshold layers keep none."""
    return dense_state_width(model) if model.get('kind') == 'lif' else 0


def _i64(v): return np.asarray(v, dtype=np.int64)


_INT_KEYS = ('W', 'b', 'th', 'Wc', 'bc', 'Wd', 'bd')


def _int_model(m):
    """`m` (dense or threshold layers) with every weight / bias / threshold as an int64 ndarray: converted once per model,
    so the executors do not reconvert the JSON lists on every step."""
    conv = lambda L: {k: _i64(v) if k in _INT_KEYS else v for k, v in L.items()}
    out = {**m, 'layers': [conv(L) for L in m['layers']]}
    if m.get('output') is not None: out['output'] = conv(m['output'])
    return out


def _affine(x, W, k, f, b):
    """One region's integers z = (x·Wᵀ)·2^k + f·b (exact int64, ADR 0015)."""
    return (x @ _i64(W).T) * (1 << k) + f * _i64(b)


def _tool_step(layer, prev, factor, call, S):
    """A tool layer's greedy decision on prev [B, fanIn] (biases × factor, each region its own shift k): choice = first
    maximum, data bit = logit > 0. Then the chosen tool gives its result through call(port, choice, data, S) → [B, R]
    (S: the tool states of the lanes, updated in place)."""
    if call is None: raise RunnerError(f"the model has tool layer {layer['tools']} but no tools are wired")
    choice = np.argmax(_affine(prev, layer['Wc'], layer['k_c'], factor, layer['bc']), axis=1)
    data = (_affine(prev, layer['Wd'], layer['k_d'], factor, layer['bd']) > 0).astype(np.int64)
    return {'choice': choice, 'data': data, 'result': call(layer['tools'], choice, data, S)}


def dense_step(model, x, V=None, call=None):
    """integerStep semantics (frontend/runtime/dense-policy.js) for a batch: x [B,I] 0/1 int64, V [B, W] int64 the
    network's state — its own LIF potentials ‖ its tools' states (call.width), zeros when None. The function returns an
    updated copy of V. Every region adds (Σ W·x)·2^k (its own shift k) to its bias. FF: each plain layer fires
    where its current ≥ 1. LIF: plain layer l fires where V ≥ its own threshold. Tool layers cut the layers into
    segments. Each segment runs all ticks and passes the spikes of each tick from layer to layer. The current of its
    first layer stays constant. A tool layer decides on the layer before it:
        FF               the activations
        LIF              the spike counts, with biases × ticks
        empty segment    its input bits
    Then it hands on `result ‖ before` (LIF: fired at least once). The chosen tools run from (and write back)
    their slices of the tool states. A trailing tool layer scores ±1 per result bit. Returns (scores [B,O] int64,
    counts [B,plain widths], V [B, W], tools {port: record} or None)."""
    layers, B = model['layers'], x.shape[0]
    own = own_state_width(model)
    width = own + (call.width if call is not None else 0)
    V = np.zeros((B, width), dtype=np.int64) if V is None else V.copy()
    if V.shape != (B, width): raise RunnerError(f'a network state needs {width} values per lane, got {V.shape[1:]}')
    S = V[:, own:]                                                   # the tools' states (a view: tools write back into V)
    counts, tools = [], None
    if model['kind'] == 'feedforward':
        h = x
        for L in layers:
            if is_tool(L):
                r = _tool_step(L, h, 1, call, S)
                tools = tools or {}; tools[L['tools']] = r
                h = np.concatenate([r['result'], h], axis=1)
                continue
            h = (_affine(h, L['W'], L['k'], 1, L['b']) >= 1).astype(np.int64)
            counts.append(h)
        last = h
    else:
        ticks, shift, reset = model['ticks'], model['leak_shift'], model['reset']
        h, seg_counts, at, s = x, None, 0, 0
        while s < len(layers):
            if is_tool(layers[s]):
                L = layers[s]
                r = _tool_step(L, seg_counts, ticks, call, S) if seg_counts is not None else _tool_step(L, h, 1, call, S)
                tools = tools or {}; tools[L['tools']] = r
                h = np.concatenate([r['result'], (seg_counts > 0).astype(np.int64) if seg_counts is not None else h], axis=1)
                seg_counts, s = None, s + 1
                continue
            e = s
            while e < len(layers) and not is_tool(layers[e]): e += 1
            seg = layers[s:e]
            Ws, bs, ks = [_i64(L['W']) for L in seg], [_i64(L['b']) for L in seg], [1 << L['k'] for L in seg]
            base = []
            for L in seg: base.append(at); at += L['hidden']
            constant = (h @ Ws[0].T) * ks[0] + bs[0]
            n = [np.zeros((B, L['hidden']), dtype=np.int64) for L in seg]
            spikes = None
            for _ in range(ticks):
                for l, L in enumerate(seg):
                    cur = constant if l == 0 else (spikes @ Ws[l].T) * ks[l] + bs[l]
                    v = V[:, base[l]:base[l] + L['hidden']]
                    v = v - (v >> shift) + cur
                    f = v >= L['threshold']
                    n[l] += f
                    V[:, base[l]:base[l] + L['hidden']] = np.where(f, reset, v)
                    spikes = f.astype(np.int64)
            counts.extend(n)
            seg_counts, s = n[-1], e
        last = seg_counts if seg_counts is not None else h
        # the module contract keeps int32 potentials and reverts ("volt") when one leaves that range after a decision
        if own and (V[:, :own].min() < -2 ** 31 or V[:, :own].max() > 2 ** 31 - 1): raise RunnerError('a LIF potential left int32: the chain refuses this step (volt)')
    counts = np.concatenate(counts, axis=1) if counts else np.zeros((B, 0), dtype=np.int64)
    final = layers[-1]
    if is_tool(final): return 2 * tools[final['tools']]['result'] - 1, counts, V, tools
    out = model['output']
    factor = model['ticks'] if model['kind'] == 'lif' else 1
    return _affine(last, out['W'], out['k'], factor, out['b']), counts, V, tools


def layers_scores(model, x):
    """Threshold layers executor: per layer z = (Σ W·h)·2^k − th, act = z ≥ 0. Returns the z of the last layer (int64)."""
    h, z = x.astype(np.int64), None
    for L in model['layers']:
        z = _affine(h, L['W'], L['k'], -1, L['th'])
        h = (z >= 0).astype(np.int64)
    return z


def argmax_first(scores): return np.argmax(scores, axis=1)          # numpy argmax returns the first maximum, like the chain


def readout_bits(spec, scores):
    """The bits the on-chain readout emits for scores [B, O]: one-hot of the first maximum (argmax) or score ≥ 0 (bits)."""
    if spec['mode'] == 'argmax':
        bits = np.zeros(scores.shape, dtype=np.int64); bits[np.arange(scores.shape[0]), argmax_first(scores)] = 1
        return bits
    return (scores >= 0).astype(np.int64)


def decode_bits(bits):
    """lsb-int decode of a [B,O] 0/1 array."""
    return bits.astype(np.float64) @ (2.0 ** np.arange(bits.shape[1]))


def readout_width(readout): return len(readout['map']) if readout['mode'] == 'argmax' else readout['width']


def slot_actions(readout):
    """argmax readout: slot index → action (null → INVALID_ACTION)."""
    return np.array([INVALID_ACTION if a is None else a for a in readout['map']], dtype=np.float64)


# ───────────────────────────── tools ─────────────────────────────
def bits_type(width): return {'type': 'vector', 'width': width, 'binary': True}


class _CodeTool:
    """A code tool: no state."""
    width = 0

    def __init__(self, tool, D, name):
        self.prog = BoundProgram(tool, [bits_type(D)], name)
        if self.prog.result.get('type') != 'vector': raise RunnerError(f'tool {name} must return bits')

    def run(self, data, _state): return np.asarray(self.prog.run([data.astype(np.float64)], data.shape[0])), _state


class _NetTool:
    """A frozen network tool (twin of loop.js toolRunner): its model on the first `inputs` data bits from its state
    (own potentials ‖ its own tools' states, through its nested ToolCaller), read through its readout (bits or argmax)."""

    def __init__(self, tool, name):
        m, st = tool.get('model'), tool.get('structure') or {}
        if m is None: raise RunnerError(f'tool {name} has no model')
        if m.get('format') not in (DENSE_FORMAT, THRESHOLD_FORMAT): raise RunnerError(f'tool {name}: unknown model format {m.get("format")!r}')
        self.I, self.spec, self.m = st['inputs'], tool['readout'], _int_model(m)
        self.call = ToolCaller(name, tool) if self.m['format'] == DENSE_FORMAT and any(is_tool(L) for L in self.m['layers']) else None
        self.width = own_state_width(self.m) + (self.call.width if self.call is not None else 0)

    def run(self, data, state):
        x = data[:, :self.I]
        if self.m['format'] == THRESHOLD_FORMAT: return readout_bits(self.spec, layers_scores(self.m, x)), state
        scores, _, state, _ = dense_step(self.m, x, state, self.call)
        return readout_bits(self.spec, scores), state


def _tool_runner(tool, D, name):
    kind = tool.get('kind') if isinstance(tool, dict) else None
    if kind == 'program': return _CodeTool(tool, D, name)
    if kind == 'net': return _NetTool(tool, name)
    raise RunnerError(f'unknown tool kind: {kind!r}')


class ToolCaller:
    """The tools of the tool layers of network `nid` (`node`: a loop network node or a network Tool entry, both
    `{structure, tools}`): call(port, choice [B], data [B, D], S [B, width]) → result [B, R] int64. S holds the tool
    states of the lanes, in tool-layer order then wire order (None: the rest state, discarded). Each lane runs only its
    chosen tool, from its slice of S, and writes that slice back in place. ToolCaller checks that results are 0/1 and at
    most R wide, then zero-extends them to R. Executor and trainers call tools through it."""

    def __init__(self, nid, node):
        self.ports, self.width = {}, 0
        for L in node['structure']['layers']:
            if not is_tool(L): continue
            tools = (node.get('tools') or {}).get(L['tools']) or []
            if len(tools) != L['K']: raise RunnerError(f"tool layer {L['tools']} of network {nid} needs {L['K']} tools; the bundle has {len(tools)}")
            runners = []
            for k, t in enumerate(tools):
                r = _tool_runner(t, L['D'], f"{nid}.{L['tools']}[{k}]")
                runners.append((r, self.width)); self.width += r.width
            self.ports[L['tools']] = (L['R'], runners)

    def state(self, B): return np.zeros((B, self.width), dtype=np.int64)

    def __call__(self, port, choice, data, S=None):
        if S is None: S = self.state(data.shape[0])
        R, runners = self.ports[port]
        out = np.zeros((data.shape[0], R), dtype=np.int64)
        for k in np.unique(choice):
            rows = choice == k
            runner, at = runners[int(k)]
            got, state = runner.run(data[rows], S[rows, at:at + runner.width])
            if got.ndim != 2 or got.shape[1] > R: raise RunnerError(f'tool {int(k)} of tool layer {port} returned {got.shape[-1]} bits, at most {R}')
            if not ((got == 0) | (got == 1)).all(): raise RunnerError(f'tool {int(k)} of tool layer {port} returned bits other than 0/1')
            out[rows, :got.shape[1]] = got
            if runner.width: S[rows, at:at + runner.width] = state
        return out


def tool_networks(loop_bundle):
    """[(id, title, {port: (D, R)})] of the loop's networks with tool layers."""
    return [(nid, n.get('title'), {L['tools']: (L['D'], L['R']) for L in n['structure']['layers'] if is_tool(L)})
            for nid, n in loop_bundle['nodes'].items() if n.get('kind') == 'network' and n.get('tools')]


def transition_type(Transition, loop_bundle):
    """The Transition type the reward receives (loop.js transitionTypeOf): with `loop: {title: {port: {choice, data,
    result}}}` when the loop has tool layers (ADR 0010 §10)."""
    nets = tool_networks(loop_bundle)
    if not nets: return Transition
    layer = lambda D, R: {'type': 'record', 'fields': {'choice': NUMBER, 'data': bits_type(D), 'result': bits_type(R)}}
    loop = {'type': 'record', 'fields': {title: {'type': 'record', 'fields': {port: layer(D, R) for port, (D, R) in ports.items()}} for _, title, ports in nets}}
    return {**Transition, 'fields': {**Transition['fields'], 'loop': loop}}


# ───────────────────────────── loop executor ─────────────────────────────
def _ref(r, what):
    if not isinstance(r, dict) or not isinstance(r.get('node'), str) or not isinstance(r.get('port'), str): raise RunnerError(f'{what} must be a {{node, port}} reference')
    return r


class LoopExec:
    def __init__(self, loop_bundle, models=None):
        if not isinstance(loop_bundle, dict) or not isinstance(loop_bundle.get('nodes'), dict): raise RunnerError('loop bundle lacks nodes')
        self.nodes, self.I = loop_bundle['nodes'], loop_bundle.get('I')
        self.action = _ref(loop_bundle.get('action'), 'loop.action')
        models = models or {}
        self.models, self.readout_of, self.callers = {}, {}, {}
        for nid, n in self.nodes.items():
            k = n.get('kind')
            if k not in BODY_KINDS: raise RunnerError(f'loop node {nid}: unknown kind {k!r}')
            if k == 'network':
                _ref(n.get('in'), f'{nid}.in')
                m = models.get(nid, n.get('model'))
                if m is not None and m.get('format') not in (DENSE_FORMAT, THRESHOLD_FORMAT): raise RunnerError(f'network {nid}: unknown model format {m.get("format")!r}')
                self.models[nid] = _int_model(m) if m is not None else None
                if n.get('tools'): self.callers[nid] = ToolCaller(nid, n)
            elif k == 'readout':
                src = _ref(n.get('scores'), f'{nid}.scores')['node']
                if src in self.readout_of: raise RunnerError(f'network {src} has more than one readout in the loop')
                self.readout_of[src] = nid
            else:
                for p in n['parts']: _ref(n['in'].get(p['port']), f"{nid}.{p['port']}")
        for r in self._refs():
            if r['node'] != INPUT and r['node'] not in self.nodes: raise RunnerError(f'loop reference to unknown node {r["node"]}')
        self.tool_nets = tool_networks(loop_bundle)
        titles = [n.get('title') for n in self.nodes.values() if n.get('kind') == 'network']
        if self.tool_nets and len(set(titles)) != len(titles): raise RunnerError('network titles in a loop with tool layers must be unique')
        self.B = None

    def _refs(self):
        yield self.action
        for n in self.nodes.values():
            k = n['kind']
            if k == 'network': yield n['in']
            elif k == 'readout': yield n['scores']
            else: yield from n['in'].values()

    def width(self, ref):
        """Static width of a bits-valued reference (0 for numbers)."""
        if ref['node'] == INPUT: return self.I
        n = self.nodes[ref['node']]
        k = n['kind']
        if k == 'network': return n['structure']['outputs']
        if k == 'readout': return 0 if ref['port'] == 'action' else readout_width(n['readout'])
        return sum(p['width'] for p in n['parts'])

    def state_width(self, nid):
        """W of network nid running its model: its own potentials ‖ its tools' states."""
        return own_state_width(self.models[nid]) + (self.callers[nid].width if nid in self.callers else 0)

    def reset(self, B):
        """Zero every network's state (its tools' states included) for B lanes."""
        self.B = B
        self.V = {nid: np.zeros((B, self.state_width(nid)), dtype=np.int64) for nid, m in self.models.items() if m is not None}

    def states(self):
        """{network: [B, W] int64} of every network running a model (loop.js states()): own potentials ‖ tool states."""
        return self.V

    def transition(self, tr, out):
        """The Transition record of step result `tr` with `loop.<title>.<port>` from `out['tools']` when the loop has tool
        layers (loop.js loopTransition). A tool network that did not run on an active lane is an error."""
        rec = transition(tr)
        if not self.tool_nets: return rec
        loop = {}
        for nid, title, _ in self.tool_nets:
            if (tr['active'] & ~out['ran'][nid]).any(): raise RunnerError(f'network {title} did not run this step: the transition has no record of its tool layers')
            loop[title] = out['tools'][nid]
        return {**rec, 'loop': loop}

    # -- one step
    def step(self, bits, mask=None, intercept=None):
        """Evaluate `loop.action` on the lanes of `mask` (default: all). Returns {action, values, ran, tools}."""
        if self.B is None: raise RunnerError('call reset first')
        B = self.B
        mask = np.ones(B, dtype=bool) if mask is None else mask
        self._bits, self._intercept = np.asarray(bits, dtype=np.float64), intercept
        self._ran = {nid: np.zeros(B, dtype=bool) for nid in self.nodes}
        self._values, self._direct, self._tools = {}, {}, {}
        action = self._eval(self.action, mask)
        return {'action': np.where(mask, action, 0.0), 'values': self._values, 'ran': self._ran, 'tools': self._tools}

    def _eval(self, ref, lanes):
        if ref['node'] == INPUT: return self._bits
        self._run(ref['node'], lanes)
        return self._values[f"{ref['node']}.{ref['port']}"]

    def _put(self, key, value, need, into=None, compact=False):
        """Write `value` on the lanes of `need`: full-batch rows, or with `compact` the rows of those lanes only."""
        into = self._values if into is None else into
        cur = into.get(key)
        if cur is None: cur = into[key] = np.zeros((self.B,) + value.shape[1:], dtype=np.float64)
        cur[need] = value if compact else value[need]

    def _put_tools(self, nid, tools, need, compact=False):
        """Tool records {port: {choice, data, result}} of network nid (arrays as in _put)."""
        rec = self._tools.setdefault(nid, {})
        for port, r in tools.items():
            p = rec.setdefault(port, {})
            for key in ('choice', 'data', 'result'): self._put(key, np.asarray(r[key], dtype=np.float64), need, p, compact)

    def _run(self, nid, lanes):
        need = lanes & ~self._ran[nid]
        if not need.any(): return
        n = self.nodes[nid]
        k = n['kind']
        if k == 'network': self._network(nid, n, need)
        elif k == 'readout': self._readout(nid, n, need)
        else:
            parts = [self._eval(n['in'][p['port']], need)[:, p['offset']:p['offset'] + p['width']] for p in n['parts']]
            self._put(f'{nid}.bits', np.concatenate(parts, axis=1), need)
        self._ran[nid] |= need

    def _network(self, nid, n, need):
        x = self._eval(n['in'], need)
        if self._intercept is not None and self._intercept[0] == nid:
            res = self._intercept[1](x, need)
            if res.get('tools') is not None: self._put_tools(nid, res['tools'], need)
            if 'scores' in res: self._put(f'{nid}.scores', np.asarray(res['scores'], dtype=np.float64), need)
            else:
                d = self._direct.setdefault(nid, {})
                for key, v in res.items():
                    if key != 'tools': self._put(key, np.asarray(v, dtype=np.float64), need, d)
            return
        m = self.models[nid]
        if m is None: raise RunnerError(f'network {nid} has no model')
        xi = x[need].astype(np.int64)
        if m['format'] == DENSE_FORMAT:
            V = self.V[nid]
            scores, _, V[need], tools = dense_step(m, xi, V[need], self.callers.get(nid))
            if tools is not None: self._put_tools(nid, tools, need, compact=True)
        else: scores = layers_scores(m, xi)
        self._put(f'{nid}.scores', scores, need, compact=True)

    def _readout(self, nid, n, need):
        spec, src = n['readout'], n['scores']['node']
        self._run(src, need)
        O = readout_width(spec)
        direct = self._direct.get(src)
        if direct is not None:                                       # an intercepted result, checked as loop.js does
            if spec['mode'] == 'argmax':
                raw = direct.get('slot')
                if raw is None: raise RunnerError(f'the intercept of {src} gave no readout slot')
                slot = raw.astype(np.int64)
                if ((slot != raw) | (slot < 0) | (slot >= O))[need].any(): raise RunnerError(f'intercepted slot outside 0..{O - 1}')
                bits = np.zeros((self.B, O)); bits[np.arange(self.B), np.clip(slot, 0, O - 1)] = 1
            else:
                raw = direct.get('bits')
                if raw is None or raw.ndim != 2 or raw.shape[1] != O: raise RunnerError(f'intercepted readout bits need {O} bits')
                bits = (raw != 0).astype(np.float64)
        else: bits = readout_bits(spec, self._values[f'{src}.scores'])
        action = slot_actions(spec)[np.argmax(bits, axis=1)] if spec['mode'] == 'argmax' else decode_bits(bits)
        self._put(f'{nid}.bits', bits, need)
        self._put(f'{nid}.action', action, need)


def create_loop(loop_bundle, models=None):
    return LoopExec(loop_bundle, models=models)


# ───────────────────────────── the greedy episode runner ─────────────────────────────
def run_episodes(env, lx, starts, reward=None, intercept=None, on_step=None):
    """Run every start to done through env + loop (one lane each). `reward` (a BoundProgram over the loop's Transition,
    transition_type) sums into `return`. `on_step(state, out, tr)` sees the state before the step, the loop's step result
    and the Transition. Returns the batched Episode summary {initial, final, steps, success, return}."""
    initial = copy_value(env.reset(starts))
    B = env.B
    lx.reset(B)
    ret = np.zeros(B, dtype=np.float64)
    success = np.zeros(B, dtype=bool)
    while not env.done.all():
        active = ~env.done
        state = env.state
        out = lx.step(env.input(), active, intercept)
        tr = env.step(out['action'])
        if reward is not None:
            r = ensure(NUMBER, reward.run([lx.transition(tr, out)], B, active), B, active, 'reward')
            ret += np.where(active, r, 0.0)
        success = np.where(active, tr['success'], success)
        if on_step is not None: on_step(state, out, tr)
    return {'initial': initial, 'final': env.state, 'steps': env.t.astype(np.float64), 'success': success, 'return': ret}
