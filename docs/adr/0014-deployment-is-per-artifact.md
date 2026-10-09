---
status: accepted
---

# Deployment is per artifact: engine contracts compute, module contracts hold identity and state, and weight chunks hold the weights

## Context

A loop can contain many modules, and a deployment must decide which composition goes on chain. The loop executor (ADR 0009) is the only composition model of the workbench, and an on-chain graph executor would be a second composition model with its own plan format, readout rules and verification. On chain, a network needs code that computes a step, a place for its weights, and a place for its identity, owner and session state. Big networks have more weights than one contract can hold. On Monad, storage costs more to write than code, and a step of a big network costs more when it reads storage. This decision builds on ADR 0010.

## Decision

### 1. One artifact is one module contract

- On chain, one artifact is one module contract.
- There is no on-chain module graph.
- The only on-chain composition is the tool layers of a network. In a tool layer, the selector calls its tool modules directly (ADR 0010 §11).

### 2. Each contract has one job

The engine ids are `dense-policy` and `threshold-layers`. On chain, each contract has one job:

- Weight chunk: a contract whose runtime code is a STOP byte followed by a maximum of 112 KiB of weights, and nothing else. This is the largest size whose creation (estimate + 10%) still fits one 30M-gas transaction on Monad.

  The official factory deploys chunks with CREATE2. The salt is the content hash of the chunk, so the address commits to the content. This has three results:
  - The factory deploys identical chunks one time, and modules share them.
  - An interrupted multi-transaction deployment can continue.
  - When the factory creates a module, it checks each chunk. It calculates the address of the chunk again.

  Weights stay in code, not in storage.
- Engine contract: pure computation. A module contract gives it the shape, the chunk addresses, the state of the session and the input by STATICCALL. The engine reads the chunks itself. It returns scores, action, counts and the next state. The engine can write nothing. Thus it cannot touch the owner, state or income of a module. An engine id has one or more immutable engine versions (ADR 0017). Engines have no proxy, and nobody upgrades them. The factory lists the versions of each engine id and the latest version. The ADMIN protocol role manages this list (ADR 0016).
- Module contract: what one deployment creates. It holds these items:
  - The identity: engine version, artifact id, task id, shape, chunk addresses and tools.
  - The state of each `(actor, session)`.
  - An owner. At first, the owner is the deployer. The owner has only two powers. The income of the module goes to the owner address. The owner can transfer ownership in two steps (nominate, accept).

  The module holds no funds. A paying contract, for example the mining game, reads `owner()` and pays it. Nobody can change the computation. New weights are a new module contract, which uses all unchanged chunks again.

  Every module runs the same code. Thus each module is a small clone of one module implementation that the factory creates. The clone is 55 bytes plus its identity, and the clone keeps the identity in its code. The owner and state are in the storage of the clone.
- Only the factory creates chunks and modules, together. One factory call creates every missing chunk and then the module in a single transaction. The call creates all of them or none. A deployment can be too large for one transaction. On Monad, the gas estimate + 10% against 30M decides this. Only then does the deployment create its missing chunks in earlier transactions, still through the factory. The last transaction creates the module and the remaining chunks.
- Factory: it creates chunks and module contracts. It checks these conditions:
  - The engine version is one that the factory lists for the engine id. If no version is named, the factory uses the latest.
  - The chunks exist.
  - The shape is valid.
  - Every tool is an official module.

  Then the factory records `isModule`, the per-artifact index and the `ModuleDeployed` event (ADR 0016).
- Any network can be a tool. This includes LIF networks and networks with their own tool layers. The state of a network tool belongs to the calling session. The outermost module contract keeps the tool state with the state of the caller itself. The tool state advances only on the steps on which the caller chooses the tool. It resets with the session. The nesting depth has a limit, so the gas of a step also has a limit.

## Considered Options

- **A graph executor contract for hand-written plans** (a router that executes a bounded DAG of registered modules atomically in one transaction). This is a path with no UI. It has its own binding and readout semantics, and the loop executor does not share them.
- **Compile whole loops into router plans.** A router has no conditional execution, so every tool would run on each step. Tool layers give on-chain composition that runs only the chosen tool.
- **Each module contract contains the full engine code.** Each deployment then pays for the engine. The weights must fit one data contract. Also, the module has no place to keep an owner or application logic.
- **DELEGATECALL into the engine.** This removes the need to pass the state (a maximum of 32 words). But it ties the engine to the storage layout of every module. Also, it lets the engine write anything that a module owns.
- **Weights in the storage of the module, written in batches and locked.** This gives one contract and no chunk limit. But the deployment costs more, and each step costs more on big networks.
- **Lookup tables of precomputed partial sums**, with the table in the code of the engine itself. The tables are much larger than the weights. They do not scale to big networks.
- **The owner points a module to other weight chunks.** This would let a record holder change the weights before a canary challenge arrives (ADR 0018). It would make verification against the artifact invalid. It would also leave LIF state calculated with other weights.

## Consequences

- Multi-network loops run on chain only as a selector network with tool layers. You deploy and verify all other loops one artifact at a time.
- On-chain graph execution needs a new contract for the semantics of the loop executor.
- A module runs the engine version with which it was deployed, for its full life (ADR 0017).
- A step pays for some cold account accesses, 10,100 gas each on Monad. The accesses are the implementation of the module, the engine version and each chunk that the step reads. A single step of `185→32→7` (int8) costs 116,689 gas as a test call (`testGasOfMiningNetworks`, figures in the contracts README). As a real transaction, it costs 100,287 gas, base fee included (`benchmark/network-size.mjs`).
- A 63-step game in one transaction pays the cold accesses one time. For `185→32→7` (int8), the game costs 3,258,388 gas (`testGasOfMiningNetworks`).
- A module alone deploys for about 0.34M gas, on chunks that exist (`testGasOfMiningNetworks`).
- If an artifact fits, the workbench bridge deploys it in one factory transaction. The bridge verifies a module by these items:
  - `isModule` of the official factory.
  - The descriptor of the module.
  - The engine version of the module, which must be one that the factory lists for its engine id.
  - The shape of the module.
  - The chunk addresses of the module.
- A single forward pass must fit one transaction. The limits are 256 neurons for each layer and 8 layers. A design for larger networks splits a forward pass across transactions. The module contract keeps the intermediate activations, and the engine calculates a range of layers. A LIF network splits by ticks. This design is not built.
- If a mining game is too long for one transaction, this is a problem of the game contract, not of the engine.
