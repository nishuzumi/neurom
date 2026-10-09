// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./Roles.sol";

/// @notice What FactoryProxy asks of an implementation: the Roles it obeys.
interface IRolesBound {
    function roles() external view returns (address);
}

/// @title FactoryProxy — the official factory's address (ADR 0016): an EIP-1967 proxy. Only an UPGRADER of
///        the Roles fixed at its construction can upgrade it.
/// @notice The proxy DELEGATECALLs every call except `upgradeToAndCall` to the implementation. So the factory's state
///         lives here and survives upgrades. The implementation's address is at the EIP-1967 slot (read it with
///         eth_getStorageAt). `roles` is immutable and no implementation can reach it, so no upgrade can remove the
///         access of UPGRADER. Every implementation must report the same Roles (`roles()`), so the factory's ADMIN
///         checks and the proxy's upgrade check always agree. Each upgrade emits `Upgraded`. The proxy is never sealed.
contract FactoryProxy {
    /// @dev EIP-1967: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    address private immutable _roles;

    event Upgraded(address indexed implementation);

    /// @notice Point at `implementation`, take its Roles permanently and DELEGATECALL `data` on it (the factory's
    ///         one-time `initialize`), all in one atomic step.
    constructor(address implementation, bytes memory data) {
        require(implementation.code.length != 0, "implementation");
        _roles = IRolesBound(implementation).roles();
        require(_roles.code.length != 0, "roles");
        _upgrade(implementation, data);
    }

    /// @notice Switch to `implementation` (same Roles). When `data` is not empty, DELEGATECALL it. Only an UPGRADER.
    function upgradeToAndCall(address implementation, bytes calldata data) external {
        require(Roles(_roles).hasRole(Roles(_roles).UPGRADER(), msg.sender), "upgrader");
        _upgrade(implementation, data);
    }

    fallback() external {
        assembly {
            let impl := sload(IMPLEMENTATION_SLOT)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    function _upgrade(address implementation, bytes memory data) private {
        require(implementation.code.length != 0, "implementation");
        require(IRolesBound(implementation).roles() == _roles, "roles");
        assembly { sstore(IMPLEMENTATION_SLOT, implementation) }
        emit Upgraded(implementation);
        if (data.length == 0) return;
        (bool ok, bytes memory ret) = implementation.delegatecall(data);
        if (!ok) assembly { revert(add(ret, 0x20), mload(ret)) }
    }
}
