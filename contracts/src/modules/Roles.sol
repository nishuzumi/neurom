// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Roles — the protocol's powers, held by accounts (ADR 0016). Not upgradeable.
/// @notice ADMIN grants and revokes both roles and manages the factory's engine versions (adds one, sets the latest).
///         UPGRADER upgrades the factory (FactoryProxy). The deployer starts with both. A role is a set of accounts:
///         granting one already held and revoking one not held change nothing and emit nothing. There is no
///         nominate-and-accept step. A handover grants the role to the new holder, checks, then revokes the old
///         holder. Revoking the last ADMIN is allowed and final: after it, nobody can grant a role again. A module's
///         owner is not a role.
contract Roles {
    bytes32 public constant ADMIN = keccak256("neurom.role.admin");
    bytes32 public constant UPGRADER = keccak256("neurom.role.upgrader");

    mapping(bytes32 => mapping(address => bool)) private _holds;

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    constructor() {
        _grant(ADMIN, msg.sender);
        _grant(UPGRADER, msg.sender);
    }

    /// @notice Whether `account` holds `role` (ADMIN or UPGRADER).
    function hasRole(bytes32 role, address account) external view returns (bool) { return _holds[role][account]; }

    /// @notice Give `account` `role`. Only an ADMIN.
    function grantRole(bytes32 role, address account) external {
        _admin(role);
        require(account != address(0), "account");
        _grant(role, account);
    }

    /// @notice Take `role` from `account`. Only an ADMIN (an ADMIN can also revoke itself).
    function revokeRole(bytes32 role, address account) external {
        _admin(role);
        if (!_holds[role][account]) return;
        _holds[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    function _admin(bytes32 role) private view {
        require(_holds[ADMIN][msg.sender], "admin");
        require(role == ADMIN || role == UPGRADER, "role");
    }

    function _grant(bytes32 role, address account) private {
        if (_holds[role][account]) return;
        _holds[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }
}
