// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../../src/modules/Roles.sol";
import "../../src/modules/FactoryProxy.sol";
import "../../src/modules/ModuleFactory.sol";
import "../../src/modules/DensePolicyEngine.sol";
import "../../src/modules/ThresholdLayersEngine.sol";
import "../../src/ladder/TankLadder.sol";

/// The Foundry cheatcodes the ladder tests use.
interface IVm {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    struct SignedDelegation { uint8 v; bytes32 r; bytes32 s; uint64 nonce; address implementation; }
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function prevrandao(bytes32 value) external;
    function roll(uint256 blockNumber) external;
    function prank(address sender, address origin) external;
    function startPrank(address sender, address origin) external;
    function stopPrank() external;
    function etch(address target, bytes calldata code) external;
    function expectRevert(bytes4 selector) external;
    function expectPartialRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function addr(uint256 privateKey) external pure returns (address);
    function signDelegation(address implementation, uint256 privateKey) external returns (SignedDelegation memory);
    function attachDelegation(SignedDelegation calldata signed) external;
    function toString(uint256 value) external pure returns (string memory);
}

/// Prints with `forge test -vv`.
library Console {
    address constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;
    function log(string memory what, uint256 value) internal view {
        (bool ok,) = CONSOLE.staticcall(abi.encodeWithSignature("log(string,uint256)", what, value));
        ok;
    }
}

/// A contract that forwards a call: a challenger that is not an EOA.
contract Wrapper {
    function go(address target, bytes calldata data) external returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) assembly { revert(add(ret, 0x20), mload(ret)) }
    }
}

/// The protocol (Roles, the Factory behind its proxy, both engines), the two trained modules of the parity corpus
/// (中 `mid`, 大 `big`, deployed from test/fixtures/tank-episodes.json) and the way to deploy a ladder.
contract LadderBase {
    IVm constant vm = IVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 constant DENSE = keccak256("dense-policy");
    string constant FIXTURE = "test/fixtures/tank-episodes.json";
    string constant DEFAULTS = "ladder-defaults.json";    // the TankLadder.Config of the spec, shared with the deploy script
    uint256 constant GAS_LIMIT = 30_000_000;    // Monad's transaction gas limit

    Roles roles;
    ModuleFactory factory;
    address dense;
    string fixture;
    address mid;
    address big;
    uint256 midBytes;
    uint256 bigBytes;

    function setUp() public virtual {
        roles = new Roles();
        factory = ModuleFactory(address(new FactoryProxy(address(new ModuleFactory(address(roles))), abi.encodeCall(ModuleFactory.initialize, ()))));
        dense = address(new DensePolicyEngine());
        address threshold = address(new ThresholdLayersEngine());
        factory.addVersion(DENSE, dense); factory.setLatest(DENSE, dense);
        factory.addVersion(keccak256("threshold-layers"), threshold); factory.setLatest(keccak256("threshold-layers"), threshold);
        fixture = vm.readFile(FIXTURE);
        mid = deployFixtureModule("mid", bytes32(0));
        big = deployFixtureModule("big", bytes32(0));
        midBytes = vm.parseJsonUint(fixture, ".modules.mid.weightBytes");
        bigBytes = vm.parseJsonUint(fixture, ".modules.big.weightBytes");
    }

    struct FixtureModule { bytes32 engineId; uint8 kind; uint16 inputs; uint16 outputs; uint256[] shape; bytes[] chunks; bytes32 artifactId; bytes32 taskId; }

    /// The module id of a test module with artifact id `art`: "m-" and the first 16 bytes of `art` in hex. Every
    /// helper below deploys one module per artifact id, so the ids of one deployer are distinct.
    function idOf(bytes32 art) internal pure returns (string memory) {
        bytes memory hex_ = "0123456789abcdef";
        bytes memory b = new bytes(34);
        b[0] = "m"; b[1] = "-";
        for (uint256 k; k < 16; k++) { b[2 + 2 * k] = hex_[uint8(art[k]) >> 4]; b[3 + 2 * k] = hex_[uint8(art[k]) & 0xf]; }
        return string(b);
    }

    /// The ModuleSpec of fixture module `tag` (`mid` or `big`) with its chunk contents. `salt` changes the artifact id
    /// (the module's decisions stay, so a second deployment reuses the chunks: a copy with the same weights).
    function fixtureSpec(string memory tag, bytes32 salt) internal view returns (ModuleFactory.ModuleSpec memory spec, bytes[] memory data) {
        FixtureModule memory m = abi.decode(vm.parseJsonBytes(fixture, string.concat(".modules.", tag, ".data")), (FixtureModule));
        bytes32[] memory ids = new bytes32[](m.chunks.length);
        for (uint256 k; k < ids.length; k++) ids[k] = keccak256(m.chunks[k]);
        bytes32 art = salt == bytes32(0) ? m.artifactId : salt;
        spec = ModuleFactory.ModuleSpec(m.engineId, address(0), m.kind, m.inputs, m.outputs, m.shape, new address[](0), ids, art, m.taskId, idOf(art));
        data = m.chunks;
    }

    function deployFixtureModule(string memory tag, bytes32 salt) internal returns (address) {
        (ModuleFactory.ModuleSpec memory spec, bytes[] memory data) = fixtureSpec(tag, salt);
        return factory.deploy(spec, data);
    }

    /// A twin of fixture module `tag` with other chunks but the same decisions: the last byte of its weight blob is
    /// padding of the output layer's bias column (9 int16 in one word), which the engine never reads.
    function deployFixtureTwin(string memory tag, bytes32 salt) internal returns (address) {
        (ModuleFactory.ModuleSpec memory spec, bytes[] memory data) = fixtureSpec(tag, salt);
        bytes memory last = data[data.length - 1];
        last[last.length - 1] = bytes1(uint8(last[last.length - 1]) ^ 0x5a);
        spec.chunks[spec.chunks.length - 1] = keccak256(last);
        return factory.deploy(spec, data);
    }

    /// A feedforward dense module `inputs` → `hidden` → `outputs` at 8 bits with zero weights, except the first
    /// hidden bias, which is `mark` (so modules with different marks have different chunks but decide the same:
    /// every score is 0, the action is 0). `art` is its artifact id.
    function tinySpec(uint16 inputs, uint16 hidden, uint16 outputs, uint8 mark, bytes32 art) internal pure returns (ModuleFactory.ModuleSpec memory spec, bytes[] memory data) {
        uint256 first = uint256(inputs) * 32 * ((hidden + 31) / 32) + 32 * ((hidden + 15) / 16);
        uint256 second = uint256(hidden) * 32 * ((outputs + 31) / 32) + 32 * ((outputs + 15) / 16);
        bytes memory blob = new bytes(first + second);
        blob[uint256(inputs) * 32 * ((hidden + 31) / 32) + 1] = bytes1(mark);
        uint256[] memory shape = new uint256[](4);
        shape[0] = hidden - 1;
        shape[2] = 1 | (1 << 8) | (8 << 24);
        shape[3] = 1;
        data = new bytes[](1);
        data[0] = blob;
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = keccak256(blob);
        spec = ModuleFactory.ModuleSpec(DENSE, address(0), 0, inputs, outputs, shape, new address[](0), ids, art, keccak256("tank"), idOf(art));
    }

    /// A tiny module (tinySpec) deployed: 572 → 1 → 9 with `mark` by default. Its weight size is 18,400 bytes.
    function tiny(uint8 mark) internal returns (address) { return tiny(572, 1, 9, mark); }
    function tiny(uint16 inputs, uint16 hidden, uint16 outputs, uint8 mark) internal returns (address) {
        (ModuleFactory.ModuleSpec memory spec, bytes[] memory data) = tinySpec(inputs, hidden, outputs, mark, keccak256(abi.encode("tiny", inputs, hidden, outputs, mark)));
        return factory.deploy(spec, data);
    }

    /// A module 572 → tool layer [a, b] (2 data bits, 1 result bit) → 1 → 9 with zero weights: a module with tools
    /// (depth 1). `a` and `b` are 2 → 1 → 1 modules.
    function selector(uint8 mark) internal returns (address) {
        address[] memory tools = new address[](2);
        tools[0] = tiny(2, 1, 1, mark);
        tools[1] = tiny(2, 1, 1, mark + 1);
        uint256 region = 572 * 32 + 32;                   // 2 rows over 572 inputs: the choice rows, then the data rows
        bytes memory blob = new bytes(2 * region + (573 * 32 + 32) + (32 + 32));   // then 1 row over 573, then 9 rows over 1
        blob[1] = bytes1(mark);
        uint256[] memory shape = new uint256[](4);
        shape[0] = (1 << 48) | 1 | (1 << 16);              // layer 0, a tool layer: K 2, D 2, R 1; layer 1: hidden 1
        shape[2] = 2 | (1 << 8) | (8 << 24);
        shape[3] = 1 << 32;                                // the threshold of the plain layer
        bytes[] memory data = new bytes[](1);
        data[0] = blob;
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = keccak256(blob);
        bytes32 art = keccak256(abi.encode("selector", mark));
        return factory.deploy(ModuleFactory.ModuleSpec(DENSE, address(0), 0, 572, 9, shape, tools, ids, art, keccak256("tank"), idOf(art)), data);
    }

    /// The default configuration of the spec (ladder-defaults.json), with `endBlock` far away.
    function defaultConfig() internal view returns (TankLadder.Config memory) {
        string memory json = vm.readFile(DEFAULTS);
        return TankLadder.Config(
            address(factory),
            uint32(vm.parseJsonUint(json, ".maxWeightBytes")),
            uint16(vm.parseJsonUint(json, ".deltaBps")),
            uint8(vm.parseJsonUint(json, ".range")),
            uint8(vm.parseJsonUint(json, ".boardSize")),
            uint32(vm.parseJsonUint(json, ".timeoutBlocks")),
            uint32(vm.parseJsonUint(json, ".cooldownBlocks")),
            uint32(vm.parseJsonUint(json, ".minStartGas")),
            uint32(vm.parseJsonUint(json, ".reserveGas")),
            type(uint64).max);
    }

    function newLadder() internal returns (TankLadder) { return new TankLadder(defaultConfig()); }

    /// Plays challenge `id` of `l` to its end with 30M transactions from this contract (not an EOA) → the
    /// transactions of the challenge, the one that started it included.
    function settle(TankLadder l, uint256 id) internal returns (uint256 transactions) {
        transactions = 1;
        while (l.challengeInfo(id).status == l.STATUS_PLAYING()) { l.advance{gas: GAS_LIMIT}(id); transactions++; }
    }

    /// The first topic of the events: keccak256 of their signature.
    bytes32 constant STEPS_SIG = keccak256("Steps(uint256,uint8,uint8,bytes)");
    bytes32 constant EPISODE_ENDED_SIG = keccak256("EpisodeEnded(uint256,uint8,int8,uint8)");
    bytes32 constant SETTLED_SIG = keccak256("ChallengeSettled(uint256,uint8,uint8,uint8,uint32)");
}
