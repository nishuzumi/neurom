---
status: accepted
---

# A module is pinned to an engine version for life, and engine versions are immutable

## Context

This ADR builds on ADR 0014 and ADR 0016. It keeps the rule of ADR 0016: no upgrade changes the computation of a deployed module. Engines need new versions to cost less gas or to fix a fault. A module whose computation can change cannot carry a verified result. On-chain verification and mining records depend on a fixed computation for each module.

## Decision

Each engine version is a separate contract. It is deployed one time and never changed. Nobody upgrades an engine version. For each engine id, the factory keeps the list of its versions and which version is the latest. ADMIN adds a version and sets the latest (ADR 0016). These rules apply:

- Versions are only added. Nobody changes or removes them.
- An address is a version of only one engine id.
- When ADMIN adds a version, that version does not become the latest.
- Only an added version of the same engine id can become the latest. Thus ADMIN can also set an older version back as the latest.

A deployment uses the latest version, but the deployer can name another listed version of the same engine id (`ModuleSpec.version`, zero = the latest). The identity of the module records the address of that version. After that, nothing can change it: not the owner of the module and not the protocol. If a module must run a newer version, deploy it again. The new module uses its unchanged weight chunks again (a module alone costs about 0.34M gas, `testGasOfMiningNetworks`, contracts README).

All versions of one engine id calculate the same results, bit for bit. A version exists to cost less gas or to fix a fault, never to change the numbers. A change of numerics is a new engine id (for example `other-engine`). The workbench has one integer model for each engine id, for training, quantisation and verification. Thus an artifact behaves the same on every version of its engine.

Before ADMIN adds a version, the version is checked against the latest version of its engine id on a fixed set of inputs (`contracts/scripts/engine-version-check.mjs`). Its source is verified on the explorer. The add and the change of the latest version emit events. Thus engine versions get an audit one time, when they are added.

An engine can write nothing (STATICCALL). Thus a faulty version can calculate wrong results or run out of gas, but it cannot take funds. A paying contract, for example the mining game, refuses the versions that it does not accept.

## Considered Options

- **Upgradeable engine proxies.** Optimisations and fixes go to every module at the same time. But the computation of every module, on-chain verification and mining records then depend on the key of the protocol. The key must keep the numerics the same in every upgrade.
- **The owner of the module switches its version later.** The version moves to storage, and each step needs one more read. Also, a switch changes the computation under a record that the module already holds.
- **The caller names the version on every call.** Then the module does not have one computation. Thus a result is not clearly the result of the module.
- **Versions of one engine id with different numerics.** The workbench would need one integer model for each version. Also, the user would have to choose the version before training, not at deployment.

## Consequences

- A step calls the version directly. Measured with Monad rules (`testGasOfMiningNetworks`, contracts README):
  - A single step of `185→32→7` int8: 116,689 gas as a test call. As a real transaction: 100,287 gas, base fee included (`benchmark/network-size.mjs`).
  - A 63-step game of `185→32→7` int8 in one transaction: 3,258,388 gas.
- UPGRADER only upgrades the factory (ADR 0016). Nobody upgrades an engine.
- Every version stays on chain permanently. The modules that use them keep their gas cost, also after a cheaper version exists.
- The factory checks only two things: the version has code, and the version is not already listed. Thus ADMIN can add any contract as a version and make it the latest.
- The chain does not make sure that all versions of an engine id calculate the same results. Two things make sure of it: the bit-for-bit check before the add, and the source verified on the explorer.
- A wrong version never gets to a module that is already deployed. But new deployments that use the latest version run the wrong version until ADMIN sets the latest back.
- The workbench shows the version number of each module, and if it is the latest.
