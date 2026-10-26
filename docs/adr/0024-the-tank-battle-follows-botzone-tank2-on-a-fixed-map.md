---
status: accepted
---

# The tank battle follows Botzone Tank2 on a fixed map with two passages

## Context

The tank battle template needs rules that a small integer network can learn, and a battle in which two tanks meet. The first rules were a 1v1 game that only borrowed the look of Battle City (bricks, steel, a base), with a bullet that flies 2 cells per step. The Namco games (Tank Battalion, Battle City, Tank Force) and their hacks have no PvP mode, so they give no rules for a battle between two sides. The only published PvP rules of this family are Botzone Tank, Tank2 and Tank2S (the AI course contests of Peking University). Tank2 plays a 9×9 map with a base at each end, 2 tanks for each side, a shot that is a ray, a cooldown of 1 step, and a random map around a fixed centre. Rules are template data (ADR 0004), so this ADR decides only the content of the scene of one template.

## Decision

The scene of `tank-battle` follows the rules of [Botzone Tank2](https://wiki.botzone.org.cn/index.php?title=Tank2) with three changes to the rules, and it plays one fixed map:

- Each side has 1 tank, not 2. The network gives one action of 9 (4 moves, 4 shots, wait). With 2 tanks it would learn 81 combinations, and the scene would need bot rules for two tanks. The rules of a scene have a limit of 4096 nodes.
- Each tank has 2 lives. Tank2 has two tanks for each side, so 2 lives keep the same amount of force. A hit does not end the game at once, so each game gives more training signal. A tank that loses a life returns to its start cell at the end of the step, without a time of immunity. Tank2 has no such rule, because it has no lives.
- An illegal action counts as wait, not as a loss. A network also gives illegal actions, above all at the start of training.
- The map is one fixed map. Only the start cells come from the seed. The fixed part of Tank2 stays (the bases, the bricks around them and the brick column in the middle). The middle row has only two brick cells, (3, 4) and (5, 4). The other cells of that row are steel and water. Thus both tanks must go through one of the two passages.

The other rules of Tank2 stay: a shot is a ray that hits in the same step, a shot hits bricks and bases of both sides, moves resolve before shots, two tanks can overlap, a cooldown of 1 step, water that a tank cannot enter and a shot flies over, and a draw after the step budget (100).

## Considered Options

- **Keep the first rules (a bullet that flies 2 cells per step).** They were our own rules, with no published source and no reference bot.
- **Tank2 with 2 tanks for each side.** The action space is 81 combinations, and the scene would need a bot for two tanks. The scene has a node limit, and the rule code of two tanks did not fit well.
- **Tank2 with 1 tank on random maps.** Measured in node (teacher imitation, trainer seed 1, 200 test seeds): on random maps the network 大 reached an agreement of 0.43 with the teacher after 2000 epochs (about 4 minutes), and a win rate of 0.16 against the hard bot. On one fixed map, 中 reached 0.99 after 600 epochs (41 seconds) and 大 reached 0.99 after 300 epochs (16 seconds), with win rates of 0.59 and 0.60. The gate of stage 2 needs 0.9. The teacher finds a path on each new map, and the network could not learn that.
- **Tank2 with 1 tank and a middle row that bricks alone close.** This was measured on the random Tank2 maps, where every brick of the middle row can be shot away. With 1 tank for each side, nobody can defend while the other attacks. Two attacking bots nearly never met: the mean number of kills in a game was close to 0, so the 2 lives had no effect, and a game ended after 21 to 26 steps when a base fell. An attacking bot beat a bot that only hunted the tank in 76% to 80% of games, and a bot that went home to defend lost to an attacker. The difficulty levels could not differ.

## Consequences

- The two passages make the tanks meet in the middle. Dodging, return fire and the 2 lives then matter.
- The teacher and the bot of the scene follow the Tank2 rules. The hard level (block a shot at the base) rarely triggers on this map, so the medium and hard bots give the same results. The user guide records this.
- There is no random map, so the network can remember the map. The start cells are the only variation of a game. The start cell of each side comes from the hash `rand(seed, side)`, because the first draws of adjacent seeds are nearly the same.
- The input is 572 bits: 7 channels of 81 cells (brick, steel, water, own base, enemy base, own tank, enemy tank) and 5 bits (each side fired in the last step, each side has 2 lives, bias). The step budget of the template is 100, as in Tank2.
- The ray hits in the same step, so there is no bullet on the map and no bullet channel in the input. The replay and the battle view draw the trail of each shot from `trails`.
- The template, its tests and the user guide changed together (template revision 11).
