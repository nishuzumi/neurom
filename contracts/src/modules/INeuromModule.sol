// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Immutable identity of one deployed module (ADR 0014): which engine computes it, which trained artifact it
///         carries, which task's port semantics it speaks and how wide its ports are. Everything here is fixed at
///         construction. shape(), chunks() and tools() return the module's shape, weight chunks and tools.
struct ModuleDescriptor {
    bytes32 engineId;    // keccak256 of the engine name, for example keccak256("dense-policy")
    bytes32 artifactId;  // neurom-module artifact content hash (sha256, bytes32) chosen by the deployer
    bytes32 taskId;      // port semantics identifier: sha256 of the artifact bundle's `env` (frontend/core/bundle.js envHash)
    uint8 kind;          // KIND_FF | KIND_LIF
    uint16 inputs;       // input bits per decision
    uint16 outputs;      // scores per decision
    uint16 stateWidth;   // persisted int32 voltages per (actor, session), its tools' states included, 0 = stateless
    address factory;     // ModuleFactory (its FactoryProxy) that created the module
    address engine;      // the engine version of `engineId` the module computes with, for life (ModuleFactory.versionsOf)
}

/// @title INeuromModule — one trained model, one contract, module-owned state.
/// @notice FF, LIF and threshold-layer modules share this call surface. A decision is `scores` (one int256 per output),
///         `action` (first argmax), `counts` (hidden activations / spike counts) and `voltages` (the persisted state
///         after the decision, empty for stateless modules).
///
///         State is keyed by (actor, session) with actor = msg.sender of `step` / `reset`. A caller can write only
///         its own histories, so nothing that a third party sends can spoof the history of another actor.
///         A module's state ("its state", stateWidth int32): its own LIF potentials (every plain layer's, none for
///         FF), then the state of each of its tools, ordered by layer, then by wire order. A network tool's state is
///         its own state, recursively in this layout. A tool without state has none. A tool's state belongs to the
///         calling session: the tool does not use its own storage. The caller's engine runs the tool with
///         `forwardFrom` from the caller's slice.
interface INeuromModule {
    /// @dev Commits the transaction's actual result. Equal final voltages alone do not imply equal spike counts.
    event Stepped(address indexed actor, bytes32 indexed session, bytes32 resultHash);
    event Reset(address indexed actor, bytes32 indexed session);

    function descriptor() external view returns (ModuleDescriptor memory);

    /// @notice Decision from the rest state. Reads and writes nothing.
    function forward(bytes calldata inputBits)
        external view returns (int256[] memory scores, uint16 action, uint8[] memory counts, int32[] memory voltages);

    /// @notice Decision from msg.sender's stored state for `session`, without persisting.
    function peek(bytes32 session, bytes calldata inputBits)
        external view returns (int256[] memory scores, uint16 action, uint8[] memory counts, int32[] memory voltages);

    /// @notice Decision from the given packed `state` (⌈stateWidth / 8⌉ words, IEngine's packing). Another length
    ///         reverts "state". Reads and writes nothing. `voltages` = the next state. A selector's engine uses this
    ///         function to run a tool whose state lives in the calling session.
    function forwardFrom(uint256[] calldata state, bytes calldata inputBits)
        external view returns (int256[] memory scores, uint16 action, uint8[] memory counts, int32[] memory voltages);

    /// @notice Decision from the state stored under (actor, session), without persisting.
    function peekAs(address actor, bytes32 session, bytes calldata inputBits)
        external view returns (int256[] memory scores, uint16 action, uint8[] memory counts, int32[] memory voltages);

    /// @notice One persisted decision for (msg.sender, session).
    function step(bytes32 session, bytes calldata inputBits)
        external returns (int256[] memory scores, uint16 action, uint8[] memory counts, int32[] memory voltages);

    /// @notice Zero (msg.sender, session). No-op for stateless modules.
    function reset(bytes32 session) external;

    /// @notice Stored voltages for (actor, session) (length stateWidth, empty for stateless modules).
    function stateOf(address actor, bytes32 session) external view returns (int32[] memory);
}

/// @title IEngine — what an engine version (an immutable contract, ADR 0017) computes for a module (ADR 0014).
/// @notice Pure computation: a module STATICCALLs `run`, so an engine can write nothing. `shape` is the engine's own
///         encoding of the layer list and parameters. `chunks` are the weight chunks in order (their code after the
///         STOP byte, concatenated, is the weight blob). `tools` holds one word per tool module, ordered by layer,
///         then by wire order (ToolWords). `state` holds the session's state words: the module's stateWidth int32 in
///         INeuromModule's layout, voltage j in word j / 8 at bits [224 − 32·(j % 8), 256 − 32·(j % 8)). `input` holds
///         one byte (0 / 1) per input bit.
interface IEngine {
    /// @notice The Factory's check before it creates a module. Reverts on an invalid shape or on a tool that does not
    ///         fit. Returns the weight bytes that the chunks must hold and the module's persisted state width.
    function check(uint8 kind, uint16 inputs, uint16 outputs, uint256[] calldata shape, uint256[] calldata tools)
        external view returns (uint256 weightBytes, uint256 stateWidth);

    /// @notice One decision from the packed `state`, returned exactly as INeuromModule returns it (a module passes the
    ///         result through). `voltages` is the state after the decision (empty for stateless modules).
    function run(uint8 kind, uint16 inputs, uint16 outputs, uint256[] calldata shape, address[] calldata chunks, uint256[] calldata tools, uint256[] calldata state, bytes calldata input)
        external view returns (int256[] memory scores, uint16 action, uint8[] memory counts, int32[] memory voltages);
}

library ModuleKinds {
    uint8 internal constant KIND_FF = 0;
    uint8 internal constant KIND_LIF = 1;
}

/// @notice A tool as an engine sees it: one word per tool module, packed by the Factory from the tool's descriptor.
library ToolWords {
    function pack(address tool, ModuleDescriptor memory d) internal pure returns (uint256) {
        return uint256(uint160(tool)) | (uint256(d.inputs) << 160) | (uint256(d.outputs) << 176) | (uint256(d.stateWidth) << 192) | (uint256(d.kind) << 208);
    }
    function module(uint256 w) internal pure returns (address) { return address(uint160(w)); }
    function inputs(uint256 w) internal pure returns (uint256) { return (w >> 160) & 0xffff; }
    function outputs(uint256 w) internal pure returns (uint256) { return (w >> 176) & 0xffff; }
    function stateWidth(uint256 w) internal pure returns (uint256) { return (w >> 192) & 0xffff; }
    function kind(uint256 w) internal pure returns (uint256) { return (w >> 208) & 0xff; }
}
