---
status: accepted
---

# A chain node gives scripts one connection, and a practice challenge runs on a fork

## Context

A user trains a tank network in the workbench. Before the user spends MON on a ladder challenge, the user wants to know if the network can win. Only the ladder contract decides a challenge (ADR 0026). A copy of the rules in JavaScript can differ from the contract.

Three places connect to a chain, each with its own code:

- `frontend/chain.js` connects the Deployment module: a local node with unlocked accounts, Privy, or an injected wallet.
- `frontend/wallet/privy.js` wraps the Privy wallet.
- The ladder page has its own read provider and wallet.

A code module cannot read a chain. It is restricted JavaScript that compiles to IR. It has only value inputs, it is synchronous, and it cannot import (ADR 0010). A script module can await a call, and the page does each call outside the sandbox (ADR 0019). The sandbox has no network (ADR 0013).

We measured on `anvil --network monad` (Foundry 1.8.0) and on the public Monad testnet RPC:

- One challenge of 中 against 中 needs about 140M gas over several transactions.
- `eth_call` has no gas cap on Anvil. The public RPC refuses more than about 150M.
- `eth_simulateV1` exists only on Anvil, and one request stops at 50M gas.
- Only Anvil lets a call set `prevRandao`.
- `challenge` refuses a caller with code (`tx.origin.code.length != 0`). So one helper contract cannot run a whole challenge in one call.
- On a fork, real transactions from an unlocked account, then a revert to a snapshot, played a full challenge in 1.6 s.

## Decision

1. One connection function, `connect(chainId, { write })`, serves every caller. It returns an EIP-1193 `request` and the account. Its adapters are a public RPC (read), a local node with unlocked accounts, Privy, and an injected wallet. A caller that uses ethers wraps the `request` in `BrowserProvider`. A caller that uses viem wraps it in `custom()`.
2. The network registry (`ladder/data/deployments.json`) gets an entry for a local fork of the ladder chain. One function makes the `anvil` command from that entry. The chain node and `ladder/scripts/dev-chain.mjs --fork` both use it.
3. A new module kind, the chain node, gives a connection to script modules. Its configuration names a chain of the registry. It reads by default. "Allow writes" can turn on only for a local node. A public chain needs a signature and real MON for a write, so the chain node never writes there.
4. The script sandbox has viem as a global, the same way it has Vue. When a function input of a script module is wired to a chain node, the script gets `ctx.chain.<name>`: a viem client on that connection. The kind of the wired module decides this, not the name of the input. The page sends each request and refuses methods that the chain node does not allow.
5. A practice challenge runs only on a local fork. The tank battle script does it, from template data:
   - It saves a snapshot.
   - It puts the challenger one rank below the defender in the ladder's `_board` storage.
   - It removes the code of the account that challenges. On Monad testnet, the public Anvil accounts carry an EIP-7702 delegation, and `challenge` refuses an account with code.
   - It plays `challenge`, then `advance` until the challenge settles.
   - It reads the result and the `Steps` events, then reverts to the snapshot.
   - It repeats this for each seed, with a few random blocks between seeds.

   The ladder contract decides each result. The storage slot and the ABI parts are template data.
6. The user puts the challenger on the fork with the existing Deployment module. The script lists the modules of the fork's deployment archive.

## Considered Options

- **Read the chain from a code module.** A code module has no I/O and cannot import a library. Its outputs must depend only on its inputs, because training and replay need this.
- **A "chain module" that decodes weights in the host, and a JavaScript copy of the battle.** This adds a third copy of the engine and a second copy of the rules.
- **Call the defender's `forward` once per step over the public RPC.** About 12,000 calls for 20 seeds, and the rules run in JavaScript, not in the contract.
- **One `eth_call` or `eth_simulateV1` for a whole challenge.** The gas caps and the EOA check stop it (see Context).
- **Give the Deployment module an output for its connection.** One module then deploys and also serves reads for other modules.
- **Run the practice challenge in the ladder page.** This keeps one copy of the challenge loop, but the user wants to practise beside the training in the workbench.

## Consequences

- A practice challenge needs Foundry and a running fork. The chain node shows the command and the two values to enter.
- A restart of the fork loses the deployed challenger, and the user deploys it again. A fork that is started again sees the newest board.
- The template script holds a second, short copy of the challenge loop. The first copy is `ladder/src/chain/client.js`. A test on Anvil runs the template's practice challenge against the current contract, so a change of the contract or of its storage layout fails the test.
- A change of the order of the ladder's storage variables changes the slot in the template data.
- The script sandbox can now reach a chain through the page. It still has no direct network access, and it cannot write to a public chain.
