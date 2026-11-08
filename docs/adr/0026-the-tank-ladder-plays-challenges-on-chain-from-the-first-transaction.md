---
status: proposed
---

# The tank ladder plays each challenge on chain, and an EOA starts it in one transaction

## Context

The tank battle contest ranks entries on a ladder. An entry is a module that the official Factory deployed (ADR 0016). Thus its weights are public (ADR 0014). An episode between two entries is deterministic: both networks are feedforward with an argmax readout. The seed selects the random part of the map, the start cells and the random move after a mutual shot (ADR 0024). The map stays the same after a turn of 180°, so the two episodes of a mirror pair are the same episode with the sides swapped. A challenger who knows the seed can play the 6 episodes offline in less than a second. We measured 0.3 to 0.5 ms for each step in node. Thus a challenger who knows the seed also knows the result of the challenge.

The workbench has no server for accounts or uploads. The chain runs only networks, not scenarios (ADR 0014). We measured on `anvil --network monad` with Foundry 1.8.0. A step transaction of 中 used about 141k gas, and a step transaction of 大 used about 473k gas. A challenge of 6 episodes of up to 100 steps does not fit in one transaction, which has a limit of 30M gas.

Monad has no randomness that validators cannot predict. `PREVRANDAO` is the hash of a BLS signature of the leader over the round number, and the leader schedule is public (`RoundSignature` in [monad-bft `payload.rs`](https://github.com/category-labs/monad-bft/blob/26553fb0d8743fac9a0c752772be353972919dc9/monad-consensus-types/src/payload.rs#L27-L58)). The EVM cannot read the `PREVRANDAO` of an earlier block.

A settlement that succeeds moves the defender and every entry between down one rank. We measured the cost of this shift with a throwaway forge bench (`forge test --network monad`, MIP-8 storage pages, a board of 20). With an unbounded array and a rank field in the entry mapping, each shifted rank cost about 12.1k gas, because each mapping slot is on its own storage page. The worst settlement with 19 shifted ranks cost 284,025 gas. With the ranks only in the array, each shifted rank cost about 0.9k gas, because the array slots are adjacent. The same settlement cost 89,660 gas. The start check costs about 25k more for the scan of the array.

## Decision

- The referee is a hand-written application contract, the ladder contract. It plays the tank scenario on chain, bit for bit the same as the template, and it calls the two entry modules. It selects the action from the scores by argmax itself.
- The ladder is a board of `boardSize` ranks (default 20). The ranks are in one array in rank order. The entry mapping has no rank field. The contract finds a rank with a scan of the array. The bound keeps the scan and the shift small.
- A new entry takes the last rank when the board is not full. Else it is off the board, with rank 0. It still counts as an entry.
- An entry off the board challenges as the rank below the last. The defender must be on the board.
- A challenge is 3 mirror pairs. The challenger succeeds only when it wins more episodes than the defender. When both win the same number, the entry whose weight size is smaller by at least δ wins. Thus a copy of the defender (the same actions from the same or permuted weights) cannot take the rank of the original.
- An episode that gets to the step limit goes to the side with more lives. Only equal lives give a draw. The template uses this rule too, so the training objective and the contest agree. This changes the draw rule of ADR 0024.
- Only an EOA without code can start a challenge: `msg.sender == tx.origin` and `tx.origin.code.length == 0`. The second check refuses an EIP-7702 account, which runs its own code while `msg.sender == tx.origin` (ADR 0018).
- The challenge starts in the first transaction. The seed is `keccak(block.prevrandao, challengeId)`. On entry, the contract requires a `gasleft()` of at least 80% of the transaction limit (24M of 30M). The transaction plays steps until the gas that is left falls below a reserve. Then it saves the position. The reserve is more than the maximum gas of one step plus the save. Thus no seed can make the transaction run out of gas.
- Anyone can call `advance(challengeId)` to play more steps. The seed is fixed, so the caller has no effect on the result.
- A challenge that does not end within M blocks is a defense.
- The challenger pays all gas, also the gas of the network of the defender. The maximum weight size is the weight size of 大 (216,864 bytes).
- These items are contract configuration: δ, M, the cooldown, the gas threshold, the reserve, the maximum weight size, the board size and the end block of the season.

## Considered Options

- **A server referee.** A server can keep the weights secret, and it plays at almost no cost. But the repo has no accounts, uploads or database, and the players must trust the operator. Secret weights do not stop distillation from replays (ADR 0018).
- **Pyth Entropy for the seed.** No validator can predict it. But it adds an oracle fee, a callback and trust in the provider, who can compute the result before the reveal. We do not assume that a challenger controls or bribes a validator, so the native source is sufficient.
- **`BLOCKHASH(R + 3)` after a registration transaction.** The seed is not known at registration. But after block R + 3, a challenger can read the seed from any RPC and stop at no cost. Then a deposit must make the stop expensive. This needs one more transaction and a deposit.
- **The `PREVRANDAO` of the first transaction without the EOA check.** A wrapper contract or an EIP-7702 account runs code in the same transaction. It can read `block.prevrandao`, or let the first steps play and then read the position. Then it reverts when the challenge looks bad. Each look costs only the gas limit of the transaction.

## Consequences

- The ladder assumes that no challenger controls or bribes a validator. The leader of a block knows its `PREVRANDAO` before the block, so it can include a challenge only in a good block. If the prizes become large, a new ladder contract must take its seed from Pyth Entropy.
- After the first transaction, the challenger knows the result. It can stop and keep the gas of the other transactions. The challenge then counts as a defense, and the cooldown applies.
- Each rule change must occur two times: in the template and in the ladder contract. The parity tests must pass.
- A challenger from off the board that succeeds pushes the last entry off the board. That entry comes back with a challenge that succeeds.
- When the defender was pushed off the board while the challenge played, the challenger still wins the challenge, and the wins and losses count. But no rank changes. This occurs only when the challenger is off the board too.
- On `anvil --network monad` (Foundry 1.8.0), the EOA check refused a wrapper contract and an EIP-7702 account. The code of a delegated account is 23 bytes (`0xef0100` and the delegate address). We did not test this on a Monad network.
- The ladder contract writes the input bits of each side directly into the call buffer. On `anvil --network monad`, one step used about 0.23M gas for 中 against 中 and 0.93M gas for 大 against 大 (median of the play loop, `contracts/scripts/ladder-gas.mjs`). A transaction of 30M gas plays about 121 steps of 中 against 中 and 31 steps of 大 against 大. A challenge of 大 against 大 of 600 steps needs about 20 transactions.
- The start transaction must have a gas limit of 30M. With a limit of 24M, the gas that is left at entry is below the threshold.
- The EOA check can also stop the wrapper attack on the mining game (ADR 0018). This ADR does not change ADR 0018.
