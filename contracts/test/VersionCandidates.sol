// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../src/modules/DensePolicyEngine.sol";

/// Candidate versions of dense-policy the engine version check is tested with
/// (contracts/scripts/engine-version-check.test.mjs). Built with the contracts (not a .t.sol), so the Anvil fixture's
/// `forge build --skip test` puts them in out/.

/// Same numerics, other code: run() decodes the decision and encodes it again itself (the stand-in for an optimised
/// version the check must let through).
contract EquivalentDensePolicyEngine is DensePolicyEngine {
    function run(uint8 kind, uint16 inputs, uint16 outputs, uint256[] calldata shape, address[] calldata chunks, uint256[] calldata tools, uint256[] calldata state, bytes calldata input)
        external view override returns (int256[] memory scores, uint8 action, uint8[] memory counts, int32[] memory voltages)
    {
        (scores, action, counts, voltages) = _run(kind, inputs, outputs, shape, chunks, tools, state, input);
    }
}

/// One bit off: the lowest bit of the first next-state voltage flips when the last input bit is 1. Only modules with
/// state (LIF, or with a stateful tool) have a next state, so every other decision stays the same.
contract OneBitDensePolicyEngine is DensePolicyEngine {
    function run(uint8 kind, uint16 inputs, uint16 outputs, uint256[] calldata shape, address[] calldata chunks, uint256[] calldata tools, uint256[] calldata state, bytes calldata input)
        external view override returns (int256[] memory scores, uint8 action, uint8[] memory counts, int32[] memory voltages)
    {
        (scores, action, counts, voltages) = _run(kind, inputs, outputs, shape, chunks, tools, state, input);
        if (voltages.length != 0 && input[input.length - 1] == 0x01) voltages[0] ^= 1;
    }
}
