# benchmark

[中文](README.md) · English

The scripts in this folder measure the gas of the module contracts with Monad rules and with Ethereum rules. The section "Monad network results" of the root README comes from these scripts.

## Prerequisites

- Node.js ≥ 22.12, with `npm ci` run at the repository root.
- Foundry ≥ 1.8.0 (`forge`, `anvil`).
- `monad-parity.mjs` connects to the RPC of the Monad testnet. It sends only `eth_call`, no transaction, so it needs no funds.

Run all commands from the repository root.

## Scripts

| Script | What it measures | Time |
|---|---|---|
| `monad-parity.mjs` | whether `anvil --network monad` and the Monad testnet charge the same gas | about 40 s |
| `mining.mjs` | the trained mining network: deploy, 63 step transactions, the real charge of one step | about 80 s |
| `network-size.mjs` | 5 networks from small to large: one step, and 63 steps in one transaction | about 3 min |

Other files:

- `mining-network.mjs`: the part that the first two scripts share. It trains `mining-task` (template defaults, seed 1) and plays test episode 0 locally.
- `MonadParity.sol`: the probe contract of the check.
- `NetworkSize.s.sol`: the forge script that `network-size.mjs` runs.

### monad-parity.mjs

```sh
node benchmark/monad-parity.mjs                      # default https://testnet-rpc.monad.xyz
node benchmark/monad-parity.mjs <testnet RPC URL>
```

The probe contract runs only in its constructor. The script sends the same initcode with `eth_call` to three nodes: the Monad testnet, `anvil --network monad` and `anvil --network ethereum`. Each number is a `gasleft()` difference in the probe. If any number differs from the testnet, the script ends with exit code 1.

Result on 2026-10-10:

| Measurement | Monad testnet | anvil --network monad | anvil --network ethereum |
|---|---|---|---|
| EXTCODESIZE, cold account | 10,117 | 10,117 | 2,617 |
| EXTCODESIZE, warm account | 117 | 117 | 117 |
| SLOAD, first slot of a page | 8,116 | 8,116 | 2,116 |
| SLOAD, same page | 117 | 117 | 2,117 |
| SLOAD, another page | 8,117 | 8,117 | 2,117 |
| SSTORE 0 → 1, new page | 27,908 | 27,908 | 22,108 |
| SSTORE 0 → 1, same page | 17,108 | 17,108 | 22,108 |
| Memory expansion by 1 MiB | 16,393 | 16,393 | 2,387,217 |
| Protocol deploy | 9,790,509 | 9,790,509 | 9,749,413 |
| createChunk (weights) | 1,542,481 | 1,542,481 | 1,538,288 |
| deploy (module) | 262,016 | 262,016 | 237,695 |
| forward | 48,949 | 48,949 | 51,529 |
| step | 51,293 | 51,293 | 53,884 |
| forward × 63 | 2,964,912 | 2,964,912 | 3,127,452 |

All 14 numbers are equal. The Ethereum column differs in cold access, storage pages and memory, so these measurements can tell the two rule sets apart.

`eth_call` charges nothing, so this script does not check the rule "a transaction pays for its gas limit". `mining.mjs` checks that rule with the balance.

### mining.mjs

```sh
node benchmark/mining.mjs
```

1. Train the mining network, and play test episode 0 locally.
2. Start `anvil --network monad` and `anvil --network ethereum`. Deploy the protocol contracts in the order of `frontend/anvil.fixture.js`.
3. Deploy the network with `deployModule` of `frontend/module-chain.js`. Then send 63 step transactions with `stepModule`.
4. Compare the on-chain scores with the local scores at each step. If they differ, the script stops with an error.
5. Read gasUsed from the receipts. Compare the balance of the sender before and after the second step transaction to get the real charge.

### network-size.mjs

```sh
node benchmark/network-size.mjs                      # the 5 default networks
node benchmark/network-size.mjs 64@8 256,256@16      # hidden widths@weight bits
```

For each network and each rule set, the script starts a new Anvil node and runs `NetworkSize.s.sol`:

1. Deploy the protocol contracts.
2. Make synthetic weights (±100) and cut them into chunks. A chunk holds at most 114,688 bytes on Monad. On Ethereum it holds at most 24,575 bytes, the EIP-170 code limit.
3. Send one `createChunk` transaction for each chunk, then one `deploy` transaction.
4. Send 8 step transactions with `_miningInput(0..7)`, and take the median gasUsed.
5. Send one more transaction that calls `forward` 63 times in one contract.

Notes:

- The block limit of Anvil is set to 1,000,000,000 gas. A Monad transaction can use at most 30M gas, so a game above 30M must be split into several transactions on Monad.
- The 8-layer network (185→256×7→7) does not run: the script runs out of memory when it puts the weights together on chain.
