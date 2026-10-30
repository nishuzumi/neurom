---
status: accepted
---

# The tank battle imitates the bot before it trains against it

## Context

The tank battle template compares two network structures, 中 (2 layers of 32) and 大 (3 layers of 128). The first version trained each network with REINFORCE alone against the scripted bot. The networks learnt to stand and fire, because that was enough to beat that bot. A change of the reward did not help, so the problem was the opponent and the start, not the reward. Trainers can chain through `init` and `gate` (ADR 0020). A later version had three stages: imitation of a teacher, a Battle City level against patrol bots, and battle training against the bot. This ADR decides which stages the template keeps.

## Decision

The template trains each structure in two stages, with one training module for each structure and stage:

1. Stage 1 · 模仿 (imitation): cross-entropy, with the target `teacher(state)` of the scene. The teacher gives the actions that the hard bot would accept as equally good, with no random action. The teacher and the bot share one rule code.
2. Stage 2 · 对战训练 (battle training): REINFORCE against the hard bot with random actions. The trainer starts from the accepted weights of stage 1 (`init`) and starts only when the agreement with the teacher in the stage 1 report reaches the gate (`gate`).

There is no level stage, and the battle in the script module uses the networks of stage 2.

## Considered Options

- **Battle training from random weights.** Measured in node (2400 epochs, trainer seed 1, 200 test seeds, win rate against the bot): 中 reached 0.865, but 大 reached 0.055. The large network does not learn the battle from random weights, so stage 1 stays.
- **A level stage between imitation and battle training.** The level (one tank against 6 patrol bots and a base to defend) taught the networks to stand and fire: 72% of the actions of 大 were shots, and it stood still in 73% of the steps. The bot of the battle attacks the base, so a network that stands still loses its base. Battle training from the level weights reached 0.66 (中) and 0.47 (大). From the stage 1 weights it reached 0.72 and 0.65. The level stage, its reward and its potential term went away.
- **A fire penalty instead of a stage.** In the level, a penalty of −0.03 for each shot that saw no enemy put the clears back to the stage 1 level: 中 99 → 59 and 大 129 → 62 clears of 200 games.

## Consequences

- The teacher is the hard bot without random actions. A stronger bot gives a stronger teacher, and the two change together.
- Stage 2 starts only when the agreement with the teacher in the stage 1 report reaches the gate. The gate follows the agreement that stage 1 can reach on the current map (ADR 0024 and the user guide give the value).
- The reward of stage 2 lives in its own Params module. A change of the reward does not change the bundle of stage 1, so the artifacts of stage 1 stay compatible.
- These measurements came from the rules before the Botzone Tank2 rules (ADR 0024). The two stages stayed when the rules changed, and the user guide records the results of the current rules.
- Self-play is not part of this decision (ADR 0020).
