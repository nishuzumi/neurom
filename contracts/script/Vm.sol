// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// The Foundry cheatcodes the deployment scripts use.
interface IVm {
    function startBroadcast() external;
    function stopBroadcast() external;
    function envString(string calldata name) external view returns (string memory);
    function envAddress(string calldata name) external view returns (address);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
    function readCallers() external returns (uint8 callerMode, address msgSender, address txOrigin);
}

IVm constant vm = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));
