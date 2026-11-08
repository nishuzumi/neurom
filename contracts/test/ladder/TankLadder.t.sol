// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./LadderBase.sol";

/// The ladder through its external functions: what registration refuses, who can start a challenge, how the ranks
/// move, δ, the range, the cooldown, the timeout, the season and the gas reserve. The fixture modules 中 and 大 play
/// real episodes. The tiny modules (zero weights, every action 0) play drawn episodes of 100 steps, so their
/// challenges are decided by δ alone: with δ = 0 the lighter or equal challenger wins, the heavier loses.
contract TankLadderTest is LadderBase {
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    TankLadder ladder;

    function setUp() public override {
        super.setUp();
        ladder = newLadder();
    }

    /// `module` registered on `l` by `owner` (an EOA).
    function enter(TankLadder l, address owner, address module) internal {
        vm.prank(owner, owner);
        l.register(module);
    }
    function enter(address owner, address module) internal { enter(ladder, owner, module); }

    /// `challenger` challenges `defender` as `owner` with a 30M transaction → the id.
    function start(address owner, address challenger, address defender) internal returns (uint256 id) {
        vm.prank(owner, owner);
        id = ladder.challenge{gas: GAS_LIMIT}(challenger, defender);
    }

    function rankOf(address module) internal view returns (uint256) { return ladder.entry(module).rank; }

    /// The modules on the board of `l` in rank order.
    function boardOf(TankLadder l) internal view returns (address[] memory out) {
        TankLadder.Entry[] memory es = l.board();
        out = new address[](es.length);
        for (uint256 k; k < es.length; k++) { require(es[k].rank == k + 1, "board ranks"); out[k] = es[k].module; }
    }

    /// The `newRank` of the last `ChallengeSettled` in `logs`.
    function settledRank(IVm.Log[] memory logs) internal pure returns (uint32 newRank) {
        for (uint256 i; i < logs.length; i++) if (logs[i].topics[0] == SETTLED_SIG) (,,, newRank) = abi.decode(logs[i].data, (uint8, uint8, uint8, uint32));
    }

    /// The steps played of challenge `id` over all its episodes (an episode counts 100 once it ended).
    function progress(uint256 id) internal view returns (uint256) {
        TankLadder.ChallengeInfo memory info = ladder.challengeInfo(id);
        return uint256(info.step) + 100 * uint256(info.episode);
    }

    /// The default ladder with another δ, range, board and season end. With δ = 0 a tiny challenger of equal size wins.
    function ladderWith(uint16 deltaBps, uint8 range_, uint8 boardSize, uint64 endBlock) internal returns (TankLadder) {
        TankLadder.Config memory c = defaultConfig();
        c.deltaBps = deltaBps; c.range = range_; c.boardSize = boardSize; c.endBlock = endBlock;
        return new TankLadder(c);
    }

    /// A ladder with δ = 0 and the default board, range and season.
    function zeroDelta() internal returns (TankLadder) { return ladderWith(0, 10, 20, type(uint64).max); }

    // ------------------------------------------------------------------------------------------------ registration

    function testConfigIsReadable() public view {
        TankLadder.Config memory c = ladder.config();
        require(c.factory == address(factory) && c.maxWeightBytes == 216_864 && c.deltaBps == 1000 && c.range == 10 && c.boardSize == 20, "config");
        require(c.timeoutBlocks == 400 && c.cooldownBlocks == 6000 && c.minStartGas == 24_000_000 && c.reserveGas == 2_000_000 && c.endBlock == type(uint64).max, "config");
    }

    function testConstructorRefusesABadConfig() public {
        TankLadder.Config memory c = defaultConfig();
        c.factory = address(0xdead);
        vm.expectRevert(TankLadder.BadConfig.selector);
        new TankLadder(c);
        c = defaultConfig(); c.deltaBps = 10_001;
        vm.expectRevert(TankLadder.BadConfig.selector);
        new TankLadder(c);
        c = defaultConfig(); c.range = 0;
        vm.expectRevert(TankLadder.BadConfig.selector);
        new TankLadder(c);
        c = defaultConfig(); c.boardSize = 0;
        vm.expectRevert(TankLadder.BadConfig.selector);
        new TankLadder(c);
    }

    /// A new entry takes the last rank. An account enters several entries. The views read owner, size and rank.
    function testRegisterAppendsAtTheLastRank() public {
        vm.recordLogs();
        enter(alice, mid);
        enter(alice, big);
        address t = tiny(1);
        enter(bob, t);
        address[] memory b = boardOf(ladder);
        require(ladder.entryCount() == 3 && b.length == 3 && b[0] == mid && b[1] == big && b[2] == t, "ranks");
        require(ladder.entryOwner(mid) == alice && ladder.entryOwner(big) == alice && ladder.entryOwner(t) == bob, "owners");
        require(ladder.entryOwner(address(0x1234)) == address(0), "not entered: no owner");
        require(ladder.entry(address(0x1234)).owner == address(0) && ladder.entry(address(0x1234)).rank == 0, "not entered: no entry");
        TankLadder.Entry memory e = ladder.entry(big);
        require(e.module == big && e.owner == alice && e.weightBytes == bigBytes && e.rank == 2 && e.wins == 0 && e.losses == 0 && e.activeChallenge == 0, "entry");
        require(ladder.entry(mid).weightBytes == midBytes && ladder.entry(t).weightBytes == 18_400, "weight sizes");
        TankLadder.Entry[] memory es = ladder.entries(1, 10);
        require(es.length == 2 && es[0].module == big && es[1].rank == 3, "entries from index 1");
        require(ladder.entries(3, 10).length == 0 && ladder.entries(0, 1).length == 1 && ladder.entries(1, type(uint256).max).length == 2, "entries at the end");
        IVm.Log[] memory logs = vm.getRecordedLogs();
        uint256 registered;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(ladder)) continue;
            require(logs[i].topics[0] == keccak256("EntryRegistered(address,address,uint32,uint32)"), "only EntryRegistered");
            (uint32 weightBytes, uint32 rank) = abi.decode(logs[i].data, (uint32, uint32));
            registered++;
            require(rank == registered && address(uint160(uint256(logs[i].topics[1]))) == b[rank - 1] && weightBytes == ladder.entry(b[rank - 1]).weightBytes, "event");
        }
        require(registered == 3, "three events");
    }

    /// When the board is full, a new entry stays off it: rank 0 in the event and the views, and it counts as entered.
    function testAFullBoardKeepsNewEntriesOffIt() public {
        TankLadder small = ladderWith(0, 2, 3, type(uint64).max);
        address[] memory t = new address[](5);
        vm.recordLogs();
        for (uint256 k; k < 5; k++) { t[k] = tiny(uint8(k + 1)); enter(small, alice, t[k]); }
        address[] memory b = boardOf(small);
        require(b.length == 3 && b[0] == t[0] && b[1] == t[1] && b[2] == t[2], "the first 3 fill the board");
        require(small.entryCount() == 5 && small.entry(t[3]).rank == 0 && small.entry(t[4]).owner == alice, "the others are entered off the board");
        TankLadder.Entry[] memory es = small.entries(0, 10);
        for (uint256 k; k < 5; k++) require(es[k].module == t[k] && es[k].rank == (k < 3 ? k + 1 : 0), "entries in the order of registration");
        IVm.Log[] memory logs = vm.getRecordedLogs();
        (, uint32 lastRank) = abi.decode(logs[logs.length - 1].data, (uint32, uint32));
        require(lastRank == 0, "the event says off the board");
        vm.expectRevert(TankLadder.AlreadyEntered.selector);
        enter(small, bob, t[4]);
    }

    /// An entry off the board challenges as the rank below the last: ranks 2 and 3 of a board of 3 with range 2.
    /// When it wins, it takes the defender's rank and the last entry leaves the board. That entry can come back.
    function testAnEntryOffTheBoardPushesTheLastOneOff() public {
        TankLadder small = ladderWith(0, 2, 3, type(uint64).max);
        address[] memory t = new address[](5);
        for (uint256 k; k < 5; k++) { t[k] = tiny(uint8(k + 1)); enter(small, alice, t[k]); }
        vm.startPrank(alice, alice);
        vm.expectRevert(TankLadder.OutOfRange.selector);
        small.challenge{gas: GAS_LIMIT}(t[3], t[0]);            // rank 1 is 3 ranks above
        vm.expectRevert(TankLadder.OutOfRange.selector);
        small.challenge{gas: GAS_LIMIT}(t[3], t[4]);            // both off the board
        vm.expectRevert(TankLadder.OutOfRange.selector);
        small.challenge{gas: GAS_LIMIT}(t[0], t[3]);            // the defender is off the board
        vm.recordLogs();
        uint256 id = small.challenge{gas: GAS_LIMIT}(t[3], t[1]);
        vm.stopPrank();
        settle(small, id);
        require(small.challengeInfo(id).status == 2 && settledRank(vm.getRecordedLogs()) == 2, "won rank 2");
        address[] memory b = boardOf(small);
        require(b.length == 3 && b[0] == t[0] && b[1] == t[3] && b[2] == t[1], "t1 moves down, t2 leaves the board");
        require(small.entry(t[2]).rank == 0 && small.entryCount() == 5, "t2 is off the board, still entered");
        // t2 comes back: it takes rank 3, and t1 leaves the board
        vm.prank(alice, alice);
        id = small.challenge{gas: GAS_LIMIT}(t[2], t[1]);
        settle(small, id);
        b = boardOf(small);
        require(b[0] == t[0] && b[1] == t[3] && b[2] == t[2] && small.entry(t[1]).rank == 0, "t2 back at rank 3");
    }

    /// A defender that leaves the board before the settlement has its challenger off the board too. The challenger
    /// wins the challenge, but no rank changes, and `newRank` is 0.
    function testADefenderOffTheBoardAtTheSettlementChangesNoRank() public {
        TankLadder small = ladderWith(0, 2, 3, type(uint64).max);
        address[] memory t = new address[](5);
        address[5] memory owners = [alice, bob, carol, address(0xD), address(0xE)];
        for (uint256 k; k < 5; k++) { t[k] = tiny(uint8(k + 1)); enter(small, owners[k], t[k]); }
        vm.prank(owners[4], owners[4]); uint256 a = small.challenge{gas: GAS_LIMIT}(t[4], t[2]);    // off against rank 3
        vm.prank(owners[3], owners[3]); uint256 b = small.challenge{gas: GAS_LIMIT}(t[3], t[1]);    // off against rank 2
        settle(small, b);                                                                           // t2 leaves the board
        require(small.entry(t[2]).rank == 0, "the defender of a is off the board");
        vm.recordLogs();
        settle(small, a);
        require(small.challengeInfo(a).status == 2 && settledRank(vm.getRecordedLogs()) == 0, "won, still off the board");
        address[] memory board = boardOf(small);
        require(board[0] == t[0] && board[1] == t[3] && board[2] == t[1], "no rank changes");
        require(small.entry(t[4]).wins == 1 && small.entry(t[2]).losses == 1, "counted");
    }

    function testRegisterRefusesAModuleOfAnotherFactory() public {
        Roles otherRoles = new Roles();
        ModuleFactory other = ModuleFactory(address(new FactoryProxy(address(new ModuleFactory(address(otherRoles))), abi.encodeCall(ModuleFactory.initialize, ()))));
        other.addVersion(DENSE, dense); other.setLatest(DENSE, dense);
        (ModuleFactory.ModuleSpec memory spec, bytes[] memory data) = tinySpec(572, 1, 9, 7, keccak256("elsewhere"));
        address elsewhere = other.deploy(spec, data);
        vm.expectRevert(TankLadder.NotOfficialModule.selector);
        enter(alice, elsewhere);
        vm.expectRevert(TankLadder.NotOfficialModule.selector);
        enter(alice, address(this));
        vm.expectRevert(TankLadder.NotOfficialModule.selector);
        enter(alice, address(0));
    }

    function testRegisterRefusesAnotherShape() public {
        address fewInputs = tiny(571, 1, 9, 1);
        vm.expectRevert(abi.encodeWithSelector(TankLadder.WrongShape.selector, uint16(571), uint16(9)));
        enter(alice, fewInputs);
        address manyOutputs = tiny(572, 1, 10, 1);
        vm.expectRevert(abi.encodeWithSelector(TankLadder.WrongShape.selector, uint16(572), uint16(10)));
        enter(alice, manyOutputs);
    }

    /// The maximum is a configuration. 大 is exactly at the default maximum.
    function testRegisterRefusesAboveTheMaximumWeightSize() public {
        TankLadder.Config memory c = defaultConfig();
        c.maxWeightBytes = uint32(bigBytes - 1);
        TankLadder small = new TankLadder(c);
        enter(small, alice, mid);
        vm.expectRevert(abi.encodeWithSelector(TankLadder.TooLarge.selector, bigBytes, bigBytes - 1));
        enter(small, alice, big);
        enter(alice, big);
        require(ladder.entry(big).weightBytes == 216_864, "at the maximum");
    }

    /// A second module with the same chunks is a copy, whoever deployed it. A twin with one other byte is not.
    function testRegisterRefusesTheSameWeights() public {
        enter(alice, mid);
        address copy = deployFixtureModule("mid", keccak256("copy"));
        require(copy != mid, "another module");
        vm.expectRevert(abi.encodeWithSelector(TankLadder.DuplicateWeights.selector, mid));
        enter(bob, copy);
        vm.expectRevert(TankLadder.AlreadyEntered.selector);
        enter(bob, mid);
        enter(bob, deployFixtureTwin("mid", keccak256("twin")));
        require(ladder.entryCount() == 2, "the twin entered");
    }

    function testRegisterRefusesAModuleWithTools() public {
        address sel = selector(3);
        require(factory.depthOf(sel) == 1, "depth 1");
        vm.expectRevert(TankLadder.HasTools.selector);
        enter(alice, sel);
    }

    function testRegisterRefusesAfterTheSeason() public {
        TankLadder season = ladderWith(1000, 10, 20, uint64(block.number + 5));
        enter(season, alice, mid);
        vm.roll(block.number + 5);
        vm.expectRevert(TankLadder.SeasonOver.selector);
        enter(season, alice, big);
    }

    // ------------------------------------------------------------------------------------------------ who can start

    function testChallengeNeedsAnEoaWithoutCode() public {
        enter(alice, big);
        enter(alice, mid);
        // a contract: msg.sender is not tx.origin
        Wrapper w = new Wrapper();
        vm.prank(alice, alice);
        vm.expectRevert(TankLadder.NotEoa.selector);
        w.go{gas: GAS_LIMIT}(address(ladder), abi.encodeCall(ladder.challenge, (mid, big)));
        // this test contract calling directly
        vm.expectRevert(TankLadder.NotEoa.selector);
        ladder.challenge{gas: GAS_LIMIT}(mid, big);
        // an EIP-7702 account: the delegation designator is its code (23 bytes)
        vm.etch(alice, abi.encodePacked(hex"ef0100", address(w)));
        require(alice.code.length == 23, "designator");
        vm.prank(alice, alice);
        vm.expectRevert(TankLadder.NotEoa.selector);
        ladder.challenge{gas: GAS_LIMIT}(mid, big);
        vm.etch(alice, "");
        // the plain EOA
        uint256 id = start(alice, mid, big);
        require(id == 1 && ladder.challengeInfo(1).status == 1, "started");
    }

    /// An account with a real signed EIP-7702 delegation (the cheatcodes of Foundry attach it) is refused too.
    function testChallengeRefusesADelegatedAccount() public {
        uint256 key = 0xA11CE;
        address delegated = vm.addr(key);
        enter(delegated, big);
        enter(delegated, mid);
        Wrapper w = new Wrapper();
        vm.attachDelegation(vm.signDelegation(address(w), key));
        require(delegated.code.length == 23, "delegated");
        vm.prank(delegated, delegated);
        vm.expectRevert(TankLadder.NotEoa.selector);
        ladder.challenge{gas: GAS_LIMIT}(mid, big);
    }

    function testChallengeNeedsTheMinimumGas() public {
        enter(alice, big);
        enter(alice, mid);
        vm.prank(alice, alice);
        vm.expectPartialRevert(TankLadder.LowGas.selector);
        ladder.challenge{gas: 23_000_000}(mid, big);
        vm.prank(alice, alice);
        ladder.challenge{gas: 24_100_000}(mid, big);
        require(ladder.challengeInfo(1).status == 1, "started with the gas");
    }

    function testChallengeChecksOwnerEntriesAndRange() public {
        address[] memory t = new address[](12);
        for (uint256 k; k < 12; k++) { t[k] = tiny(uint8(k + 1)); enter(k < 6 ? alice : bob, t[k]); }
        // not entered
        address stranger = tiny(99);
        vm.prank(bob, bob);
        vm.expectRevert(TankLadder.NotEntered.selector);
        ladder.challenge{gas: GAS_LIMIT}(stranger, t[0]);
        vm.prank(bob, bob);
        vm.expectRevert(TankLadder.NotEntered.selector);
        ladder.challenge{gas: GAS_LIMIT}(t[11], stranger);
        // not the owner
        vm.prank(bob, bob);
        vm.expectRevert(TankLadder.NotOwner.selector);
        ladder.challenge{gas: GAS_LIMIT}(t[5], t[0]);
        // the range: rank 12 can challenge ranks 2..11, not 1, not itself, not below
        vm.prank(bob, bob);
        vm.expectRevert(TankLadder.OutOfRange.selector);
        ladder.challenge{gas: GAS_LIMIT}(t[11], t[0]);
        vm.prank(bob, bob);
        vm.expectRevert(TankLadder.OutOfRange.selector);
        ladder.challenge{gas: GAS_LIMIT}(t[11], t[11]);
        vm.prank(bob, bob);
        vm.expectRevert(TankLadder.OutOfRange.selector);
        ladder.challenge{gas: GAS_LIMIT}(t[10], t[11]);
        uint256 id = start(bob, t[11], t[1]);
        require(ladder.challengeInfo(id).challenger == t[11] && ladder.challengeInfo(id).defender == t[1], "rank 12 against rank 2");
    }

    function testOneActiveChallengePerChallengerManyPerDefender() public {
        address a = tiny(1); address b = tiny(2); address c = tiny(3);
        enter(alice, a); enter(bob, b); enter(carol, c);
        uint256 id = start(bob, b, a);
        require(ladder.entry(b).activeChallenge == id && ladder.entry(a).activeChallenge == 0, "the challenger is busy, not the defender");
        vm.prank(bob, bob);
        vm.expectRevert(TankLadder.Busy.selector);
        ladder.challenge{gas: GAS_LIMIT}(b, a);
        uint256 id2 = start(carol, c, a);
        require(id2 == id + 1, "a second challenge of the same defender");
        vm.prank(carol, carol);
        vm.expectRevert(TankLadder.Busy.selector);
        ladder.challenge{gas: GAS_LIMIT}(c, b);
        require(ladder.entry(c).activeChallenge == id2 && ladder.entry(a).activeChallenge == 0, "busy with its own challenge");
    }

    // ------------------------------------------------------------------------------------------------ playing

    /// The first transaction plays, `advance` by anyone continues, the last one settles with the events.
    function testAChallengePlaysSixEpisodesAndSettles() public {
        enter(alice, big);
        enter(bob, mid);
        vm.roll(100);
        vm.recordLogs();
        uint256 id = start(bob, mid, big);
        TankLadder.ChallengeInfo memory info = ladder.challengeInfo(id);
        require(info.status == 1 && info.startBlock == 100 && info.deadline == 500 && info.episode + info.step > 0, "played in the first transaction");
        require(info.seed == keccak256(abi.encode(block.prevrandao, id)), "the seed");
        uint256 transactions = settle(ladder, id);
        info = ladder.challengeInfo(id);
        require(info.episode == 6 && info.status != 1, "settled");
        // 中 is lighter than 大 by more than δ: it wins with as many episodes as 大, and loses with fewer
        bool won = info.challengerWins >= info.defenderWins;
        require(info.status == (won ? 2 : 3), "the status follows the score and delta");
        require(rankOf(mid) == (won ? 1 : 2) && rankOf(big) == (won ? 2 : 1) && boardOf(ladder)[0] == (won ? mid : big), "the ranks follow");
        require(ladder.entry(won ? mid : big).wins == 1 && ladder.entry(won ? big : mid).losses == 1 && ladder.entry(mid).activeChallenge == 0, "counted");
        IVm.Log[] memory logs = vm.getRecordedLogs();
        uint256 started; uint256 episodes; uint256 settled; uint256 steps; uint256 episodeSteps;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(ladder)) continue;
            bytes32 sig = logs[i].topics[0];
            if (sig == keccak256("ChallengeStarted(uint256,address,address,bytes32,uint64)")) {
                (bytes32 seed, uint64 startBlock) = abi.decode(logs[i].data, (bytes32, uint64));
                require(uint256(logs[i].topics[1]) == id && address(uint160(uint256(logs[i].topics[2]))) == mid && address(uint160(uint256(logs[i].topics[3]))) == big && seed == info.seed && startBlock == 100, "started");
                started++;
            } else if (sig == EPISODE_ENDED_SIG) {
                (uint8 episode, int8 end, uint8 n) = abi.decode(logs[i].data, (uint8, int8, uint8));
                require(episode == episodes && end >= 0 && end <= 2 && n >= 1 && n <= 100, "episodes in order, each with an end");
                episodes++;
                episodeSteps += n;
            } else if (sig == STEPS_SIG) {
                (,, bytes memory acts) = abi.decode(logs[i].data, (uint8, uint8, bytes));
                for (uint256 k; k < acts.length; k++) require(uint8(acts[k]) < 81, "a0 * 9 + a1");
                steps += acts.length;
            } else if (sig == SETTLED_SIG) {
                (uint8 status, uint8 cw, uint8 dw, uint32 newRank) = abi.decode(logs[i].data, (uint8, uint8, uint8, uint32));
                require(status == info.status && cw == info.challengerWins && dw == info.defenderWins && newRank == rankOf(mid), "settled");
                settled++;
            }
        }
        require(started == 1 && episodes == 6 && settled == 1 && steps == episodeSteps, "events");
        require(transactions >= 2 && transactions <= 16, "at most 13 transactions of 30M for mid against big");
        vm.expectRevert(TankLadder.NotPlaying.selector);
        ladder.advance(id);
        vm.expectRevert(TankLadder.NotPlaying.selector);
        ladder.expire(id);
    }

    /// Every transaction of 30M plays many steps: the reserve of 2M is not wasteful. 大 against 大 is the worst.
    function testATransactionPlaysManySteps() public {
        address twin = deployFixtureTwin("big", keccak256("twin"));
        enter(alice, big);
        enter(bob, twin);
        vm.recordLogs();
        start(bob, twin, big);
        IVm.Log[] memory logs = vm.getRecordedLogs();
        uint256 steps;
        for (uint256 i; i < logs.length; i++) if (logs[i].emitter == address(ladder) && logs[i].topics[0] == STEPS_SIG) { (,, bytes memory acts) = abi.decode(logs[i].data, (uint8, uint8, bytes)); steps += acts.length; }
        require(steps >= 24, "at least 24 steps of big against big in 30M");
        Console.log("big vs big: steps in the first 30M transaction", steps);
    }

    /// No seed and no gas limit above the reserve makes a play transaction run out of gas: a transaction with just
    /// enough gas for the entry plays nothing and saves, a transaction with gas for one step plays one step.
    /// forge-config: default.fuzz.runs = 24
    function testFuzzNoSeedRunsOutOfGas(bytes32 prevrandao, uint32 extra) public {
        address twin = deployFixtureTwin("big", keccak256("twin"));
        enter(alice, big);
        enter(bob, twin);
        vm.prevrandao(prevrandao);
        uint256 id = start(bob, twin, big);
        uint256 before = progress(id);
        // from the reserve plus the entry's own cost up to one step more
        ladder.advance{gas: 2_050_000 + (uint256(extra) % 1_500_000)}(id);
        require(ladder.challengeInfo(id).status == 1 && progress(id) >= before, "saved");
        ladder.advance{gas: GAS_LIMIT}(id);
        require(progress(id) > before + 20, "played on");
    }

    /// `advance` is open to anyone, and the result is the same whoever calls: two ladders with the same seed, one
    /// played by the challenger, one by this contract and a stranger, settle the same episodes.
    function testAdvanceByAnyoneGivesTheSameResult() public {
        address twin = deployFixtureTwin("mid", keccak256("twin"));
        TankLadder other = newLadder();
        enter(alice, mid); enter(bob, twin);
        enter(other, alice, mid); enter(other, bob, twin);
        vm.prevrandao(keccak256("same"));
        uint256 id = start(bob, twin, mid);
        vm.prank(bob, bob);
        uint256 id2 = other.challenge{gas: GAS_LIMIT}(twin, mid);
        while (ladder.challengeInfo(id).status == 1) { vm.prank(bob, bob); ladder.advance{gas: GAS_LIMIT}(id); }
        uint256 k;
        while (other.challengeInfo(id2).status == 1) { if (k++ % 2 == 0) other.advance{gas: GAS_LIMIT}(id2); else { vm.prank(carol, carol); other.advance{gas: 20_000_000}(id2); } }
        TankLadder.ChallengeInfo memory a = ladder.challengeInfo(id);
        TankLadder.ChallengeInfo memory b = other.challengeInfo(id2);
        require(a.seed == b.seed && a.status == b.status && a.challengerWins == b.challengerWins && a.defenderWins == b.defenderWins, "the same result");
    }

    // ------------------------------------------------------------------------------------------------ ranks and δ

    /// Equal episodes: the challenger wins only when its weight size is at most (1 − δ) of the defender's.
    function testDeltaDecidesEqualEpisodes() public {
        // tiny modules: 572 → 1 → 9 = 18,400 bytes, 572 → 2 → 9 = 18,432 bytes (every episode a draw)
        address light = tiny(572, 1, 9, 1);
        address heavy = tiny(572, 2, 9, 2);
        address light2 = tiny(572, 1, 9, 3);
        // δ = 10%: 18,400 is not 10% below 18,432, so the lighter one defends against the heavier
        enter(alice, heavy); enter(bob, light);
        uint256 id = start(bob, light, heavy);
        settle(ladder, id);
        require(ladder.challengeInfo(id).status == 3 && rankOf(heavy) == 1 && rankOf(light) == 2, "a defense: within delta");
        require(ladder.entry(heavy).wins == 1 && ladder.entry(light).losses == 1, "counted as a defense");
        // δ = 0: a challenger of at most the defender's size wins equal episodes; a heavier one does not
        TankLadder zero = zeroDelta();
        enter(zero, alice, heavy); enter(zero, bob, light); enter(zero, carol, light2);
        vm.prank(bob, bob);
        id = zero.challenge{gas: GAS_LIMIT}(light, heavy);
        settle(zero, id);
        require(zero.challengeInfo(id).status == 2 && zero.entry(light).rank == 1 && zero.entry(heavy).rank == 2, "the lighter one won");
        vm.prank(carol, carol);
        id = zero.challenge{gas: GAS_LIMIT}(light2, light);
        settle(zero, id);
        require(zero.challengeInfo(id).status == 2 && zero.entry(light2).rank == 1 && zero.entry(light).rank == 2, "an equal one won");
        vm.prank(alice, alice);
        id = zero.challenge{gas: GAS_LIMIT}(heavy, light);
        settle(zero, id);
        require(zero.challengeInfo(id).status == 3 && zero.entry(heavy).rank == 3, "the heavier one lost");
        // δ = 10% with a real difference: 中 (39,840) against 大 (216,864) wins with as many episodes, 大 against 中
        // wins only with more episodes (the fixture seed of the parity corpus: every episode is a draw)
        enter(alice, big); enter(bob, mid);
        vm.prevrandao(keccak256("ladder-mid-big"));
        id = start(bob, mid, big);
        settle(ladder, id);
        TankLadder.ChallengeInfo memory info = ladder.challengeInfo(id);
        bool midWon = info.challengerWins >= info.defenderWins;
        require(info.status == (midWon ? 2 : 3) && rankOf(mid) == (midWon ? 3 : 4), "mid wins equal episodes");
        if (!midWon) return;
        id = start(alice, big, mid);
        settle(ladder, id);
        info = ladder.challengeInfo(id);
        require(info.status == (info.challengerWins > info.defenderWins ? 2 : 3), "big needs more episodes");
    }

    /// A success moves the challenger to the defender's rank; the defender and the entries between move down one.
    function testASuccessShiftsTheRanksBetween() public {
        TankLadder zero = zeroDelta();
        address[] memory t = new address[](6);
        for (uint256 k; k < 6; k++) { t[k] = tiny(uint8(k + 1)); enter(zero, alice, t[k]); }
        vm.prank(alice, alice);
        uint256 id = zero.challenge{gas: GAS_LIMIT}(t[5], t[1]);        // rank 6 against rank 2
        settle(zero, id);
        require(zero.challengeInfo(id).status == 2, "won (equal size, delta 0)");
        address[6] memory want = [t[0], t[5], t[1], t[2], t[3], t[4]];
        address[] memory b = boardOf(zero);
        for (uint256 r; r < 6; r++) require(b[r] == want[r] && zero.entry(want[r]).rank == r + 1, "order after the success");
        TankLadder.Entry[] memory es = zero.entries(0, 6);
        for (uint256 k; k < 6; k++) require(es[k].module == t[k] && es[k].rank == zero.entry(t[k]).rank, "entries view: the order of registration");
    }

    /// Concurrent challenges: the defender stays above its challenger until that challenge succeeds, so every
    /// settlement inserts at the defender's rank of that moment.
    function testConcurrentChallengesSettleInOrder() public {
        TankLadder zero = zeroDelta();
        address[] memory t = new address[](5);
        address[5] memory owners = [alice, bob, carol, address(0xD), address(0xE)];
        for (uint256 k; k < 5; k++) { t[k] = tiny(uint8(k + 1)); enter(zero, owners[k], t[k]); }
        // rank 4 challenges rank 2, rank 5 challenges rank 2, rank 3 challenges rank 1; all three win (equal sizes)
        vm.prank(owners[3], owners[3]); uint256 a = zero.challenge{gas: GAS_LIMIT}(t[3], t[1]);
        vm.prank(owners[4], owners[4]); uint256 b = zero.challenge{gas: GAS_LIMIT}(t[4], t[1]);
        vm.prank(owners[2], owners[2]); uint256 c = zero.challenge{gas: GAS_LIMIT}(t[2], t[0]);
        // c settles first: t2 takes rank 1 → t2 t0 t1 t3 t4
        settle(zero, c);
        require(zero.entry(t[2]).rank == 1 && zero.entry(t[0]).rank == 2 && zero.entry(t[1]).rank == 3 && zero.entry(t[3]).rank == 4 && zero.entry(t[4]).rank == 5, "after c");
        // b settles: t4 (rank 5) takes t1's rank of now, 3 → t2 t0 t4 t1 t3
        settle(zero, b);
        require(zero.entry(t[4]).rank == 3 && zero.entry(t[1]).rank == 4 && zero.entry(t[3]).rank == 5, "after b");
        // a settles: t3 (rank 5) takes t1's rank of now, 4 → t2 t0 t4 t3 t1
        settle(zero, a);
        address[5] memory want = [t[2], t[0], t[4], t[3], t[1]];
        address[] memory order = boardOf(zero);
        for (uint256 r; r < 5; r++) require(order[r] == want[r] && zero.entry(want[r]).rank == r + 1, "after a");
        require(zero.entry(t[1]).losses == 2 && zero.entry(t[0]).losses == 1 && zero.entry(t[3]).wins == 1, "counted");
        // a challenger that lost its rank meanwhile still settles against the defender above it
        vm.prank(owners[1], owners[1]); uint256 d = zero.challenge{gas: GAS_LIMIT}(t[1], t[3]);     // rank 5 against rank 4
        vm.prank(owners[0], owners[0]); uint256 e = zero.challenge{gas: GAS_LIMIT}(t[0], t[2]);     // rank 2 against rank 1
        settle(zero, e);                                                                            // → t0 t2 t4 t3 t1
        settle(zero, d);                                                                            // → t0 t2 t4 t1 t3
        want = [t[0], t[2], t[4], t[1], t[3]];
        order = boardOf(zero);
        for (uint256 r; r < 5; r++) require(order[r] == want[r], "after d and e");
    }

    // ------------------------------------------------------------------------------------------------ cooldown, timeout, season

    function testCooldownOfAPair() public {
        TankLadder zero = zeroDelta();
        // a above x above b: b (18,432 bytes) is heavier than a (18,400), so b loses equal episodes with δ = 0
        address a = tiny(572, 1, 9, 1); address x = tiny(572, 2, 9, 3); address b = tiny(572, 2, 9, 2);
        enter(zero, alice, a); enter(zero, carol, x); enter(zero, bob, b);
        vm.roll(1000);
        vm.prank(bob, bob);
        uint256 id = zero.challenge{gas: GAS_LIMIT}(b, a);
        require(zero.cooldownUntil(b, a) == 7000 && zero.cooldownUntil(a, b) == 0, "the pair, not the reverse");
        settle(zero, id);
        require(zero.challengeInfo(id).status == 3, "heavier: a defense");
        vm.roll(6999);
        vm.prank(bob, bob);
        vm.expectRevert(abi.encodeWithSelector(TankLadder.Cooldown.selector, uint64(7000)));
        zero.challenge{gas: GAS_LIMIT}(b, a);
        // the same challenger against another defender meanwhile
        vm.prank(bob, bob);
        uint256 id2 = zero.challenge{gas: GAS_LIMIT}(b, x);
        require(id2 == 2, "another pair is free");
        vm.roll(7000);
        settle(zero, id2);
        vm.prank(bob, bob);
        uint256 id3 = zero.challenge{gas: GAS_LIMIT}(b, a);
        require(id3 == 3 && zero.cooldownUntil(b, a) == 13000, "after the cooldown");
    }

    function testTimeoutIsADefense() public {
        enter(alice, big);
        enter(bob, mid);
        vm.roll(1000);
        vm.prevrandao(keccak256("ladder-timeout"));              // a challenge of 209 steps: two transactions do not settle it
        uint256 id = start(bob, mid, big);
        ladder.advance{gas: GAS_LIMIT}(id);
        vm.expectRevert(TankLadder.NotExpired.selector);
        ladder.expire(id);
        vm.roll(1400);
        ladder.advance{gas: GAS_LIMIT}(id);                       // the last block of the deadline still plays
        vm.expectRevert(TankLadder.NotExpired.selector);
        ladder.expire(id);
        vm.roll(1401);
        vm.expectRevert(TankLadder.Expired.selector);
        ladder.advance{gas: GAS_LIMIT}(id);
        vm.recordLogs();
        vm.prank(carol, carol);
        ladder.expire(id);
        TankLadder.ChallengeInfo memory info = ladder.challengeInfo(id);
        require(info.status == 4 && info.episode < 6, "expired before the end");
        require(rankOf(big) == 1 && rankOf(mid) == 2 && ladder.entry(big).wins == 1 && ladder.entry(mid).losses == 1 && ladder.entry(mid).activeChallenge == 0, "a defense");
        IVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].topics[0] == SETTLED_SIG, "one ChallengeSettled");
        (uint8 status,,, uint32 newRank) = abi.decode(logs[0].data, (uint8, uint8, uint8, uint32));
        require(status == 4 && newRank == 2, "settled as expired");
        vm.expectRevert(TankLadder.NotPlaying.selector);
        ladder.expire(id);
        vm.roll(7000);                                            // the cooldown of the pair, from the start
        uint256 id2 = start(bob, mid, big);
        require(id2 == 2, "the challenger is free again");
    }

    function testSeasonEndRefusesNewChallengesOnly() public {
        TankLadder season = ladderWith(1000, 10, 20, 2000);
        enter(season, alice, big); enter(season, bob, mid);
        vm.roll(1999);
        vm.prank(bob, bob);
        uint256 id = season.challenge{gas: GAS_LIMIT}(mid, big);
        vm.roll(2000);
        vm.prank(alice, alice);
        vm.expectRevert(TankLadder.SeasonOver.selector);
        season.challenge{gas: GAS_LIMIT}(big, mid);
        while (season.challengeInfo(id).status == 1) { vm.roll(block.number + 1); season.advance{gas: GAS_LIMIT}(id); }
        require(season.challengeInfo(id).status != 1 && season.challengeInfo(id).episode == 6, "the started challenge played to its end");
        vm.prank(alice, alice);
        vm.expectRevert(TankLadder.SeasonOver.selector);
        season.challenge{gas: GAS_LIMIT}(big, mid);
    }
}
