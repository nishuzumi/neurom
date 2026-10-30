---
status: accepted
---

# The tank battle follows Botzone Tank2 on a map with two passages and a random quarter

## Context

The tank battle template needs rules that a small integer network can learn, and a battle in which two tanks meet. The first rules were a 1v1 game that only borrowed the look of Battle City (bricks, steel, a base), with a bullet that flies 2 cells per step. The Namco games (Tank Battalion, Battle City, Tank Force) and their hacks have no PvP mode, so they give no rules for a battle between two sides. The only published PvP rules of this family are Botzone Tank, Tank2 and Tank2S (the AI course contests of Peking University). Tank2 plays a 9×9 map with a base at each end, 2 tanks for each side, a shot that is a ray, a cooldown of 1 step, and a random map around a fixed centre. Rules are template data (ADR 0004), so this ADR decides only the content of the scene of one template.

## Decision

The scene of `tank-battle` follows the rules of [Botzone Tank2](https://wiki.botzone.org.cn/index.php?title=Tank2) with four changes to the rules, and it plays a map with a fixed part and a random part:

- Each side has 1 tank, not 2. The network gives one action of 9 (4 moves, 4 shots, wait). With 2 tanks it would learn 81 combinations, and the scene would need bot rules for two tanks. The rules of a scene have a limit of 4096 nodes.
- Each tank has 2 lives. Tank2 has two tanks for each side, so 2 lives keep the same amount of force. A hit does not end the game at once, so each game gives more training signal. A tank that loses a life returns to its start cell at the end of the step, without a time of immunity. Tank2 has no such rule, because it has no lives.
- An illegal action counts as wait, not as a loss. A network also gives illegal actions, above all at the start of training.
- After a mutual shot, each side makes one random move or wait (4 moves and wait, no shot) instead of its own action. The random number comes from the episode seed, the step and the side. In Tank2 a mutual shot counts as no action, so both tanks can fire again in the next step. With 1 tank for each side, two tanks face to face then fire at each other until the step budget ends. Measured on the fixed map of revision 13, seeds 1 to 200 with no random actions: without this rule, 65 to 98 of 200 games of a stage 2 network against the medium or hard bot ended in such a loop. With this rule, 0 to 4 games end after 100 steps, and 中 beats the hard bot in 124 games instead of 76.
- The fixed part of the map keeps the fixed part of Tank2 (the bases, the bricks around them and the brick column in the middle) and the two top and two bottom rows. The middle row has only two brick cells, (3, 4) and (5, 4). The other cells of that row are steel and water. Thus both tanks must go through one of the two passages.
- The random part is the banks of the river (rows 2, 3, 5 and 6, without the middle column and the water at the edges). The seed decides 7 cells of the top-left quarter. Each cell is mirrored left to right and turned 180°, so the map stays the same for both sides. At most 2 of the 7 cells are steel or water. The other cells are bricks with a probability of 1/2. Steel and water never go on (3, 3) in front of a passage, and never on both (1, 2) and (2, 3), so every empty cell and every brick stays reachable. Seeds 1 to 200 give 190 different maps.

The other rules of Tank2 stay: a shot is a ray that hits in the same step, a shot hits bricks and bases of both sides, moves resolve before shots, two tanks can overlap, a cooldown of 1 step, a mutual shot cancels both shots, water that a tank cannot enter and a shot flies over, and a draw after the step budget (100).

## Considered Options

- **Keep the first rules (a bullet that flies 2 cells per step).** They were our own rules, with no published source and no reference bot.
- **Tank2 with 2 tanks for each side.** The action space is 81 combinations, and the scene would need a bot for two tanks. The scene has a node limit, and the rule code of two tanks did not fit well.
- **Tank2 with 1 tank on random maps.** Measured in node (teacher imitation, trainer seed 1, 200 test seeds): on random maps the network 大 reached an agreement of 0.43 with the teacher after 2000 epochs (about 4 minutes), and a win rate of 0.16 against the hard bot. On one fixed map, 中 reached 0.99 after 600 epochs (41 seconds) and 大 reached 0.99 after 300 epochs (16 seconds), with win rates of 0.59 and 0.60. The gate of stage 2 needs 0.9. The teacher finds a path on each new map, and the network could not learn that.
- **Tank2 with 1 tank and a middle row that bricks alone close.** This was measured on the random Tank2 maps, where every brick of the middle row can be shot away. With 1 tank for each side, nobody can defend while the other attacks. Two attacking bots nearly never met: the mean number of kills in a game was close to 0, so the 2 lives had no effect, and a game ended after 21 to 26 steps when a base fell. An attacking bot beat a bot that only hunted the tank in 76% to 80% of games, and a bot that went home to defend lost to an attacker. The difficulty levels could not differ.
- **Random actions in the battle (10% for each side in each step).** This also broke the loop of mutual shots, but it changed every step of a battle, and the networks also played random actions. The battle has no random action now.
- **A mutual shot that counts as a shot (both sides cool down).** This was not measured. Both sides cool down in the same step and can fire again in the step after, so the loop would only repeat every 2 steps.
- **One fixed map (template revisions 11 to 13).** The start cells were the only variation, so a battle had at most 100 starts. Measured on seeds 1 to 200 with no random actions (revision 13): 中 beat the hard bot in 124 games and lost 58, and 大 beat it in 123 and lost 58. The larger network had nothing more to learn.
- **Random bricks only (steel and water fixed).** Measured in node: the agreement of stage 1 was 0.763 for 中 (2500 epochs) and 0.837 for 大 (900 epochs). Thus the networks can learn a map that changes, and 大 already led 中. This ADR adds steel and water with a limit, and more epochs.

## Consequences

- The two passages make the tanks meet in the middle. Dodging, return fire and the 2 lives then matter.
- The teacher and the bot of the scene follow the Tank2 rules. Blocking a shot at the base rarely triggers on this map. Thus the hard level gets its lead from the step count: a brick costs 2 steps, and each brick before the base costs 2 steps more to dig (template revision 12). The user guide records the results of the levels.
- The network cannot remember one map. The agreement of stage 1 on the 256 test episodes is about 0.75 for 中 (5000 epochs) and 0.86 for 大 (2500 epochs). Thus the gate of stage 2 is 0.7. 大 now beats 中: against the hard bot with no random actions it wins 67 of 200 games and loses 98, and 中 wins 54 and loses 118. Both networks still lose more than they win against the hard bot. The user guide records the results.
- The start cell of each side comes from the hash `rand(seed, side)`, because the first draws of adjacent seeds are nearly the same. The cells of the random part come from `rand(seed, k)` with other keys.
- The input is 572 bits: 7 channels of 81 cells (brick, steel, water, own base, enemy base, own tank, enemy tank) and 5 bits (each side fired in the last step, each side has 2 lives, bias). The step budget of the template is 100, as in Tank2.
- The ray hits in the same step, so there is no bullet on the map and no bullet channel in the input. The replay and the battle view draw the trail of each shot from `trails`.
- Two bots still draw many games after 100 steps, because both tanks wait on the two sides of a brick of a passage. The side that shoots the brick first opens the ray for the other side. A stage 2 network nearly never waits there.
- The template, its tests and the user guide changed together (template revisions 11, 13 and 14).
