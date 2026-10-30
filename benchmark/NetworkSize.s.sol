// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "test/Modules.t.sol";   // resolved from the contracts/ project root (forge runs with cwd contracts/)

interface IVmBench {
    function startBroadcast() external;
    function stopBroadcast() external;
    function envUint(string calldata) external view returns (uint256);
    function envUint(string calldata, string calldata) external view returns (uint256[] memory);
}

/// One transaction that calls `forward` once per input. Not a view, so the script broadcasts it.
contract GameTx {
    uint256 public last;

    function play(INeuromModule m, bytes[] calldata inputs) external returns (uint256 sum) {
        for (uint256 i; i < inputs.length; i++) { (, uint16 a,,) = m.forward(inputs[i]); sum += a; }
        last = sum;
    }
}

/// Benchmark for benchmark/network-size.mjs. It broadcasts, in this order:
///   - the protocol (ModulesTest.setUp: Roles, the factory proxy, the engines);
///   - FF 185 → HIDDEN… → 7 at BITS with synthetic weights (±100), cut into chunks of at most CHUNK bytes, one
///     createChunk transaction each, then one deploy transaction;
///   - 8 step transactions with _miningInput(0..7);
///   - one transaction that plays 63 forwards (_miningInput(0..62)).
/// Env: HIDDEN (comma list, for example "256,256"), BITS (8 or 16), CHUNK (bytes per chunk).
contract NetworkSize is ModulesTest {
    IVmBench constant vb = IVmBench(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external {
        uint256 bits = vb.envUint("BITS");
        uint256 chunk = vb.envUint("CHUNK");
        uint256[] memory h = vb.envUint("HIDDEN", ",");
        uint16[] memory hidden = new uint16[](h.length);
        for (uint256 k; k < h.length; k++) hidden[k] = uint16(h[k]);

        vb.startBroadcast();
        setUp();
        Layer[] memory l = new Layer[](hidden.length);
        uint256 n;
        uint256 width = 185;
        for (uint256 k; k < hidden.length; k++) { l[k] = _plain(hidden[k]); n += uint256(hidden[k]) * (width + 1); width = hidden[k]; }
        n += 7 * (width + 1);
        bytes memory rowMajor = new bytes(2 * n);
        for (uint256 k; k < n; k++) _i16(rowMajor, k, int256((37 * k + 11) % 201) - 100);
        bytes memory blob = _denseBlob(rowMajor, 185, l, 7, bits);

        uint256 count = (blob.length + chunk - 1) / chunk;
        bytes32[] memory ids = new bytes32[](count);
        for (uint256 k; k < count; k++) {
            uint256 from = k * chunk;
            uint256 len = blob.length - from < chunk ? blob.length - from : chunk;
            bytes memory piece = new bytes(len);
            for (uint256 i; i < len; i++) piece[i] = blob[from + i];
            ids[k] = keccak256(piece);
            factory.createChunk(piece);
        }
        ModuleFactory.ModuleSpec memory spec = ModuleFactory.ModuleSpec(
            DENSE, address(0), 0, 185, 7, _denseShape(l, bits, 1, 0, 1, 0), new address[](0), ids,
            keccak256(abi.encode(hidden, bits, chunk)), TASK
        );
        NeuromModule m = NeuromModule(factory.deploy(spec, new bytes[](count)));

        for (uint256 t; t < 8; t++) m.step(S0, _miningInput(t));
        bytes[] memory inputs = new bytes[](63);
        for (uint256 t; t < 63; t++) inputs[t] = _miningInput(t);
        new GameTx().play(m, inputs);
        vb.stopBroadcast();
    }
}
