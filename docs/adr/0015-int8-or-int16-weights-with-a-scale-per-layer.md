---
status: accepted
---

# Weights are int8 by default or int16, with a scale per layer, computed column by column

## Context

This ADR sets the weight format of the blob of ADR 0010 §5. It builds on ADR 0014. The engines read integer weights from weight chunks. A narrow weight makes the step and the deployment cheaper. Some networks get a benefit from more precision. The correct scale of the weights is known only after training.

## Decision

The config of each network sets `weightBits`: 8 (the default) or 16. The two engines (`dense-policy` and `threshold-layers`) run the two widths with the same column method, 32 or 16 weights per word. Biases are int16. The default is int8, because int8 gives the cheaper step and deployment (`testGasOfMiningNetworks`, gas table in the contracts README). int16 is for networks that get a benefit from it.

- The memory map template uses 16. Mining, the combiner and the arithmetic tools use 8.
- The scale is per layer, and the trainer chooses it. The largest |weight| of each layer maps to the largest code of the width (127 or 32767). Thus no weight is clipped, and templates do not set `scale`.
- Biases use a finer unit than the weights. The accumulator unit of the layer is the weight unit / 2^k. k ≥ 0 is the largest value for which the biases still fit int16. Thus the engine shifts the sum of each neuron left by k before it adds the bias. The threshold of a LIF layer is 1.0 in real units, expressed in that unit (in the int32 range).
- Training reports clipped weights and biases for each layer, in the browser and in Python. With a scale per layer, this number should be zero.
- The engine calculates column by column. In the chunk, the weights of one input for all neurons of a layer are together. Each active input adds its full column at one time, with several neurons in each word. With synthetic weights, one 63-step game of `185→32→7` costs 3,258,388 gas (int8). `185→64→32→7` costs 6,573,514 gas (`testGasOfMiningNetworks`, contracts README).

## Considered Options

- **int8 only.** This gives one weight path. But no network could choose more precision.
- **One `scale` for each template, set by hand.** This works when it is tuned for each template. But the correct value is known only after training.
- **More layers instead of a wider range.** Several coarse weights can add up to a finer weight. But no number of layers removes the limit on a single connection, and each layer costs gas.
- **int8 biases.** Each layer has only a small number of biases, so int8 biases save few bytes.

## Consequences

- The engines, the bridge and the two training backends have two weight widths.
- On-chain tests run each model whose weights fit int8 at the two widths (`contracts/test/Modules.t.sol`).
