// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./NeuromModule.sol";
import "./Roles.sol";

/// @title ModuleFactory — creates weight chunks and module contracts, lists the engine versions and indexes the modules
///        by artifact (ADR 0014, ADR 0016, ADR 0017). It runs behind a FactoryProxy: everything below lives in the
///        proxy's storage and survives upgrades. `initialize` initializes it one time.
/// @notice Engine versions: per engine id (keccak256 of its name), a list of immutable engine contracts and the latest
///         one. ADMIN of `roles` adds a version and sets the latest among the added ones. A version never changes and
///         never leaves the list. An address is a version of one id only. All versions of one id compute the same,
///         bit for bit (ADR 0017).
///         Weight chunks: `createChunk(data)` deploys a contract whose code is a STOP byte followed by `data`. It uses
///         CREATE2 at salt keccak256(data) and the fixed init code CHUNK_INIT. CHUNK_INIT fetches the data back from
///         the Factory, so the address depends on the content hash alone. Thus anyone computes a chunk's address from
///         its content (chunkAddress). Identical chunks are created once and shared. An existing chunk is skipped.
///         Modules: `deploy(spec, data)` creates the module's missing chunks and then the module in one transaction
///         (all or nothing). It refuses:
///           - an engine id without a latest version (when `spec.version` is zero), or a `spec.version` not listed
///             for `spec.engineId`
///           - a chunk that does not exist after that (it recomputes the chunk's address)
///           - a shape that the engine refuses, or whose weights are not exactly the chunks' bytes
///           - a tool that is not a module of this Factory, and tools nested deeper than MAX_TOOL_DEPTH.
///         It records `isModule`, `depthOf`, the per-artifact index and ModuleDeployed. The module calls its engine
///         version directly, for life. The deployer becomes the module's owner. When chunks and module do not fit one
///         transaction, the deployer creates some chunks first with createChunk. The Factory is the only way to create
///         either. It vouches for how a module was assembled, not for the quality of the model it carries.
contract ModuleFactory {
    uint256 public constant MAX_PORT = 256;
    /// @notice Largest chunk content (112 KiB). It is under Monad's 128 KB code limit. It is the largest size whose
    ///         creation, estimate + 10% (the deployer's margin), fits one 30M-gas transaction on Monad.
    uint256 public constant MAX_CHUNK_BYTES = 114_688;
    /// @notice Deepest tool nesting a module may have: depthOf(module) = 0 without tools, else 1 + the deepest of its
    ///         tools. It bounds a step's gas. A step runs the chosen tool of each of its tool layers, recursively. So
    ///         with 8 tool layers per network, it makes up to Σ_{i=1..d} 8^i tool calls: 584 at d = 3, 4,680 at d = 4.
    ///         Each level costs at least the call into one more module and engine: ~24k gas warm on Monad rules for a
    ///         2 → [tool, FF 1 → 1 → 1] selector (test/Modules.t.sol testGasOfNetworkTools). A LIF tool's state slice
    ///         adds ~6k to a step. That floor alone is ~14M at d = 3, within Monad's 30M per transaction. At d = 4 it
    ///         is ~112M, which no transaction holds. The workbench reports the same limit as a network problem.
    uint256 public constant MAX_TOOL_DEPTH = 3;
    /// @notice Chunk init code: STATICCALL msg.sender's chunkData(), revert on failure, return the returned bytes as code.
    bytes public constant CHUNK_INIT = hex"63151ce8865f525f5f6004601c335afa6016575f5ffd5b3d5f5f3e3d5ff3";
    bytes32 public constant CHUNK_INIT_HASH = keccak256(CHUNK_INIT);

    uint256 private constant PENDING_LENGTH = uint256(keccak256("neurom.factory.chunk.length")) - 1;
    uint256 private constant PENDING_DATA = uint256(keccak256("neurom.factory.chunk.data")) - 1;

    /// @notice What `deploy` creates. `version` is the engine version to compute with: address(0) = the latest of
    ///         `engineId` when the module is created, else one of `versionsOf(engineId)`. `shape` is the engine's
    ///         encoding. `tools` are the tool modules, ordered by layer, then by wire order. `chunks` are the content
    ///         hashes (keccak256) of the weight chunks in blob order.
    struct ModuleSpec {
        bytes32 engineId;
        address version;
        uint8 kind;
        uint16 inputs;
        uint16 outputs;
        uint256[] shape;
        address[] tools;
        bytes32[] chunks;
        bytes32 artifactId;
        bytes32 taskId;
    }

    /// @notice The Roles contract whose ADMIN manages engine versions (FactoryProxy upgrades only with the same Roles).
    address public immutable roles;
    address private immutable _self;

    /// @notice The NeuromModule every module of this Factory delegates to (ModuleClone). `initialize` creates it.
    address public implementation;
    /// @notice Modules deployed so far (the next ModuleDeployed id).
    uint256 public count;
    /// @notice Whether `module` was deployed by this factory.
    mapping(address => bool) public isModule;
    /// @notice Tool nesting depth of `module` (0 without tools, see MAX_TOOL_DEPTH). 0 for an address that is no module.
    mapping(address => uint8) public depthOf;
    mapping(bytes32 => address[]) private _byArtifact;
    /// @notice The latest engine version of an engine id (what a deployment with `version` zero uses), else address(0).
    mapping(bytes32 => address) public latestOf;
    /// @notice The engine id `version` was added under, else bytes32(0).
    mapping(address => bytes32) public engineIdOf;
    mapping(bytes32 => address[]) private _versions;

    event ModuleDeployed(uint256 indexed id, address indexed module, bytes32 indexed artifactId, bytes32 engineId, address engine, bytes32 taskId, uint8 kind, uint16 inputs, uint16 outputs, address deployer);
    event ChunkCreated(bytes32 indexed id, address chunk, uint256 size);
    event VersionAdded(bytes32 indexed engineId, address indexed version);
    event LatestSet(bytes32 indexed engineId, address indexed version);

    constructor(address roles_) {
        require(roles_.code.length != 0, "roles");
        roles = roles_;
        _self = address(this);
    }

    /// @notice Initialize the proxy's state one time (FactoryProxy's constructor calls it): the module implementation,
    ///         created here so that its `factory` is the proxy. Refused on the implementation itself and a second time.
    function initialize() external {
        require(address(this) != _self && implementation == address(0), "init");
        implementation = address(new NeuromModule());
    }

    // ------------------------------------------------------------------------------------------- engine versions

    /// @notice Add `version` (an engine contract) to `engineId`'s versions. Only an ADMIN of `roles`. It must compute
    ///         exactly as the id's earlier versions (checked off chain before, ADR 0017). It never leaves the list.
    function addVersion(bytes32 engineId, address version) external {
        _onlyAdmin();
        require(engineId != bytes32(0) && version.code.length != 0, "engine");
        require(engineIdOf[version] == bytes32(0), "added");
        engineIdOf[version] = engineId;
        _versions[engineId].push(version);
        emit VersionAdded(engineId, version);
    }

    /// @notice Make `version`, already added to `engineId`, the one new deployments use by default. Only an ADMIN.
    function setLatest(bytes32 engineId, address version) external {
        _onlyAdmin();
        require(engineId != bytes32(0) && engineIdOf[version] == engineId, "version");
        latestOf[engineId] = version;
        emit LatestSet(engineId, version);
    }

    /// @notice Every version of `engineId`, in the order they were added.
    function versionsOf(bytes32 engineId) external view returns (address[] memory) { return _versions[engineId]; }

    function _onlyAdmin() private view {
        Roles r = Roles(roles);
        require(r.hasRole(r.ADMIN(), msg.sender), "admin");
    }

    // ------------------------------------------------------------------------------------------- chunks

    /// @notice The address of the chunk whose content hashes to `id` (it exists once createChunk has run).
    function chunkAddress(bytes32 id) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), id, CHUNK_INIT_HASH)))));
    }

    /// @notice Create the chunk holding `data` (1..MAX_CHUNK_BYTES bytes), or return it when it already exists.
    function createChunk(bytes calldata data) external returns (address) {
        require(data.length >= 1 && data.length <= MAX_CHUNK_BYTES, "chunk");
        return _createChunk(data, keccak256(data));
    }

    /// @dev The chunk of `data` (1..MAX_CHUNK_BYTES bytes, keccak256 = `id`, both checked by the caller): created unless
    ///      it exists.
    function _createChunk(bytes calldata data, bytes32 id) private returns (address chunk) {
        chunk = chunkAddress(id);
        if (chunk.code.length != 0) return chunk;
        uint256 len = data.length;
        (uint256 lengthSlot, uint256 dataSlot) = (PENDING_LENGTH, PENDING_DATA);
        assembly ("memory-safe") {
            tstore(lengthSlot, len)
            for { let i := 0 } lt(shl(5, i), len) { i := add(i, 1) } { tstore(add(dataSlot, i), calldataload(add(data.offset, shl(5, i)))) }
        }
        bytes memory init = CHUNK_INIT;
        address created;
        assembly ("memory-safe") {
            created := create2(0, add(init, 0x20), mload(init), id)
            tstore(lengthSlot, 0)
        }
        require(created == chunk && created.code.length == len + 1, "chunk");
        emit ChunkCreated(id, chunk, len);
    }

    /// @notice CHUNK_INIT's callback: the code of the chunk being created (0x00 ‖ data). Outside createChunk, only 0x00.
    function chunkData() external view {
        (uint256 lengthSlot, uint256 dataSlot) = (PENDING_LENGTH, PENDING_DATA);
        assembly {
            let len := tload(lengthSlot)
            let p := mload(0x40)
            mstore8(p, 0)
            for { let i := 0 } lt(shl(5, i), len) { i := add(i, 1) } { mstore(add(add(p, 1), shl(5, i)), tload(add(dataSlot, i))) }
            return(p, add(len, 1))
        }
    }

    // ------------------------------------------------------------------------------------------- modules

    /// @notice Create the chunks of `spec` given in `data`, then a module of `spec`. msg.sender becomes its owner.
    ///         `data[k]` is chunk k's content: its keccak256 must be `spec.chunks[k]`, and it is skipped when the chunk
    ///         exists. `data[k]` is empty for a chunk that exists or whose content an earlier slot sends. Everything is
    ///         checked before anything is created. The whole call is one transaction: a module that cannot be created
    ///         leaves no chunk behind.
    function deploy(ModuleSpec calldata spec, bytes[] calldata data) external returns (address module) {
        (address engine, uint256[] memory tools, address[] memory chunks, uint256 stateWidth, uint256 depth) = _check(spec, data);
        for (uint256 k; k < data.length; k++) if (data[k].length != 0) _createChunk(data[k], spec.chunks[k]);
        bytes memory args = abi.encodePacked(
            uint256(uint160(engine)) | (uint256(spec.kind) << 160) | (uint256(spec.inputs) << 168) | (uint256(spec.outputs) << 184)
                | (stateWidth << 200) | (spec.shape.length << 216) | (chunks.length << 224) | (tools.length << 240),
            spec.engineId, spec.artifactId, spec.taskId, spec.shape, chunks, tools);
        bytes memory init = ModuleClone.initCode(implementation, abi.encodePacked(args, args.length));
        assembly ("memory-safe") { module := create(0, add(init, 0x20), mload(init)) }
        require(module != address(0), "deploy");
        NeuromModule(module).initialize(msg.sender);
        isModule[module] = true;
        depthOf[module] = uint8(depth);
        _byArtifact[spec.artifactId].push(module);
        emit ModuleDeployed(count++, module, spec.artifactId, spec.engineId, engine, spec.taskId, spec.kind, spec.inputs, spec.outputs, msg.sender);
    }

    /// @notice Reverts with the reason that `deploy(spec, data)` would refuse for, and creates nothing. Returns
    ///         otherwise. Only running out of gas is left for `deploy` (a deployer checks first, then sizes its
    ///         transactions by gas).
    function checkDeploy(ModuleSpec calldata spec, bytes[] calldata data) external view {
        _check(spec, data);
    }

    /// @dev Every refusal of deploy, before anything is created: the engine version, the tool words and depth, the chunk
    ///      addresses and the state width of the module. A chunk counts with its code when it exists, else with the
    ///      content in `data`.
    function _check(ModuleSpec calldata spec, bytes[] calldata data)
        private view returns (address engine, uint256[] memory tools, address[] memory chunks, uint256 stateWidth, uint256 depth)
    {
        if (spec.version == address(0)) {
            engine = latestOf[spec.engineId];
            require(engine != address(0), "engine");
        } else {
            engine = spec.version;
            require(spec.engineId != bytes32(0) && engineIdOf[engine] == spec.engineId, "version");
        }
        require(spec.kind <= ModuleKinds.KIND_LIF, "kind");
        require(spec.inputs >= 1 && spec.inputs <= MAX_PORT, "inputs");
        require(spec.outputs >= 1 && spec.outputs <= MAX_PORT, "outputs");
        require(spec.shape.length <= 0xff, "shape");
        // the module's identity (ModuleClone: header, three ids, shape, chunks, tools, its length) must fit the clone
        require(ModuleClone.STUB + 32 * (5 + spec.shape.length + spec.chunks.length + spec.tools.length) <= 0xffff, "args");
        tools = new uint256[](spec.tools.length);
        for (uint256 k; k < tools.length; k++) {
            address tool = spec.tools[k];
            require(isModule[tool], "tool");
            tools[k] = ToolWords.pack(tool, INeuromModule(tool).descriptor());
            uint256 d = uint256(depthOf[tool]) + 1;
            if (d > depth) depth = d;
        }
        require(depth <= MAX_TOOL_DEPTH, "depth");
        uint256 weightBytes;
        (weightBytes, stateWidth) = IEngine(engine).check(spec.kind, spec.inputs, spec.outputs, spec.shape, tools);
        require(stateWidth <= 8 * 32, "state");
        chunks = _chunkAddresses(spec.chunks, data, weightBytes);
    }

    /// @dev The addresses of `ids`, each chunk existing or sent along in `data`, holding `weightBytes` bytes in all.
    function _chunkAddresses(bytes32[] calldata ids, bytes[] calldata data, uint256 weightBytes) private view returns (address[] memory chunks) {
        require(ids.length >= 1 && data.length == ids.length, "chunk");
        chunks = new address[](ids.length);
        uint256 total;
        for (uint256 k; k < chunks.length; k++) {
            chunks[k] = chunkAddress(ids[k]);
            uint256 sent = data[k].length;
            if (sent != 0) require(sent <= MAX_CHUNK_BYTES && keccak256(data[k]) == ids[k], "chunk");
            uint256 size = chunks[k].code.length;
            if (size != 0) total += size - 1;
            else total += sent != 0 ? sent : _sentEarlier(ids, data, k);
        }
        require(total == weightBytes, "weights");
    }

    /// @dev The length of chunk k's content sent in an earlier slot with the same id (a repeat within one module is sent
    ///      once). Reverts "chunk" when it is not sent at all.
    function _sentEarlier(bytes32[] calldata ids, bytes[] calldata data, uint256 k) private pure returns (uint256) {
        for (uint256 j; j < k; j++) if (ids[j] == ids[k] && data[j].length != 0) return data[j].length;
        revert("chunk");
    }

    /// @notice Every module deployed with `artifactId`, in deployment order. A deployer verifies a module against the
    ///         artifact before it reuses the module as a tool: the artifactId is the deployer's claim, not proof.
    function modulesOf(bytes32 artifactId) external view returns (address[] memory) { return _byArtifact[artifactId]; }
}
