// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "../src/modules/Roles.sol";
import "../src/modules/FactoryProxy.sol";
import "../src/modules/ModuleFactory.sol";
import "../src/modules/DensePolicyEngine.sol";
import "../src/modules/ThresholdLayersEngine.sol";
import "./Vm.sol";

/// forge script script/Deploy.s.sol --rpc-url monad_testnet --private-key $PK --broadcast
/// Deploys the protocol (ADR 0016, ADR 0017) from the broadcasting account, which holds ADMIN and UPGRADER. It deploys
/// Roles, the ModuleFactory implementation and its FactoryProxy (the official factory, initialised in the same
/// transaction). Then it deploys one version of each engine id (dense-policy: DensePolicyEngine, threshold-layers:
/// ThresholdLayersEngine), adds each version and sets it latest. Returns (and forge prints) every address. The order is
/// fixed: on a fresh node, the proxy is the broadcasting account's third contract (nonce 2).
contract Deploy {
    function run() external returns (Roles roles, ModuleFactory factoryImplementation, ModuleFactory factory, address densePolicy, address thresholdLayers) {
        vm.startBroadcast();
        roles = new Roles();
        factoryImplementation = new ModuleFactory(address(roles));
        factory = ModuleFactory(address(new FactoryProxy(address(factoryImplementation), abi.encodeCall(ModuleFactory.initialize, ()))));
        densePolicy = address(new DensePolicyEngine());
        thresholdLayers = address(new ThresholdLayersEngine());
        factory.addVersion(keccak256("dense-policy"), densePolicy);
        factory.setLatest(keccak256("dense-policy"), densePolicy);
        factory.addVersion(keccak256("threshold-layers"), thresholdLayers);
        factory.setLatest(keccak256("threshold-layers"), thresholdLayers);
        vm.stopBroadcast();
    }
}
