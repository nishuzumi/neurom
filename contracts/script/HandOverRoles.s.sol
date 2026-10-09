// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "../src/modules/Roles.sol";
import "../src/modules/ModuleFactory.sol";
import "./Vm.sol";

/// Hands both protocol roles (ADR 0016) of the official factory's Roles from the broadcasting account to MULTISIG, in
/// two runs with a check between them (contracts README, "Roles and handover"):
///
/// FACTORY=<ModuleFactory proxy> MULTISIG=<address> \
///   forge script script/HandOverRoles.s.sol --sig 'grant()' --rpc-url <url> --private-key $PK --broadcast
/// Grants MULTISIG ADMIN and UPGRADER. The broadcasting account must hold ADMIN.
///
/// FACTORY=… MULTISIG=… forge script script/HandOverRoles.s.sol --sig 'revoke()' …
/// Revokes the broadcasting account's UPGRADER, then its ADMIN. Unless MULTISIG, another account, holds both roles, the
/// script refuses before it sends anything. So no role is left without a holder.
contract HandOverRoles {
    function grant() external {
        (Roles roles, address multisig) = _env();
        vm.startBroadcast();
        roles.grantRole(roles.ADMIN(), multisig);
        roles.grantRole(roles.UPGRADER(), multisig);
        vm.stopBroadcast();
    }

    function revoke() external {
        (Roles roles, address multisig) = _env();
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        require(multisig != sender, "MULTISIG is the broadcasting account");
        require(roles.hasRole(roles.ADMIN(), multisig) && roles.hasRole(roles.UPGRADER(), multisig), "MULTISIG does not hold both roles");
        roles.revokeRole(roles.UPGRADER(), sender);
        roles.revokeRole(roles.ADMIN(), sender);
        vm.stopBroadcast();
    }

    function _env() private view returns (Roles, address) {
        return (Roles(ModuleFactory(vm.envAddress("FACTORY")).roles()), vm.envAddress("MULTISIG"));
    }
}
