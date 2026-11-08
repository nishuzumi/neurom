// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./LadderBase.sol";

/// The referee against the template scene: test/fixtures/tank-episodes.json (written by tank-episodes.mjs with the
/// browser code) replayed on the deployed 中 and 大 modules. Every chosen action, every action made and every state
/// word must agree. Then whole challenges through the ladder's external functions: the `Steps` and `EpisodeEnded`
/// events must agree with the episodes the browser code played from the same seed.
contract TankParityTest is LadderBase {
    struct Episode { string tag0; string tag1; uint32 seed; uint256[] cells; uint256[] meta; }
    struct Challenge { string challenger; string defender; bytes32 prevrandao; uint256 id; bytes32 seed; bytes[] actions; int8[] ends; uint8[] steps; uint8 challengerWins; uint8 defenderWins; }

    address eoa = address(0xE0A);

    function moduleOf(string memory tag) internal view returns (address) {
        return keccak256(bytes(tag)) == keccak256("mid") ? mid : big;
    }

    function argmax(int256[] memory scores) internal pure returns (uint8 best) {
        for (uint256 k = 1; k < scores.length; k++) if (scores[k] > scores[best]) best = uint8(k);
    }

    /// The 572 input bits of `side` as bytes, the way the ladder fills its call buffer.
    function inputOf(TankScene.State memory s, uint256 side) internal pure returns (bytes memory v) {
        v = new bytes(TankScene.INPUTS);
        uint256 ptr;
        assembly ("memory-safe") { ptr := add(v, 32) }
        TankScene.fillInput(s, side, ptr);
    }

    function decide(address module, TankScene.State memory s, uint256 side) internal view returns (uint8) {
        (int256[] memory scores,,,) = INeuromModule(module).forward(inputOf(s, side));
        require(scores.length == 9, "9 scores");
        return argmax(scores);
    }

    /// Every recorded episode, step by step: the scene from `battle`, the inputs from `fillInput`, the modules' scores.
    function testEpisodesMatchTheTemplate() public {
        Episode[] memory episodes = abi.decode(vm.parseJsonBytes(fixture, ".episodesData"), (Episode[]));
        uint256 steps;
        for (uint256 k; k < episodes.length; k++) {
            Episode memory e = episodes[k];
            address m0 = moduleOf(e.tag0);
            address m1 = moduleOf(e.tag1);
            string memory name = string.concat(e.tag0, "-", e.tag1, " seed ", vm.toString(uint256(e.seed)));
            TankScene.State memory s = TankScene.battle(e.seed);
            for (uint256 i; i < e.meta.length; i++) {
                // the step's allocations (inputs, the modules' counts, messages) are dropped after the step: the EVM
                // memory of the test stays small over 2,000 steps
                uint256 free;
                assembly ("memory-safe") { free := mload(0x40) }
                uint256 want = e.meta[i];
                string memory where = string.concat(name, " step ", vm.toString(i + 1));
                require(s.end < 0, string.concat(where, ": the episode ended early"));
                uint8 a0 = decide(m0, s, 0);
                uint8 a1 = decide(m1, s, 1);
                require(a0 == uint8(want & 15) && a1 == uint8((want >> 4) & 15), string.concat(where, ": actions chosen"));
                uint8[2] memory acts = TankScene.play(s, a0, a1);
                require(acts[0] == uint8((want >> 8) & 15) && acts[1] == uint8((want >> 12) & 15), string.concat(where, ": actions made"));
                require(s.cells == e.cells[i], string.concat(where, ": cells"));
                require(TankScene.packTank(s.tanks[0]) == ((want >> 16) & 0x3fffff), string.concat(where, ": tank 0"));
                require(TankScene.packTank(s.tanks[1]) == ((want >> 38) & 0x3fffff), string.concat(where, ": tank 1"));
                require((s.bases[0] ? 1 : 0) | (s.bases[1] ? 2 : 0) == ((want >> 60) & 3), string.concat(where, ": bases"));
                require((s.jolt ? 1 : 0) == ((want >> 62) & 1), string.concat(where, ": mutual shot"));
                require(uint8(s.end + 1) == uint8((want >> 63) & 3), string.concat(where, ": end"));
                require(s.t == i + 1, string.concat(where, ": t"));
                assembly ("memory-safe") { mstore(0x40, free) }
                steps++;
            }
            require(s.end >= 0, string.concat(name, ": the episode did not end"));
        }
        require(episodes.length >= 20 && steps > 1000, "the corpus is small");
    }

    /// Every recorded challenge through the ladder: the actions of the `Steps` events, the end of every episode and
    /// the settled score agree with the browser code. `mid` against `mid` plays a twin with the same decisions.
    function testChallengesMatchTheTemplate() public {
        Challenge[] memory challenges = abi.decode(vm.parseJsonBytes(fixture, ".challengesData"), (Challenge[]));
        require(challenges.length >= 3, "the corpus is small");
        for (uint256 k; k < challenges.length; k++) {
            Challenge memory c = challenges[k];
            address challenger = moduleOf(c.challenger);
            address defender = keccak256(bytes(c.challenger)) == keccak256(bytes(c.defender)) ? deployFixtureTwin(c.defender, keccak256(abi.encode("twin", k))) : moduleOf(c.defender);
            TankLadder ladder = newLadder();
            vm.prank(eoa, eoa);
            ladder.register(defender);
            vm.prank(eoa, eoa);
            ladder.register(challenger);
            vm.prevrandao(c.prevrandao);
            vm.recordLogs();
            vm.prank(eoa, eoa);
            uint256 id = ladder.challenge{gas: GAS_LIMIT}(challenger, defender);
            require(id == c.id, "id");
            require(ladder.challengeInfo(id).seed == c.seed, "seed");
            uint256 transactions = settle(ladder, id);
            IVm.Log[] memory logs = vm.getRecordedLogs();
            bytes[6] memory actions;
            uint256[6] memory nextStep;
            int8[6] memory ends;
            bool[6] memory ended;
            for (uint256 i; i < logs.length; i++) {
                if (logs[i].emitter != address(ladder)) continue;
                if (logs[i].topics[0] == STEPS_SIG) {
                    (uint8 episode, uint8 fromStep, bytes memory acts) = abi.decode(logs[i].data, (uint8, uint8, bytes));
                    require(fromStep == nextStep[episode], "Steps continue where the last transaction stopped");
                    actions[episode] = bytes.concat(actions[episode], acts);
                    nextStep[episode] += acts.length;
                } else if (logs[i].topics[0] == EPISODE_ENDED_SIG) {
                    (uint8 episode, int8 end, uint8 steps) = abi.decode(logs[i].data, (uint8, int8, uint8));
                    require(!ended[episode] && steps == nextStep[episode], "EpisodeEnded once, after its steps");
                    ended[episode] = true;
                    ends[episode] = end;
                }
            }
            for (uint256 e; e < 6; e++) {
                string memory where = string.concat(c.challenger, " vs ", c.defender, " episode ", vm.toString(e));
                require(ended[e], string.concat(where, ": ended"));
                require(keccak256(actions[e]) == keccak256(c.actions[e]), string.concat(where, ": actions"));
                require(ends[e] == c.ends[e], string.concat(where, ": end"));
                require(nextStep[e] == c.steps[e], string.concat(where, ": steps"));
            }
            TankLadder.ChallengeInfo memory info = ladder.challengeInfo(id);
            require(info.challengerWins == c.challengerWins && info.defenderWins == c.defenderWins, "score");
            require(info.episode == 6 && info.status != ladder.STATUS_PLAYING(), "settled");
            Console.log(string.concat(c.challenger, " vs ", c.defender, ": transactions of 30M"), transactions);
        }
    }
}
