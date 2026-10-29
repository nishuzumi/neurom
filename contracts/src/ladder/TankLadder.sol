// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../modules/INeuromModule.sol";
import "./TankScene.sol";

/// @dev What the ladder reads from the official ModuleFactory.
interface ILadderFactory {
    function isModule(address module) external view returns (bool);
    function depthOf(address module) external view returns (uint8);
}

/// @dev What the ladder reads from a module.
interface ILadderModule {
    function descriptor() external view returns (ModuleDescriptor memory);
    function chunks() external view returns (address[] memory);
}

/// @title TankLadder — the ladder and the referee of the tank battle contest (ADR 0026).
/// @notice An entry is a module of the official Factory with 572 input bits and 9 scores, without tools, whose weight
///         size is at most `maxWeightBytes` and whose weight chunks differ from every other entry. The entry's owner
///         is the account that registered it. A new entry takes the last rank.
///         A challenge is 3 mirror pairs (6 episodes) between a challenger and a defender 1 to `range` ranks above
///         it. Only an EOA without code starts a challenge, with at least `minStartGas` gas left at the entry. The seed
///         is keccak256(block.prevrandao, id). The transaction that starts the challenge plays steps until less than
///         `reserveGas` gas is left, then saves the position. Anyone continues it with `advance`. The transaction that
///         ends episode 6 settles. A challenge that is not settled `timeoutBlocks` blocks after its start is a
///         defense, and anyone settles it with `expire`.
///         The challenger wins when it wins more episodes than the defender, or the same number with a weight size
///         of at most (1 − δ) times the defender's. Then it takes the defender's rank, and the defender and every
///         entry between them move down one rank. Every other result is a defense. The same challenger cannot
///         challenge the same defender again for `cooldownBlocks` blocks. After `endBlock` the ladder accepts no new
///         entry and no new challenge. A started challenge plays to its end.
///         The page replays a challenge from the seed and the `Steps` events alone. The referee is TankScene, which
///         mirrors the template scene bit for bit. The ladder reads the scores of each side with the read-only
///         `forward` from the rest state and takes the first maximum (the readout of the workbench).
contract TankLadder {
    struct Config {
        address factory;
        uint32 maxWeightBytes;
        uint16 deltaBps;
        uint8 range;
        uint32 timeoutBlocks;
        uint32 cooldownBlocks;
        uint32 minStartGas;
        uint32 reserveGas;
        uint64 endBlock;
    }

    /// @notice An entry as the views return it. `rank` is 1-based, `activeChallenge` 0 = none.
    struct Entry {
        address module;
        address owner;
        uint32 weightBytes;
        uint32 rank;
        uint16 wins;
        uint16 losses;
        uint256 activeChallenge;
    }

    /// @notice A challenge as `challengeInfo` returns it. `status`: 0 none, 1 playing, 2 the challenger won, 3 defense,
    ///         4 expired. `episode` 0..6 (6 = all played), `step` the steps played of the current episode. `deadline`
    ///         is the last block in which the challenge can still settle by play.
    struct ChallengeInfo {
        address challenger;
        address defender;
        bytes32 seed;
        uint64 startBlock;
        uint64 deadline;
        uint8 status;
        uint8 episode;
        uint8 step;
        uint8 challengerWins;
        uint8 defenderWins;
    }

    uint8 public constant STATUS_PLAYING = 1;
    uint8 public constant STATUS_CHALLENGER_WON = 2;
    uint8 public constant STATUS_DEFENSE = 3;
    uint8 public constant STATUS_EXPIRED = 4;
    uint8 public constant EPISODES = 6;

    event EntryRegistered(address indexed module, address indexed owner, uint32 weightBytes, uint32 rank);
    event ChallengeStarted(uint256 indexed id, address indexed challenger, address indexed defender, bytes32 seed, uint64 startBlock);
    /// @notice The actions of the steps `fromStep`.. of `episode`: one byte per step, a0 · 9 + a1, the actions that
    ///         the two networks chose in their own maps, side 0 first.
    event Steps(uint256 indexed id, uint8 episode, uint8 fromStep, bytes actions);
    /// @notice `end` as the scene: 0 side 0 wins, 1 side 1 wins, 2 draw.
    event EpisodeEnded(uint256 indexed id, uint8 episode, int8 end, uint8 steps);
    event ChallengeSettled(uint256 indexed id, uint8 status, uint8 challengerWins, uint8 defenderWins, uint32 newRank);

    error BadConfig();
    error NotOfficialModule();
    error WrongShape(uint16 inputs, uint16 outputs);
    error TooLarge(uint256 weightBytes, uint256 maxWeightBytes);
    error DuplicateWeights(address entry);
    error HasTools();
    error AlreadyEntered();
    error NotEntered();
    error NotEoa();
    error LowGas(uint256 gasLeft, uint256 minStartGas);
    error NotOwner();
    error OutOfRange();
    error Busy();
    error Cooldown(uint64 untilBlock);
    error SeasonOver();
    error NotPlaying();
    error Expired();
    error NotExpired();
    error BadRank();
    error ForwardFailed(address module);

    // ------------------------------------------------------------------------------------------------ configuration

    address public immutable factory;
    uint32 public immutable maxWeightBytes;
    uint16 public immutable deltaBps;
    uint8 public immutable range;
    uint32 public immutable timeoutBlocks;
    uint32 public immutable cooldownBlocks;
    uint32 public immutable minStartGas;
    uint32 public immutable reserveGas;
    uint64 public immutable endBlock;

    constructor(Config memory c) {
        if (c.factory.code.length == 0 || c.deltaBps > 10000 || c.range == 0 || c.reserveGas == 0 || c.timeoutBlocks == 0) revert BadConfig();
        factory = c.factory;
        maxWeightBytes = c.maxWeightBytes;
        deltaBps = c.deltaBps;
        range = c.range;
        timeoutBlocks = c.timeoutBlocks;
        cooldownBlocks = c.cooldownBlocks;
        minStartGas = c.minStartGas;
        reserveGas = c.reserveGas;
        endBlock = c.endBlock;
    }

    function config() external view returns (Config memory) {
        return Config(factory, maxWeightBytes, deltaBps, range, timeoutBlocks, cooldownBlocks, minStartGas, reserveGas, endBlock);
    }

    // ------------------------------------------------------------------------------------------------ storage

    /// @dev One slot: owner 160 | weightBytes 32 | rank 32 | wins 16 | losses 16.
    struct EntryData { address owner; uint32 weightBytes; uint32 rank; uint16 wins; uint16 losses; uint256 activeChallenge; }
    /// @dev head: challenger 160 | startBlock 64 | status 8 | episode 8 | challengerWins 8 | defenderWins 8.
    ///      body: defender 160 | scene meta 96 (TankScene.packMeta). cells: the 81 cells of the current episode.
    struct ChallengeData { uint256 head; uint256 body; bytes32 seed; uint256 cells; }

    address[] private _ranks;
    mapping(address => EntryData) private _entries;
    /// @dev keccak256 of the chunk list of each entry → the entry.
    mapping(bytes32 => address) private _byChunks;
    mapping(uint256 => ChallengeData) private _challenges;
    mapping(bytes32 => uint64) private _cooldownUntil;
    /// @notice Challenges started so far (the id of the last one).
    uint256 public challengeCount;

    // ------------------------------------------------------------------------------------------------ registration

    /// @notice Enter `module` on the ladder at the last rank. msg.sender becomes its owner.
    function register(address module) external {
        if (block.number >= endBlock) revert SeasonOver();
        if (_entries[module].rank != 0) revert AlreadyEntered();
        if (!ILadderFactory(factory).isModule(module)) revert NotOfficialModule();
        ModuleDescriptor memory d = ILadderModule(module).descriptor();
        if (d.inputs != TankScene.INPUTS || d.outputs != TankScene.ACTIONS) revert WrongShape(d.inputs, d.outputs);
        if (ILadderFactory(factory).depthOf(module) != 0) revert HasTools();
        address[] memory chunks = ILadderModule(module).chunks();
        uint256 weightBytes;
        for (uint256 k; k < chunks.length; k++) weightBytes += chunks[k].code.length - 1;   // the STOP byte is not a weight
        if (weightBytes > maxWeightBytes) revert TooLarge(weightBytes, maxWeightBytes);
        bytes32 key = keccak256(abi.encode(chunks));
        if (_byChunks[key] != address(0)) revert DuplicateWeights(_byChunks[key]);
        _byChunks[key] = module;
        _ranks.push(module);
        uint32 rank = uint32(_ranks.length);
        _entries[module] = EntryData(msg.sender, uint32(weightBytes), rank, 0, 0, 0);
        emit EntryRegistered(module, msg.sender, uint32(weightBytes), rank);
    }

    // ------------------------------------------------------------------------------------------------ challenges

    /// @notice Start a challenge of `challenger` against `defender` and play it as far as the gas goes.
    function challenge(address challenger, address defender) external returns (uint256 id) {
        uint256 g = gasleft();
        if (g < minStartGas) revert LowGas(g, minStartGas);
        if (msg.sender != tx.origin || tx.origin.code.length != 0) revert NotEoa();
        if (block.number >= endBlock) revert SeasonOver();
        EntryData storage c = _entries[challenger];
        EntryData storage d = _entries[defender];
        if (c.rank == 0 || d.rank == 0) revert NotEntered();
        if (c.owner != msg.sender) revert NotOwner();
        if (d.rank >= c.rank || c.rank - d.rank > range) revert OutOfRange();
        if (c.activeChallenge != 0) revert Busy();
        bytes32 pair = _pair(challenger, defender);
        if (block.number < _cooldownUntil[pair]) revert Cooldown(_cooldownUntil[pair]);
        _cooldownUntil[pair] = uint64(block.number + cooldownBlocks);
        id = ++challengeCount;
        c.activeChallenge = id;
        bytes32 seed = keccak256(abi.encode(block.prevrandao, id));
        ChallengeData storage ch = _challenges[id];
        ch.seed = seed;
        ch.head = uint256(uint160(challenger)) | (uint256(block.number) << 160) | (uint256(STATUS_PLAYING) << 224);
        TankScene.State memory s = TankScene.battle(_episodeSeed(seed, 0));
        ch.body = uint256(uint160(defender)) | (TankScene.packMeta(s) << 160);
        ch.cells = s.cells;
        emit ChallengeStarted(id, challenger, defender, seed, uint64(block.number));
        _play(id, ch);
    }

    /// @notice Play challenge `id` on until less than `reserveGas` gas is left or the challenge ends. Anyone.
    function advance(uint256 id) external {
        ChallengeData storage ch = _challenges[id];
        uint256 head = ch.head;
        if (uint8(head >> 224) != STATUS_PLAYING) revert NotPlaying();
        if (block.number > uint64(head >> 160) + timeoutBlocks) revert Expired();
        _play(id, ch);
    }

    /// @notice Settle challenge `id` as a defense, `timeoutBlocks` blocks after its start. Anyone.
    function expire(uint256 id) external {
        ChallengeData storage ch = _challenges[id];
        uint256 head = ch.head;
        if (uint8(head >> 224) != STATUS_PLAYING) revert NotPlaying();
        if (block.number <= uint64(head >> 160) + timeoutBlocks) revert NotExpired();
        _settle(id, ch, head, STATUS_EXPIRED);
    }

    /// @dev The seed of mirror pair `pair` of a challenge.
    function _episodeSeed(bytes32 seed, uint256 pair) private pure returns (uint32) {
        return uint32(uint256(keccak256(abi.encode(seed, pair))));
    }

    function _pair(address challenger, address defender) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(challenger, defender));
    }

    /// @dev Plays steps of `id` while at least `reserveGas` gas is left. The reserve holds one step (at most about
    ///      1.2M gas for two 大 networks), the save, the events and the settlement (about 5k gas per rank the
    ///      challenger climbs). Emits `Steps` per episode segment played here, `EpisodeEnded` per finished episode.
    function _play(uint256 id, ChallengeData storage ch) private {
        uint256 head = ch.head;
        uint256 body = ch.body;
        address challenger = address(uint160(head));
        address defender = address(uint160(body));
        uint256 episode = uint8(head >> 232);
        TankScene.State memory s = TankScene.unpack(body >> 160, ch.cells);
        bytes memory actions = new bytes(TankScene.STEPS);
        uint256 played;
        uint8 fromStep = s.t;
        // the call buffer of forward(bytes): selector, offset, length, 572 bytes padded to 576
        bytes memory buf = new bytes(4 + 32 + 32 + 576);
        uint256 scores;
        assembly ("memory-safe") {
            mstore(add(buf, 32), shl(224, 0xd948d468))   // forward(bytes)
            mstore(add(buf, 36), 32)
            mstore(add(buf, 68), 572)
            scores := mload(0x40)
            mstore(0x40, add(scores, 320))
        }
        uint256 reserve = reserveGas;
        bool settled;
        while (gasleft() >= reserve) {
            bool swapped = episode % 2 == 1;
            uint8 a0 = _decide(swapped ? defender : challenger, s, 0, buf, scores);
            uint8 a1 = _decide(swapped ? challenger : defender, s, 1, buf, scores);
            actions[played++] = bytes1(a0 * 9 + a1);
            TankScene.play(s, a0, a1);
            if (s.end < 0) continue;
            assembly ("memory-safe") { mstore(actions, played) }
            emit Steps(id, uint8(episode), fromStep, actions);
            emit EpisodeEnded(id, uint8(episode), s.end, s.t);
            // the winner of the episode: side 0 is the challenger in even episodes
            if (s.end == 0 || s.end == 1) {
                bool challengerWon = (s.end == 0) != swapped;
                head += challengerWon ? (uint256(1) << 240) : (uint256(1) << 248);
            }
            episode++;
            head = (head & ~(uint256(0xff) << 232)) | (episode << 232);
            if (episode == EPISODES) { settled = true; break; }
            s = TankScene.battle(_episodeSeed(ch.seed, episode / 2));
            assembly ("memory-safe") { mstore(actions, 100) }
            played = 0;
            fromStep = 0;
        }
        if (settled) {
            _settle(id, ch, head, uint8(head >> 240) > uint8(head >> 248) || (uint8(head >> 240) == uint8(head >> 248) && _lighter(challenger, defender)) ? STATUS_CHALLENGER_WON : STATUS_DEFENSE);
            return;
        }
        if (played != 0) {
            assembly ("memory-safe") { mstore(actions, played) }
            emit Steps(id, uint8(episode), fromStep, actions);
        }
        if (head != ch.head) ch.head = head;
        ch.body = uint256(uint160(defender)) | (TankScene.packMeta(s) << 160);
        ch.cells = s.cells;
    }

    /// @dev The action of `module` for `side` of `s`: its 9 scores from the rest state, the first maximum. `buf` is
    ///      the call buffer (its input bytes are cleared here), `scores` a 320-byte scratch.
    function _decide(address module, TankScene.State memory s, uint256 side, bytes memory buf, uint256 scores) private view returns (uint8 best) {
        uint256 input;
        assembly ("memory-safe") {
            input := add(buf, 100)
            for { let k := 0 } lt(k, 576) { k := add(k, 32) } { mstore(add(input, k), 0) }
        }
        TankScene.fillInput(s, side, input);
        bool ok;
        assembly ("memory-safe") {
            ok := staticcall(gas(), module, add(buf, 32), 644, scores, 32)
            if ok {
                let at := mload(scores)                          // where the scores array starts
                ok := and(gt(returndatasize(), add(at, 319)), lt(at, returndatasize()))
                if ok {
                    returndatacopy(scores, at, 320)
                    ok := eq(mload(scores), 9)
                    let top := mload(add(scores, 32))
                    for { let k := 1 } lt(k, 9) { k := add(k, 1) } {
                        let v := mload(add(scores, add(32, mul(k, 32))))
                        if sgt(v, top) { top := v best := k }
                    }
                }
            }
        }
        if (!ok) revert ForwardFailed(module);
    }

    /// @dev Whether the challenger's weight size is at most (1 − δ) of the defender's.
    function _lighter(address challenger, address defender) private view returns (bool) {
        return uint256(_entries[challenger].weightBytes) * 10000 <= uint256(_entries[defender].weightBytes) * (10000 - deltaBps);
    }

    /// @dev Records `status` of challenge `id`, counts the win and the loss, moves the ranks when the challenger won.
    function _settle(uint256 id, ChallengeData storage ch, uint256 head, uint8 status) private {
        address challenger = address(uint160(head));
        address defender = address(uint160(ch.body));
        ch.head = (head & ~(uint256(0xff) << 224)) | (uint256(status) << 224);
        EntryData storage c = _entries[challenger];
        EntryData storage d = _entries[defender];
        c.activeChallenge = 0;
        uint32 newRank = c.rank;
        if (status == STATUS_CHALLENGER_WON) {
            c.wins++;
            d.losses++;
            // the defender is above the challenger: every rank change keeps the order of two entries, except for a
            // winner that climbs, and the challenger climbs only here
            newRank = d.rank;
            for (uint256 r = c.rank - 1; r > newRank - 1; r--) {
                address below = _ranks[r - 1];
                _ranks[r] = below;
                _entries[below].rank = uint32(r + 1);
            }
            _ranks[newRank - 1] = challenger;
            c.rank = newRank;
        } else {
            d.wins++;
            c.losses++;
        }
        emit ChallengeSettled(id, status, uint8(head >> 240), uint8(head >> 248), newRank);
    }

    // ------------------------------------------------------------------------------------------------ views

    function entryCount() external view returns (uint256) { return _ranks.length; }

    /// @notice The module at `rank` (1-based).
    function entryAt(uint256 rank) external view returns (address) {
        if (rank == 0 || rank > _ranks.length) revert BadRank();
        return _ranks[rank - 1];
    }

    /// @notice The owner of entry `module`, address(0) when it is not entered.
    function entryOwner(address module) external view returns (address) { return _entries[module].owner; }

    function entry(address module) public view returns (Entry memory) {
        EntryData storage e = _entries[module];
        return Entry(module, e.owner, e.weightBytes, e.rank, e.wins, e.losses, e.activeChallenge);
    }

    /// @notice Up to `count` entries from `fromRank` (1-based) on, in rank order.
    function entries(uint256 fromRank, uint256 count) external view returns (Entry[] memory out) {
        if (fromRank == 0) revert BadRank();
        uint256 n = _ranks.length;
        uint256 end = fromRank - 1 + count;
        if (end > n) end = n;
        out = new Entry[](end >= fromRank - 1 ? end - (fromRank - 1) : 0);
        for (uint256 k; k < out.length; k++) out[k] = entry(_ranks[fromRank - 1 + k]);
    }

    function challengeInfo(uint256 id) external view returns (ChallengeInfo memory info) {
        ChallengeData storage ch = _challenges[id];
        uint256 head = ch.head;
        uint256 body = ch.body;
        info.challenger = address(uint160(head));
        info.defender = address(uint160(body));
        info.seed = ch.seed;
        info.startBlock = uint64(head >> 160);
        info.deadline = info.startBlock + timeoutBlocks;
        info.status = uint8(head >> 224);
        info.episode = uint8(head >> 232);
        info.step = info.episode < EPISODES ? uint8((body >> 160) >> 32) : 0;   // a settled challenge keeps its last saved position
        info.challengerWins = uint8(head >> 240);
        info.defenderWins = uint8(head >> 248);
    }

    /// @notice The first block in which `challenger` can challenge `defender` again (0 = never challenged).
    function cooldownUntil(address challenger, address defender) external view returns (uint64) {
        return _cooldownUntil[_pair(challenger, defender)];
    }
}
