// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "../src/ladder/TankLadder.sol";
import "./Vm.sol";

/// LADDER_FACTORY=0x… LADDER_END_BLOCK=… forge script script/DeployLadder.s.sol --rpc-url monad_testnet --private-key $PK --broadcast
/// Deploys the TankLadder (ADR 0026) from the broadcasting account. The configuration comes from the environment:
///   LADDER_FACTORY          the official ModuleFactory (its FactoryProxy), required
///   LADDER_END_BLOCK        the block from which the ladder accepts no new entry and no new challenge, required
///   LADDER_MAX_WEIGHT_BYTES the largest weight size of an entry, default 216864
///   LADDER_DELTA_BPS        δ in basis points, default 1000 (10%)
///   LADDER_RANGE            how many ranks above itself an entry can challenge, default 10
///   LADDER_TIMEOUT_BLOCKS   blocks from the start of a challenge until it expires, default 400
///   LADDER_COOLDOWN_BLOCKS  blocks before the same challenger can challenge the same defender again, default 6000
///   LADDER_MIN_START_GAS    the gas left at the entry of `challenge`, default 24000000
///   LADDER_RESERVE_GAS      the gas a play transaction keeps for the last step, the save and the settlement, default 2000000
/// Returns (and forge prints) the ladder's address.
contract DeployLadder {
    function run() external returns (TankLadder ladder) {
        TankLadder.Config memory c = TankLadder.Config(
            vm.envAddress("LADDER_FACTORY"),
            uint32(vm.envOr("LADDER_MAX_WEIGHT_BYTES", 216_864)),
            uint16(vm.envOr("LADDER_DELTA_BPS", 1000)),
            uint8(vm.envOr("LADDER_RANGE", 10)),
            uint32(vm.envOr("LADDER_TIMEOUT_BLOCKS", 400)),
            uint32(vm.envOr("LADDER_COOLDOWN_BLOCKS", 6000)),
            uint32(vm.envOr("LADDER_MIN_START_GAS", 24_000_000)),
            uint32(vm.envOr("LADDER_RESERVE_GAS", 2_000_000)),
            uint64(vm.envOr("LADDER_END_BLOCK", 0)));
        require(c.endBlock != 0, "LADDER_END_BLOCK");
        vm.startBroadcast();
        ladder = new TankLadder(c);
        vm.stopBroadcast();
    }
}
