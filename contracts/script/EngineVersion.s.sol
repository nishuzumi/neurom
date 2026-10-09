// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "../src/modules/ModuleFactory.sol";
import "./Vm.sol";

/// Engine versions of the official factory (ADR 0017). The broadcasting account must hold ADMIN (ADR 0016).
///
/// ENGINE=<engine id> VERSION=<address> FACTORY=<ModuleFactory proxy> \
///   forge script script/EngineVersion.s.sol --sig 'add()' --rpc-url <url> --private-key $PK --broadcast
/// Adds VERSION to the versions of keccak256(ENGINE) and sets it latest. VERSION is an engine version that is already
/// deployed (for example with `forge create`) and checked with scripts/engine-version-check.mjs. A new engine id needs
/// no factory upgrade. The script refuses an address that already is a version before it sends anything. The Factory
/// would refuse it too: versions are never changed or removed.
///
/// ENGINE=… VERSION=… FACTORY=… forge script script/EngineVersion.s.sol --sig 'setLatest()' …
/// Makes VERSION, already a version of keccak256(ENGINE), the latest again (for example, back to the previous one).
/// When VERSION is not a version of keccak256(ENGINE), the script refuses it before it sends anything.
contract EngineVersion {
    function add() external {
        (bytes32 engineId, address version, ModuleFactory factory) = _env();
        require(factory.engineIdOf(version) == bytes32(0), "VERSION already is an added engine version");
        vm.startBroadcast();
        factory.addVersion(engineId, version);
        factory.setLatest(engineId, version);
        vm.stopBroadcast();
    }

    function setLatest() external {
        (bytes32 engineId, address version, ModuleFactory factory) = _env();
        require(factory.engineIdOf(version) == engineId, "VERSION is not a version of ENGINE");
        vm.startBroadcast();
        factory.setLatest(engineId, version);
        vm.stopBroadcast();
    }

    function _env() private view returns (bytes32, address, ModuleFactory) {
        return (keccak256(bytes(vm.envString("ENGINE"))), vm.envAddress("VERSION"), ModuleFactory(vm.envAddress("FACTORY")));
    }
}
