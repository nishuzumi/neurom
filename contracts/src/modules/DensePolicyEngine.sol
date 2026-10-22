// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./EngineBase.sol";

/// @title DensePolicyEngine — engine "dense-policy": a list of plain layers and tool layers, FF or LIF (ADR 0010).
/// @notice Numerics equal frontend/runtime/dense-policy.js integerStep. The layer list holds plain layers (`hidden`
///         neurons) and tool layers (K tools in wire order, D data bits, R result bits). Every affine map (region) has
///         its own shift k (ADR 0015). Below, x is the vector a layer reads (the input bits first) and
///         I[j] = (Σ_i W[j,i]·x[i]) · 2^k + b[j]:
///           FF  (kind 0): a plain layer fires where I[j] >= 1 (its threshold, always 1) and passes those bits on.
///                         FF has no state.
///           LIF (kind 1): tool layers cut the network into segments. A segment runs all `ticks`. In each tick, each of
///                         its layers updates V[j] = V[j] - (V[j] >> leakShift) + I[j] and fires where V[j] >= threshold_l
///                         (the layer's own threshold). A fire sets count[j]++ and V[j] = reset. The first layer of a
///                         segment computes its I one time from the segment input. A later layer computes its I from the
///                         spikes of the layer before it in the same tick. Voltages of every plain layer persist per
///                         (actor, session).
///           Tool layer (greedy): K choice logits and D data logits on the layer before. That is its activations (FF)
///                         or its spike counts with the biases × ticks (LIF). When no plain layer comes before it in its
///                         segment, it is the segment input bits with unscaled biases. choice = first maximum. Data bit
///                         d = (logit_d > 0). Only tool `choice` is called: forwardFrom(its state slice, data[0 .. its
///                         inputs)). Its result bit k = (score_k >= 0), zero-extended to R. The next layer reads
///                         result ‖ the layer before. For FF, the layer before gives its activations / the bits it read.
///                         For LIF, it gives whether each neuron fired at least once in the segment / the segment input.
///           Output: scores[a] = (Σ_j W[a,j]·x[j]) · 2^k + m·b[a], m = 1 (FF) or ticks (LIF) over the last layer's
///                   activations / spike counts. When the last layer is a tool layer, its R result bits are the
///                   output: scores = +1 / −1.
///           action = first maximum. counts = activations / spike counts of every plain layer, in layer order.
///         Shape (four words):
///           shape[0], shape[1] layout: layer l is the 64-bit descriptor at bits [64·(l % 4), 64·(l % 4) + 64) of
///                    shape[l / 4]. A descriptor holds [0, 16) hidden − 1 or K − 1, [16, 32) D − 1, [32, 48) R − 1 and
///                    bit 48 = tool layer. Bits 49..63 are zero. A plain layer has zero at [16, 48). Every width is
///                    1..65535. Zero above the last layer.
///           shape[2] parameters: [0, 8) layer count 1..8, [8, 16) ticks 1..64, [16, 24) leakShift 0..10,
///                    [24, 32) weightBits (8 or 16), [32, 48) reset (int16). Layer l's shifts are at [48 + 10·l, 53 + 10·l)
///                    (its plain region / its choice region) and [53 + 10·l, 58 + 10·l) (its data region, 0 for a plain
///                    layer). [128, 133) is the output region's shift (0 when the last layer is a tool layer). Every
///                    shift ≤ 20. Zero above the last layer and from bit 133. FF modules carry valid ticks / leak / reset.
///           shape[3] thresholds: layer l at bits [32·l, 32·l + 32), uint32. A plain layer holds its threshold: FF
///                    exactly 1, LIF 1..2^31 − 1. A tool layer and the bits above the last layer hold 0.
///         Weights (EngineBase layout, at weightBits) come in layer order. A plain layer has one region of `hidden`
///         rows. A tool layer has two regions: its K choice rows, then its D data rows (the engine computes only the
///         input rows of the chosen tool). Then come the output layer's `outputs` rows, unless the last layer is a
///         tool layer. Each region covers the width that the layer reads (inputs first, hidden after a plain layer,
///         R + width after a tool layer).
///         Tools: modules of any kind (FF / LIF, with or without tool layers of their own) with inputs ≤ D and
///         outputs ≤ R. State (W = stateWidth int32, ≤ 256): the module's own potentials at [0, own), then the state
///         of each tool (its stateWidth, from its tool word), ordered by layer, then by wire order. The own potentials are
///         every plain layer's in layer order for LIF, and none for FF. Only the chosen tool gets its slice. The next
///         state that the tool returns replaces that slice. The slice of an unchosen tool does not change. `>>` is an
///         arithmetic shift (rounds toward −inf). Voltages are int32 (checked over the whole state after each
///         decision, "volt"). An all-zero state is rest.
contract DensePolicyEngine is EngineBase {
    uint256 public constant MAX_LAYERS = 8;
    uint256 public constant MAX_WIDTH = 65535;
    uint256 public constant MAX_TICKS = 64;
    uint256 public constant MAX_LEAK_SHIFT = 10;
    uint256 public constant MAX_STATE = 256;
    uint256 public constant MAX_SHIFT = 20;

    uint256 private constant TOOL_FLAG = 1 << 48;
    /// @dev the 64 bits of one layer descriptor
    uint256 private constant DESC = 0xffffffffffffffff;
    /// @dev the largest LIF threshold, 2^31 − 1
    uint256 private constant MAX_THRESHOLD = 0x7fffffff;

    /// @dev The decoded shape and everything one decision threads through the layers.
    struct Run {
        uint256 layout0;     // shape[0]: the descriptors of layers 0 .. 3
        uint256 layout1;     // shape[1]: the descriptors of layers 4 .. 7
        uint256 n;           // layer count
        uint256 ticks;
        uint256 leak;
        uint256 bits;        // weightBits, 8 or 16
        int256 reset;
        uint256 params;      // shape[2], where each region's shift is read
        uint256 thresholds;  // shape[3]
        bytes blob;          // the weight blob
        uint256 pos;         // byte offset of the next layer's region
        uint256 tool;        // index into tools of the next tool layer's first tool
        uint256 at;          // next free slot of counts / own voltages
        uint256 slot;        // index into state of the next tool layer's first tool's slice
        int256[] state;      // the whole state: own voltages, then each tool's slice, updated in place
        uint256[] result;    // the last tool layer's result
    }

    function check(uint8 kind, uint16 inputs, uint16 outputs, uint256[] calldata shape, uint256[] calldata tools)
        external pure returns (uint256 weightBytes, uint256 stateWidth)
    {
        require(shape.length == 4, "shape");
        Run memory r = _decode(shape);
        require(r.n >= 1 && r.n <= MAX_LAYERS, "layers");
        require(r.n >= 4 ? r.layout1 >> (64 * (r.n - 4)) == 0 : r.layout0 >> (64 * r.n) == 0 && r.layout1 == 0, "shape");
        require(r.params >> 133 == 0, "shape");
        require(r.ticks >= 1 && r.ticks <= MAX_TICKS, "ticks");
        require(r.leak <= MAX_LEAK_SHIFT, "leak");
        require(r.bits == 8 || r.bits == 16, "bits");
        require((r.params >> (48 + 10 * r.n)) & ((1 << (10 * (MAX_LAYERS - r.n))) - 1) == 0, "shift");   // none above the last layer
        require(r.n == MAX_LAYERS || r.thresholds >> (32 * r.n) == 0, "threshold");
        bool lif = kind == ModuleKinds.KIND_LIF;
        uint256 width = inputs;
        uint256 t;
        uint256 plain;
        bool lastTool;
        for (uint256 l; l < r.n; l++) {
            uint256 desc = _desc(r, l);
            require(desc >> 49 == 0, "shape");
            uint256 slot = (r.params >> (48 + 10 * l)) & 1023;                  // k0 | k1 << 5
            uint256 th = (r.thresholds >> (32 * l)) & 0xffffffff;
            lastTool = desc & TOOL_FLAG != 0;
            if (!lastTool) {
                require(slot <= MAX_SHIFT, "shift");                              // and no data shift
                require(lif ? th >= 1 && th <= MAX_THRESHOLD : th == 1, "threshold");
                uint256 hidden = (desc & 0xffff) + 1;
                require(hidden <= MAX_WIDTH && (desc >> 16) & 0xffffffff == 0, "hidden");
                weightBytes += regionBytes(hidden, width, r.bits);
                width = hidden;
                plain += hidden;
                continue;
            }
            require(slot & 31 <= MAX_SHIFT && slot >> 5 <= MAX_SHIFT, "shift");
            require(th == 0, "threshold");
            uint256 K = (desc & 0xffff) + 1;
            uint256 D = ((desc >> 16) & 0xffff) + 1;
            uint256 R = ((desc >> 32) & 0xffff) + 1;
            require(K <= MAX_WIDTH && D <= MAX_WIDTH && R <= MAX_WIDTH, "tool layer");
            for (uint256 k; k < K; k++) {
                require(t + k < tools.length, "tool");
                uint256 w = tools[t + k];
                require(ToolWords.inputs(w) <= D && ToolWords.outputs(w) <= R, "tool");
                stateWidth += ToolWords.stateWidth(w);
            }
            t += K;
            weightBytes += regionBytes(K, width, r.bits) + regionBytes(D, width, r.bits);
            width += R;
            if (l == r.n - 1) require(outputs == R, "outputs");
        }
        require(t == tools.length, "tool");
        uint256 ko = r.params >> 128;
        require(lastTool ? ko == 0 : ko <= MAX_SHIFT, "shift");
        if (!lastTool) weightBytes += regionBytes(outputs, width, r.bits);
        if (lif) stateWidth += plain;
        require(stateWidth <= MAX_STATE, "state");
    }

    function run(uint8 kind, uint16 inputs, uint16 outputs, uint256[] calldata shape, address[] calldata chunks, uint256[] calldata tools, uint256[] calldata state, bytes calldata input)
        external view virtual returns (int256[] memory, uint16, uint8[] memory, int32[] memory)
    {
        return _run(kind, inputs, outputs, shape, chunks, tools, state, input);
    }

    function _run(uint8 kind, uint16 inputs, uint16 outputs, uint256[] calldata shape, address[] calldata chunks, uint256[] calldata tools, uint256[] calldata state, bytes calldata input)
        internal view returns (int256[] memory scores, uint16 action, uint8[] memory counts, int32[] memory voltages)
    {
        Run memory r = _decode(shape);
        Vec memory x = _input(input, inputs);
        r.blob = _load(chunks);
        uint256 plain = _plainWidth(r);
        counts = new uint8[](plain);
        uint256 own = kind == ModuleKinds.KIND_LIF ? plain : 0;
        uint256 width = own;
        unchecked { for (uint256 k; k < tools.length; k++) width += ToolWords.stateWidth(tools[k]); }
        require(state.length == (width + 7) >> 3, "state");
        r.state = _unpackState(state, width);
        r.slot = own;

        int256 factor = 1;
        if (kind == ModuleKinds.KIND_FF) {
            x = _feedforward(r, tools, x, counts);
        } else {
            bool spiking;
            (x, spiking) = _lif(r, tools, x, counts, r.state);
            if (spiking) factor = int256(r.ticks);
        }
        voltages = _voltages(r.state);

        if (_desc(r, r.n - 1) & TOOL_FLAG != 0) {
            scores = new int256[](outputs);
            unchecked { for (uint256 k; k < outputs; k++) scores[k] = r.result[k] == 1 ? int256(1) : int256(-1); }
        } else {
            scores = _affine(r.blob, r.pos, outputs, x, factor, r.bits, r.params >> 128);
        }
        action = _argmax(scores);
    }

    function _decode(uint256[] calldata shape) private pure returns (Run memory r) {
        r.layout0 = shape[0];
        r.layout1 = shape[1];
        uint256 p = shape[2];
        r.n = p & 0xff;
        r.ticks = (p >> 8) & 0xff;
        r.leak = (p >> 16) & 0xff;
        r.bits = (p >> 24) & 0xff;
        r.reset = int16(uint16(p >> 32));
        r.params = p;
        r.thresholds = shape[3];
    }

    /// @dev Layer l's 64-bit descriptor.
    function _desc(Run memory r, uint256 l) private pure returns (uint256) {
        return ((l < 4 ? r.layout0 : r.layout1) >> (64 * (l & 3))) & DESC;
    }

    /// @dev The shift of layer l's plain / choice region (`data` false) or of its data region (`data` true).
    function _shift(Run memory r, uint256 l, bool data) private pure returns (uint256) {
        return (r.params >> (data ? 53 + 10 * l : 48 + 10 * l)) & 31;
    }

    /// @dev Plain layer l's fire threshold.
    function _threshold(Run memory r, uint256 l) private pure returns (int256) {
        return int256((r.thresholds >> (32 * l)) & 0xffffffff);
    }

    function _plainWidth(Run memory r) private pure returns (uint256 total) {
        for (uint256 l; l < r.n; l++) {
            uint256 desc = _desc(r, l);
            if (desc & TOOL_FLAG == 0) total += (desc & 0xffff) + 1;
        }
    }

    /// @dev FF: every layer in order. Returns what the output layer reads.
    function _feedforward(Run memory r, uint256[] calldata tools, Vec memory x, uint8[] memory counts) private view returns (Vec memory) {
        unchecked {
            for (uint256 l; l < r.n; l++) {
                uint256 desc = _desc(r, l);
                if (desc & TOOL_FLAG != 0) { x = _concat(_vec(_toolStep(r, tools, l, x, 1)), x); continue; }
                uint256 hidden = (desc & 0xffff) + 1;
                int256[] memory current = _affine(r.blob, r.pos, hidden, x, 1, r.bits, _shift(r, l, false));
                r.pos += regionBytes(hidden, x.width, r.bits);
                x = _fire(current, 1, counts, r.at);                            // an FF layer's threshold is 1
                r.at += hidden;
            }
            return x;
        }
    }

    /// @dev LIF: segments between tool layers. `v` = the voltages of every plain layer, updated in place. Returns what
    ///      the output layer reads and whether that is a segment's spike counts (true) or bits (false).
    function _lif(Run memory r, uint256[] calldata tools, Vec memory x, uint8[] memory counts, int256[] memory v) private view returns (Vec memory, bool) {
        unchecked {
            uint256 L = r.n;
            Vec memory spikes;                   // spike counts of the last segment's last layer, while no tool layer follows
            bool spiking;
            for (uint256 s; s < L;) {
                if (_desc(r, s) & TOOL_FLAG != 0) {
                    Vec memory before = spiking ? _fired(spikes) : x;
                    x = _concat(_vec(_toolStep(r, tools, s, spiking ? spikes : x, spiking ? int256(r.ticks) : int256(1))), before);
                    spiking = false;
                    s++;
                    continue;
                }
                uint256 e = s;
                while (e < L && _desc(r, e) & TOOL_FLAG == 0) e++;
                spikes = _segment(r, s, e, x, counts, v);
                spiking = true;
                s = e;
            }
            return (spiking ? spikes : x, spiking);
        }
    }

    /// @dev Spike counts → whether each neuron fired at least once.
    function _fired(Vec memory counts) private pure returns (Vec memory v) {
        v.width = counts.width;
        v.sum = counts.nz.length;
        v.nz = new uint256[](counts.nz.length);
        for (uint256 i; i < v.nz.length; i++) v.nz[i] = (counts.nz[i] & 0xffffffff) | (1 << 32);
    }

    /// @dev One LIF segment of plain layers [s, e) on input `x`: all ticks. Returns its last layer's spike counts.
    function _segment(Run memory r, uint256 s, uint256 e, Vec memory x, uint8[] memory counts, int256[] memory v) private pure returns (Vec memory) {
        unchecked {
            uint256 len = e - s;
            uint256[] memory pos = new uint256[](len);
            uint256[] memory width = new uint256[](len);
            uint256[] memory base = new uint256[](len);
            uint256[][] memory out = new uint256[][](len);
            uint256 prevWidth = x.width;
            for (uint256 l; l < len; l++) {
                uint256 hidden = (_desc(r, s + l) & 0xffff) + 1;
                pos[l] = r.pos; width[l] = hidden; base[l] = r.at;
                r.pos += regionBytes(hidden, prevWidth, r.bits);
                r.at += hidden;
                out[l] = new uint256[](hidden);
                prevWidth = hidden;
            }
            int256[] memory constant_ = _affine(r.blob, pos[0], width[0], x, 1, r.bits, _shift(r, s, false));
            if (len == 1) {
                _ticks(r, constant_, out[0], counts, v, base[0], r.ticks, _threshold(r, s));   // one layer: all ticks per neuron at once
            } else {
                for (uint256 t; t < r.ticks; t++) {
                    _ticks(r, constant_, out[0], counts, v, base[0], 1, _threshold(r, s));
                    for (uint256 l = 1; l < len; l++) {
                        int256[] memory current = _affine(r.blob, pos[l], width[l], _vec(out[l - 1]), 1, r.bits, _shift(r, s + l, false));
                        _ticks(r, current, out[l], counts, v, base[l], 1, _threshold(r, s + l));
                    }
                }
            }
            uint256 last = base[len - 1];
            uint256[] memory n = new uint256[](width[len - 1]);
            for (uint256 j; j < n.length; j++) n[j] = counts[last + j];
            return _vec(n);
        }
    }

    /// @dev `ticks_` ticks of one layer under a constant `current` and fire threshold `th`. Updates voltages v[b ..]
    ///      and spike counts counts[b ..] in place (counts and voltages share the plain layers' layout). `o` = the
    ///      spikes of the last tick.
    function _ticks(Run memory r, int256[] memory current, uint256[] memory o, uint8[] memory counts, int256[] memory v, uint256 b, uint256 ticks_, int256 th) private pure {
        uint256 leak = r.leak;
        int256 rst = r.reset;
        assembly ("memory-safe") {
            let n := mload(current)
            let pCur := add(current, 0x20)
            let po := add(o, 0x20)
            let pk := add(add(counts, 0x20), shl(5, b))
            let pv := add(add(v, 0x20), shl(5, b))
            for { let j := 0 } lt(j, n) { j := add(j, 1) } {
                let off := shl(5, j)
                let vj := mload(add(pv, off))
                let cur := mload(add(pCur, off))
                let k := mload(add(pk, off))
                let fired := 0
                for { let t := 0 } lt(t, ticks_) { t := add(t, 1) } {
                    vj := add(sub(vj, sar(leak, vj)), cur)                          // 漏 + 积
                    fired := iszero(slt(vj, th))
                    if fired { k := add(k, 1) vj := rst }                           // 放
                }
                mstore(add(pv, off), vj)
                mstore(add(pk, off), k)
                mstore(add(po, off), fired)
            }
        }
    }

    /// @dev Tool layer l on `prev` (biases × factor): the greedy choice and data bits, then only the chosen tool, from
    ///      its state slice. The next state that the tool returns replaces its slice. The other tools' slices do not change.
    function _toolStep(Run memory r, uint256[] calldata tools, uint256 l, Vec memory prev, int256 factor) private view returns (uint256[] memory result) {
        unchecked {
            uint256 desc = _desc(r, l);
            uint256 K = (desc & 0xffff) + 1;
            uint256 D = ((desc >> 16) & 0xffff) + 1;
            uint256 R = ((desc >> 32) & 0xffff) + 1;
            int256[] memory logits = _affine(r.blob, r.pos, K, prev, factor, r.bits, _shift(r, l, false));
            r.pos += regionBytes(K, prev.width, r.bits);
            uint256 choice;
            for (uint256 k = 1; k < K; k++) if (logits[k] > logits[choice]) choice = k;
            uint256 word = tools[r.tool + choice];
            uint256 off;
            for (uint256 k; k < K; k++) {
                if (k == choice) off = r.slot;
                r.slot += ToolWords.stateWidth(tools[r.tool + k]);
            }
            r.tool += K;
            uint256 tin = ToolWords.inputs(word);
            uint256 tout = ToolWords.outputs(word);
            int256[] memory dl = _affineRows(r.blob, r.pos, tin, D, prev, factor, r.bits, _shift(r, l, true));   // data rows past the tool's inputs are unused
            r.pos += regionBytes(D, prev.width, r.bits);
            bytes memory data = new bytes(tin);
            for (uint256 d; d < tin; d++) if (dl[d] > 0) data[d] = 0x01;
            int256[] memory s = _callTool(r, word, off, data);
            require(s.length == tout, "tool");
            result = new uint256[](R);
            for (uint256 k; k < tout; k++) if (s[k] >= 0) result[k] = 1;
            r.result = result;
        }
    }

    /// @dev The tool of `word` on `data` from its slice r.state[off ..), which takes the next state it returns.
    function _callTool(Run memory r, uint256 word, uint256 off, bytes memory data) private view returns (int256[] memory s) {
        unchecked {
            uint256 width = ToolWords.stateWidth(word);
            uint256[] memory slice = new uint256[]((width + 7) >> 3);
            for (uint256 j; j < width; j++) slice[j >> 3] |= uint256(uint32(int32(r.state[off + j]))) << (224 - 32 * (j & 7));
            int32[] memory next;
            (s,,, next) = INeuromModule(ToolWords.module(word)).forwardFrom(slice, data);
            require(next.length == width, "tool");
            for (uint256 j; j < width; j++) r.state[off + j] = next[j];
        }
    }

    /// @dev int32 voltage j lives in word j/8 at bits [224 - 32·(j%8), 256 - 32·(j%8)) (NeuromModule's packing).
    function _unpackState(uint256[] calldata state, uint256 width) private pure returns (int256[] memory v) {
        v = new int256[](width);
        for (uint256 j; j < width; j++) v[j] = int32(uint32(state[j >> 3] >> (224 - 32 * (j & 7))));
    }

    /// @dev The voltages after a decision as int32. Reverts "volt" when one leaves the int32 range.
    function _voltages(int256[] memory v) private pure returns (int32[] memory out) {
        out = new int32[](v.length);
        for (uint256 j; j < v.length; j++) {
            require(v[j] >= type(int32).min && v[j] <= type(int32).max, "volt");
            out[j] = int32(v[j]);
        }
    }
}
