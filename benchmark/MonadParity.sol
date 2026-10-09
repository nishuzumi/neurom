// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "src/modules/Roles.sol";
import "src/modules/FactoryProxy.sol";
import "src/modules/ModuleFactory.sol";
import "src/modules/DensePolicyEngine.sol";
import "src/modules/NeuromModule.sol";

/// Gas probe for benchmark/monad-parity.mjs. It runs only in its constructor, through eth_call (no transaction), and
/// returns its measurements as abi.encode(uint256[]). The same initcode runs on the Monad testnet RPC and on a local
/// anvil, so equal numbers mean equal gas rules for these operations. Each number is a gasleft() difference:
///   [0] EXTCODESIZE of an untouched account (cold)        [1] the same again (warm)
///   [2] SLOAD slot 0 of this contract (first in its page)  [3] SLOAD slot 1 (same 128-slot page)
///   [4] SLOAD slot 200 (another page)                      [5] SSTORE 0 → 1 at slot 300 (new page)
///   [6] SSTORE 0 → 1 at slot 301 (same page)               [7] memory expansion: MSTORE 1 MiB above the free pointer
///   [8] protocol deploy (Roles, factory proxy, DensePolicyEngine, version)
///   [9] createChunk of every weight chunk                  [10] deploy of the module
///   [11] forward of inputs[0]                               [12] step of inputs[0]
///   [13] all forwards of inputs, one after the other
contract MonadParity {
    constructor(uint8 kind, uint16 inputs, uint16 outputs, uint256[] memory shape, bytes[] memory chunks, bytes32 artifactId, bytes32 taskId, bytes[] memory observations) {
        uint256[] memory m = new uint256[](20);   // [14..18] keep the values read, so the optimizer keeps each read
        uint256 g;
        address cold = address(uint160(uint256(keccak256("neurom parity: an untouched account"))));
        assembly ("memory-safe") {
            g := gas() mstore(add(m, 0x1e0), extcodesize(cold)) mstore(add(m, 0x20), sub(g, gas()))
            g := gas() mstore(add(m, 0x200), extcodesize(cold)) mstore(add(m, 0x40), sub(g, gas()))
            g := gas() mstore(add(m, 0x220), sload(0)) mstore(add(m, 0x60), sub(g, gas()))
            g := gas() mstore(add(m, 0x240), sload(1)) mstore(add(m, 0x80), sub(g, gas()))
            g := gas() mstore(add(m, 0x260), sload(200)) mstore(add(m, 0xa0), sub(g, gas()))
            g := gas() sstore(300, 1) mstore(add(m, 0xc0), sub(g, gas()))
            g := gas() sstore(301, 1) mstore(add(m, 0xe0), sub(g, gas()))
            let far := add(mload(0x40), 0x100000)
            g := gas() mstore(far, 1) mstore(add(m, 0x100), sub(g, gas()))
        }

        g = gasleft();
        Roles roles = new Roles();
        ModuleFactory factory = ModuleFactory(address(new FactoryProxy(address(new ModuleFactory(address(roles))), abi.encodeCall(ModuleFactory.initialize, ()))));
        address engine = address(new DensePolicyEngine());
        bytes32 engineId = keccak256("dense-policy");
        factory.addVersion(engineId, engine);
        factory.setLatest(engineId, engine);
        m[8] = g - gasleft();

        bytes32[] memory ids = new bytes32[](chunks.length);
        g = gasleft();
        for (uint256 k; k < chunks.length; k++) { ids[k] = keccak256(chunks[k]); factory.createChunk(chunks[k]); }
        m[9] = g - gasleft();
        ModuleFactory.ModuleSpec memory spec = ModuleFactory.ModuleSpec(engineId, address(0), kind, inputs, outputs, shape, new address[](0), ids, artifactId, taskId);
        g = gasleft();
        NeuromModule module = NeuromModule(factory.deploy(spec, new bytes[](chunks.length)));
        m[10] = g - gasleft();

        g = gasleft();
        module.forward(observations[0]);
        m[11] = g - gasleft();
        g = gasleft();
        module.step(bytes32(0), observations[0]);
        m[12] = g - gasleft();
        g = gasleft();
        for (uint256 t; t < observations.length; t++) module.forward(observations[t]);
        m[13] = g - gasleft();

        bytes memory out = abi.encode(m);
        assembly ("memory-safe") { return(add(out, 0x20), mload(out)) }
    }
}
