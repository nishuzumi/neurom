---
status: accepted
---

# A network calls tools through tool layers

## Context

A selector network must call other modules as tools and compute on what the tools return. The network must give a tool what its earlier layers compute. Its later layers must see the result of the tool. Only the chosen tool may run on each step, in the workbench and on chain. This ADR builds on ADR 0006 and ADR 0009. ADR 0014 describes the module contracts on chain.

## Decision

Tools are one layer inside the selector network. The tools see what comes out of the layers before them. What the tools return goes on to the layers after them.

### 1. The structure is a layer list

The `layers` of `dense-policy` is a list of two types of layers:

- Plain layers `{ hidden: n }`.
- Tool layers `{ tools: <port>, data? }`.

The output layer is implicit. But if the last entry is a tool layer, the result bits of that tool layer are the output (§4). The only hard limit is the on-chain weight blob (`MAX_WEIGHT_BYTES`).

Only `dense-policy` hosts tool layers. `threshold-layers` trains only by hinge (§6). Thus it can be a tool, but it can never be a host.

### 2. A tool layer declares a call port

Each tool layer declares one call input. The `tools` entry of the layer gives the name of the input. The input takes any number of tools (ADR 0006: the port comes from the declaration). Tools are ordinary modules wired into the input, in wire order. The graph stays flat.

### 3. A tool is a function `(bits) → bits`

A tool is one of these:

- An export of a code module with that signature.
- A frozen network, through the `run` output of the readout that reads it. The network can be of any kind: FF, LIF, or a network with its own tool layers.

> **Note (ADR 0019):** First, only a bits-mode readout gave `run`. Now an argmax readout also gives `run`. It returns the one-hot bits of the first maximum, and its width is the length of the map. Such a tool runs in the workbench and in Python with the same bits. On chain, a tool layer reads the scores of a tool as bits (score ≥ 0, §11). Thus it is not possible to deploy a network that has an argmax tool.

The signature of each tool gives the widths:

- `D` data bits. If `data` is declared, `D` is `data`. If not, `D` is the input width of the widest network tool. Code tools have the type `bits[D]`.
- Results are zero-extended to `R`. `R` is the widest output.

Each step runs only the chosen tool.

The state of a network tool belongs to the calling session. In that session, the tool state comes after the state of the caller itself, in tool-layer order and then wire order (recursively). The tool state advances only on the steps on which the caller chooses the tool. It resets with the session.

Tools nest a maximum of `MAX_TOOL_DEPTH` = 3 deep. In the workbench, a deeper tool is a network problem. On chain, the Factory refuses it. A nested tool must be wired to the tools with which its artifact was trained.

### 4. What a tool layer computes

A decision head on the layer before gives `K` choice logits and `D` data-bit logits. In greedy mode, the head picks the first maximum, and a data bit is 1 when its logit > 0. In training, the head samples. The next layer sees `result (R) ‖ the layer before`.

In LIF, tool layers cut the network into segments. Each segment runs all ticks. The head reads spike counts. The next segment sees which neurons fired.

### 5. Weights

The weights are one blob in layer order:

- Each plain layer: `W | b`.
- Each tool layer: `Wc[K][prev] | bc[K] | Wd[D][prev] | bd[D]`.
- Then the `W | b` of the output layer, but not if the last entry is a tool layer.

ADR 0015 sets the width of the weights, the scale of each layer and the layout inside a layer.

### 6. Training: REINFORCE only

A network with a tool layer trains only by REINFORCE, in the two back ends. Every discrete decision goes into one policy gradient on the episode reward. The discrete decisions are the choice, the data bits and the readout action. Supervised methods would need a gradient through a discrete layer.

### 7. The loop body

The loop body is networks, readouts and bit wires. No module in the loop calls tools.

### 8. Frozen networks own their artifact

If no trainer trains a network, the network names its accepted artifact in its own config (`artifact`). The trained network continues to use `candidates → weights`.

### 9. On the canvas

A network card has one foldable sub-canvas for each tool layer. The sub-canvas holds the modules that are wired only into that tool layer. An execution highlights the chosen tool of each step, with its data and result.

### 10. What the loop exposes

The executor adds `transition.loop.<network title>.<tool port> = { choice, data, result }` on each step. Network titles in one loop must be unique.

### 11. On chain

Each tool network is a separate module contract. The selector stores the addresses of its tools and calls only the chosen tool. Thus any selector can use a deployed tool again. The selector finds the tool through `modulesOf` and verifies it against its artifact.

A tool is any module of the same Factory whose widths fit `D` and `R`. The tool can have state or be nested. It is not possible to deploy a code tool.

The selector keeps the state of each tool in its own session state. `stateWidth` counts these states, with a maximum of 256 int32. The selector gives the chosen tool its slice through `forwardFrom(state, data)`. Then the selector writes back the next state that the tool returns. The selector never uses the storage of the tool module.

The Factory records the nesting depth of each module (`depthOf`). The Factory refuses a module deeper than `MAX_TOOL_DEPTH` (`depth`).

## Considered Options

- **A `call` module in the loop.** A policy only picks a tool. The data goes to the tools directly from the loop, never through the network that the trainer trains. The result of a tool can only become the action.
- **Tools in the loop, with data routed through the selector.** This is smaller. But the network can never compute on the result of a tool.
- **Tools as artifact ids in the network config.** Only networks could be tools. Executions could not show the calls.
- **A fixed `before / tools / after` structure.** This allows only one tool layer.
- **Tool layers only in FF networks.** This would exclude LIF hosts.
- **A `call` module adjacent to tool layers.** This gives two ways to do one thing. It doubles the executors, trainers and deployments.
- **Pack the weights of every tool into the selector contract.** This is large and not reusable. Each change to a tool needs a new deployment.

## Consequences

- It is not possible to choose a network from a code module.
