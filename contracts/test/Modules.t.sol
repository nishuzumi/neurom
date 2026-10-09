// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "../src/modules/ModuleFactory.sol";
import "../src/modules/FactoryProxy.sol";
import "../src/modules/Roles.sol";
import "../src/modules/DensePolicyEngine.sol";
import "../src/modules/ThresholdLayersEngine.sol";

interface IVm {
    function cool(address) external;
    function load(address target, bytes32 slot) external view returns (bytes32);
    function expectEmit() external;
}

/// Prints with `forge test -vv` (Foundry's console).
library Console {
    address constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;
    function log(string memory what, uint256 value) internal view {
        (bool ok,) = CONSOLE.staticcall(abi.encodeWithSignature("log(string,uint256)", what, value));
        ok;
    }
}

/// A second msg.sender for direct module calls, deployments and ownership.
contract Actor {
    function step(INeuromModule m, bytes32 s, bytes calldata obs) external returns (int32[] memory v) { (,,, v) = m.step(s, obs); }
    function reset(INeuromModule m, bytes32 s) external { m.reset(s); }
    function deploy(ModuleFactory f, ModuleFactory.ModuleSpec calldata spec, bytes[] calldata data) external returns (address) { return f.deploy(spec, data); }
    function nominate(NeuromModule m, address next) external { m.nominateOwner(next); }
    function accept(NeuromModule m) external { m.acceptOwnership(); }
    /// Any call as this actor. A revert bubbles up unchanged.
    function exec(address target, bytes calldata data) external returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) assembly { revert(add(ret, 0x20), mload(ret)) }
    }
}

/// One transaction playing a whole game: `forward` once per input, like the mining game contract will.
contract Game {
    function play(INeuromModule m, bytes[] calldata inputs) external view returns (uint256 sum) {
        for (uint256 i; i < inputs.length; i++) { (, uint8 a,,) = m.forward(inputs[i]); sum += a; }
    }
}

/// Gas of a call once every account it touches is warm: the call runs twice in one transaction, the second is measured.
contract Meter {
    function warm(address target, bytes calldata data) external returns (uint256 used) {
        (bool ok,) = target.call(data);
        require(ok, "call");
        uint256 g = gasleft();
        (ok,) = target.call(data);
        used = g - gasleft();
    }
}

/// Engines that try to write while computing, added as versions of dense-policy (shapes checked as the real engine
/// does): one writes its own storage, one steps the module that called it. A module STATICCALLs its engine, so both fail.
abstract contract CheckingEngine {
    DensePolicyEngine private immutable real = new DensePolicyEngine();
    function check(uint8 kind, uint16 inputs, uint16 outputs, uint256[] calldata shape, uint256[] calldata tools) external view returns (uint256, uint256) {
        return real.check(kind, inputs, outputs, shape, tools);
    }
}
contract WritingEngine is CheckingEngine { fallback() external { assembly { sstore(0, 1) } } }
contract ReentrantEngine is CheckingEngine {
    fallback() external {
        (bool ok,) = msg.sender.call(abi.encodeCall(INeuromModule.step, (bytes32(0), new bytes(55))));
        require(ok, "reenter");
    }
}

/// A version that changes decisions — every score + 1000 — so the version a module computes with shows in its scores.
/// Real versions of one engine id never do (ADR 0017).
contract ShiftedEngine is DensePolicyEngine {
    function run(uint8 kind, uint16 inputs, uint16 outputs, uint256[] calldata shape, address[] calldata chunks, uint256[] calldata tools, uint256[] calldata state, bytes calldata input)
        external view override returns (int256[] memory scores, uint8 action, uint8[] memory counts, int32[] memory voltages)
    {
        (scores, action, counts, voltages) = _run(kind, inputs, outputs, shape, chunks, tools, state, input);
        for (uint256 k; k < scores.length; k++) scores[k] += 1000;
    }
}

/// Roles, engine versions, the Factory behind its proxy, chunks and module contracts. The tests check dense numerics
/// against values from frontend/runtime/dense-policy.js integerStep (the 12 → 8 → 4 model) or small hand models. Every
/// other number is small enough to verify by hand. Models are written row-major as int16 (W | b per layer).
/// _denseBlob / _thresholdBlob convert them to the column-major chunk layout at weightBits 8 or 16, so one expectation
/// holds at both widths. Every model whose weights fit int8 runs at both (shift 0 everywhere unless a test sets one).
contract ModulesTest {
    IVm constant vm = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 constant DENSE = keccak256("dense-policy");
    bytes32 constant THRESHOLD = keccak256("threshold-layers");

    struct Layer { uint16 hidden; uint16 data; uint16 result; address[] tools; }

    Actor foreign;                                            // a contract the Factory did not deploy
    Roles roles;
    address dense;                                            // the first version of dense-policy
    address threshold;                                        // the first version of threshold-layers
    ModuleFactory factory;                                    // the FactoryProxy
    bytes32 constant S0 = bytes32(0);
    bytes32 constant S1 = keccak256("episode-1");
    bytes32 constant ART = keccak256("artifact");
    bytes32 constant TASK = keccak256("task");
    bytes32 constant TASK_ADD = keccak256("arithmetic-add4");
    uint16 constant IN = 55; uint16 constant OUT = 7;          // hand-model layout
    uint256 constant H1 = 55 * 1 + 1 + 7 * 1 + 7;   // int16 count for 55 → 1 → 7
    uint256 constant H2 = 55 * 2 + 2 + 7 * 2 + 7;   // 55 → 2 → 7

    function setUp() public {
        foreign = new Actor();
        roles = new Roles();
        factory = ModuleFactory(address(new FactoryProxy(address(new ModuleFactory(address(roles))), abi.encodeCall(ModuleFactory.initialize, ()))));
        dense = address(new DensePolicyEngine());
        threshold = address(new ThresholdLayersEngine());
        factory.addVersion(DENSE, dense); factory.setLatest(DENSE, dense);
        factory.addVersion(THRESHOLD, threshold); factory.setLatest(THRESHOLD, threshold);
    }

    // ------------------------------------------------------------------------------------------------ blobs

    function _i16(bytes memory b, uint256 k, int256 v) internal pure { b[2 * k] = bytes1(uint8(uint256(v) >> 8)); b[2 * k + 1] = bytes1(uint8(uint256(v))); }
    function _get(bytes memory b, uint256 k) internal pure returns (int256) { return int16(uint16(uint8(b[2 * k])) << 8 | uint16(uint8(b[2 * k + 1]))); }

    /// One column-major region at `bits` per weight: row r's weights at int16 index wAt[r] .. wAt[r] + cols of `rowMajor`,
    /// its bias at bAt[r]. Each weight column takes ⌈rows · bits / 256⌉ words, then the int16 bias column ⌈rows / 16⌉ words.
    function _region(bytes memory rowMajor, uint256[] memory wAt, uint256[] memory bAt, uint256 cols, uint256 bits) internal pure returns (bytes memory out) {
        uint256 rows = wAt.length;
        uint256 colBytes = 32 * ((rows * bits + 255) / 256);
        out = new bytes(cols * colBytes + 32 * ((rows + 15) / 16));
        for (uint256 i; i < cols; i++) for (uint256 r; r < rows; r++) {
            int256 w = _get(rowMajor, wAt[r] + i);
            if (bits == 8) { require(w >= -128 && w <= 127, "not int8"); out[i * colBytes + r] = bytes1(uint8(uint256(w))); }
            else _i16(out, (i * colBytes) / 2 + r, w);
        }
        for (uint256 r; r < rows; r++) _i16(out, (cols * colBytes) / 2 + r, _get(rowMajor, bAt[r]));
    }

    /// A row-major W[rows][cols] at int16 index `at`, b right after.
    function _plainRegion(bytes memory rowMajor, uint256 at, uint256 rows, uint256 cols, uint256 bits) internal pure returns (bytes memory) {
        uint256[] memory wAt = new uint256[](rows);
        uint256[] memory bAt = new uint256[](rows);
        for (uint256 r; r < rows; r++) { wAt[r] = at + r * cols; bAt[r] = at + rows * cols + r; }
        return _region(rowMajor, wAt, bAt, cols, bits);
    }

    /// A row-major dense blob (W | b per plain layer, Wc | bc | Wd | bd per tool layer, then W | b of the output layer)
    /// in the engine's layout at `bits`: a tool layer is two regions, its K choice rows and its D data rows.
    function _denseBlob(bytes memory rowMajor, uint256 inputs, Layer[] memory l, uint256 outputs, uint256 bits) internal pure returns (bytes memory blob) {
        uint256 width = inputs;
        uint256 at;
        for (uint256 k; k < l.length; k++) {
            uint256 K = l[k].tools.length;
            if (K == 0) {
                blob = bytes.concat(blob, _plainRegion(rowMajor, at, l[k].hidden, width, bits));
                at += l[k].hidden * (width + 1);
                width = l[k].hidden;
                continue;
            }
            uint256 D = l[k].data;
            blob = bytes.concat(blob, _plainRegion(rowMajor, at, K, width, bits), _plainRegion(rowMajor, at + K * (width + 1), D, width, bits));
            at += (K + D) * (width + 1);
            width += l[k].result;
        }
        if (l.length == 0 || l[l.length - 1].tools.length == 0) blob = bytes.concat(blob, _plainRegion(rowMajor, at, outputs, width, bits));
    }

    function _thresholdBlob(bytes memory rowMajor, uint16[] memory widths, uint256 bits) internal pure returns (bytes memory blob) {
        uint256 at;
        for (uint256 l = 1; l < widths.length; l++) {
            blob = bytes.concat(blob, _plainRegion(rowMajor, at, widths[l], widths[l - 1], bits));
            at += uint256(widths[l]) * (widths[l - 1] + 1);
        }
    }

    /// The content of every chunk _pieces made, by content hash (what a deployer sends along in `deploy`).
    mapping(bytes32 => bytes) private _content;

    /// `blob` as chunks of at most MAX_CHUNK_BYTES → their content hashes. Nothing is created yet.
    function _pieces(bytes memory blob) internal returns (bytes32[] memory ids) {
        uint256 max = factory.MAX_CHUNK_BYTES();
        ids = new bytes32[]((blob.length + max - 1) / max);
        for (uint256 k; k < ids.length; k++) {
            uint256 from = k * max;
            uint256 len = blob.length - from < max ? blob.length - from : max;
            bytes memory piece = new bytes(len);
            for (uint256 i; i < len; i++) piece[i] = blob[from + i];
            ids[k] = keccak256(piece);
            _content[ids[k]] = piece;
        }
    }

    /// The `data` of deploy for `spec`: every chunk's content (the Factory skips the ones that exist).
    function _data(ModuleFactory.ModuleSpec memory spec) internal view returns (bytes[] memory d) {
        d = new bytes[](spec.chunks.length);
        for (uint256 k; k < d.length; k++) d[k] = _content[spec.chunks[k]];
    }

    /// One transaction: the missing chunks of `spec`, then its module.
    function _deploy(ModuleFactory.ModuleSpec memory spec) internal returns (address) {
        return factory.deploy(spec, _data(spec));
    }

    // ------------------------------------------------------------------------------------------------ specs

    /// Three words. shape[0] = layout. shape[1] = layer count, ticks, leak, `bits`, reset, every shift 0. shape[2] = `th`
    /// as every plain layer's threshold (FF: 1), 0 for a tool layer. A test sets a shift or a per-layer threshold in the
    /// words itself.
    function _denseShape(Layer[] memory l, uint256 bits, uint8 ticks_, uint8 leak, uint32 th, int16 rst) internal pure returns (uint256[] memory s) {
        s = new uint256[](3);
        for (uint256 k; k < l.length; k++) {
            uint256 K = l[k].tools.length;
            uint256 desc = K == 0 ? uint256(l[k].hidden) - 1 : (1 << 27) | (K - 1) | (uint256(l[k].data - 1) << 9) | (uint256(l[k].result - 1) << 18);
            s[0] |= desc << (32 * k);
            if (K == 0) s[2] |= uint256(th) << (32 * k);
        }
        s[1] = l.length | (uint256(ticks_) << 8) | (uint256(leak) << 16) | (bits << 24) | (uint256(uint16(rst)) << 32);
    }

    function _toolList(Layer[] memory l) internal pure returns (address[] memory t) {
        uint256 n;
        for (uint256 k; k < l.length; k++) n += l[k].tools.length;
        t = new address[](n);
        n = 0;
        for (uint256 k; k < l.length; k++) for (uint256 j; j < l[k].tools.length; j++) t[n++] = l[k].tools[j];
    }

    /// The spec of a dense model given as `rowMajor` at `bits`. Its chunks are not created yet.
    function _denseSpec(uint256 bits, uint8 kind, uint16 inputs, uint16 outputs, Layer[] memory l, uint8 ticks_, uint8 leak, uint32 th, int16 rst, bytes memory rowMajor, bytes32 art, bytes32 task)
        internal returns (ModuleFactory.ModuleSpec memory spec)
    {
        spec = ModuleFactory.ModuleSpec(DENSE, address(0), kind, inputs, outputs, _denseShape(l, bits, ticks_, leak, th, rst), _toolList(l), _pieces(_denseBlob(rowMajor, inputs, l, outputs, bits)), art, task);
    }

    function _dense(uint256 bits, uint8 kind, uint16 inputs, uint16 outputs, Layer[] memory l, uint8 ticks_, uint8 leak, uint32 th, int16 rst, bytes memory rowMajor, bytes32 art, bytes32 task) internal returns (NeuromModule) {
        return NeuromModule(_deploy(_denseSpec(bits, kind, inputs, outputs, l, ticks_, leak, th, rst, rowMajor, art, task)));
    }

    /// Two words: the widths, then `bits` with every shift 0.
    function _thresholdShape(uint16[] memory widths, uint256 bits) internal pure returns (uint256[] memory s) {
        s = new uint256[](2);
        for (uint256 l; l < widths.length; l++) s[0] |= uint256(widths[l]) << (16 * l);
        s[1] = bits;
    }

    function _thresholdSpec(uint256 bits, uint16[] memory widths, bytes memory rowMajor, bytes32 art, bytes32 task) internal returns (ModuleFactory.ModuleSpec memory) {
        return ModuleFactory.ModuleSpec(THRESHOLD, address(0), 0, widths[0], widths[widths.length - 1], _thresholdShape(widths, bits), new address[](0), _pieces(_thresholdBlob(rowMajor, widths, bits)), art, task);
    }

    function _threshold(uint256 bits, uint16[] memory widths, bytes memory rowMajor, bytes32 art, bytes32 task) internal returns (NeuromModule) {
        return NeuromModule(_deploy(_thresholdSpec(bits, widths, rowMajor, art, task)));
    }

    /// Both weight widths, for the tests that run at each.
    function _widths() internal pure returns (uint256[2] memory) { return [uint256(8), 16]; }

    // ------------------------------------------------------------------------------------------------ fixtures

    function _obs(bool x0, bool x1) internal pure returns (bytes memory o) { o = new bytes(55); if (x0) o[0] = 0x01; if (x1) o[1] = 0x01; }

    /// LIF, hidden 1: I = 3·x0 − 2, W2[3][0] = 10, b2[3] = −1.
    function _lifWeights() internal pure returns (bytes memory w) {
        w = new bytes(2 * H1);
        _i16(w, 0, 3); _i16(w, 55, -2); _i16(w, 56 + 3, 10); _i16(w, 56 + 7 + 3, -1);
    }

    /// FF, hidden 2: h0 = (3·x0 − 2 >= 1), h1 = (−x1 + 1 >= 1), b2[0] = 1, W2[2][0] = W2[4][0] = 5, W2[6][1] = 7.
    function _ffWeights() internal pure returns (bytes memory w) {
        w = new bytes(2 * H2);
        _i16(w, 0, 3); _i16(w, 55 + 1, -1); _i16(w, 110, -2); _i16(w, 111, 1);
        uint256 w2 = 112;
        _i16(w, w2 + 2 * 2, 5); _i16(w, w2 + 4 * 2, 5); _i16(w, w2 + 6 * 2 + 1, 7); _i16(w, w2 + 14, 1);
    }

    function _lif(uint256 bits) internal returns (NeuromModule) { return _dense(bits, 1, IN, OUT, _one(1), 1, 2, 4, 0, _lifWeights(), ART, TASK); }

    function _ff(uint256 bits) internal returns (NeuromModule) { return _dense(bits, 0, IN, OUT, _one(2), 1, 0, 1, 0, _ffWeights(), ART, TASK); }

    // 12 → 8 → 4 model of the integer-executor tests: int16 k of the row-major blob = ((29k + 13) mod 25) − 12.
    // Observation t has bit i set iff (7t + 3i) mod 5 < 2. The node script that produced the expectations uses the
    // same generator.
    uint16 constant WI = 12; uint16 constant WH = 8; uint16 constant WO = 4;

    function _wideObs(uint256 t) internal pure returns (bytes memory o) {
        o = new bytes(WI);
        for (uint256 i; i < WI; i++) if ((7 * t + 3 * i) % 5 < 2) o[i] = 0x01;
    }

    /// XOR as two threshold layers over 2 input bits: h = [a + b >= 1, a + b >= 2], out = h0 − h1 >= 1.
    function _xor(uint256 bits) internal returns (NeuromModule) {
        uint16[] memory widths = new uint16[](3); widths[0] = 2; widths[1] = 2; widths[2] = 1;
        bytes memory w = new bytes(2 * (2 * 2 + 2 + 1 * 2 + 1));
        _i16(w, 0, 1); _i16(w, 1, 1); _i16(w, 2, 1); _i16(w, 3, 1);   // W1 rows (1,1),(1,1)
        _i16(w, 4, 1); _i16(w, 5, 2);                                 // th1 = 1, 2
        _i16(w, 6, 1); _i16(w, 7, -1);                                // W2 = (1, −1)
        _i16(w, 8, 1);                                                // th2 = 1
        return _threshold(bits, widths, w, keccak256("xor"), TASK_ADD);
    }

    /// 7 → 1 detector: fires iff bit 2 is set (W = e_2, th = 1).
    function _detector(uint256 bits) internal returns (NeuromModule) {
        uint16[] memory widths = new uint16[](2); widths[0] = 7; widths[1] = 1;
        bytes memory w = new bytes(2 * (7 + 1));
        _i16(w, 2, 1); _i16(w, 7, 1);
        return _threshold(bits, widths, w, keccak256("detector"), keccak256("detector-task"));
    }

    // ------------------------------------------------------------------------------------------------ layer lists

    function _one(uint16 hidden) internal pure returns (Layer[] memory l) {
        l = new Layer[](1);
        l[0].hidden = hidden;
    }

    function _plain(uint16 hidden) internal pure returns (Layer memory L) { L.hidden = hidden; }

    function _toolLayer(address a, address b, uint16 data, uint16 result) internal pure returns (Layer memory L) {
        L.tools = new address[](2); L.tools[0] = a; L.tools[1] = b; L.data = data; L.result = result;
    }

    /// `n` int16 of the generator ((29k + 13) mod 25) − 12 — the row-major blob of every generated dense model below.
    function _gen(uint256 n) internal pure returns (bytes memory w) {
        w = new bytes(2 * n);
        for (uint256 k; k < n; k++) _i16(w, k, int256((29 * k + 13) % 25) - 12);
    }

    /// Tool B: threshold layers 3 → 96 → 2, blob int16 k = ((17k + 5) mod 7) − 3 (wide on purpose: its gas shows).
    function _toolB(uint256 bits) internal returns (NeuromModule) {
        uint16[] memory widths = new uint16[](3); widths[0] = 3; widths[1] = 96; widths[2] = 2;
        uint256 n = 3 * 96 + 96 + 96 * 2 + 2;
        bytes memory w = new bytes(2 * n);
        for (uint256 k; k < n; k++) _i16(w, k, int256((17 * k + 5) % 7) - 3);
        return _threshold(bits, widths, w, keccak256("tool-b"), keccak256("tool-b-task"));
    }

    /// Observation t of the tool-layer models: bit i set iff (5t + 2i + t·i) mod 7 < 3.
    function _toolObs(uint256 t) internal pure returns (bytes memory o) {
        o = new bytes(12);
        for (uint256 i; i < 12; i++) if ((5 * t + 2 * i + t * i) % 7 < 3) o[i] = 0x01;
    }

    /// 12 → 8 → tools [XOR, B] (D 3, R 2) → 5 → 4: blob 8·13 + (2 + 3)·9 + 5·11 + 4·6 = 228 int16.
    function _toolSelector(uint256 bits, uint8 kind, uint8 ticks_, uint8 leak, uint32 th, int16 rst, address a, address b) internal returns (NeuromModule) {
        Layer[] memory l = new Layer[](3);
        l[0] = _plain(8); l[1] = _toolLayer(a, b, 3, 2); l[2] = _plain(5);
        return _dense(bits, kind, 12, 4, l, ticks_, leak, th, rst, _gen(228), keccak256("selector"), TASK);
    }

    /// The combiner's form: 12 → tools [XOR, B] (D 3, R 2), the tool layer last. Blob (2 + 3)·13 = 65 int16.
    function _trailingSelector(uint256 bits, address a, address b) internal returns (NeuromModule) {
        Layer[] memory l = new Layer[](1);
        l[0] = _toolLayer(a, b, 3, 2);
        return _dense(bits, 0, 12, 2, l, 1, 0, 1, 0, _gen(65), keccak256("trailing"), TASK);
    }

    function _expectRevert(address target, bytes memory call, string memory want) internal {
        (bool ok, bytes memory ret) = target.call(call);
        require(!ok, string.concat("should revert: ", want));
        require(ret.length >= 4 + 64 && keccak256(abi.encodeWithSignature("Error(string)", want)) == keccak256(ret), string.concat("reason: ", want));
    }

    /// deploy refuses `spec` with `want`, and checkDeploy says so beforehand, creating nothing.
    function _refused(ModuleFactory.ModuleSpec memory spec, bytes[] memory data, string memory want) internal {
        _expectRevert(address(factory), abi.encodeCall(factory.checkDeploy, (spec, data)), want);
        _expectRevert(address(factory), abi.encodeCall(factory.deploy, (spec, data)), want);
    }

    function _same(int32[] memory a, int32[] memory b) internal pure returns (bool) {
        if (a.length != b.length) return false;
        for (uint256 i; i < a.length; i++) if (a[i] != b[i]) return false;
        return true;
    }

    // ------------------------------------------------------------------------------------------------ dense numerics

    /// Hand model: a negative current accumulates down to its floor step by step, and forward/peek are read-only.
    function testLifHandModelAndReadOnlyViews() public { _lifHandModel(8); _lifHandModel(16); }

    function _lifHandModel(uint256 bits) internal {
        NeuromModule m = _lif(bits);
        int32[5] memory want = [int32(-2), -3, -4, -5, -5];
        for (uint256 k; k < 5; k++) {
            (int256[] memory s, uint8 a,, int32[] memory v) = m.step(S0, _obs(false, false));
            require(v[0] == want[k] && s[3] == -1 && a == 0, "negative leak path");
        }
        (,,, int32[] memory fwd) = m.forward(_obs(true, false));
        (,,, int32[] memory pk) = m.peek(S0, _obs(true, false));
        require(fwd[0] == 1 && pk[0] == -2, "forward from rest, peek from stored");
        require(m.stateOf(address(this), S0)[0] == -5, "views persist nothing");
    }

    /// FF hand model: hidden bits and the output layer's sums.
    function testFeedforwardHandModel() public { _ffHandModel(8); _ffHandModel(16); }

    function _ffHandModel(uint256 bits) internal {
        NeuromModule m = _ff(bits);
        (int256[] memory s, uint8 a, uint8[] memory c, int32[] memory v) = m.forward(_obs(true, false));
        require(c.length == 2 && c[0] == 1 && c[1] == 1 && v.length == 0, "both hidden fire");
        require(s[0] == 1 && s[2] == 5 && s[4] == 5 && s[6] == 7 && a == 6, "output sums");
        (s, a, c,) = m.forward(_obs(false, true));
        require(c[0] == 0 && c[1] == 0 && s[0] == 1 && a == 0, "silent hidden layer: biases only");
    }

    /// 12 → 8 → 4 FF: scores / action / counts equal frontend/runtime/dense-policy.js integerStep on the same model.
    /// That executor generated the expectations offline. The t = 1 row is a three-way tie, resolved to the first maximum.
    function testWideFeedforwardMatchesIntegerExecutor() public { _wideFeedforward(8); _wideFeedforward(16); }

    function _wideFeedforward(uint256 bits) internal {
        NeuromModule m = _dense(bits, 0, WI, WO, _one(WH), 1, 0, 1, 0, _gen(WH * (WI + 1) + WO * (WH + 1)), ART, TASK);
        require(m.inputs() == WI && m.outputs() == WO && m.stateWidth() == 0 && m.shape()[0] == WH - 1, "wide FF descriptor");
        int256[4][6] memory scores = [[int256(-1), -8, 10, 3], [int256(7), -18, 7, 7], [int256(2), -9, 5, 19], [int256(-3), 11, 0, 14], [int256(-2), -20, 12, 19], [int256(-1), -8, 10, 3]];
        uint8[6] memory actions = [2, 0, 3, 3, 3, 2];
        uint8[8][6] memory counts = [[1, 0, 0, 0, 0, 1, 0, 0], [1, 0, 0, 0, 1, 1, 0, 0], [1, 0, 0, 1, 1, 1, 1, 0], [0, 0, 1, 1, 0, 1, 1, 1], [1, 0, 0, 0, 1, 1, 1, 0], [1, 0, 0, 0, 0, 1, 0, 0]];
        for (uint256 t; t < 6; t++) {
            (int256[] memory s, uint8 a, uint8[] memory c, int32[] memory v) = m.step(S0, _wideObs(t));
            require(s.length == WO && a == actions[t] && c.length == WH && v.length == 0, "wide FF shape / action");
            for (uint256 k; k < WO; k++) require(s[k] == scores[t][k], "wide FF score");
            for (uint256 j; j < WH; j++) require(c[j] == counts[t][j], "wide FF count");
        }
    }

    /// 12 → 8 → 4 LIF (ticks 3, leak 2, threshold 6, reset −2): six persisted steps equal integerStep's scores,
    /// action, counts and voltages.
    function testWideLifMatchesIntegerExecutor() public { _wideLif(8); _wideLif(16); }

    function _wideLif(uint256 bits) internal {
        NeuromModule m = _dense(bits, 1, WI, WO, _one(WH), 3, 2, 6, -2, _gen(WH * (WI + 1) + WO * (WH + 1)), ART, TASK);
        require(m.stateWidth() == WH, "wide LIF state width");
        int256[4][6] memory scores = [[int256(-15), -18, 29, 1], [int256(-23), -4, 15, 9], [int256(29), -32, 7, 21], [int256(-6), -20, 16, 77], [int256(20), -55, 20, 45], [int256(-27), -12, 28, -7]];
        uint8[6] memory actions = [2, 2, 0, 3, 3, 2];
        uint8[8][6] memory counts = [[3, 0, 0, 0, 0, 2, 0, 0], [1, 0, 0, 0, 0, 0, 0, 0], [3, 0, 0, 2, 3, 3, 0, 0], [0, 0, 1, 0, 0, 3, 3, 0], [2, 0, 0, 0, 3, 3, 1, 0], [3, 0, 0, 0, 0, 1, 0, 0]];
        int32[8][6] memory volts = [
            [int32(-2), -46, -1, -16, -29, -2, 0, -13], [int32(5), -18, -13, -34, 5, 2, -11, -30], [int32(-2), -11, -18, -2, -2, -2, 3, -72],
            [int32(-14), -32, -2, 2, -11, -2, -2, -25], [int32(-2), -52, -53, -7, -2, -2, -2, -16], [int32(-2), -68, -24, -19, -30, 5, 0, -20]
        ];
        for (uint256 t; t < 6; t++) {
            (int256[] memory s, uint8 a, uint8[] memory c, int32[] memory v) = m.step(S0, _wideObs(t));
            require(s.length == WO && a == actions[t] && c.length == WH && v.length == WH, "wide LIF shape / action");
            for (uint256 k; k < WO; k++) require(s[k] == scores[t][k], "wide LIF score");
            for (uint256 j; j < WH; j++) require(c[j] == counts[t][j] && v[j] == volts[t][j], "wide LIF count / voltage");
            require(_same(m.stateOf(address(this), S0), v), "wide LIF persisted voltages");
        }
        _expectRevert(address(m), abi.encodeCall(m.forward, (new bytes(55))), "obs");
        bytes memory two = _wideObs(0); two[3] = 0x02;
        _expectRevert(address(m), abi.encodeCall(m.forward, (two)), "bit");
    }

    /// Weights over one chunk: 240 → 256 → 16 FF (123,392 + 8,224 bytes) spans two chunks. It decides as the same model
    /// does, read across the chunk boundary (the output layer's region starts in the second chunk). The model:
    /// W1[j][i] = 1 iff i == j (inputs 0..239 copy into hidden 0..239), b1 = 0. Output a reads hidden 16a + 15
    /// (input 16a + 15) with weight 5 and bias −a.
    function testWeightsAcrossChunks() public { _acrossChunks(8); _acrossChunks(16); }

    /// int16: 123,392 + 8,224 bytes, two chunks. int8: 61,952 + 8,224 bytes, one chunk (the 256 rows take the int8
    /// memory path).
    function _acrossChunks(uint256 bits) internal {
        uint256 I = 240; uint256 H = 256; uint256 O = 16;
        bytes memory old = new bytes(2 * (H * (I + 1) + O * (H + 1)));
        for (uint256 j; j < I; j++) _i16(old, j * I + j, 1);
        uint256 out = H * (I + 1);
        for (uint256 a; a < O; a++) { _i16(old, out + a * H + 16 * a + 15, 5); _i16(old, out + O * H + a, -int256(a)); }
        NeuromModule m = _dense(bits, 0, uint16(I), uint16(O), _one(uint16(H)), 1, 0, 1, 0, old, ART, TASK);
        address[] memory c = m.chunks();
        if (bits == 16) require(c.length == 2 && c[0].code.length == 1 + factory.MAX_CHUNK_BYTES() && c[1].code.length == 1 + (123_392 + 8_224 - 114_688), "two chunks");
        else require(c.length == 1 && c[0].code.length == 1 + 61_952 + 8_224, "one int8 chunk");
        bytes memory x = new bytes(I);
        x[16 * 9 + 15] = 0x01; x[16 * 3 + 15] = 0x01; x[100] = 0x01;
        (int256[] memory s, uint8 act, uint8[] memory counts,) = m.forward(x);
        require(s[9] == 5 - 9 && s[3] == 5 - 3 && s[0] == 0 && s[15] == -15 && act == 3, "decision across the boundary");
        require(counts[100] == 1 && counts[159] == 1 && counts[63] == 1 && counts[240] == 0 && counts[101] == 0, "hidden copies the inputs");
    }

    // ------------------------------------------------------------------------------------------------ layer lists
    // Expectations of this section come from frontend/runtime/dense-policy.js integerStep on the same generated models
    // (tools run as frontend/runtime/threshold-layers.js layersStep, result bit = score >= 0).

    /// 12 → 8 → 5 → 4 FF: two plain layers, counts = both layers' activations.
    function testMultiLayerFeedforwardMatchesIntegerExecutor() public { _multiLayerFeedforward(8); _multiLayerFeedforward(16); }

    function _multiLayerFeedforward(uint256 bits) internal {
        Layer[] memory l = new Layer[](2);
        l[0] = _plain(8); l[1] = _plain(5);
        NeuromModule m = _dense(bits, 0, WI, WO, l, 1, 0, 1, 0, _gen(173), ART, TASK);
        require(m.stateWidth() == 0 && m.shape()[0] == (7 | (4 << 32)), "multi-layer FF shape");
        int256[4][6] memory scores = [[int256(4), -2, 17, -14], [int256(4), -2, 17, -14], [int256(13), 2, 16, -20], [int256(5), -6, 8, -3], [int256(13), 2, 16, -20], [int256(4), -2, 17, -14]];
        uint8[13][6] memory counts = [[uint8(1), 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0], [uint8(1), 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0], [uint8(1), 0, 0, 1, 1, 1, 1, 0, 1, 0, 1, 1, 0], [uint8(0), 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0], [uint8(1), 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 0], [uint8(1), 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0]];
        for (uint256 t; t < 6; t++) {
            (int256[] memory s, uint8 a, uint8[] memory c, int32[] memory v) = m.step(S0, _wideObs(t));
            require(s.length == WO && a == 2 && c.length == 13 && v.length == 0, "multi-layer FF shape / action");
            for (uint256 k; k < WO; k++) require(s[k] == scores[t][k], "multi-layer FF score");
            for (uint256 j; j < 13; j++) require(c[j] == counts[t][j], "multi-layer FF count");
        }
    }

    /// 12 → 8 → 5 → 4 LIF (ticks 3, leak 2, threshold 6, reset −2): layer 2 reads layer 1's spikes of the same tick.
    /// The voltages of both layers persist (13 of them).
    function testMultiLayerLifMatchesIntegerExecutor() public { _multiLayerLif(8); _multiLayerLif(16); }

    function _multiLayerLif(uint256 bits) internal {
        Layer[] memory l = new Layer[](2);
        l[0] = _plain(8); l[1] = _plain(5);
        NeuromModule m = _dense(bits, 1, WI, WO, l, 3, 2, 6, -2, _gen(173), ART, TASK);
        require(m.stateWidth() == 13, "multi-layer LIF state width");
        int256[4][6] memory scores = [[int256(18), 10, 27, -56], [int256(23), 10, -3, -41], [int256(12), -6, 51, -42], [int256(13), 10, 32, -46], [int256(15), 2, 39, -49], [int256(21), 18, 15, -63]];
        uint8[6] memory actions = [2, 0, 2, 2, 2, 0];
        uint8[13][6] memory counts = [[uint8(3), 0, 0, 0, 0, 2, 0, 0, 1, 0, 3, 0, 0], [uint8(1), 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 0, 0], [uint8(3), 0, 0, 2, 3, 3, 0, 0, 3, 0, 3, 0, 0], [uint8(0), 0, 1, 0, 0, 3, 3, 0, 1, 0, 2, 0, 0], [uint8(2), 0, 0, 0, 3, 3, 1, 0, 2, 0, 3, 0, 0], [uint8(3), 0, 0, 0, 0, 1, 0, 0, 0, 0, 3, 0, 0]];
        int32[13][6] memory volts = [
            [int32(-2), -46, -1, -16, -29, -2, 0, -13, 1, 3, -2, -40, -43],
            [int32(5), -18, -13, -34, 5, 2, -11, -30, 0, -2, -2, -50, -37],
            [int32(-2), -11, -18, -2, -2, -2, 3, -72, -2, -6, -2, -46, -28],
            [int32(-14), -32, -2, 2, -11, -2, -2, -25, 4, 1, 4, -1, -62],
            [int32(-2), -52, -53, -7, -2, -2, -2, -16, 4, -25, -2, -6, -54],
            [int32(-2), -68, -24, -19, -30, 5, 0, -20, -3, -2, -2, -49, -57]
        ];
        for (uint256 t; t < 6; t++) {
            (int256[] memory s, uint8 a, uint8[] memory c, int32[] memory v) = m.step(S0, _wideObs(t));
            require(s.length == WO && a == actions[t] && c.length == 13 && v.length == 13, "multi-layer LIF shape / action");
            for (uint256 k; k < WO; k++) require(s[k] == scores[t][k], "multi-layer LIF score");
            for (uint256 j; j < 13; j++) require(c[j] == counts[t][j] && v[j] == volts[t][j], "multi-layer LIF count / voltage");
            require(_same(m.stateOf(address(this), S0), v), "multi-layer LIF persisted voltages");
        }
    }

    /// FF 12 → 8 → tools [XOR, B] → 5 → 4: the tool layer's head reads layer 1, the chosen tool gets the data bits, and
    /// layer 3 reads result ‖ layer 1 (choices over t: 0 1 1 0 0 0 1 0).
    function testToolLayerFeedforwardCallsTheChosenTool() public { _toolLayerFeedforward(8); _toolLayerFeedforward(16); }

    function _toolLayerFeedforward(uint256 bits) internal {
        NeuromModule a = _xor(bits);
        NeuromModule b = _toolB(bits);
        NeuromModule m = _toolSelector(bits, 0, 1, 0, 1, 0, address(a), address(b));
        address[] memory t_ = m.tools();
        require(t_.length == 2 && t_[0] == address(a) && t_[1] == address(b), "tools read back in wire order");
        int256[4][8] memory scores = [[int256(-7), -13, 6, 25], [int256(-3), -14, 0, 14], [int256(1), -5, -11, 8], [int256(1), -10, 4, 18], [int256(-15), -1, 13, 27], [int256(-7), -13, 6, 25], [int256(-7), 7, -4, 10], [int256(-7), -13, 6, 25]];
        uint8[13][8] memory counts = [[uint8(1), 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0], [uint8(1), 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0], [uint8(0), 0, 1, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0], [uint8(0), 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1], [uint8(0), 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0], [uint8(1), 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0], [uint8(1), 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0], [uint8(1), 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0]];
        for (uint256 t; t < 8; t++) {
            (int256[] memory s, uint8 act, uint8[] memory c, int32[] memory v) = m.step(S0, _toolObs(t));
            require(s.length == 4 && act == 3 && c.length == 13 && v.length == 0, "FF tool shape / action");
            for (uint256 k; k < 4; k++) require(s[k] == scores[t][k], "FF tool score");
            for (uint256 j; j < 13; j++) require(c[j] == counts[t][j], "FF tool count");
        }
    }

    /// LIF 12 → 8 → tools [XOR, B] → 5 → 4: two segments. The head reads segment 1's spike counts (biases × ticks).
    /// Segment 2 reads result ‖ fired-at-least-once. The voltages of both plain layers persist (choices: 0 1 0 0 0 1 1 1).
    function testToolLayerLifSegmentsMatchIntegerExecutor() public { _toolLayerLif(8); _toolLayerLif(16); }

    function _toolLayerLif(uint256 bits) internal {
        NeuromModule m = _toolSelector(bits, 1, 3, 2, 6, -2, address(_xor(bits)), address(_toolB(bits)));
        require(m.stateWidth() == 13, "tool layers hold no state");
        int256[4][8] memory scores = [[int256(-21), -39, 18, 75], [int256(-9), -27, 30, 12], [int256(-9), -37, 10, 32], [int256(-21), -39, 18, 75], [int256(-9), -12, -15, 57], [int256(-25), 12, -1, 61], [int256(-25), 22, -6, 41], [int256(-13), -1, -14, 48]];
        uint8[8] memory actions = [3, 2, 3, 3, 3, 3, 3, 3];
        uint8[13][8] memory counts = [[uint8(3), 0, 0, 0, 3, 0, 0, 0, 0, 3, 3, 0, 0], [uint8(0), 0, 1, 1, 1, 0, 0, 0, 0, 3, 0, 3, 0], [uint8(0), 0, 3, 1, 0, 3, 2, 0, 0, 3, 2, 3, 0], [uint8(0), 0, 0, 3, 3, 3, 3, 0, 0, 3, 3, 0, 0], [uint8(0), 0, 0, 0, 0, 3, 3, 2, 0, 0, 3, 0, 0], [uint8(1), 0, 0, 0, 0, 1, 3, 0, 2, 0, 3, 0, 0], [uint8(3), 0, 0, 0, 0, 0, 0, 1, 3, 0, 3, 2, 0], [uint8(3), 0, 0, 0, 0, 0, 0, 0, 1, 0, 3, 1, 0]];
        int32[13][8] memory volts = [
            [int32(-2), -41, -59, -20, -2, 0, -18, -37, -11, -2, -2, -18, -20],
            [int32(5), -25, -2, -2, -2, -6, -27, -49, -66, -2, -9, -2, -21],
            [int32(-2), -28, -2, 4, -2, -2, -2, -64, -78, -2, -2, -2, -21],
            [int32(-44), -74, -23, -2, -2, -2, -2, -27, -65, -2, -2, -5, -3],
            [int32(-34), -114, -101, -44, 5, -2, -2, -2, -12, -11, -2, -5, -31],
            [int32(-2), -73, -58, -25, 5, 4, -2, -27, -2, -71, -2, -4, -40],
            [int32(-2), -72, -74, -70, -66, -18, -30, -2, -2, -64, -2, -2, -58],
            [int32(-2), -72, -90, -49, -8, -6, -30, -37, -2, -56, -2, 4, -49]
        ];
        for (uint256 t; t < 8; t++) {
            (int256[] memory s, uint8 a, uint8[] memory c, int32[] memory v) = m.step(S0, _toolObs(t));
            require(s.length == 4 && a == actions[t] && c.length == 13 && v.length == 13, "LIF tool shape / action");
            for (uint256 k; k < 4; k++) require(s[k] == scores[t][k], "LIF tool score");
            for (uint256 j; j < 13; j++) require(c[j] == counts[t][j] && v[j] == volts[t][j], "LIF tool count / voltage");
            require(_same(m.stateOf(address(this), S0), v), "LIF tool persisted voltages");
        }
    }

    /// The combiner's form (the tool layer last, scores = ±1 of the result). Only the chosen tool runs. A decision costs
    /// the selector's own head (plus the call and decoding the tool's result) and the chosen tool's forward. So choosing
    /// XOR never pays for the wide tool B (choices over t: 0 1 1 1 0 1 0 0). `forge test -vvvv` shows the one call.
    function testTrailingToolLayerRunsOnlyTheChosenTool() public { _trailingToolLayer(8); _trailingToolLayer(16); }

    function _trailingToolLayer(uint256 bits) internal {
        NeuromModule a = _xor(bits);
        NeuromModule b = _toolB(bits);
        NeuromModule m = _trailingSelector(bits, address(a), address(b));
        require(m.stateWidth() == 0 && m.outputs() == 2, "trailing tool layer: outputs = R");
        int256[2][8] memory scores = [[int256(-1), -1], [int256(-1), -1], [int256(-1), -1], [int256(-1), 1], [int256(-1), -1], [int256(1), -1], [int256(-1), -1], [int256(-1), -1]];
        uint8[8] memory actions = [0, 0, 0, 1, 0, 0, 0, 0];
        for (uint256 t; t < 8; t++) {
            (int256[] memory s, uint8 act, uint8[] memory c,) = m.forward(_toolObs(t));
            require(s.length == 2 && s[0] == scores[t][0] && s[1] == scores[t][1] && act == actions[t] && c.length == 0, "trailing tool scores");
        }
        // every account warm (one transaction): t = 0 chooses XOR on data 1 1 1, t = 1 chooses B on data 1 1 0
        bytes memory dA = new bytes(2); dA[0] = 0x01; dA[1] = 0x01;
        bytes memory dB = new bytes(3); dB[0] = 0x01; dB[1] = 0x01;
        Meter meter = new Meter();
        uint256 toolA = meter.warm(address(a), abi.encodeCall(a.forward, (dA)));
        uint256 toolB = meter.warm(address(b), abi.encodeCall(b.forward, (dB)));
        uint256 selA = meter.warm(address(m), abi.encodeCall(m.forward, (_toolObs(0))));
        uint256 selB = meter.warm(address(m), abi.encodeCall(m.forward, (_toolObs(1))));
        Console.log("tool XOR forward", toolA); Console.log("tool B forward", toolB);
        Console.log("selector choosing XOR", selA); Console.log("selector choosing B", selB);
        uint256 own = 60_000;                                                  // the selector's head, call and result decoding
        require(toolB > toolA + own / 2, "B is the expensive tool");
        require(selA < toolA + own && selA < toolB, "choosing XOR never pays for B");
        require(selB > toolB && selB < toolB + own, "choosing B pays for B once");
    }

    /// A tool must be a module of this Factory that fits the layer. A last tool layer's R is the output.
    function testToolLayerValidation() public {
        NeuromModule a = _xor(8);
        NeuromModule b = _toolB(8);
        NeuromModule lif = _dense(8, 1, 3, 2, _one(1), 1, 2, 4, 0, _gen(3 + 1 + 2 * 2), ART, TASK);   // LIF 3 → 1 → 2
        Layer[] memory l = new Layer[](1);
        l[0] = _toolLayer(address(a), address(b), 3, 2);
        ModuleFactory.ModuleSpec memory spec = _denseSpec(8, 0, 12, 2, l, 1, 0, 1, 0, _gen(65), ART, TASK);
        spec.tools[1] = address(foreign);                                        // not a module of this Factory
        _refused(spec, _data(spec), "tool");
        spec.tools[1] = address(lif);                                            // a LIF tool fits like any other
        factory.checkDeploy(spec, _data(spec));                                  // (reverts when refused)
        spec.tools[1] = address(b);
        spec.shape = _denseShape(_one1(_toolLayer(address(a), address(b), 2, 2)), 8, 1, 0, 1, 0);   // B reads 3 bits > D = 2
        _refused(spec, _data(spec), "tool");
        spec.shape = _denseShape(_one1(_toolLayer(address(a), address(b), 3, 1)), 8, 1, 0, 1, 0);   // B returns 2 bits > R = 1
        spec.outputs = 1;
        _refused(spec, _data(spec), "tool");
        spec.shape = _denseShape(l, 8, 1, 0, 1, 0);
        spec.outputs = 3;
        _refused(spec, _data(spec), "outputs");
        spec.outputs = 2;
        address[] memory three = new address[](3); three[0] = address(a); three[1] = address(b); three[2] = address(a);
        spec.tools = three;                                                      // more tools than the layer list takes
        _refused(spec, _data(spec), "tool");
        spec.tools = _toolList(l);
        require(NeuromModule(_deploy(spec)).tools().length == 2, "the valid spec deploys");
    }

    function _one1(Layer memory L) internal pure returns (Layer[] memory l) { l = new Layer[](1); l[0] = L; }

    // ------------------------------------------------------------------------------------------------ network tools
    // Hand models, small enough to follow step by step. A LIF tool counts the steps that choose it. An FF tool echoes
    // its data bit. Selectors pick the first tool unless only x1 is set.

    function _bits2(bool x0, bool x1) internal pure returns (bytes memory o) { o = new bytes(2); if (x0) o[0] = 0x01; if (x1) o[1] = 0x01; }

    /// LIF 1 → 1 → 1 (ticks 1, leak 10, threshold 3, reset 0): V += the data bit and fires at 3 (V >> 10 = 0 here).
    /// score = 2·count − 1, so its result is 1 exactly on the step it fires.
    function _lifTool() internal returns (NeuromModule) {
        bytes memory w = new bytes(2 * 4);
        _i16(w, 0, 1); _i16(w, 2, 2); _i16(w, 3, -1);
        return _dense(8, 1, 1, 1, _one(1), 1, 10, 3, 0, w, keccak256("lif tool"), TASK);
    }

    /// FF 1 → 1 → 1: h = (x >= 1), score = h − 1, so its result is its data bit.
    function _ffTool() internal returns (NeuromModule) {
        bytes memory w = new bytes(2 * 4);
        _i16(w, 0, 1); _i16(w, 2, 1); _i16(w, 3, -1);
        return _dense(8, 0, 1, 1, _one(1), 1, 0, 1, 0, w, keccak256("ff tool"), TASK);
    }

    /// FF 2 → tools [a, b] (D `D`, R 1), the tool layer last. Choice logits (x0, x1) choose a unless only x1 is set.
    /// Every data bit is 1. scores = ±1 of the chosen tool's result. Blob (2 + D)·3 int16.
    function _pairSelector(address a, address b, uint16 D) internal returns (NeuromModule) {
        return NeuromModule(_deploy(_pairSpec(a, b, D)));
    }

    function _pairSpec(address a, address b, uint16 D) internal returns (ModuleFactory.ModuleSpec memory) {
        bytes memory w = new bytes(2 * 3 * (2 + D));
        _i16(w, 0, 1); _i16(w, 3, 1);                                           // choice W = identity, biases 0
        for (uint256 d; d < D; d++) _i16(w, 6 + 2 * D + d, 1);                  // data W = 0, biases 1
        return _denseSpec(8, 0, 2, 1, _one1(_toolLayer(a, b, D, 1)), 1, 0, 1, 0, w, keccak256(abi.encode("pair", a, b, D)), TASK);
    }

    /// The state the tool `t` would hand back from `v` on data bit 1 (its own call surface, outside any selector).
    function _toolNext(NeuromModule t, int32 v) internal view returns (int32) {
        uint256[] memory s = new uint256[](1);
        s[0] = uint256(uint32(v)) << 224;
        bytes memory one = new bytes(1); one[0] = 0x01;
        (,,, int32[] memory next) = t.forwardFrom(s, one);
        return next[0];
    }

    /// FF selector with tools [LIF, FF]: the LIF tool's potential is the selector's state (the selector has none of its
    /// own). The potential changes only on the steps that choose the tool. It persists across steps, resets with the
    /// session, stays apart per session and per actor, and never touches the tool module's own storage. Choices
    /// L L F L L (data bit 1): V_L = 1 2 2 0 1 (fires on the third choice), scores −1 −1 +1 (F echoes 1) +1 (L fired) −1.
    /// Each next potential is also what the tool alone computes from the previous one (forwardFrom) and what it stores
    /// when stepped itself.
    function testLifToolStateLivesInTheCallersSession() public {
        NeuromModule L = _lifTool();
        NeuromModule F = _ffTool();
        NeuromModule m = _pairSelector(address(L), address(F), 1);
        require(m.stateWidth() == 1 && L.stateWidth() == 1 && F.stateWidth() == 0, "selector state = its tools' states");
        require(factory.depthOf(address(m)) == 1 && factory.depthOf(address(L)) == 0, "depth");
        Actor shadow = new Actor();                                             // steps L itself on the choosing steps
        bytes memory one = new bytes(1); one[0] = 0x01;
        bool[2][5] memory obs = [[true, false], [true, false], [false, true], [true, true], [false, false]];
        int32[5] memory volt = [int32(1), 2, 2, 0, 1];
        int256[5] memory score = [int256(-1), -1, 1, 1, -1];
        for (uint256 t; t < 5; t++) {
            int32 before = m.stateOf(address(this), S0)[0];
            (int256[] memory s, uint8 a, uint8[] memory c, int32[] memory v) = m.step(S0, _bits2(obs[t][0], obs[t][1]));
            require(s.length == 1 && s[0] == score[t] && a == 0 && c.length == 0, "selector scores");
            require(v.length == 1 && v[0] == volt[t] && _same(m.stateOf(address(this), S0), v), "tool potential in the selector's state");
            if (obs[t][0] || !obs[t][1]) {
                require(_toolNext(L, before) == v[0], "the tool's own numerics from its slice");
                require(shadow.step(L, S0, one)[0] == v[0], "the tool stepped by itself agrees");
            } else {
                require(v[0] == before, "an unchosen tool's state is untouched");
            }
        }
        require(L.stateOf(address(this), S0)[0] == 0 && L.stateOf(address(m), S0)[0] == 0, "the tool module's storage is not used");
        (,,, int32[] memory rest) = m.forward(_bits2(true, false));
        require(rest.length == 1 && rest[0] == 1, "forward starts the tool from rest");
        // another session, another actor: their own tool state
        m.step(S1, _bits2(true, false));
        Actor other = new Actor();
        require(other.step(m, S0, _bits2(true, false))[0] == 1 && other.step(m, S0, _bits2(true, false))[0] == 2, "another actor's own state");
        require(m.stateOf(address(this), S0)[0] == 1 && m.stateOf(address(this), S1)[0] == 1, "sessions apart");
        // the session's reset clears the tool state, nothing else
        m.reset(S0);
        require(m.stateOf(address(this), S0)[0] == 0 && m.stateOf(address(this), S1)[0] == 1 && m.stateOf(address(other), S0)[0] == 2, "reset clears the session's tool state");
        (,,, int32[] memory again) = m.step(S0, _bits2(true, false));
        require(again[0] == 1, "after reset the tool starts from rest");
    }

    /// LIF selector with tools [LIF, FF] first, then a plain layer that reads result ‖ input (W = (1, 0, 0), threshold 2)
    /// and the output score = its count. The state is the selector's own potential, then the tool's. Same choices as
    /// above: results 0 0 1 1 0, own V = 0 0 1 0 (fired) 0, V_L = 1 2 2 0 1.
    function testLifSelectorKeepsItsOwnStateBeforeTheTools() public {
        NeuromModule L = _lifTool();
        NeuromModule F = _ffTool();
        Layer[] memory l = new Layer[](2);
        l[0] = _toolLayer(address(L), address(F), 1, 1); l[1] = _plain(1);
        bytes memory w = new bytes(2 * 15);
        _i16(w, 0, 1); _i16(w, 3, 1); _i16(w, 8, 1);                            // the tool layer as in _pairSelector
        _i16(w, 9, 1); _i16(w, 13, 1);                                          // plain W = (1, 0, 0), b 0, output W = 1, b 0
        NeuromModule m = _dense(8, 1, 2, 1, l, 1, 10, 2, 0, w, keccak256("lif pair"), TASK);
        require(m.stateWidth() == 2, "own 1 + the tool's 1");
        bool[2][5] memory obs = [[true, false], [true, false], [false, true], [true, true], [false, false]];
        int32[2][5] memory volt = [[int32(0), 1], [int32(0), 2], [int32(1), 2], [int32(0), 0], [int32(0), 1]];
        int256[5] memory score = [int256(0), 0, 0, 1, 0];
        for (uint256 t; t < 5; t++) {
            (int256[] memory s,, uint8[] memory c, int32[] memory v) = m.step(S0, _bits2(obs[t][0], obs[t][1]));
            require(s.length == 1 && s[0] == score[t] && c.length == 1 && c[0] == uint8(uint256(score[t])), "LIF selector scores / counts");
            require(v.length == 2 && v[0] == volt[t][0] && v[1] == volt[t][1] && _same(m.stateOf(address(this), S0), v), "own state first, the tool's after");
        }
        m.reset(S0);
        int32[] memory z = m.stateOf(address(this), S0);
        require(z[0] == 0 && z[1] == 0, "reset clears both");
    }

    /// A network with its own tool layer as a tool: outer FF selector with tools [N, L] (D 2), N = selector [L, F].
    /// The outer state is N's state (its L's potential), then the state of the directly wired L. So one module is wired
    /// twice and has two slices. Choices N L N N L L (N always picks its L on data 1 1): V = (1, 0) (1, 1) (2, 1) (0, 1)
    /// (0, 2) (0, 0). Scores −1 −1 −1 +1 (N's L fired) −1 +1 (the direct L fired).
    function testNestedNetworkToolKeepsItsToolsState() public {
        NeuromModule L = _lifTool();
        NeuromModule F = _ffTool();
        NeuromModule N = _pairSelector(address(L), address(F), 1);
        NeuromModule m = _pairSelector(address(N), address(L), 2);
        require(m.stateWidth() == 2 && factory.depthOf(address(m)) == 2, "nested state and depth");
        bool[2][6] memory obs = [[true, false], [false, true], [true, false], [true, true], [false, true], [false, true]];
        int32[2][6] memory volt = [[int32(1), 0], [int32(1), 1], [int32(2), 1], [int32(0), 1], [int32(0), 2], [int32(0), 0]];
        int256[6] memory score = [int256(-1), -1, -1, 1, -1, 1];
        for (uint256 t; t < 6; t++) {
            (int256[] memory s,,, int32[] memory v) = m.step(S0, _bits2(obs[t][0], obs[t][1]));
            require(s[0] == score[t], "nested scores");
            require(v.length == 2 && v[0] == volt[t][0] && v[1] == volt[t][1] && _same(m.stateOf(address(this), S0), v), "nested state");
        }
        require(N.stateOf(address(this), S0)[0] == 0 && N.stateOf(address(m), S0)[0] == 0 && L.stateOf(address(m), S0)[0] == 0, "no tool storage used");
        m.reset(S0);
        require(m.stateOf(address(this), S0)[0] == 0 && m.stateOf(address(this), S0)[1] == 0, "reset clears the nested state");
    }

    /// Depth: T0 = the LIF tool, T_i = selector [T_{i−1}, F] (D 2). The Factory records depths 0..3 and refuses depth 4
    /// ("depth", checkDeploy too). A step of T3 reaches T0 through three selectors and keeps its potential.
    function testFactoryBoundsToolDepth() public {
        NeuromModule F = _ffTool();
        address t = address(_lifTool());
        for (uint256 i = 1; i <= 3; i++) {
            t = address(_pairSelector(t, address(F), 2));
            require(factory.depthOf(t) == i, "depth recorded");
        }
        require(factory.MAX_TOOL_DEPTH() == 3, "the limit");
        ModuleFactory.ModuleSpec memory four = _pairSpec(t, address(F), 2);
        _refused(four, _data(four), "depth");
        (,,, int32[] memory v) = NeuromModule(t).step(S0, _bits2(true, false));
        require(v.length == 1 && v[0] == 1 && NeuromModule(t).stateOf(address(this), S0)[0] == 1, "three levels down");
    }

    /// The whole state, the tools' included, is at most 256: LIF h → tools [LIF 1 → 100 → 1, F] holds h + 100.
    function testFactoryBoundsStateWithTheTools() public {
        NeuromModule F = _ffTool();
        NeuromModule big = _dense(8, 1, 1, 1, _one(100), 1, 0, 1, 0, _gen(100 * 2 + 101), keccak256("big"), TASK);
        require(big.stateWidth() == 100, "big tool");
        ModuleFactory.ModuleSpec memory s = _stateSpec(157, address(big), address(F));
        _refused(s, _data(s), "state");
        NeuromModule m = NeuromModule(_deploy(_stateSpec(156, address(big), address(F))));
        require(m.stateWidth() == 256, "256 fits");
        (,,, int32[] memory v) = m.step(S0, _bits2(true, false));
        require(v.length == 256 && _same(m.stateOf(address(this), S0), v), "a full state persists");
    }

    function _stateSpec(uint16 h, address a, address b) internal returns (ModuleFactory.ModuleSpec memory) {
        Layer[] memory l = new Layer[](2);
        l[0] = _plain(h); l[1] = _toolLayer(a, b, 1, 1);
        return _denseSpec(8, 1, 2, 1, l, 1, 0, 1, 0, _gen(6 * uint256(h) + 3), keccak256(abi.encode("state", h)), TASK);
    }

    /// Gas (Monad rules, `forge test --network monad -vv`), every account warm: a selector step that chooses the LIF tool
    /// vs the same step that chooses the FF tool, and a forward through 0..3 nesting levels (T_i as in
    /// testFactoryBoundsToolDepth).
    function testGasOfNetworkTools() public {
        NeuromModule L = _lifTool();
        NeuromModule F = _ffTool();
        NeuromModule m = _pairSelector(address(L), address(F), 1);
        Meter meter = new Meter();
        uint256 chooseL = meter.warm(address(m), abi.encodeCall(m.step, (S0, _bits2(true, false))));
        uint256 chooseF = meter.warm(address(m), abi.encodeCall(m.step, (S0, _bits2(false, true))));
        Console.log("selector step choosing the LIF tool", chooseL);
        Console.log("selector step choosing the FF tool", chooseF);
        require(chooseL > chooseF, "the LIF tool's slice costs");
        bytes memory one = new bytes(1); one[0] = 0x01;
        string[4] memory depth = [string("forward, depth 0 (the LIF tool)"), "forward, depth 1", "forward, depth 2", "forward, depth 3"];
        uint256 last = meter.warm(address(L), abi.encodeCall(L.forward, (one)));
        Console.log(depth[0], last);
        address t = address(L);
        for (uint256 i = 1; i <= 3; i++) {
            t = address(_pairSelector(t, address(F), 2));
            uint256 g = meter.warm(t, abi.encodeCall(INeuromModule.forward, (_bits2(true, false))));
            Console.log(depth[i], g);
            Console.log("  one more level", g - last);
            last = g;
        }
    }

    /// modulesOf indexes the Factory's modules by artifact, so a deployer can find a tool to reuse.
    function testFactoryIndexesModulesByArtifact() public {
        NeuromModule a = _xor(8);
        NeuromModule a2 = _xor(8);
        _toolB(8);
        address[] memory xs = factory.modulesOf(keccak256("xor"));
        require(xs.length == 2 && xs[0] == address(a) && xs[1] == address(a2), "both XOR instances, in order");
        require(factory.modulesOf(keccak256("tool-b")).length == 1 && factory.modulesOf(keccak256("none")).length == 0, "per artifact");
        require(a.chunks()[0] == a2.chunks()[0], "the second XOR reuses the first one's chunk");
    }

    // ------------------------------------------------------------------------------------------------ identity

    function testFactoryRecordsIdentity() public {
        NeuromModule lif = _lif(8);
        NeuromModule x = _xor(8);
        require(factory.count() == 2 && factory.isModule(address(lif)) && factory.isModule(address(x)), "registered");
        require(!factory.isModule(address(foreign)) && !factory.isModule(address(this)), "foreign addresses are not modules");
        ModuleDescriptor memory d = lif.descriptor();
        require(d.engineId == DENSE && d.artifactId == ART && d.taskId == TASK, "dense ids");
        require(d.kind == 1 && d.inputs == 55 && d.outputs == 7, "dense ports");
        require(d.factory == address(factory) && d.stateWidth == 1 && d.engine == address(dense), "descriptor");
        address[] memory c = lif.chunks();
        bytes memory blob = _denseBlob(_lifWeights(), IN, _one(1), OUT, 8);
        require(c.length == 1 && c[0] == factory.chunkAddress(keccak256(blob)), "chunk address = content hash");
        require(keccak256(c[0].code) == keccak256(bytes.concat(bytes1(0x00), blob)), "chunk code = STOP | blob");
        ModuleDescriptor memory dx = x.descriptor();
        require(dx.engineId == THRESHOLD && dx.kind == 0 && dx.inputs == 2 && dx.outputs == 1 && dx.factory == address(factory) && dx.engine == address(threshold), "threshold descriptor");
        require(x.shape().length == 2 && x.shape()[0] == (2 | (2 << 16) | (1 << 32)) && x.shape()[1] == 8, "threshold widths, weightBits");
    }

    /// Chunks: the address comes from the content alone. An existing chunk is skipped, not an error. Sizes are bounded.
    function testChunksAreContentAddressed() public {
        bytes memory data = hex"0102030405";
        address want = factory.chunkAddress(keccak256(data));
        require(want.code.length == 0, "nothing there yet");
        address got = factory.createChunk(data);
        require(got == want && keccak256(got.code) == keccak256(hex"000102030405"), "STOP | data at the content address");
        require(factory.createChunk(data) == want, "again: the same address");
        require(new Meter().warm(address(factory), abi.encodeCall(factory.createChunk, (data))) < 10_000, "an existing chunk is skipped");
        bytes memory full = new bytes(factory.MAX_CHUNK_BYTES() + 1);
        _expectRevert(address(factory), abi.encodeCall(factory.createChunk, (full)), "chunk");
        _expectRevert(address(factory), abi.encodeCall(factory.createChunk, (new bytes(0))), "chunk");
        (bool ok, bytes memory ret) = address(factory).staticcall(abi.encodeCall(factory.chunkData, ()));
        require(ok && ret.length == 1 && ret[0] == 0x00, "chunkData outside createChunk is just the STOP byte");
    }

    function testDeployValidation() public {
        ModuleFactory.ModuleSpec memory s = _denseSpec(8, 1, IN, OUT, _one(1), 1, 2, 4, 0, _lifWeights(), ART, TASK);
        s.kind = 2; _refused(s, _data(s), "kind"); s.kind = 1;
        s.inputs = 0; _refused(s, _data(s), "inputs");
        s.inputs = 257; _refused(s, _data(s), "inputs");
        s.inputs = 54; _refused(s, _data(s), "weights"); s.inputs = IN;
        s.outputs = 0; _refused(s, _data(s), "outputs");
        s.outputs = 257; _refused(s, _data(s), "outputs");
        s.outputs = 17; _refused(s, _data(s), "weights"); s.outputs = OUT;
        s.shape = _denseShape(_one(257), 8, 1, 2, 4, 0); _refused(s, _data(s), "hidden");
        s.shape = _denseShape(_one(2), 8, 1, 2, 4, 0); _refused(s, _data(s), "weights");
        s.shape = _denseShape(_one(1), 8, 0, 2, 4, 0); _refused(s, _data(s), "ticks");
        s.shape = _denseShape(_one(1), 8, 65, 2, 4, 0); _refused(s, _data(s), "ticks");
        s.shape = _denseShape(_one(1), 8, 1, 11, 4, 0); _refused(s, _data(s), "leak");
        s.shape = _denseShape(_one(1), 8, 1, 2, 0, 0); _refused(s, _data(s), "threshold");
        s.shape = _denseShape(new Layer[](0), 8, 1, 2, 4, 0); _refused(s, _data(s), "layers");
        Layer[] memory nine = new Layer[](9);
        for (uint256 k; k < 9; k++) nine[k] = _plain(1);
        s.shape = _denseShape(nine, 8, 1, 2, 4, 0); _refused(s, _data(s), "layers");
        s.shape = _denseShape(_one(1), 8, 1, 2, 4, 0); s.shape[0] |= 1 << 40;          // bits above the last layer
        _refused(s, _data(s), "shape");
        s.shape = new uint256[](2); _refused(s, _data(s), "shape");
        Layer[] memory wide = new Layer[](2); wide[0] = _plain(128); wide[1] = _plain(129);
        s.shape = _denseShape(wide, 8, 1, 2, 4, 0); _refused(s, _data(s), "state");
        s.shape = _denseShape(_one(1), 8, 1, 2, 4, 0);
        require(NeuromModule(_deploy(s)).stateWidth() == 1, "the valid spec deploys");

        uint16[] memory widths = new uint16[](3); widths[0] = 2; widths[1] = 2; widths[2] = 1;
        ModuleFactory.ModuleSpec memory t = _thresholdSpec(8, widths, new bytes(18), ART, TASK_ADD);
        t.kind = 1; _refused(t, _data(t), "kind"); t.kind = 0;
        t.outputs = 2; _refused(t, _data(t), "shape"); t.outputs = 1;
        uint16[] memory one = new uint16[](1); one[0] = 2;
        t.shape = _thresholdShape(one, 8); t.outputs = 2; _refused(t, _data(t), "layers"); t.outputs = 1;
        widths[1] = 0; t.shape = _thresholdShape(widths, 8); _refused(t, _data(t), "layers");
        widths[1] = 257; t.shape = _thresholdShape(widths, 8); _refused(t, _data(t), "width");
        widths[1] = 3; t.shape = _thresholdShape(widths, 8); _refused(t, _data(t), "weights");
        t.tools = new address[](1); t.tools[0] = address(_xor(8)); widths[1] = 2; t.shape = _thresholdShape(widths, 8);
        _refused(t, _data(t), "tool");
    }

    /// weightBits, the shifts and the per-layer thresholds (ADR 0015). check() refuses a width other than 8 / 16
    /// ("bits"), a shift above 20 or one where no region is ("shift"), an FF threshold other than 1, and a LIF threshold
    /// outside 1..2^31 − 1 or one on a tool layer / above the last layer ("threshold"). The weight bytes follow the width.
    function testDeployRefusesBadWidthsShiftsAndThresholds() public {
        ModuleFactory.ModuleSpec memory s = _denseSpec(8, 1, IN, OUT, _one(1), 1, 2, 4, 0, _lifWeights(), ART, TASK);
        bytes[] memory data = _data(s);
        s.shape = _denseShape(_one(1), 4, 1, 2, 4, 0); _refused(s, data, "bits");
        s.shape = _denseShape(_one(1), 0, 1, 2, 4, 0); _refused(s, data, "bits");
        ModuleFactory.ModuleSpec memory w20 = _denseSpec(8, 0, WI, WO, _one(20), 1, 0, 1, 0, _gen(20 * 13 + 4 * 21), ART, TASK);
        w20.shape = _denseShape(_one(20), 16, 1, 0, 1, 0);                  // 20 rows: one int8 word per column, two int16
        _refused(w20, _data(w20), "weights");                               // int8 chunks under weightBits 16
        s.shape = _denseShape(_one(1), 8, 1, 2, 4, 0); s.shape[1] |= 21 << 48; _refused(s, data, "shift");      // layer 0
        s.shape = _denseShape(_one(1), 8, 1, 2, 4, 0); s.shape[1] |= 1 << 53; _refused(s, data, "shift");       // a data shift on a plain layer
        s.shape = _denseShape(_one(1), 8, 1, 2, 4, 0); s.shape[1] |= 1 << 58; _refused(s, data, "shift");       // above the last layer
        s.shape = _denseShape(_one(1), 8, 1, 2, 4, 0); s.shape[1] |= 21 << 128; _refused(s, data, "shift");     // the output region
        s.shape = _denseShape(_one(1), 8, 1, 2, 4, 0); s.shape[1] |= 1 << 133; _refused(s, data, "shape");
        s.shape = _denseShape(_one(1), 8, 1, 2, 4, 0); s.shape[2] |= 1 << 32; _refused(s, data, "threshold");   // above the last layer
        s.shape = _denseShape(_one(1), 8, 1, 2, uint32(1 << 31), 0); _refused(s, data, "threshold");             // LIF > 2^31 − 1
        s.kind = 0;
        s.shape = _denseShape(_one(1), 8, 1, 2, 4, 0); _refused(s, data, "threshold");                         // FF: exactly 1
        s.shape = _denseShape(_one(1), 8, 1, 2, 1, 0); s.shape[1] |= (20 << 48) | (20 << 128);
        factory.checkDeploy(s, data);                                                                       // shifts up to 20
        s.kind = 1;
        s.shape = _denseShape(_one(1), 8, 1, 2, uint32((1 << 31) - 1), 0);
        require(NeuromModule(_deploy(s)).stateWidth() == 1, "LIF threshold 2^31 - 1 deploys");

        Layer[] memory l = new Layer[](1);
        l[0] = _toolLayer(address(_xor(8)), address(_toolB(8)), 3, 2);
        ModuleFactory.ModuleSpec memory tl = _denseSpec(8, 0, 12, 2, l, 1, 0, 1, 0, _gen(65), ART, TASK);
        data = _data(tl);
        tl.shape[2] = 1; _refused(tl, data, "threshold");                                                     // on a tool layer
        tl.shape[2] = 0; tl.shape[1] |= 1 << 128; _refused(tl, data, "shift");                                // no output region
        tl.shape[1] ^= 1 << 128; tl.shape[1] |= 21 << 53; _refused(tl, data, "shift");                        // data shift > 20
        tl.shape[1] ^= 21 << 53; tl.shape[1] |= (20 << 48) | (20 << 53);
        factory.checkDeploy(tl, data);

        uint16[] memory widths = new uint16[](3); widths[0] = 2; widths[1] = 2; widths[2] = 1;
        ModuleFactory.ModuleSpec memory t = _thresholdSpec(8, widths, new bytes(18), ART, TASK_ADD);
        data = _data(t);
        t.shape = _thresholdShape(widths, 12); _refused(t, data, "bits");
        uint16[] memory w40 = new uint16[](2); w40[0] = 3; w40[1] = 40;
        ModuleFactory.ModuleSpec memory t40 = _thresholdSpec(16, w40, new bytes(2 * 160), ART, TASK_ADD);
        t40.shape = _thresholdShape(w40, 8);                                  // int16 chunks under weightBits 8
        _refused(t40, _data(t40), "weights");
        t.shape = _thresholdShape(widths, 8); t.shape[1] |= 21 << 13; _refused(t, data, "shift");              // map 1
        t.shape = _thresholdShape(widths, 8); t.shape[1] |= 1 << 18; _refused(t, data, "shift");               // above the last map
        t.shape = new uint256[](1); t.shape[0] = _thresholdShape(widths, 8)[0]; _refused(t, data, "shape");
        t.shape = _thresholdShape(widths, 8); t.shape[1] |= (20 << 8) | (20 << 13);
        factory.checkDeploy(t, data);
    }

    /// The Factory refuses an engine id without a latest version and a chunk that neither exists nor comes along.
    function testFactoryRefusesUnregisteredEnginesAndMissingChunks() public {
        ModuleFactory.ModuleSpec memory s = _denseSpec(8, 1, IN, OUT, _one(1), 1, 2, 4, 0, _lifWeights(), ART, TASK);
        s.engineId = keccak256("other-engine");
        _refused(s, _data(s), "engine");
        s.engineId = DENSE;
        _refused(s, new bytes[](1), "chunk");       // not on chain, not sent
        bytes[] memory wrong = new bytes[](1); wrong[0] = hex"01";
        _refused(s, wrong, "chunk");               // content of another hash
        _refused(s, new bytes[](0), "chunk");      // data not aligned with chunks
        bytes32[] memory real1 = s.chunks;
        s.chunks = new bytes32[](2100);                                          // an identity too long for a module clone
        _refused(s, new bytes[](2100), "args");
        s.chunks = real1;
        bytes32 real = s.chunks[0];
        s.chunks = new bytes32[](0);
        _refused(s, new bytes[](0), "chunk");
        factory.createChunk(_content[real]);
        s.chunks = new bytes32[](2); s.chunks[0] = real; s.chunks[1] = real;   // existing chunks, but twice the weights
        _refused(s, new bytes[](2), "weights");
    }

    /// deploy creates the missing chunks and the module in one transaction, all or nothing. A module that the Factory
    /// refuses leaves no chunk behind. A chunk that exists already is skipped, whether its content comes along or not.
    function testDeployCreatesChunksAndModuleAtomically() public {
        Layer[] memory l = new Layer[](1);
        l[0] = _plain(256);
        ModuleFactory.ModuleSpec memory s = _denseSpec(16, 0, 240, 16, l, 1, 0, 1, 0, _gen(256 * 241 + 16 * 257), ART, TASK);
        require(s.chunks.length == 2, "two chunks");
        address first = factory.chunkAddress(s.chunks[0]);
        address second = factory.chunkAddress(s.chunks[1]);
        s.tools = new address[](1); s.tools[0] = address(foreign);
        _refused(s, _data(s), "tool");
        require(first.code.length == 0 && second.code.length == 0, "a refused module leaves no chunk");
        s.tools = new address[](0);
        factory.checkDeploy(s, _data(s));
        require(first.code.length == 0, "checking creates nothing");
        NeuromModule m = NeuromModule(_deploy(s));                              // both chunks missing: one call creates all
        require(first.code.length == 1 + _content[s.chunks[0]].length && second.code.length == 1 + _content[s.chunks[1]].length, "both chunks created");
        require(factory.isModule(address(m)) && m.chunks()[0] == first && m.chunks()[1] == second, "and the module reading them");
        s.artifactId = keccak256("resumed");
        bytes[] memory half = _data(s); half[0] = "";                          // chunk 0 sent before, chunk 1 sent again
        require(NeuromModule(factory.deploy(s, half)).chunks()[1] == second, "an existing chunk sent again is skipped");
        s.artifactId = keccak256("twin");
        NeuromModule twin = NeuromModule(factory.deploy(s, new bytes[](2)));   // both exist: nothing comes along
        require(twin.chunks()[1] == second && factory.count() == 3, "every module shares the chunks");
    }

    /// A chunk a module uses twice is sent once: its later slot is empty and counts with the earlier one's content.
    function testRepeatedChunkIsSentOnce() public {
        Layer[] memory l = new Layer[](1);
        l[0] = _plain(256);
        ModuleFactory.ModuleSpec memory s = _denseSpec(16, 0, 256, 256, l, 1, 0, 1, 0, new bytes(2 * (2 * 256 * 257)), ART, TASK);
        require(s.chunks.length == 3 && s.chunks[0] == s.chunks[1] && s.chunks[1] != s.chunks[2], "all zeros: chunks 1 and 2 alike");
        bytes[] memory data = _data(s);
        data[1] = "";
        _refused(s, new bytes[](3), "chunk");
        NeuromModule m = NeuromModule(factory.deploy(s, data));
        require(m.chunks()[0] == m.chunks()[1] && m.chunks()[0].code.length == 1 + factory.MAX_CHUNK_BYTES(), "one chunk, read twice");
        (int256[] memory scores,,,) = m.forward(new bytes(256));
        require(scores.length == 256 && scores[255] == 0, "decides on zeros");
    }

    // ------------------------------------------------------------------------------------------------ engine versions

    /// The engine computes by STATICCALL: a version that tries to write (itself, or the module through step) reverts
    /// the decision. The module's state stays as it was.
    function testEngineCannotWrite() public {
        address writing = address(new WritingEngine());
        address reentrant = address(new ReentrantEngine());
        factory.addVersion(DENSE, writing);
        factory.addVersion(DENSE, reentrant);
        ModuleFactory.ModuleSpec memory s = _denseSpec(8, 1, IN, OUT, _one(1), 1, 2, 4, 0, _lifWeights(), ART, TASK);
        s.version = writing;
        NeuromModule w = NeuromModule(_deploy(s));
        (bool ok,) = address(w).call(abi.encodeCall(w.step, (S0, _obs(false, false))));
        require(!ok, "an engine writing its storage fails");
        s.version = reentrant;
        NeuromModule r = NeuromModule(_deploy(s));
        _expectRevert(address(r), abi.encodeCall(r.step, (S0, _obs(false, false))), "reenter");
        require(w.stateOf(address(this), S0)[0] == 0 && r.stateOf(address(this), S0)[0] == 0, "the stored state is untouched");
    }

    /// A module runs the version it was deployed with for life. Adding a version does not move the latest. When the
    /// latest moves, an existing module still decides on its version, a new deployment takes the latest, and a deployer
    /// can still name the older version.
    function testModuleKeepsItsVersionAfterTheLatestMoves() public {
        ModuleFactory.ModuleSpec memory s = _denseSpec(8, 0, WI, WO, _one(WH), 1, 0, 1, 0, _gen(WH * (WI + 1) + WO * (WH + 1)), ART, TASK);
        NeuromModule m = NeuromModule(_deploy(s));
        (int256[] memory before,,,) = m.forward(_wideObs(2));
        require(before[3] == 19, "baseline");
        address shifted = address(new ShiftedEngine());
        vm.expectEmit();
        emit ModuleFactory.VersionAdded(DENSE, shifted);
        factory.addVersion(DENSE, shifted);
        require(factory.latestOf(DENSE) == dense, "adding a version does not make it the latest");
        vm.expectEmit();
        emit ModuleFactory.LatestSet(DENSE, shifted);
        factory.setLatest(DENSE, shifted);
        address[] memory vs = factory.versionsOf(DENSE);
        require(vs.length == 2 && vs[0] == dense && vs[1] == shifted && factory.latestOf(DENSE) == shifted, "both versions, the new one latest");
        (int256[] memory still,,,) = m.forward(_wideObs(2));
        for (uint256 k; k < WO; k++) require(still[k] == before[k], "the existing module keeps its version");
        require(m.descriptor().engine == dense, "and records it");
        NeuromModule fresh = NeuromModule(_deploy(s));
        (int256[] memory now_,,,) = fresh.forward(_wideObs(2));
        for (uint256 k; k < WO; k++) require(now_[k] == before[k] + 1000, "a new deployment computes with the latest");
        require(fresh.descriptor().engine == shifted && fresh.chunks()[0] == m.chunks()[0], "records it, reusing the chunk");
        s.version = dense;
        NeuromModule older = NeuromModule(_deploy(s));
        (int256[] memory old_,,,) = older.forward(_wideObs(2));
        for (uint256 k; k < WO; k++) require(old_[k] == before[k], "an older version can be named");
        require(older.descriptor().engine == dense, "and is recorded");
    }

    /// Versions are add-only and belong to one engine id. The latest is always an added version of its id. A deployment
    /// names a listed version or takes the latest. Only an ADMIN adds versions or sets the latest.
    function testVersionsAreAddOnly() public {
        _expectRevert(address(factory), abi.encodeCall(factory.addVersion, (DENSE, dense)), "added");
        _expectRevert(address(factory), abi.encodeCall(factory.addVersion, (THRESHOLD, dense)), "added");
        _expectRevert(address(factory), abi.encodeCall(factory.addVersion, (keccak256("new-engine"), address(0xbeef))), "engine");
        _expectRevert(address(factory), abi.encodeCall(factory.addVersion, (bytes32(0), address(new DensePolicyEngine()))), "engine");
        _expectRevert(address(factory), abi.encodeCall(factory.setLatest, (THRESHOLD, dense)), "version");
        _expectRevert(address(factory), abi.encodeCall(factory.setLatest, (DENSE, address(0xbeef))), "version");
        address second = address(new DensePolicyEngine());
        _expectRevert(address(foreign), abi.encodeCall(foreign.exec, (address(factory), abi.encodeCall(factory.addVersion, (DENSE, second)))), "admin");
        _expectRevert(address(foreign), abi.encodeCall(foreign.exec, (address(factory), abi.encodeCall(factory.setLatest, (DENSE, dense)))), "admin");
        ModuleFactory.ModuleSpec memory s = _denseSpec(8, 1, IN, OUT, _one(1), 1, 2, 4, 0, _lifWeights(), ART, TASK);
        s.version = threshold; _refused(s, _data(s), "version");              // a version of another id
        s.version = second; _refused(s, _data(s), "version");                 // not added
        s.engineId = keccak256("other-engine"); s.version = address(0);
        factory.addVersion(s.engineId, second);
        _refused(s, _data(s), "engine");                                      // a new id without a latest yet
        s.version = second;
        require(NeuromModule(_deploy(s)).descriptor().engine == second, "but its listed version deploys");
        address[] memory vs = factory.versionsOf(DENSE);
        require(vs.length == 1 && vs[0] == dense && factory.latestOf(DENSE) == dense && factory.engineIdOf(dense) == DENSE, "dense-policy unchanged");
    }

    // ------------------------------------------------------------------------------------------------ roles and upgrades

    /// The deployer holds ADMIN and UPGRADER. Only an ADMIN grants or revokes (both roles, nothing else). ADMIN manages
    /// versions and roles. UPGRADER only upgrades the factory. A handover: grant the new holder, revoke the old one.
    function testRolesGrantAndRevoke() public {
        bytes32 ADMIN = roles.ADMIN();
        bytes32 UPGRADER = roles.UPGRADER();
        require(roles.hasRole(ADMIN, address(this)) && roles.hasRole(UPGRADER, address(this)), "the deployer holds both");
        Actor next = new Actor();
        _expectRevert(address(next), abi.encodeCall(next.exec, (address(roles), abi.encodeCall(roles.grantRole, (ADMIN, address(next))))), "admin");
        _expectRevert(address(roles), abi.encodeCall(roles.grantRole, (keccak256("other"), address(next))), "role");
        _expectRevert(address(roles), abi.encodeCall(roles.grantRole, (ADMIN, address(0))), "account");
        vm.expectEmit();
        emit Roles.RoleGranted(ADMIN, address(next), address(this));
        roles.grantRole(ADMIN, address(next));
        next.exec(address(factory), abi.encodeCall(factory.addVersion, (keccak256("next"), address(new DensePolicyEngine()))));
        address impl = address(new ModuleFactory(address(roles)));
        _expectRevert(address(next), abi.encodeCall(next.exec, (address(factory), abi.encodeCall(FactoryProxy.upgradeToAndCall, (impl, "")))), "upgrader");
        vm.expectEmit();
        emit Roles.RoleRevoked(ADMIN, address(this), address(next));
        next.exec(address(roles), abi.encodeCall(roles.revokeRole, (ADMIN, address(this))));
        require(!roles.hasRole(ADMIN, address(this)) && roles.hasRole(ADMIN, address(next)), "handed over");
        _expectRevert(address(roles), abi.encodeCall(roles.grantRole, (ADMIN, address(this))), "admin");
        _expectRevert(address(factory), abi.encodeCall(factory.addVersion, (keccak256("mine"), address(new DensePolicyEngine()))), "admin");
        _expectRevert(address(factory), abi.encodeCall(factory.setLatest, (DENSE, dense)), "admin");
        FactoryProxy(address(factory)).upgradeToAndCall(impl, "");                       // still UPGRADER
        next.exec(address(roles), abi.encodeCall(roles.revokeRole, (UPGRADER, address(this))));
        _expectRevert(address(factory), abi.encodeCall(FactoryProxy.upgradeToAndCall, (impl, "")), "upgrader");
        next.exec(address(roles), abi.encodeCall(roles.grantRole, (UPGRADER, address(next))));                  // ADMIN may make itself UPGRADER
        next.exec(address(factory), abi.encodeCall(FactoryProxy.upgradeToAndCall, (impl, "")));
    }

    /// A factory upgrade keeps everything in the proxy's storage: count, isModule, depthOf, the chunks, the artifact
    /// index, the module implementation and the versions. Every module decides as before, and its session continues.
    /// Only an UPGRADER upgrades, only to a contract with the same Roles. initialize runs once.
    function testFactoryUpgradeKeepsItsState() public {
        NeuromModule lif = _lif(8);
        NeuromModule x = _xor(8);
        NeuromModule sel = _pairSelector(address(_lifTool()), address(_ffTool()), 1);
        (,,, int32[] memory v) = lif.step(S0, _obs(false, false));
        require(v[0] == -2, "first step");
        (int256[] memory selBefore,,,) = sel.forward(_bits2(true, false));
        (uint256 n, address impl, address chunk) = (factory.count(), factory.implementation(), lif.chunks()[0]);
        FactoryProxy proxy = FactoryProxy(address(factory));
        address next = address(new ModuleFactory(address(roles)));
        _expectRevert(address(foreign), abi.encodeCall(foreign.exec, (address(proxy), abi.encodeCall(proxy.upgradeToAndCall, (next, "")))), "upgrader");
        _expectRevert(address(proxy), abi.encodeCall(proxy.upgradeToAndCall, (address(0xbeef), "")), "implementation");
        _expectRevert(address(proxy), abi.encodeCall(proxy.upgradeToAndCall, (address(new ModuleFactory(address(new Roles()))), "")), "roles");
        _expectRevert(address(proxy), abi.encodeCall(proxy.upgradeToAndCall, (next, abi.encodeCall(ModuleFactory.initialize, ()))), "init");
        vm.expectEmit();
        emit FactoryProxy.Upgraded(next);
        proxy.upgradeToAndCall(next, "");
        require(address(uint160(uint256(vm.load(address(proxy), 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)))) == next, "EIP-1967 slot");
        require(factory.count() == n && factory.isModule(address(lif)) && factory.isModule(address(x)) && factory.isModule(address(sel)), "count, isModule");
        require(factory.depthOf(address(sel)) == 1 && factory.implementation() == impl && factory.latestOf(DENSE) == dense, "depthOf, implementation, versions");
        require(factory.modulesOf(ART).length == 1 && factory.modulesOf(ART)[0] == address(lif) && factory.chunkAddress(_denseSpec(8, 1, IN, OUT, _one(1), 1, 2, 4, 0, _lifWeights(), ART, TASK).chunks[0]) == chunk, "artifact index, chunks");
        (,,, v) = lif.step(S0, _obs(false, false));
        require(v[0] == -3, "the session continues");
        (int256[] memory selAfter,,,) = sel.forward(_bits2(true, false));
        require(keccak256(abi.encode(selAfter)) == keccak256(abi.encode(selBefore)), "the selector decides the same");
        NeuromModule again = _lif(8);
        require(again.descriptor().factory == address(factory) && again.chunks()[0] == chunk && factory.count() == n + 1, "deploying continues, on the same chunks");
        _expectRevert(address(factory), abi.encodeCall(factory.initialize, ()), "init");
        _expectRevert(next, abi.encodeCall(ModuleFactory.initialize, ()), "init");
    }

    // ------------------------------------------------------------------------------------------------ owner

    /// owner() is the deployer. It moves only by nominate + accept. The owner has no other power over the module.
    function testOwnerIsTheDeployerAndTransfersInTwoSteps() public {
        Actor deployer = new Actor();
        Actor next = new Actor();
        ModuleFactory.ModuleSpec memory spec = _denseSpec(8, 1, IN, OUT, _one(1), 1, 2, 4, 0, _lifWeights(), ART, TASK);
        NeuromModule m = NeuromModule(deployer.deploy(factory, spec, _data(spec)));
        require(m.owner() == address(deployer) && m.nominee() == address(0), "the deployer owns it");
        _expectRevert(address(m), abi.encodeCall(m.nominateOwner, (address(this))), "owner");
        _expectRevert(address(next), abi.encodeCall(next.accept, (m)), "nominee");
        deployer.nominate(m, address(this));                                          // a mistaken nominee …
        require(m.owner() == address(deployer), "nominating does not transfer");
        deployer.nominate(m, address(next));                                          // … is replaced before it accepts
        _expectRevert(address(m), abi.encodeCall(m.acceptOwnership, ()), "nominee");
        next.accept(m);
        require(m.owner() == address(next) && m.nominee() == address(0), "accepted");
        _expectRevert(address(deployer), abi.encodeCall(deployer.nominate, (m, address(deployer))), "owner");
        // the owner's calls write only its own (actor, session) state. Identity, chunks and tools stay.
        deployer.step(m, S0, _obs(false, false));
        next.step(m, S0, _obs(false, false)); next.step(m, S0, _obs(false, false));
        require(m.stateOf(address(deployer), S0)[0] == -2 && m.stateOf(address(next), S0)[0] == -3, "per actor");
        ModuleDescriptor memory d = m.descriptor();
        require(d.engine == address(dense) && d.factory == address(factory) && m.chunks().length == 1 && m.tools().length == 0, "identity unchanged");
        (bool ok,) = address(m).call(abi.encodeWithSignature("setEngine(address)", address(this)));
        require(!ok, "no other entry point");
    }

    /// A module is a clone of the Factory's implementation with its identity in its code. Only the Factory sets a
    /// module's first owner, once. A clone made elsewhere copies the descriptor but is not a module of the Factory.
    function testOnlyTheFactoryMakesModules() public {
        NeuromModule m = _lif(8);
        NeuromModule impl = NeuromModule(factory.implementation());
        require(address(m).code.length < 600, "a module is a small clone");
        _expectRevert(address(m), abi.encodeCall(m.initialize, (address(this))), "init");
        _expectRevert(address(impl), abi.encodeCall(impl.initialize, (address(this))), "init");
        bytes memory args = abi.encodePacked(uint256(uint160(address(dense))) | (uint256(1) << 160) | (uint256(IN) << 168) | (uint256(OUT) << 184)
            | (uint256(1) << 200) | (uint256(3) << 216) | (uint256(1) << 224), DENSE, ART, TASK, m.shape(), m.chunks());
        bytes memory init = ModuleClone.initCode(address(impl), abi.encodePacked(args, args.length));
        address forged;
        assembly { forged := create(0, add(init, 0x20), mload(init)) }
        (,,, int32[] memory v) = NeuromModule(forged).forward(_obs(true, false));
        require(v[0] == 1 && NeuromModule(forged).descriptor().factory == address(factory), "the copy computes and claims the Factory");
        require(!factory.isModule(forged) && factory.isModule(address(m)), "but only the Factory's own are modules");
    }

    // ------------------------------------------------------------------------------------------------ isolation

    /// Two instances of the same artifact own separate histories. Two sessions of one instance do too.
    function testInstanceAndSessionIsolation() public {
        NeuromModule a = _lif(8);
        NeuromModule b = _lif(8);
        a.step(S0, _obs(false, false)); a.step(S0, _obs(false, false));
        a.step(S1, _obs(false, false));
        require(a.stateOf(address(this), S0)[0] == -3, "session 0");
        require(a.stateOf(address(this), S1)[0] == -2, "session 1 is a separate history");
        require(b.stateOf(address(this), S0)[0] == 0, "second instance untouched");
        a.reset(S1);
        require(a.stateOf(address(this), S1)[0] == 0 && a.stateOf(address(this), S0)[0] == -3, "reset is per session");
    }

    /// Another caller cannot read into, write over or reset this caller's histories.
    function testActorIsolation() public {
        NeuromModule m = _lif(8);
        Actor other = new Actor();
        m.step(S0, _obs(false, false)); m.step(S0, _obs(false, false));
        int32[] memory v = other.step(m, S0, _obs(false, false));
        require(v[0] == -2, "other caller starts from its own history, not ours");
        require(m.stateOf(address(this), S0)[0] == -3, "our history intact");
        require(m.stateOf(address(other), S0)[0] == -2, "other caller's history");
        other.reset(m, S0);
        require(m.stateOf(address(other), S0)[0] == 0 && m.stateOf(address(this), S0)[0] == -3, "reset is per actor");
    }

    // ------------------------------------------------------------------------------------------------ threshold numerics

    /// XOR and the 7 → 1 detector: scores = Σ W·h − th, counts = the hidden activations.
    function testThresholdLayersScoresAndCounts() public { _thresholdScores(8); _thresholdScores(16); }

    function _thresholdScores(uint256 bits) internal {
        NeuromModule det = _detector(bits);
        bytes memory o = new bytes(7);
        (int256[] memory s,,,) = det.forward(o);
        require(s.length == 1 && s[0] == -1, "detector silent: 0 - th 1");
        o[2] = 0x01;
        (s,,,) = det.forward(o);
        require(s[0] == 0, "detector: sum 1 - th 1 = 0 -> fired");
        NeuromModule x = _xor(bits);
        bytes memory in_ = new bytes(2);
        for (uint256 a; a < 2; a++) for (uint256 b; b < 2; b++) {
            in_[0] = bytes1(uint8(a)); in_[1] = bytes1(uint8(b));
            (int256[] memory sx,, uint8[] memory counts,) = x.forward(in_);
            require(sx[0] == int256(a | b) - int256(a & b) - 1, "score = sum - threshold");
            require((sx[0] >= 0 ? 1 : 0) == (a ^ b), "xor output bit");
            require(counts.length == 2 && counts[0] == uint8(a | b) && counts[1] == uint8(a & b), "hidden activations");
        }
    }

    /// The extremes of int8 (−128, 127, −1) at both widths: 4 → 3 threshold map, rows (−128, 127, −1, 0),
    /// (−128, −128, −128, −128), (127, 127, 127, 127), th = (−200, 0, 1). scores = Σ W·x − th, by hand.
    function testInt8ExtremesAndNegativeWeights() public {
        for (uint256 i; i < 2; i++) {
            uint256 bits = _widths()[i];
            uint16[] memory widths = new uint16[](2); widths[0] = 4; widths[1] = 3;
            bytes memory w = new bytes(2 * (4 * 3 + 3));
            int16[12] memory W = [int16(-128), 127, -1, 0, -128, -128, -128, -128, 127, 127, 127, 127];
            for (uint256 k; k < 12; k++) _i16(w, k, W[k]);
            _i16(w, 12, -200); _i16(w, 13, 0); _i16(w, 14, 1);
            NeuromModule m = _threshold(bits, widths, w, keccak256("extremes"), TASK);
            bytes memory x = new bytes(4);
            x[0] = 0x01; x[1] = 0x01; x[2] = 0x01; x[3] = 0x01;
            (int256[] memory s, uint8 a,,) = m.forward(x);
            require(s[0] == 198 && s[1] == -512 && s[2] == 507 && a == 2, "all ones");
            x[1] = 0x00; x[3] = 0x00;
            (s, a,,) = m.forward(x);
            require(s[0] == 71 && s[1] == -256 && s[2] == 253 && a == 2, "x = 1 0 1 0");
            x[0] = 0x00; x[1] = 0x01; x[2] = 0x00;
            (s, a,,) = m.forward(x);
            require(s[0] == 327 && s[1] == -128 && s[2] == 126 && a == 0, "x = 0 1 0 0");
        }
    }

    /// 3 → 40 threshold map (int8: two column words, the memory path. int16: three words) over the whole int8 range:
    /// W[j][i] = ((37j + 11i + 5) mod 256) − 128, th[j] = (7919j mod 60001) − 30000. The test compares against
    /// Σ W·x · 2^k − th computed here, for every input and k = 0 and 3 at both widths.
    function testWideRowsOverTheInt8Range() public {
        for (uint256 i; i < 2; i++) for (uint256 k; k <= 3; k += 3) {
            uint256 bits = _widths()[i];
            uint16[] memory widths = new uint16[](2); widths[0] = 3; widths[1] = 40;
            bytes memory w = new bytes(2 * (40 * 3 + 40));
            for (uint256 j; j < 40; j++) {
                for (uint256 c; c < 3; c++) _i16(w, 3 * j + c, int256((37 * j + 11 * c + 5) % 256) - 128);
                _i16(w, 120 + j, int256((7919 * j) % 60001) - 30000);
            }
            ModuleFactory.ModuleSpec memory spec = _thresholdSpec(bits, widths, w, keccak256("wide-rows"), TASK);
            spec.shape[1] |= k << 8;
            NeuromModule m = NeuromModule(_deploy(spec));
            for (uint256 t; t < 8; t++) {
                bytes memory x = new bytes(3);
                for (uint256 c; c < 3; c++) if ((t >> c) & 1 == 1) x[c] = 0x01;
                (int256[] memory s,,,) = m.forward(x);
                require(s.length == 40, "40 scores");
                for (uint256 j; j < 40; j++) {
                    int256 sum;
                    for (uint256 c; c < 3; c++) if ((t >> c) & 1 == 1) sum += int256((37 * j + 11 * c + 5) % 256) - 128;
                    require(s[j] == sum * int256(1 << k) - (int256((7919 * j) % 60001) - 30000), "score = sum * 2^k - th");
                }
            }
        }
    }

    /// A region's shift k scales its sums, never its biases: 3 → 1 → 2 FF, W1 = (2, −3, 1), b1 = −5, k1 = 2 (fires
    /// where 4·Σ − 5 >= 1). Output W2 = (3, −128), b2 = (7, 100), k_out = 3: scores = 8·3·h + 7, 8·(−128)·h + 100.
    /// With k_out = 20: 3·2^20 + 7, −128·2^20 + 100. Hand-computed, both widths.
    function testShiftScalesTheSums() public {
        for (uint256 i; i < 2; i++) {
            uint256 bits = _widths()[i];
            bytes memory w = new bytes(2 * 8);
            _i16(w, 0, 2); _i16(w, 1, -3); _i16(w, 2, 1); _i16(w, 3, -5);
            _i16(w, 4, 3); _i16(w, 5, -128); _i16(w, 6, 7); _i16(w, 7, 100);
            ModuleFactory.ModuleSpec memory spec = _denseSpec(bits, 0, 3, 2, _one(1), 1, 0, 1, 0, w, keccak256("shift"), TASK);
            spec.shape[1] |= (2 << 48) | (3 << 128);
            NeuromModule m = NeuromModule(_deploy(spec));
            bytes memory x = new bytes(3);
            x[0] = 0x01;                                                        // Σ = 2: 8 − 5 = 3 fires (k = 0 would not)
            (int256[] memory s, uint8 a, uint8[] memory c,) = m.forward(x);
            require(c[0] == 1 && s[0] == 31 && s[1] == -924 && a == 0, "shifted: 2*4 - 5 fires; 3*8 + 7, -128*8 + 100");
            x[1] = 0x01;                                                        // Σ = −1: −9
            (s, a, c,) = m.forward(x);
            require(c[0] == 0 && s[0] == 7 && s[1] == 100 && a == 1, "silent: biases only, never shifted");
            x[1] = 0x00; x[2] = 0x01;                                           // Σ = 3: 7
            (s, a, c,) = m.forward(x);
            require(c[0] == 1 && s[0] == 31 && s[1] == -924, "sum 3");
            x[0] = 0x00;                                                        // Σ = 1: −1
            (s, a, c,) = m.forward(x);
            require(c[0] == 0 && s[0] == 7, "sum 1: 4 - 5 < 1");
            spec.shape[1] = (spec.shape[1] & ~uint256(31 << 128)) | (20 << 128);
            m = NeuromModule(_deploy(spec));
            x[0] = 0x01; x[2] = 0x00;
            (s,,,) = m.forward(x);
            require(s[0] == 3 * 2 ** 20 + 7 && s[1] == -128 * 2 ** 20 + 100, "k_out = 20");
        }
    }

    /// Two LIF plain layers, each with its own threshold (ticks 1, leak 10, reset 0): 2 → 1 → 1 → 1. Layer 1
    /// I = 5·x0, layer 2 I = 3·(layer 1's spike), output = layer 2's spike count. Thresholds (5, 7): layer 1 fires
    /// every step, layer 2 on the third (3, 6, 9 >= 7). Swapped (7, 5): layer 1 fires on every second step (5, 10),
    /// layer 2 on its second input spike (3, 6 >= 5). Hand-computed, both widths.
    function testLifLayersHaveTheirOwnThresholds() public {
        Layer[] memory l = new Layer[](2);
        l[0] = _plain(1); l[1] = _plain(1);
        bytes memory w = new bytes(2 * 7);
        _i16(w, 0, 5); _i16(w, 3, 3); _i16(w, 5, 1);
        bytes memory x = new bytes(2);
        x[0] = 0x01;
        for (uint256 i; i < 2; i++) {
            uint256 bits = _widths()[i];
            ModuleFactory.ModuleSpec memory spec = _denseSpec(bits, 1, 2, 1, l, 1, 10, 1, 0, w, keccak256("thresholds"), TASK);
            spec.shape[2] = 5 | (7 << 32);
            NeuromModule m = NeuromModule(_deploy(spec));
            int32[2][3] memory volts = [[int32(0), 3], [int32(0), 6], [int32(0), 0]];
            for (uint256 t; t < 3; t++) {
                (int256[] memory s,, uint8[] memory c, int32[] memory v) = m.step(S0, x);
                require(c[0] == 1 && c[1] == (t == 2 ? 1 : 0) && s[0] == (t == 2 ? int256(1) : int256(0)), "(5, 7): counts / score");
                require(v[0] == volts[t][0] && v[1] == volts[t][1], "(5, 7): voltages");
            }
            spec.shape[2] = 7 | (5 << 32);
            m = NeuromModule(_deploy(spec));
            int32[2][4] memory swapped = [[int32(5), 0], [int32(0), 3], [int32(5), 3], [int32(0), 0]];
            for (uint256 t; t < 4; t++) {
                (int256[] memory s,, uint8[] memory c, int32[] memory v) = m.step(S0, x);
                require(c[0] == t % 2 && c[1] == (t == 3 ? 1 : 0) && s[0] == (t == 3 ? int256(1) : int256(0)), "(7, 5): counts / score");
                require(v[0] == swapped[t][0] && v[1] == swapped[t][1], "(7, 5): voltages");
            }
        }
    }

    // ------------------------------------------------------------------------------------------------ gas (Monad rules)

    /// Mining-like input t: 185 bits, bit i set iff keccak256(t, i) mod 9 == 0 (about 21 of them).
    function _miningInput(uint256 t) internal pure returns (bytes memory o) {
        o = new bytes(185);
        for (uint256 i; i < 185; i++) if (uint256(keccak256(abi.encode(t, i))) % 9 == 0) o[i] = 0x01;
    }

    /// Weights in ±100 (int16 k = ((37k + 11) mod 201) − 100, within int8) for a 185 → hidden… → 7 FF at `bits`,
    /// deployed in one transaction (`oneTx`: its chunk and the module). `moduleOnly` = a second module on the same chunk.
    function _miningNet(uint16[] memory hidden, uint256 bits) internal returns (NeuromModule m, uint256 oneTx, uint256 moduleOnly) {
        Layer[] memory l = new Layer[](hidden.length);
        uint256 n;
        uint256 width = 185;
        for (uint256 k; k < hidden.length; k++) { l[k] = _plain(hidden[k]); n += uint256(hidden[k]) * (width + 1); width = hidden[k]; }
        n += 7 * (width + 1);
        bytes memory old = new bytes(2 * n);
        for (uint256 k; k < n; k++) _i16(old, k, int256((37 * k + 11) % 201) - 100);
        ModuleFactory.ModuleSpec memory spec = ModuleFactory.ModuleSpec(DENSE, address(0), 0, 185, 7, _denseShape(l, bits, 1, 0, 1, 0), new address[](0), _pieces(_denseBlob(old, 185, l, 7, bits)), keccak256(abi.encode(hidden, bits)), TASK);
        bytes[] memory data = _data(spec);
        uint256 g = gasleft();
        m = NeuromModule(factory.deploy(spec, data));
        oneTx = g - gasleft();
        spec.artifactId = keccak256(abi.encode(hidden, bits, "twin"));
        data = new bytes[](1);
        g = gasleft();
        factory.deploy(spec, data);
        moduleOnly = g - gasleft();
    }

    function _measure(string memory name, uint16[] memory hidden, uint256 bits) internal returns (uint256 game) {
        (NeuromModule m, uint256 oneTx, uint256 moduleOnly) = _miningNet(hidden, bits);
        address chunk = m.chunks()[0];
        Game g_ = new Game();
        bytes[] memory inputs = new bytes[](63);
        for (uint256 t; t < 63; t++) inputs[t] = _miningInput(t);
        vm.cool(address(m)); vm.cool(dense); vm.cool(chunk);
        uint256 g = gasleft();
        m.forward(inputs[0]);
        uint256 forwardGas = g - gasleft();
        vm.cool(address(m)); vm.cool(dense); vm.cool(chunk);
        g = gasleft();
        m.step(S0, inputs[1]);
        uint256 stepGas = g - gasleft();
        vm.cool(address(m)); vm.cool(dense); vm.cool(chunk);
        g = gasleft();
        g_.play(m, inputs);
        game = g - gasleft();
        Console.log(string.concat(name, ": deployment, chunk + module in one call"), oneTx);
        Console.log(string.concat(name, ": a second module on the same chunk"), moduleOnly);
        Console.log(string.concat(name, ": one forward (cold)"), forwardGas);
        Console.log(string.concat(name, ": one step (cold)"), stepGas);
        Console.log(string.concat(name, ": 63-step game, one call"), game);
    }

    /// Deployment and step gas of the mining networks at weightBits 8 and 16 on Monad rules (`forge test --network
    /// monad -vv` prints them). A 63-step game of the default 185 → 32 → 7 stays below 3.5M at both widths.
    function testGasOfMiningNetworks() public {
        uint16[] memory small = new uint16[](1); small[0] = 32;
        uint16[] memory strong = new uint16[](2); strong[0] = 64; strong[1] = 32;
        require(_measure("FF 185-32-7 int8", small, 8) < 3_500_000, "a 63-step game of 185 -> 32 -> 7 (int8) stays below 3.5M gas");
        require(_measure("FF 185-32-7 int16", small, 16) < 3_500_000, "a 63-step game of 185 -> 32 -> 7 (int16) stays below 3.5M gas");
        _measure("FF 185-64-32-7 int8", strong, 8);
        _measure("FF 185-64-32-7 int16", strong, 16);
    }
}
