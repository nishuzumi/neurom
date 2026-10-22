---
status: accepted
---

# The limit of ports, actions and layer widths is 65535

## Context

The workbench and the contracts limited the inputs, outputs and layer widths of a network to 256. Bit Wires, scenario `input`, readout maps and the action of a loop used the same limit (`MAX_BITS`). The limit stopped tasks whose input does not fit in 256 bits, for example a full map with several channels. No contract is deployed yet, so a change needs no compatibility.

## Decision

One limit, 65535, applies to these items, in the workbench (JS and Python) and in the contracts:

- The input bits of a network, of a Bit Wire and of the scenario `input`.
- The outputs of a network, the entries of an argmax map, and the action. The action of `INeuromModule` changes from `uint8` to `uint16`.
- The width of a layer. The layer descriptor of the engines changes from a 9-bit width to a 16-bit width.

These limits do not change:

- At most 8 layers.
- `MAX_STATE`, the state that a LIF module keeps for each session. It sets the cost of chain storage, so a wide LIF network can be refused at deployment.
- At most 53 bits for an `lsb-int` bits readout. This limit comes from the precision of a JS number.

The user of a large network controls its cost. The workbench does not refuse a network because of gas.

## Considered Options

- **Keep 256.** It stops tasks that need more input bits.
- **Raise only the workbench limit, and check the chain limit at deployment.** This keeps two limits, and a network can then train but not deploy.
- **Raise only the input limit.** The outputs and the layer widths would need a second change later.

## Consequences

- The factory, both engines, `INeuromModule` and the weight encoding in JS change together. The contract tests and the JS/Python parity corpus cover the new widths.
- Deployment and each step cost more gas for large networks. The first layer has inputs × width weights.
- The mining game keeps its fixed map of 256 cells (ADR 0018). Only its rules limit it.
