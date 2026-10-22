// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./EngineBase.sol";

/// @title ThresholdLayersEngine — engine "threshold-layers": the arithmetic layer models (ADD4 / SUB4 / MUL4), exact.
/// @notice A stack of integer threshold layers. Each neuron j of layer l computes
///         h_l[j] = ((Σ_i W_l[j,i]·h_{l-1}[i]) · 2^k_l >= th_l[j]), with h_0 = the input bits. This is the rule that
///         frontend/runtime/threshold-layers.js layersStep evaluates.
///         Stateless (kind FF), no tools. scores[a] = (Σ_i W_L[a,i]·h_{L-1}[i]) · 2^k_L − th_L[a], so "scores[a] >= 0"
///         means "output neuron a fired". action = first argmax. counts = the activations of every hidden layer, in
///         layer order.
///
///         Shape (two words): shape[0] holds width_l at bits [16·l, 16·l + 16) for l = 0 (inputs) .. L (outputs),
///         zero above. 1 ≤ L ≤ 8, every width 1..65535. shape[1]: [0, 8) weightBits (8 or 16). The shift k of map l
///         (l = 0 .. L − 1, the map that produces width l + 1) is at [8 + 5·l, 13 + 5·l). Every k ≤ 20, zero above
///         the last map's.
///         Weights (EngineBase layout, at weightBits): per map one region of width_l rows over width_{l-1} columns.
///         Its (int16) bias column holds th_l.
contract ThresholdLayersEngine is EngineBase {
    uint256 public constant MAX_LAYERS = 8;
    uint256 public constant MAX_WIDTH = 65535;
    uint256 public constant MAX_SHIFT = 20;

    function check(uint8 kind, uint16 inputs, uint16 outputs, uint256[] calldata shape, uint256[] calldata tools)
        external pure returns (uint256 weightBytes, uint256 stateWidth)
    {
        require(kind == ModuleKinds.KIND_FF, "kind");
        require(tools.length == 0, "tool");
        require(shape.length == 2, "shape");
        uint256 widths = shape[0];
        uint256 layers = _layers(widths);
        require(layers >= 1 && layers <= MAX_LAYERS && widths >> (16 * (layers + 1)) == 0, "layers");
        require(widths & 0xffff == inputs && (widths >> (16 * layers)) & 0xffff == outputs, "shape");
        uint256 p = shape[1];
        uint256 bits = p & 0xff;
        require(bits == 8 || bits == 16, "bits");
        require(p >> (8 + 5 * layers) == 0, "shift");
        for (uint256 l; l <= layers; l++) {
            uint256 w = (widths >> (16 * l)) & 0xffff;
            require(w >= 1 && w <= MAX_WIDTH, "width");
            if (l > 0) {
                require((p >> (8 + 5 * (l - 1))) & 31 <= MAX_SHIFT, "shift");
                weightBytes += regionBytes(w, (widths >> (16 * (l - 1))) & 0xffff, bits);
            }
        }
        stateWidth = 0;
    }

    function run(uint8, uint16, uint16, uint256[] calldata shape, address[] calldata chunks, uint256[] calldata, uint256[] calldata, bytes calldata input)
        external view returns (int256[] memory scores, uint16 action, uint8[] memory counts, int32[] memory voltages)
    {
        uint256 widths = shape[0];
        uint256 layers = _layers(widths);
        uint256 p = shape[1];
        uint256 bits = p & 0xff;
        Vec memory h = _input(input, widths & 0xffff);
        bytes memory blob = _load(chunks);
        uint256 hidden;
        for (uint256 l = 1; l < layers; l++) hidden += (widths >> (16 * l)) & 0xffff;
        counts = new uint8[](hidden);
        uint256 pos;
        uint256 at;
        for (uint256 l = 1; l <= layers; l++) {
            uint256 outW = (widths >> (16 * l)) & 0xffff;
            int256[] memory z = _affine(blob, pos, outW, h, -1, bits, (p >> (3 + 5 * l)) & 31);   // Σ_i W·h · 2^k − th
            pos += regionBytes(outW, h.width, bits);
            if (l == layers) { scores = z; break; }
            h = _fire(z, 0, counts, at);
            at += outW;
        }
        action = _argmax(scores);
        voltages = new int32[](0);
    }

    /// @dev L: the index of the last nonzero width.
    function _layers(uint256 widths) private pure returns (uint256 l) {
        while (l < MAX_LAYERS + 1 && (widths >> (16 * (l + 1))) & 0xffff != 0) l++;
    }
}
