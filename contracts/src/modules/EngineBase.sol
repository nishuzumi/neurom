// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./INeuromModule.sol";

/// @title EngineBase — what both engines share: reading the weight chunks and one affine map, column by column.
/// @notice Weight layout (ADR 0014, ADR 0015): the blob is a sequence of regions, one per affine map.
///         Each region is column-major at the module's weightBits w (8 or 16). Column i holds the weights of every
///         row (neuron) for input i as big-endian two's-complement w-bit integers, 256 / w per 32-byte word.
///         Row j is at element j, and element 0 is the most significant byte(s) of the word. Zeros pad each column
///         to whole words. The bias column comes last. It is always int16, 16 per word, with the same padding.
///         A map of `rows` rows over `cols` inputs takes cols · ⌈rows · w / 256⌉ · 32 + ⌈rows / 16⌉ · 32 bytes.
///         A region with shift k computes z[j] = (Σ_i W[j,i]·x[i]) · 2^k + factor·b[j].
abstract contract EngineBase is IEngine {
    /// @notice A vector that a layer reads: `width` entries. `nz` lists only the nonzero entries, each as
    ///         index | value << 32, in no specified order. `sum` is the sum of all values. A layer pays only for its
    ///         active inputs. The index has 32 bits because a tool layer adds R entries to the width it reads, so a
    ///         width can be above 65535.
    struct Vec {
        uint256 width;
        uint256 sum;
        uint256[] nz;
    }

    /// @dev The largest Σx of one int16 pass: a lane holds at most 65535 · Σx, which is below 2^32 while Σx ≤ 65537.
    uint256 private constant MAX_SUM16 = 65537;

    /// @dev 0x8000 in every 16-bit position: XOR turns an int16 w into the unsigned w + 32768.
    uint256 private constant FLIP = 0x8000800080008000800080008000800080008000800080008000800080008000;
    /// @dev the low 16 bits of every 32-bit lane
    uint256 private constant LO = 0x0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff;
    /// @dev 0x80 in every byte: XOR turns an int8 w into the unsigned w + 128.
    uint256 private constant FLIP8 = 0x8080808080808080808080808080808080808080808080808080808080808080;
    /// @dev the low 8 bits of every 32-bit lane
    uint256 private constant LO8 = 0x000000ff000000ff000000ff000000ff000000ff000000ff000000ff000000ff;
    /// @dev bit 0 of every byte: an input word whose bytes are all 0 / 1 has no other bit set
    uint256 private constant ONES = 0x0101010101010101010101010101010101010101010101010101010101010101;
    /// @dev (c · GATHER) >> 56 packs the 8 bytes (each 0 / 1) of a 64-bit c into 8 bits, the first byte highest
    uint256 private constant GATHER = 0x0102040810204080;
    /// @dev de Bruijn table: the position of a 32-bit power of two p is byte (p · 0x077CB531 mod 2^32) >> 27 of it
    uint256 private constant DEBRUIJN = 0x00011c021d0e18031e16140f191104081f1b0d17151310071a0c12060b050a09;

    /// @notice Bytes of one region: `rows` neurons over `cols` inputs at `bits` (8 or 16) per weight, plus the int16
    ///         bias column.
    function regionBytes(uint256 rows, uint256 cols, uint256 bits) public pure returns (uint256) {
        return (cols * ((rows * bits + 255) >> 8) + ((rows + 15) >> 4)) * 32;
    }

    /// @dev The weight blob: every chunk's code after its STOP byte, concatenated in order.
    function _load(address[] calldata chunks) internal view returns (bytes memory blob) {
        uint256 total;
        for (uint256 k; k < chunks.length; k++) total += chunks[k].code.length - 1;
        blob = new bytes(total);
        uint256 at;
        for (uint256 k; k < chunks.length; k++) {
            address c = chunks[k];
            uint256 len;
            assembly ("memory-safe") {
                len := sub(extcodesize(c), 1)
                extcodecopy(c, add(add(blob, 0x20), at), 1, len)
            }
            at += len;
        }
    }

    /// @dev The input (one 0 / 1 byte per bit) as a Vec. Reverts "obs" on a wrong length and "bit" on another byte.
    ///      Reads 32 input bytes per word. A zero word costs nothing more. A nonzero word becomes 32 bits, and the
    ///      function visits only its set bits. The list takes memory only for the set bits.
    function _input(bytes calldata input, uint256 n) internal pure returns (Vec memory v) {
        require(input.length == n, "obs");
        v.width = n;
        uint256[] memory nz;
        uint256 count;
        bool bad;
        assembly ("memory-safe") {
            nz := mload(0x40)
            let ones := not(ONES)
            let gather := GATHER
            let table := DEBRUIJN
            let pn := add(nz, 0x20)
            for { let w := 0 } lt(shl(5, w), n) { w := add(w, 1) } {
                let word := calldataload(add(input.offset, shl(5, w)))
                let rem := sub(n, shl(5, w))
                if lt(rem, 32) { word := and(word, not(sub(shl(sub(256, shl(3, rem)), 1), 1))) }
                bad := or(bad, and(word, ones))
                if word {
                    let mask := 0
                    for { let q := 0 } lt(q, 4) { q := add(q, 1) } {
                        let c := and(shr(sub(192, shl(6, q)), word), 0xffffffffffffffff)
                        mask := or(shl(8, mask), and(shr(56, mul(c, gather)), 0xff))
                    }
                    let first := shl(5, w)
                    for { } mask { } {
                        let p := and(mask, sub(0, mask))
                        let bit := byte(shr(27, and(mul(p, 0x077CB531), 0xffffffff)), table)
                        mstore(add(pn, shl(5, count)), or(add(first, sub(31, bit)), 0x100000000))
                        count := add(count, 1)
                        mask := xor(mask, p)
                    }
                }
            }
            mstore(nz, count)
            mstore(0x40, add(pn, shl(5, count)))
        }
        require(!bad, "bit");
        v.sum = count;
        v.nz = nz;
    }

    /// @dev Bits (0 / 1 entries) or counts as a Vec.
    function _vec(uint256[] memory x) internal pure returns (Vec memory v) {
        uint256 n = x.length;
        v.width = n;
        uint256[] memory nz;
        uint256 sum;
        assembly ("memory-safe") {
            nz := mload(0x40)
            let px := add(x, 0x20)
            let pn := add(nz, 0x20)
            let count := 0
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                let xi := mload(add(px, shl(5, i)))
                if xi { mstore(add(pn, shl(5, count)), or(i, shl(32, xi))) count := add(count, 1) sum := add(sum, xi) }
            }
            mstore(nz, count)
            mstore(0x40, add(pn, shl(5, count)))
        }
        v.sum = sum;
        v.nz = nz;
    }

    /// @dev The neurons j with z[j] >= min fire: counts[at + j] = 1, and they are the next layer's bits.
    function _fire(int256[] memory z, int256 min, uint8[] memory counts, uint256 at) internal pure returns (Vec memory v) {
        uint256 n = z.length;
        v.width = n;
        uint256[] memory nz;
        uint256 fired;
        assembly ("memory-safe") {
            nz := mload(0x40)
            let pz := add(z, 0x20)
            let pn := add(nz, 0x20)
            let pk := add(add(counts, 0x20), shl(5, at))
            for { let j := 0 } lt(j, n) { j := add(j, 1) } {
                if iszero(slt(mload(add(pz, shl(5, j))), min)) {
                    mstore(add(pn, shl(5, fired)), or(j, 0x100000000))
                    fired := add(fired, 1)
                    mstore(add(pk, shl(5, j)), 1)
                }
            }
            mstore(nz, fired)
            mstore(0x40, add(pn, shl(5, fired)))
        }
        v.sum = fired;
        v.nz = nz;
    }

    /// @dev `a` ‖ `b`: b's indices move up by a.width.
    function _concat(Vec memory a, Vec memory b) internal pure returns (Vec memory v) {
        v.width = a.width + b.width;
        v.sum = a.sum + b.sum;
        uint256 na = a.nz.length;
        uint256 nb = b.nz.length;
        v.nz = new uint256[](na + nb);
        uint256 shift = a.width;
        for (uint256 i; i < na; i++) v.nz[i] = a.nz[i];
        for (uint256 i; i < nb; i++) v.nz[na + i] = b.nz[i] + shift;
    }

    /// @dev out[j] = (Σ_i x[i]·W[j,i]) · 2^k + factor·b[j] for the region at byte `at` of `blob` (`rows` rows over
    ///      x.width columns, weights of `bits` = 8 or 16). Each nonzero x[i] adds its whole column in one step into
    ///      32-bit lanes. The lanes hold the weight made unsigned, scaled by x[i]. The offset is removed at the end:
    ///        int16: a column word spreads into two words of eight lanes (even rows, odd rows) that hold w + 32768.
    ///               The offset is 32768·Σx. Lanes stay below 2^32 while Σx·65535 does, that is Σx ≤ 65537. A larger
    ///               Σx (only after a tool layer) goes in batches of Σx ≤ 65537, and their sums are added. Up to 32
    ///               rows (one or two words per column), the lanes stay on the stack.
    ///        int8:  a column word spreads into four words of eight lanes (rows ≡ 0, 1, 2, 3 mod 4) that hold w + 128.
    ///               The offset is 128·Σx. Lanes stay below 2^32 while Σx·255 does, that is Σx ≤ 16843009. No shape
    ///               gets near it: Σx ≤ 9 · 65535 bits, or 256 · 64 spike counts. Up to 32 rows (one word per column),
    ///               the lanes stay on the stack.
    function _affine(bytes memory blob, uint256 at, uint256 rows, Vec memory x, int256 factor, uint256 bits, uint256 k) internal pure returns (int256[] memory) {
        uint256 base;
        assembly ("memory-safe") { base := add(add(blob, 0x20), at) }
        return bits == 8 ? _affine8(base, rows, rows, x, factor, k) : _affine16(base, rows, rows, x, factor, k);
    }

    /// @dev The first `rows` rows of _affine over a region of `regionRows` ≥ rows rows: only their words are read.
    function _affineRows(bytes memory blob, uint256 at, uint256 rows, uint256 regionRows, Vec memory x, int256 factor, uint256 bits, uint256 k) internal pure returns (int256[] memory) {
        uint256 base;
        assembly ("memory-safe") { base := add(add(blob, 0x20), at) }
        return bits == 8 ? _affine8(base, rows, regionRows, x, factor, k) : _affine16(base, rows, regionRows, x, factor, k);
    }

    /// @dev _affineRows over int16 weights, the region at memory `base`. One pass when Σx ≤ MAX_SUM16. Else the entries
    ///      go in batches whose Σx is at most MAX_SUM16 (each entry is a bit or a spike count, so it fits alone, and
    ///      "sum" reverts if one does not). Only the first batch adds the bias.
    function _affine16(uint256 base, uint256 rows, uint256 regionRows, Vec memory x, int256 factor, uint256 k) private pure returns (int256[] memory out) {
        uint256[] memory nz = x.nz;
        uint256 from;
        uint256 end;
        assembly ("memory-safe") {
            from := add(nz, 0x20)
            end := add(from, shl(5, mload(nz)))
        }
        if (x.sum <= MAX_SUM16) return _pass16(base, rows, regionRows, x.width, from, end, factor, k);
        out = new int256[](rows);
        while (from < end) {
            uint256 to = from;
            uint256 sum;
            for (; to < end; to += 32) {
                uint256 xi;
                assembly ("memory-safe") { xi := shr(32, mload(to)) }
                if (sum + xi > MAX_SUM16) break;
                sum += xi;
            }
            require(to > from, "sum");
            int256[] memory part = _pass16(base, rows, regionRows, x.width, from, to, factor, k);
            for (uint256 j; j < rows; j++) out[j] += part[j];
            factor = 0;
            from = to;
        }
    }

    /// @dev One int16 pass over the entries in memory [pnz, end), whose Σx is at most MAX_SUM16.
    function _pass16(uint256 base, uint256 rows, uint256 regionRows, uint256 cols, uint256 pnz, uint256 end, int256 factor, uint256 k) private pure returns (int256[] memory out) {
        out = new int256[](rows);
        assembly ("memory-safe") {
            /// rows [16c, 16c + n) of `out` from one column word's lanes (`ev` even rows, `od` odd rows) and bias word `bw`
            function emit(ev, od, bw, n, po, off, f, s) {
                let sh := 224
                let full := add(po, shl(6, shr(1, n)))                // past the last whole row pair
                for { } lt(po, full) { po := add(po, 0x40) } {
                    mstore(po, add(shl(s, sub(and(shr(sh, ev), 0xffffffff), off)), mul(f, signextend(1, shr(add(sh, 16), bw)))))
                    mstore(add(po, 0x20), add(shl(s, sub(and(shr(sh, od), 0xffffffff), off)), mul(f, signextend(1, shr(sh, bw)))))
                    sh := sub(sh, 32)
                }
                if and(n, 1) { mstore(po, add(shl(s, sub(and(shr(sh, ev), 0xffffffff), off)), mul(f, signextend(1, shr(add(sh, 16), bw))))) }
            }
            /// the lane words of one-word columns over the entries [e, end_), and Σx
            function one(base_, e, end_) -> a0, a1, sum {
                for { } lt(e, end_) { e := add(e, 0x20) } {
                    let entry := mload(e)
                    let xi := shr(32, entry)
                    sum := add(sum, xi)
                    let v := xor(mload(add(base_, shl(5, and(entry, 0xffffffff)))), FLIP)
                    a0 := add(a0, mul(and(shr(16, v), LO), xi))
                    a1 := add(a1, mul(and(v, LO), xi))
                }
            }
            /// the lane words of two-word columns over the entries [e, end_), and Σx
            function two(base_, e, end_) -> a0, a1, a2, a3, sum {
                for { } lt(e, end_) { e := add(e, 0x20) } {
                    let entry := mload(e)
                    let xi := shr(32, entry)
                    sum := add(sum, xi)
                    let col := add(base_, shl(6, and(entry, 0xffffffff)))
                    let v := xor(mload(col), FLIP)
                    a0 := add(a0, mul(and(shr(16, v), LO), xi))
                    a1 := add(a1, mul(and(v, LO), xi))
                    v := xor(mload(add(col, 0x20)), FLIP)
                    a2 := add(a2, mul(and(shr(16, v), LO), xi))
                    a3 := add(a3, mul(and(v, LO), xi))
                }
            }
            let words := shr(4, add(rows, 15))
            let stride := shr(4, add(regionRows, 15))
            let po := add(out, 0x20)
            switch mul(words, eq(words, stride))                     // the stack paths read whole columns, else default
            case 1 {
                let a0, a1, sum := one(base, pnz, end)
                emit(a0, a1, mload(add(base, shl(5, cols))), rows, po, shl(15, sum), factor, k)
            }
            case 2 {
                let a0, a1, a2, a3, sum := two(base, pnz, end)
                let off := shl(15, sum)
                let pb := add(base, shl(6, cols))
                emit(a0, a1, mload(pb), 16, po, off, factor, k)
                emit(a2, a3, mload(add(pb, 0x20)), sub(rows, 16), add(po, 0x200), off, factor, k)
            }
            default {
                let colBytes := shl(5, stride)
                let pacc := mload(0x40)                              // 2 · words zeroed accumulator words
                calldatacopy(pacc, calldatasize(), shl(6, words))
                mstore(0x40, add(pacc, shl(6, words)))
                let sum := 0
                for { let e := pnz } lt(e, end) { e := add(e, 0x20) } {
                    let entry := mload(e)
                    let xi := shr(32, entry)
                    sum := add(sum, xi)
                    let col := add(base, mul(and(entry, 0xffffffff), colBytes))
                    for { let c := 0 } lt(c, words) { c := add(c, 1) } {
                        let v := xor(mload(add(col, shl(5, c))), FLIP)
                        let pa := add(pacc, shl(6, c))
                        mstore(pa, add(mload(pa), mul(and(shr(16, v), LO), xi)))
                        mstore(add(pa, 0x20), add(mload(add(pa, 0x20)), mul(and(v, LO), xi)))
                    }
                }
                let off := shl(15, sum)
                let pb := add(base, mul(cols, colBytes))
                for { let c := 0 } lt(c, words) { c := add(c, 1) } {
                    let left := sub(rows, shl(4, c))
                    if gt(left, 16) { left := 16 }
                    let pa := add(pacc, shl(6, c))
                    emit(mload(pa), mload(add(pa, 0x20)), mload(add(pb, shl(5, c))), left, add(po, shl(9, c)), off, factor, k)
                }
            }
        }
    }

    /// @dev _affineRows over int8 weights, the region at memory `base`: 32 rows per column word, the bias column still
    ///      int16 (two words per 32 rows). One pass always: Σx stays far below 16843009 (see _affine).
    function _affine8(uint256 base, uint256 rows, uint256 regionRows, Vec memory x, int256 factor, uint256 k) private pure returns (int256[] memory) {
        uint256[] memory nz = x.nz;
        uint256 from;
        uint256 end;
        assembly ("memory-safe") {
            from := add(nz, 0x20)
            end := add(from, shl(5, mload(nz)))
        }
        return _pass8(base, rows, regionRows, x.width, from, end, factor, k);
    }

    /// @dev One int8 pass over the entries in memory [pnz, end).
    function _pass8(uint256 base, uint256 rows, uint256 regionRows, uint256 cols, uint256 pnz, uint256 end, int256 factor, uint256 k) private pure returns (int256[] memory out) {
        out = new int256[](rows);
        assembly ("memory-safe") {
            /// rows [32c, 32c + n) of `out` from one column word's lanes (`a0`..`a3`: rows ≡ 0..3 mod 4) and the bias
            /// words at `pb` (rows 32c .. 32c + 15, then 32c + 16 .. 32c + 31)
            function emit(a0, a1, a2, a3, pb, n, po, off, f, s) {
                let sh := 224
                let bs := 240                                          // row 4q's bias position in its bias word
                let bw := mload(pb)
                let full := add(po, shl(7, shr(2, n)))                // past the last whole row quad
                for { } lt(po, full) { po := add(po, 0x80) } {
                    mstore(po, add(shl(s, sub(and(shr(sh, a0), 0xffffffff), off)), mul(f, signextend(1, shr(bs, bw)))))
                    mstore(add(po, 0x20), add(shl(s, sub(and(shr(sh, a1), 0xffffffff), off)), mul(f, signextend(1, shr(sub(bs, 16), bw)))))
                    mstore(add(po, 0x40), add(shl(s, sub(and(shr(sh, a2), 0xffffffff), off)), mul(f, signextend(1, shr(sub(bs, 32), bw)))))
                    mstore(add(po, 0x60), add(shl(s, sub(and(shr(sh, a3), 0xffffffff), off)), mul(f, signextend(1, shr(sub(bs, 48), bw)))))
                    sh := sub(sh, 32)
                    switch bs
                    case 48 { bs := 240 pb := add(pb, 0x20) bw := mload(pb) }   // rows 16 .. 31: the next bias word
                    default { bs := sub(bs, 64) }
                }
                if and(n, 3) {
                    mstore(po, add(shl(s, sub(and(shr(sh, a0), 0xffffffff), off)), mul(f, signextend(1, shr(bs, bw)))))
                    if gt(and(n, 3), 1) { mstore(add(po, 0x20), add(shl(s, sub(and(shr(sh, a1), 0xffffffff), off)), mul(f, signextend(1, shr(sub(bs, 16), bw))))) }
                    if gt(and(n, 3), 2) { mstore(add(po, 0x40), add(shl(s, sub(and(shr(sh, a2), 0xffffffff), off)), mul(f, signextend(1, shr(sub(bs, 32), bw))))) }
                }
            }
            /// the four lane words of one-word columns over the entries [e, end_), and Σx
            function one(base_, e, end_) -> a0, a1, a2, a3, sum {
                for { } lt(e, end_) { e := add(e, 0x20) } {
                    let entry := mload(e)
                    let xi := shr(32, entry)
                    sum := add(sum, xi)
                    let v := xor(mload(add(base_, shl(5, and(entry, 0xffffffff)))), FLIP8)
                    a0 := add(a0, mul(and(shr(24, v), LO8), xi))
                    a1 := add(a1, mul(and(shr(16, v), LO8), xi))
                    a2 := add(a2, mul(and(shr(8, v), LO8), xi))
                    a3 := add(a3, mul(and(v, LO8), xi))
                }
            }
            let words := shr(5, add(rows, 31))
            let stride := shr(5, add(regionRows, 31))
            switch mul(words, eq(words, stride))                     // the stack path reads whole columns, else default
            case 1 {
                let a0, a1, a2, a3, sum := one(base, pnz, end)
                emit(a0, a1, a2, a3, add(base, shl(5, cols)), rows, add(out, 0x20), shl(7, sum), factor, k)
            }
            default {
                let colBytes := shl(5, stride)
                let pacc := mload(0x40)                              // 4 · words zeroed accumulator words
                calldatacopy(pacc, calldatasize(), shl(7, words))
                mstore(0x40, add(pacc, shl(7, words)))
                let sum := 0
                for { let e := pnz } lt(e, end) { e := add(e, 0x20) } {
                    let entry := mload(e)
                    let xi := shr(32, entry)
                    sum := add(sum, xi)
                    let col := add(base, mul(and(entry, 0xffffffff), colBytes))
                    for { let c := 0 } lt(c, words) { c := add(c, 1) } {
                        let v := xor(mload(add(col, shl(5, c))), FLIP8)
                        let pa := add(pacc, shl(7, c))
                        mstore(pa, add(mload(pa), mul(and(shr(24, v), LO8), xi)))
                        mstore(add(pa, 0x20), add(mload(add(pa, 0x20)), mul(and(shr(16, v), LO8), xi)))
                        mstore(add(pa, 0x40), add(mload(add(pa, 0x40)), mul(and(shr(8, v), LO8), xi)))
                        mstore(add(pa, 0x60), add(mload(add(pa, 0x60)), mul(and(v, LO8), xi)))
                    }
                }
                let off := shl(7, sum)
                let pb := add(base, mul(cols, colBytes))
                for { let c := 0 } lt(c, words) { c := add(c, 1) } {
                    let left := sub(rows, shl(5, c))
                    if gt(left, 32) { left := 32 }
                    let pa := add(pacc, shl(7, c))
                    emit(mload(pa), mload(add(pa, 0x20)), mload(add(pa, 0x40)), mload(add(pa, 0x60)), add(pb, shl(6, c)), left, add(add(out, 0x20), shl(10, c)), off, factor, k)
                }
            }
        }
    }

    /// @dev First maximum.
    function _argmax(int256[] memory s) internal pure returns (uint16) {
        uint256 best;
        unchecked { for (uint256 a = 1; a < s.length; a++) if (s[a] > s[best]) best = a; }
        return uint16(best);
    }
}
