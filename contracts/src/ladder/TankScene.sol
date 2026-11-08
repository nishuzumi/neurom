// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title TankScene — the battle rules of the template tank-battle, bit for bit (ADR 0026).
/// @notice The library mirrors `battle`, `view` and `play` of the scene of frontend/templates/tank-battle.yaml. The
///         fixture contracts/test/fixtures/tank-episodes.json proves the parity. A rule changes in the template and
///         here at the same time.
///         The map is 9 × 9 cells, row by row, cell y * 9 + x. A cell is 0 empty, 1 brick, 2 steel, 3 base, 4 water.
///         The state keeps the 81 cells as 3 bits each in one word. Actions: 0–3 move up, right, down, left, 4–7 fire
///         up, right, down, left, 8 wait. `end`: -1 running, 0 side 0 wins, 1 side 1 wins, 2 draw.
library TankScene {
    /// @notice Steps of one episode (params.steps of the template).
    uint8 internal constant STEPS = 100;
    /// @notice Input bits that a side sees.
    uint16 internal constant INPUTS = 572;
    /// @notice Scores that a side returns.
    uint8 internal constant ACTIONS = 9;
    uint8 internal constant WAIT = 8;

    struct Tank { bool on; uint8 x; uint8 y; uint8 d; uint8 lives; bool fired; uint8 sx; uint8 sy; }
    struct State { uint32 seed; uint8 t; uint256 cells; Tank[2] tanks; bool[2] bases; bool jolt; int8 end; }
    struct Ray { uint8 n; int8 x; int8 y; uint8 why; }

    /// @dev The fixed part of the map (MAP of the template), 3 bits per cell. The 28 random cells are 0 here.
    uint256 private constant MAP = 0xb20008124200004002000802488a2a480020080004000204908000b200;
    /// @dev The 4 cells that quarter cell k (0..6) decides: the cell, its left-right mirror, both turned 180°.
    uint256 private constant QUARTER = 0x3032201e2f33211d2e34221c393b1715383c1814373d1913363e1a12;
    /// @dev The 10 start cells of side 0 (START of the template). Side 1 starts at 80 − START[i].
    uint256 private constant START = 0x504f4e4a49484745413f;
    uint256 private constant HOME0 = 76; // (4, 8)
    uint256 private constant HOME1 = 4;  // (4, 0)

    // ------------------------------------------------------------------------------------------------ random numbers

    /// @dev The hash rand(key, counter) of the IR: the raw 32-bit value h. The scene uses h / 2^32 in [0, 1).
    function rand(uint32 key, uint32 counter) internal pure returns (uint32 h) {
        unchecked {
            h = key ^ (counter * 0x9e3779b9);
            h ^= h >> 16; h *= 0x7feb352d; h ^= h >> 15; h *= 0x846ca68b; h ^= h >> 16;
        }
    }
    /// @dev floor(rand · n) for a small n: exact, because h · n fits a double.
    function randInt(uint32 key, uint32 counter, uint256 n) internal pure returns (uint256) {
        return (uint256(rand(key, counter)) * n) >> 32;
    }
    /// @dev rand < 0.5.
    function coin(uint32 key, uint32 counter) internal pure returns (bool) {
        return rand(key, counter) < 0x80000000;
    }

    // ------------------------------------------------------------------------------------------------ cells

    function cellAt(uint256 cells, uint256 c) internal pure returns (uint256) { return (cells >> (3 * c)) & 7; }

    function dx(uint256 d) internal pure returns (int8) { return d == 1 ? int8(1) : d == 3 ? int8(-1) : int8(0); }
    function dy(uint256 d) internal pure returns (int8) { return d == 0 ? int8(-1) : d == 2 ? int8(1) : int8(0); }
    function inside(int8 x, int8 y) internal pure returns (bool) { return x >= 0 && y >= 0 && x < 9 && y < 9; }

    /// @dev The map of `seed` (cellsOf of the template): the quarter cells 0..5 hold up to two steel or water cells,
    ///      every other quarter cell is a brick with probability 1/2.
    function cellsOf(uint32 seed) internal pure returns (uint256 cells) {
        cells = MAP;
        int256 o0 = coin(seed, 9) ? int256(randInt(seed, 10, 6)) : -1;
        uint256 t0 = coin(seed, 11) ? 2 : 4;
        int256 pick = coin(seed, 12) ? int256(randInt(seed, 13, 6)) : -1;
        int256 o1 = pick == o0 || (o0 == 1 && pick == 5) || (o0 == 5 && pick == 1) ? -1 : pick;
        uint256 t1 = coin(seed, 14) ? 2 : 4;
        for (uint256 k; k < 7; k++) {
            uint256 v = int256(k) == o0 ? t0 : int256(k) == o1 ? t1 : coin(seed, uint32(2 + k)) ? 1 : 0;
            if (v == 0) continue;
            for (uint256 j; j < 4; j++) cells |= v << (3 * ((QUARTER >> (8 * (4 * k + j))) & 0xff));
        }
    }

    // ------------------------------------------------------------------------------------------------ battle(start)

    /// @dev The start of an episode with `seed`: the map, two bases, each tank with 2 lives on its start cell.
    function battle(uint32 seed) internal pure returns (State memory s) {
        uint8 c0 = uint8((START >> (8 * randInt(seed, 0, 10))) & 0xff);
        uint8 c1 = 80 - uint8((START >> (8 * randInt(seed, 1, 10))) & 0xff);
        s.seed = seed;
        s.cells = cellsOf(seed);
        s.tanks[0] = Tank(true, c0 % 9, c0 / 9, 0, 2, false, c0 % 9, c0 / 9);
        s.tanks[1] = Tank(true, c1 % 9, c1 / 9, 2, 2, false, c1 % 9, c1 / 9);
        s.bases[0] = true;
        s.bases[1] = true;
        s.end = -1;
    }

    // ------------------------------------------------------------------------------------------------ view(state, side)

    /// @dev Writes the 572 input bits of `side` (view of the template), one byte per bit, at memory `ptr`. The 572
    ///      bytes at `ptr` must be zero before the call. Side 1 sees the map turned 180°.
    function fillInput(State memory s, uint256 side, uint256 ptr) internal pure {
        uint256 cells = s.cells;
        assembly ("memory-safe") {
            for { let c := 0 } lt(c, 81) { c := add(c, 1) } {
                let cell := and(shr(mul(3, c), cells), 7)
                if cell {
                    let at := c
                    if side { at := sub(80, c) }
                    switch cell
                    case 1 { mstore8(add(ptr, at), 1) }
                    case 2 { mstore8(add(ptr, add(81, at)), 1) }
                    case 4 { mstore8(add(ptr, add(162, at)), 1) }
                }
            }
        }
        Tank memory own = s.tanks[side];
        Tank memory other = s.tanks[1 - side];
        if (s.bases[side]) _bit(ptr, 243 + _turned(side == 0 ? HOME0 : HOME1, side));
        if (s.bases[1 - side]) _bit(ptr, 324 + _turned(side == 0 ? HOME1 : HOME0, side));
        if (own.on) _bit(ptr, 405 + _turned(uint256(own.y) * 9 + own.x, side));
        if (other.on) _bit(ptr, 486 + _turned(uint256(other.y) * 9 + other.x, side));
        if (own.fired) _bit(ptr, 567);
        if (other.fired) _bit(ptr, 568);
        if (own.lives > 1) _bit(ptr, 569);
        if (other.lives > 1) _bit(ptr, 570);
        _bit(ptr, 571);
    }

    function _turned(uint256 c, uint256 side) private pure returns (uint256) { return side == 0 ? c : 80 - c; }
    function _bit(uint256 ptr, uint256 k) private pure { assembly ("memory-safe") { mstore8(add(ptr, k), 1) } }

    // ------------------------------------------------------------------------------------------------ move(state, a0, a1)

    /// @dev The first cell that a shell from (x, y) in direction d hits (ray of the template). `on`, `tx_`, `ty` are
    ///      the other tank. why: 1 brick, 2 steel or the map edge, 3 base, 4 tank.
    function ray(uint256 cells, int8 x, int8 y, uint256 d, bool on, int8 tx_, int8 ty) internal pure returns (Ray memory r) {
        r = Ray(0, x, y, 0);
        for (uint256 k; k < 9; k++) {
            int8 cx = x + int8(int256(k + 1)) * dx(d);
            int8 cy = y + int8(int256(k + 1)) * dy(d);
            uint256 v = inside(cx, cy) ? cellAt(cells, uint8(cy) * 9 + uint8(cx)) : 2;
            uint8 why = on && tx_ == cx && ty == cy ? 4 : (v == 0 || v == 4) ? 0 : uint8(v);
            if (why > 0) return Ray(uint8(k + 1), cx, cy, why);
        }
    }

    /// @dev An action of side 1 in its own map, turned 180° into the world (turnAct of the template).
    function turnAct(uint8 a) internal pure returns (uint8) { return a < 8 ? a - (a % 4) + ((a % 4) + 2) % 4 : a; }

    /// @dev One step with the world actions `a0` and `a1` (move of the template) → the actions each side made.
    function move(State memory s, uint8 a0, uint8 a1) internal pure returns (uint8[2] memory acts) {
        uint8[2] memory asked;
        if (s.jolt) {
            // after a mutual shot: a random move or wait for each side, no fire
            for (uint256 k; k < 2; k++) {
                uint256 pickIdx = randInt(s.seed, uint32(4096 + 32 * uint256(s.t) + 16 * k + 12), 5);
                asked[k] = pickIdx == 4 ? WAIT : uint8(pickIdx);
            }
        } else { asked[0] = a0; asked[1] = a1; }
        Tank[2] memory was = s.tanks;
        for (uint256 k; k < 2; k++) {
            Tank memory me = was[k];
            uint8 a = asked[k];
            int8 x = int8(me.x) + dx(a % 4);
            int8 y = int8(me.y) + dy(a % 4);
            bool free = inside(x, y) && cellAt(s.cells, uint8(y) * 9 + uint8(x)) == 0
                && !(was[0].on && int8(was[0].x) == x && int8(was[0].y) == y)
                && !(was[1].on && int8(was[1].x) == x && int8(was[1].y) == y);
            acts[k] = me.on && ((a < 4 && free) || (a >= 4 && a < 8 && !me.fired)) ? a : WAIT;
        }
        Tank[2] memory moved;
        for (uint256 k; k < 2; k++) {
            moved[k] = Tank(was[k].on, was[k].x, was[k].y, was[k].d, was[k].lives, was[k].fired, was[k].sx, was[k].sy);
            if (acts[k] < 4) {
                moved[k].x = uint8(int8(was[k].x) + dx(acts[k]));
                moved[k].y = uint8(int8(was[k].y) + dy(acts[k]));
                moved[k].d = acts[k];
            } else if (acts[k] < 8) moved[k].d = acts[k] - 4;
        }
        Ray[2] memory rays;
        bool[2] memory fire;
        for (uint256 k; k < 2; k++) {
            rays[k] = ray(s.cells, int8(moved[k].x), int8(moved[k].y), acts[k] % 4, moved[1 - k].on, int8(moved[1 - k].x), int8(moved[1 - k].y));
            fire[k] = acts[k] >= 4 && acts[k] < 8;
        }
        bool mutual = fire[0] && fire[1] && rays[0].why == 4 && rays[1].why == 4;
        bool[2] memory shot = [fire[0] && !mutual, fire[1] && !mutual];
        bool[2] memory hits = [shot[1] && rays[1].why == 4, shot[0] && rays[0].why == 4];
        // struck cells: the bricks and bases that a shell hit
        for (uint256 k; k < 2; k++) {
            if (shot[k] && (rays[k].why == 1 || rays[k].why == 3)) {
                uint256 c = uint8(rays[k].y) * 9 + uint8(rays[k].x);
                if (c == HOME0) s.bases[0] = false;
                if (c == HOME1) s.bases[1] = false;
                s.cells &= ~(uint256(7) << (3 * c));
            }
        }
        for (uint256 k; k < 2; k++) {
            uint8 lives = was[k].lives - (hits[k] ? 1 : 0);
            if (hits[k] && lives > 0) {
                s.tanks[k] = Tank(moved[k].on, was[k].sx, was[k].sy, k == 0 ? 0 : 2, lives, false, was[k].sx, was[k].sy);
            } else {
                s.tanks[k] = Tank(moved[k].on && lives > 0, moved[k].x, moved[k].y, moved[k].d, lives, shot[k], was[k].sx, was[k].sy);
            }
        }
        bool lost0 = !s.bases[0] || s.tanks[0].lives < 1;
        bool lost1 = !s.bases[1] || s.tanks[1].lives < 1;
        s.t += 1;
        s.jolt = mutual;
        if (lost0 && lost1) s.end = 2;
        else if (lost1) s.end = 0;
        else if (lost0) s.end = 1;
        else if (s.t < STEPS) s.end = -1;
        else s.end = s.tanks[0].lives > s.tanks[1].lives ? int8(0) : s.tanks[1].lives > s.tanks[0].lives ? int8(1) : int8(2);
    }

    /// @dev One step with the actions as each side sees them (play of the template): side 1's action turns 180°.
    function play(State memory s, uint8 a0, uint8 a1) internal pure returns (uint8[2] memory) {
        return move(s, a0, turnAct(a1));
    }

    // ------------------------------------------------------------------------------------------------ packing

    /// @dev A tank as 22 bits: on 1, x 4, y 4, d 2, lives 2, fired 1, sx 4, sy 4.
    function packTank(Tank memory t) internal pure returns (uint256 w) {
        w = (t.on ? 1 : 0) | (uint256(t.x) << 1) | (uint256(t.y) << 5) | (uint256(t.d) << 9) | (uint256(t.lives) << 11)
            | (uint256(t.fired ? 1 : 0) << 13) | (uint256(t.sx) << 14) | (uint256(t.sy) << 18);
    }
    function unpackTank(uint256 w) internal pure returns (Tank memory t) {
        t = Tank((w & 1) == 1, uint8((w >> 1) & 15), uint8((w >> 5) & 15), uint8((w >> 9) & 3), uint8((w >> 11) & 3), ((w >> 13) & 1) == 1, uint8((w >> 14) & 15), uint8((w >> 18) & 15));
    }
    /// @dev Everything but the cells as 89 bits: seed 32, t 8, tank 0 22, tank 1 22, bases 2, jolt 1, end + 1 2.
    function packMeta(State memory s) internal pure returns (uint256 meta) {
        meta = uint256(s.seed) | (uint256(s.t) << 32) | (packTank(s.tanks[0]) << 40) | (packTank(s.tanks[1]) << 62)
            | (uint256(s.bases[0] ? 1 : 0) << 84) | (uint256(s.bases[1] ? 1 : 0) << 85) | (uint256(s.jolt ? 1 : 0) << 86)
            | (uint256(uint8(s.end + 1)) << 87);
    }
    function unpack(uint256 meta, uint256 cells) internal pure returns (State memory s) {
        s.cells = cells;
        s.seed = uint32(meta);
        s.t = uint8(meta >> 32);
        s.tanks[0] = unpackTank((meta >> 40) & 0x3fffff);
        s.tanks[1] = unpackTank((meta >> 62) & 0x3fffff);
        s.bases[0] = ((meta >> 84) & 1) == 1;
        s.bases[1] = ((meta >> 85) & 1) == 1;
        s.jolt = ((meta >> 86) & 1) == 1;
        s.end = int8(uint8((meta >> 87) & 3)) - 1;
    }
}
