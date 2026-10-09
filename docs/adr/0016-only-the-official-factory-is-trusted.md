---
status: accepted
---

# Only the official factory is trusted: it is an upgradeable proxy, modules are not upgradeable, and one immutable Roles contract holds the protocol powers

## Context

The weights of a deployed module are public weight chunks, and anyone can read them with `getCode` (ADR 0014). The bytes and the code hash of a module do not tell where the module came from. The code of each module contains its own identity (artifact id, engine version, chunk addresses and more), and a permutation of hidden units changes the hash of a weight set but not its behaviour. The protocol has powers: it grants and revokes roles, manages engine versions and upgrades the factory, and engines have no proxy (ADR 0017). Before mainnet, a multisig must take these powers from the deployer, the checks of every power must ask one source, and a faulty upgrade must not lock the protocol. This ADR builds on ADR 0014 and ADR 0017.

## Decision

### 1. The official factory

The workbench can check only one thing: who created the module. Thus on each chain the workbench trusts exactly one official factory. A module is genuine only when `isModule` of that factory says so. The rules are:

- Deployment targets are only Monad chains: mainnet (143), testnet (10143) and local `anvil --network monad` (31337). The contracts need MIP-8 paged storage and the 128 KB code limit.
- Each chain has one official factory, deployed separately on that chain. The address of the factory is part of the entry of the chain in `frontend/chain.js`.
- The workbench deploys, verifies and uses tools again only through the official factory. It refuses modules of all other factories, also when their code and weights are identical. The user cannot enter a factory address.
- Verification checks a module against the official factory of the chain. It does not check against the factory that the descriptor of the module names. That factory must be the same as the official factory.
- The official factory on local Anvil is `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0`. This is the proxy that `contracts/script/Deploy.s.sol` creates on a fresh node from the default account 0 (its third contract, nonce 2).
- Testnet and mainnet have no official factory until someone deploys it there. Until then, the workbench deploys and verifies nothing on them.

### 2. The factory proxy and its upgrades

- The factory is behind a proxy, so its address stays the same after upgrades. Upgrades keep its storage (`count`, `isModule`, the per-artifact index, the engine versions).
- The proxy creates the module implementation when it is initialised. Thus every module reports the proxy as its `factory`.
- Modules stay immutable. No upgrade changes the computation of a deployed module (ADR 0017).
- When the proxy is deployed, it gets its Roles contract from `roles()` of the first implementation. Then the proxy keeps the Roles out of the reach of all implementations.
- Only an UPGRADER of that Roles can upgrade. The proxy refuses an implementation that reports a different Roles. Thus the ADMIN checks of the factory and the upgrade check of the proxy always ask the same contract.
- The factory is never sealed, so it is possible to fix it. Its upgrades are auditable. Each upgrade emits `Upgraded(implementation)`, and the source of the new implementation is verified on the explorer.
- An upgrade could mark arbitrary addresses as modules. Thus a contract that pays modules does not use only `isModule`. It also checks that the module is a clone of the module implementation and runs an engine version that it accepts.
- There is no separate engine registry contract. The factory keeps the engine versions and the latest version for each engine id.

### 3. The protocol roles

The powers of the protocol are in one Roles contract. The Roles contract itself is not upgradeable. It has two roles:

- ADMIN grants and revokes roles. It also manages engine versions: it adds a version and sets the latest version (ADR 0017).
- UPGRADER upgrades the factory.

At first, the deployer holds the two roles. During testnet, the account of the deployer keeps them. Before mainnet, a multisig contract gets them, and the signers of that contract can change. Control moves to the multisig in three steps:

1. Grant ADMIN and UPGRADER to the multisig.
2. Check the result.
3. Revoke the roles of the deployer.

Protocol contracts do not use a nominate-and-accept handover. The owner of a module (its payee, ADR 0014) is not a protocol role. The owner keeps its own two-step transfer.

## Considered Options

- **Check the code hash of the module.** The hash is different for each instance because of the immutables. Also, identical code tells nothing about who deployed it.
- **One CREATE2 address on every chain.** The deterministic deployer `0x4e59b448…4956C` exists on Monad mainnet, testnet and Anvil. But `frontend/chain.js` lists the address of each chain in any case. Thus a shared address gives nothing that users need, and each chain gets a separate deployment.
- **A non-upgradeable factory that adds the address of each new version to a list.** Each version then has a different address. The workbench needs a single stable address.
- **Upgradeable modules.** This lets the owner change the computation behind every deployed module, and that breaks on-chain verification. Also, per-instance immutables would move to storage, and this adds SLOADs to every step.
- **Accept other factories with an "unofficial" warning.** Any contract can say that an address is a module. Only the official factory makes `isModule` mean something. A warning does not tell the user if the module is genuine.
- **Seal the factory when it is stable** (an irreversible renouncement of upgrades). This would also prevent fixes to the factory. The checks of the paying contract itself guard what an upgrade could abuse (`isModule`).
- **Detect copies in the factory or the workbench by a weight hash.** A permutation of hidden units changes the hash and nothing else. Thus a copy can have a new hash and the same behaviour. The factory and the workbench record who deployed a module and in which block, and nothing more. Protection against copies belongs to the rules of the contract that calls the modules. In these rules, only a better score than the current record takes the record, and canaries are evidence against plain copies (ADR 0018).
- **An owner for each protocol contract**, each with its own two-step transfer. The handover needs one acceptance for each contract. If you forget one, that contract stays with the deployer key. Also, the owner code exists in more than one contract.
- **Roles kept in the storage of the factory.** This gives one contract fewer. But the factory is upgradeable. If an upgrade breaks the role check, nothing can upgrade the factory again.
- **A separate role for engine versions.** A new engine version cannot change a deployed module. But the same multisig as ADMIN would hold this role, so it gives no benefit.
- **A separate engine registry contract.** It lets the protocol add engines to a sealed factory. The factory is never sealed, so a registry gives no benefit.

## Consequences

- The key of the protocol is the permanent trust root for two things: which addresses count as modules, and which engine version new deployments use. The key cannot change the computation of a deployed module.
- The rule belongs to the workbench, not to the chain. The contracts are MIT. Anyone can deploy their own factory and use it outside the workbench.
- For local development, run `Deploy.s.sol` from the default Anvil account on a fresh node. If you do not, the address of the proxy is not the same as the configured address.
- The address of Roles is fixed when the factory proxy is deployed. The only fix for a bug in Roles is a new proxy, and a new proxy is a new official factory.
- ADMIN can grant UPGRADER to itself. Thus the two roles separate duties, not trust. On mainnet, the multisig holds the two roles.
- It is possible to revoke the last ADMIN, and this is permanent. After that, nobody can grant a role or manage engine versions again.
- The handover script refuses to revoke the roles of the deployer if no other account holds the two roles.
