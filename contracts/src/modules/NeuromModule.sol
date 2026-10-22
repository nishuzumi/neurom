// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./INeuromModule.sol";

/// @title ModuleClone — the code of one module contract: a 55-byte stub followed by the module's identity.
/// @notice The stub copies the call's data, appends the identity (everything after the stub in its own code) and
///         DELEGATECALLs the Factory's NeuromModule implementation. The result or revert comes back unchanged. So a
///         module costs a few hundred bytes of code to deploy. Its identity is in its code (fixed, read without storage
///         access). Its state and owner are in its own storage.
///         Identity (`args`), 32-byte words: header, engineId, artifactId, taskId, shape words, chunk addresses, tool
///         words (ToolWords), then the byte length of everything before. header = engine | kind << 160 | inputs << 168 |
///         outputs << 184 | stateWidth << 200 | shape words << 216 | chunks << 224 | tools << 240.
library ModuleClone {
    uint256 internal constant STUB = 55;

    /// @notice Init code of a module: returns stub(implementation) ‖ args as the runtime code.
    function initCode(address implementation, bytes memory args) internal pure returns (bytes memory) {
        uint256 size = STUB + args.length;
        require(size <= 0xffff, "args");
        return abi.encodePacked(
            hex"61", uint16(size), hex"80600a5f395ff3",                                   // PUSH2 size, CODECOPY(0, 10, size), RETURN(0, size)
            hex"365f5f37" hex"5f5f" hex"6037380380603736393601" hex"5f" hex"73", implementation,
            hex"5af4" hex"3d5f5f3e" hex"603357" hex"3d5ffd" hex"5b3d5ff3",
            args
        );
    }
}

/// @title NeuromModule — the implementation every module contract of one Factory runs (ADR 0014, ADR 0017): identity,
///        weight chunks, tools, each (actor, session)'s state and an owner. It computes by STATICCALLing its engine
///        version, which can write nothing.
/// @notice Nothing about the computation can change: the engine version, shape, chunks and tools are in the module's
///         code (ModuleClone). So the module runs the version it was deployed with for life. The owner (initially the
///         deployer) is only the address that a paying contract (the mining game) reads and pays. The owner is not a
///         protocol role. Ownership moves in two steps: the owner nominates, then the nominee accepts. A typo in
///         `nominateOwner` gives nothing away. address(0) withdraws the nomination. The module holds no funds.
contract NeuromModule is INeuromModule {
    uint256 public constant MAX_STATE_WORDS = 32;   // 256 int32 voltages packed 8 per word

    /// @notice The Factory that created this implementation and creates its modules: the FactoryProxy, since the
    ///         Factory creates it in `initialize`, running in the proxy.
    address public immutable factory;
    address private immutable _self;

    /// @notice The module's payee, initially its deployer.
    address public owner;
    /// @notice Who may accept ownership next (address(0): nobody).
    address public nominee;

    mapping(bytes32 => uint256[MAX_STATE_WORDS]) private _state;

    event OwnerNominated(address indexed owner, address indexed nominee);
    event OwnershipTransferred(address indexed from, address indexed to);

    constructor() {
        factory = msg.sender;
        _self = address(this);
    }

    /// @notice Set the first owner of a freshly created module. Only the Factory, once, and never on the implementation.
    function initialize(address owner_) external {
        require(msg.sender == factory && address(this) != _self && owner == address(0) && owner_ != address(0), "init");
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function nominateOwner(address next) external {
        require(msg.sender == owner, "owner");
        nominee = next;
        emit OwnerNominated(msg.sender, next);
    }

    function acceptOwnership() external {
        require(msg.sender == nominee && msg.sender != address(0), "nominee");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        nominee = address(0);
    }

    // ------------------------------------------------------------------------------------------- identity

    function descriptor() external view returns (ModuleDescriptor memory d) {
        (uint256 base, uint256 h) = _args();
        bytes32 engineId;
        bytes32 artifactId;
        bytes32 taskId;
        assembly ("memory-safe") {
            engineId := calldataload(add(base, 0x20))
            artifactId := calldataload(add(base, 0x40))
            taskId := calldataload(add(base, 0x60))
        }
        d = ModuleDescriptor(engineId, artifactId, taskId, uint8(h >> 160), uint16(h >> 168), uint16(h >> 184), uint16(h >> 200), factory, address(uint160(h)));
    }

    function engine() public pure returns (address) { (, uint256 h) = _args(); return address(uint160(h)); }
    function kind() public pure returns (uint8) { (, uint256 h) = _args(); return uint8(h >> 160); }
    function inputs() public pure returns (uint16) { (, uint256 h) = _args(); return uint16(h >> 168); }
    function outputs() public pure returns (uint16) { (, uint256 h) = _args(); return uint16(h >> 184); }
    function stateWidth() public pure returns (uint16) { (, uint256 h) = _args(); return uint16(h >> 200); }

    /// @notice The engine's shape words (DensePolicyEngine / ThresholdLayersEngine document their encoding).
    function shape() external pure returns (uint256[] memory) { (uint256[] calldata s,,) = _lists(); return s; }

    /// @notice The weight chunks, in blob order.
    function chunks() external pure returns (address[] memory c) {
        (, uint256[] calldata words,) = _lists();
        c = new address[](words.length);
        for (uint256 k; k < c.length; k++) c[k] = address(uint160(words[k]));
    }

    /// @notice The tool modules, ordered by layer, then by wire order.
    function tools() external pure returns (address[] memory t) {
        (,, uint256[] calldata words) = _lists();
        t = new address[](words.length);
        for (uint256 k; k < t.length; k++) t[k] = ToolWords.module(words[k]);
    }

    // ------------------------------------------------------------------------------------------- call surface
    // The engine returns a decision exactly as these functions return it: forward / peek pass its result through.

    function forward(bytes calldata inputBits)
        external view returns (int256[] memory, uint16, uint8[] memory, int32[] memory)
    {
        _return(_decide(inputBits, new uint256[](_stateWords())));
    }

    function forwardFrom(uint256[] calldata state, bytes calldata inputBits)
        external view returns (int256[] memory, uint16, uint8[] memory, int32[] memory)
    {
        require(state.length == _stateWords(), "state");
        _return(_decide(inputBits, state));
    }

    function peek(bytes32 session, bytes calldata inputBits)
        external view returns (int256[] memory, uint16, uint8[] memory, int32[] memory)
    {
        _return(_decide(inputBits, _load(_key(msg.sender, session))));
    }

    function peekAs(address actor, bytes32 session, bytes calldata inputBits)
        external view returns (int256[] memory, uint16, uint8[] memory, int32[] memory)
    {
        _return(_decide(inputBits, _load(_key(actor, session))));
    }

    /// @dev Stepped commits keccak256(abi.encode(scores, action, counts, voltages)): the engine's result bytes.
    function step(bytes32 session, bytes calldata inputBits)
        external returns (int256[] memory, uint16, uint8[] memory, int32[] memory)
    {
        bytes32 key = _key(msg.sender, session);
        uint256[] memory state = _load(key);
        bytes memory result = _decide(inputBits, state);
        if (state.length != 0) {
            uint256[] memory next = _pack(result);
            uint256[MAX_STATE_WORDS] storage s = _state[key];
            for (uint256 k; k < next.length; k++) if (next[k] != state[k]) s[k] = next[k];
        }
        emit Stepped(msg.sender, session, keccak256(result));
        _return(result);
    }

    function reset(bytes32 session) external {
        uint256 words = _stateWords();
        if (words == 0) return;
        uint256[MAX_STATE_WORDS] storage s = _state[_key(msg.sender, session)];
        for (uint256 k; k < words; k++) if (s[k] != 0) s[k] = 0;
        emit Reset(msg.sender, session);
    }

    function stateOf(address actor, bytes32 session) external view returns (int32[] memory v) {
        uint256[] memory packed = _load(_key(actor, session));
        v = new int32[](stateWidth());
        for (uint256 j; j < v.length; j++) v[j] = int32(uint32(packed[j >> 3] >> (224 - 32 * (j & 7))));
    }

    // ------------------------------------------------------------------------------------------- internals

    /// @dev Where the identity the clone appended starts in calldata, and its header word.
    function _args() private pure returns (uint256 base, uint256 header) {
        assembly ("memory-safe") {
            let end := sub(calldatasize(), 0x20)
            base := sub(end, calldataload(end))
            header := calldataload(base)
        }
    }

    /// @dev The shape, chunk and tool words of the identity, as calldata arrays.
    function _lists() private pure returns (uint256[] calldata s, uint256[] calldata c, uint256[] calldata t) {
        (uint256 base, uint256 h) = _args();
        uint256 ns = (h >> 216) & 0xff;
        uint256 nc = (h >> 224) & 0xffff;
        uint256 nt = h >> 240;
        assembly ("memory-safe") {
            s.offset := add(base, 0x80)
            s.length := ns
            c.offset := add(s.offset, shl(5, ns))
            c.length := nc
            t.offset := add(c.offset, shl(5, nc))
            t.length := nt
        }
    }

    function _stateWords() private pure returns (uint256) { return (uint256(stateWidth()) + 7) >> 3; }

    /// @dev The engine's result bytes for `inputBits` from `state`. An engine revert bubbles up.
    function _decide(bytes calldata inputBits, uint256[] memory state) private view returns (bytes memory result) {
        (, uint256 h) = _args();
        (uint256[] calldata s, uint256[] calldata c, uint256[] calldata t) = _lists();
        bool ok;
        (ok, result) = address(uint160(h)).staticcall(abi.encodeWithSelector(IEngine.run.selector, uint8(h >> 160), uint16(h >> 168), uint16(h >> 184), s, c, t, state, inputBits));
        if (!ok) assembly ("memory-safe") { revert(add(result, 0x20), mload(result)) }
    }

    /// @dev Return `result` as this call's return data.
    function _return(bytes memory result) private pure {
        assembly ("memory-safe") { return(add(result, 0x20), mload(result)) }
    }

    /// @dev The result's voltages (stateWidth of them, int32) packed into state words.
    function _pack(bytes memory result) private pure returns (uint256[] memory next) {
        (,,, int32[] memory v) = abi.decode(result, (int256[], uint16, uint8[], int32[]));
        uint256 width = stateWidth();
        require(v.length == width, "engine");
        next = new uint256[]((width + 7) >> 3);
        for (uint256 j; j < width; j++) next[j >> 3] |= uint256(uint32(v[j])) << (224 - 32 * (j & 7));
    }

    function _key(address actor, bytes32 session) private pure returns (bytes32) {
        return keccak256(abi.encode(actor, session));
    }

    function _load(bytes32 key) private view returns (uint256[] memory state) {
        uint256 words = _stateWords();
        state = new uint256[](words);
        uint256[MAX_STATE_WORDS] storage s = _state[key];
        for (uint256 k; k < words; k++) state[k] = s[k];
    }
}
