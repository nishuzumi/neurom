---
status: accepted
---

# Copies are made worthless by the mining game's rules, not detected by the chain

## Context

The workbench deploys no loops (ADR 0014), and the mining game is an application contract that calls modules. The weights of a mining module are public on chain, and a copier can change a copy and keep its actions. A permutation of hidden units changes the weights and nothing else (ADR 0016). A mask that the game applies and derives from the address of the deployer is easy to undo in closed form: flip the first-layer columns and fold the constant into the bias, and the actions stay the same. This ADR decides the rules of the game. The payout (base income, design premium, challenge period) is outside this ADR.

## Decision

The game does not try to detect copies. The rules of the game make copies worthless:

- The game is a hand-written contract. It is the only caller of mining modules. Tests keep it bit for bit the same as the scenario of the template.
- Every mining transaction plays one small map. The seed of the map is `hash(prevrandao, player, counter)`. When a player sends the transaction, `prevrandao` is unknown.

  A wrapper can still look at the outcome inside the transaction and revert. But Monad charges the full gas limit also for a revert. Thus a revert costs as much as a full play.
- Record claims get a score in two steps. First, the claimant registers. Then the game plays a batch of episodes. The seed of the batch comes from a block k blocks after the registration. A registered claim must get a score. If a claim does not get a score, it fails. In one transaction, a single lucky run would take the record. Thus record claims cannot use the one-transaction path.
- Difficulty increases with the total value mined. Each time the total increases by a configured amount, the rules of the next level apply (a larger map, less ore). The aim is that models tuned to an earlier level fall behind. The map of the scenario is a fixed `number[256]` (a maximum of 16×16). Thus levels after that need a larger array, and each step costs more gas.
- The record holder is the first module to get the best score. To take the record, a module must beat the record by δ. A copy of the holder can match the record but cannot take it.
- A canary owner can challenge a new record holder. A canary is a set of secret inputs that the scenario never produces, answered with chosen actions. The owner must commit the canary (hash of triggers, answers and salt) before the deployment of the new holder. Then the owner reveals it. If the canary gets the hit threshold (40 of 64) or more, these things occur:
  - The record is revoked.
  - The module is banned.
  - The record goes back to the previous valid holder.
- The rules aim at score bands (template data). Each band is a share of the optimum of each map. A beam search over trips, with the full map known, estimates the optimum. The bands are:
  - The band of a default training.
  - The band of a strong design.
  - The long-term top.

  The rules are:
  - A 16×16 grid.
  - 63 steps.
  - Capacity 3.
  - Delivery at the base without the end of the episode (many trips).
  - Gold that is rare and valuable (3%, value 10).
  - A 9×9 view.

  `input` encodes these items, in a total of 185 bits:
  - Coal and gold, one bit for each cell in the view. Dirt is not shown.
  - The base offset.
  - The bag.
  - The steps that are left.

  The input has no arrows to the nearest targets.
- Each difficulty level aims at the same bands. A hand-written reference strategy that reads the same bits is the yardstick of each level (like the reference implementation for each task in TapeOut).
- These items are game configuration: δ, the hit threshold, k, and the difficulty levels with their thresholds.

## Considered Options

- **Weight hash.** See ADR 0016.
- **Address-dependent input masks. Networks trained to break on any change.** These have no effect on exact copies, permuted units and the closed-form mask conversion.
- **Keep weights secret (zkML, TEE, a private part of the network off chain).** This conflicts with on-chain execution. Also, it is still possible to distill from the public log of inputs and actions.
- **Two transactions for every play. Ban contract callers.** Two steps are necessary only where a single lucky run can take the record, and that is record claims. An EIP-7702 account bypasses a ban on contract callers. Such an account runs its own code while `msg.sender == tx.origin`.

## Consequences

- To distill a copy and then improve it by δ through real training is legitimate competition.
- Each rule change must occur two times: in the template and in the game contract. The parity tests must pass.
- The gas cost of scoring episodes on chain is not measured.
- The trainer needs a canary option.
- No document tells how Monad produces `prevrandao`, or if a leader can bias it. A leader who can bias it could favour its own plays.
