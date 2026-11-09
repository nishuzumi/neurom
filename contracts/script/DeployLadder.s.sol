// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "../src/ladder/TankLadder.sol";
import "./Vm.sol";

/// LADDER_FACTORY=0x… LADDER_END_BLOCK=… forge script script/DeployLadder.s.sol --rpc-url monad_testnet --private-key $PK --broadcast
/// Deploys the TankLadder (ADR 0026) from the broadcasting account. The defaults of the configuration come from
/// ladder-defaults.json (the spec). The environment gives the two values of the season and overrides any default:
///   LADDER_FACTORY          the official ModuleFactory (its FactoryProxy), required
///   LADDER_END_BLOCK        the block from which the ladder accepts no new entry and no new challenge, required
///   LADDER_MAX_WEIGHT_BYTES the largest weight size of an entry
///   LADDER_DELTA_BPS        δ in basis points
///   LADDER_RANGE            how many ranks above itself an entry can challenge
///   LADDER_BOARD_SIZE       how many ranks the board holds
///   LADDER_TIMEOUT_BLOCKS   blocks from the start of a challenge until it expires
///   LADDER_COOLDOWN_BLOCKS  blocks before the same challenger can challenge the same defender again
///   LADDER_MIN_START_GAS    the gas left at the entry of `challenge`
///   LADDER_RESERVE_GAS      the gas a play transaction keeps for the last step, the save and the settlement
/// Returns (and forge prints) the ladder's address.
contract DeployLadder {
    string constant DEFAULTS = "ladder-defaults.json";

    /// The value of `name` in the environment, else `key` of the defaults file `json`.
    function setting(string memory json, string memory name, string memory key) internal view returns (uint256) {
        return vm.envOr(name, vm.parseJsonUint(json, key));
    }

    function run() external returns (TankLadder ladder) {
        string memory json = vm.readFile(DEFAULTS);
        TankLadder.Config memory c = TankLadder.Config(
            vm.envAddress("LADDER_FACTORY"),
            uint32(setting(json, "LADDER_MAX_WEIGHT_BYTES", ".maxWeightBytes")),
            uint16(setting(json, "LADDER_DELTA_BPS", ".deltaBps")),
            uint8(setting(json, "LADDER_RANGE", ".range")),
            uint8(setting(json, "LADDER_BOARD_SIZE", ".boardSize")),
            uint32(setting(json, "LADDER_TIMEOUT_BLOCKS", ".timeoutBlocks")),
            uint32(setting(json, "LADDER_COOLDOWN_BLOCKS", ".cooldownBlocks")),
            uint32(setting(json, "LADDER_MIN_START_GAS", ".minStartGas")),
            uint32(setting(json, "LADDER_RESERVE_GAS", ".reserveGas")),
            uint64(vm.envOr("LADDER_END_BLOCK", 0)));
        require(c.endBlock != 0, "LADDER_END_BLOCK");
        vm.startBroadcast();
        ladder = new TankLadder(c);
        vm.stopBroadcast();
    }
}
