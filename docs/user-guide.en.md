# User guide

[中文](user-guide.md) · **English**

This guide tells you how to install, try and test the Neurom workbench. Each section tells you where to click and what you must see. The [frontend guide](../frontend/README.en.md) gives all the canvas operations. [CONTEXT.md](../CONTEXT.md) gives the terms.

## Contents

1. [Prepare](#1-prepare)
2. [Start the workbench](#2-start-the-workbench)
3. [Five minutes with the combiner](#3-five-minutes-with-the-combiner)
4. [Train your first model: mining](#4-train-your-first-model-mining)
5. [Change the rules](#5-change-the-rules)
6. [Train in Python](#6-train-in-python)
7. [Deploy on a local chain](#7-deploy-on-a-local-chain)
8. [Save, share and templates](#8-save-share-and-templates)
9. [Keyboard shortcuts](#9-keyboard-shortcuts)
10. [Script module](#10-script-module)
11. [Builtin tasks](#builtin-tasks)
12. [Troubleshooting](#troubleshooting)

## 1. Prepare

| Tool | Version | When you need it |
|---|---|---|
| Node.js | ≥ 22.12 | always |
| Python | 3.12 (the CI version) | only for Python training |
| Foundry (`forge`, `anvil`) | ≥ 1.8.0 | only for on-chain deployment or the contract tests |
| Browser | a recent Chrome, Edge or Safari | always |

Install the dependencies in the repository root:

```sh
npm ci
```

## 2. Start the workbench

There are three ways to start. Use the first one first.

| Way | Command | Address | Use it for |
|---|---|---|---|
| Dev server | `npm run dev` | the address that the terminal shows, default `http://localhost:5173/` | trying, changing the source |
| Single file | `npm run build`, then open `frontend/dist/neurom-studio.html` | `file://…` | offline demos, browser training only |
| Python Workspace | see [section 6](#6-train-in-python) | `http://127.0.0.1:18766/` | Python training |

Do not serve the `frontend/` sources with `python -m http.server`. The sources contain TypeScript and Vue SFCs, and a browser cannot run them directly.

When the page opens, you see these areas:

- Top bar: workspace status, "Save workspace", "Open" and the language toggle "中 / EN".
- Left navigation: the three drawers "Add", "Templates" and "Files".
- Middle: the canvas.
- Bottom right: "Selection", "Fit all" and the zoom level.
- Bottom: the status bar. When the canvas refuses a wire, the status bar gives the reason.

<p align="center"><img src="images/add-drawer-en.png" alt="The Add drawer: examples, composite templates and blank modules" width="100%"></p>

## 3. Five minutes with the combiner

The combiner comes with builtin artifacts, so you see results without training.

1. Open `http://localhost:5173/?preset=arithmetic-combiner`. You can also click "Combiner · builtin ADD4 / SUB4 / MUL4 and policy artifacts accepted" under "Examples" in the "Add" drawer.
2. Press `F`. The canvas shows the whole training module.
3. In the left column, find the evaluator "按运算评估" and click "Evaluation".
4. In the execution, set the episode index to `88`.
5. Click "Reset", then click "Step".
6. Select the loop box on the right, then click "Selection" at the bottom right. The canvas zooms to the loop box.

You must see these results:

- Evaluation report: 154 episodes in the test partition, `exact` mean 1. Grouped by `op`, the three groups `*`, `−` and `+` are all 1.
- Execution: the test episode at index 88 is `{index: 440, a: 9, b: 2, op: −}`. This step "calls SUB4（内置）", the `action` of the answer is 7, and the result is "Success".
- Loop box: SUB4 is highlighted, and ADD4 and MUL4 are dimmed. `State` shows `t 1 / 1`, and `action` shows 7.

Module titles come from the template, so some titles stay in Chinese in the English interface.

<p align="center"><img src="images/combiner-loop-en.png" alt="The combiner loop box: the tool layer picks SUB4" width="100%"></p>

<p align="center"><img src="images/combiner-results-en.png" alt="Candidates, evaluation report and execution" width="420"></p>

## 4. Train your first model: mining

The mining task has no builtin artifact. You train a network yourself.

1. If the workspace has content that you want to keep, click "Save workspace" first.
2. In the "Files" drawer, click "Clear entire workspace".
3. Open `http://localhost:5173/?preset=mining-task`.
4. On the trainer, make sure that `backend` is `browser`.
5. Click "Start training". The trainer shows a progress bar, the loss curve and the validation metric curve.
6. When the training is complete, click "Accept" on one candidate.
7. On the execution, click "Reset", then click "run".
8. Look at the map view. The view draws the path of the player, the view square and the base.

<p align="center"><img src="images/mining-overview-en.png" alt="The mining training module: the left column holds data, environment, objective, trainer and results, and the loop box is on the right" width="100%"></p>

Reference results (seed 1, 600 epochs, headless Chrome on Apple Silicon):

- The training takes about 35 seconds.
- The validation metric `validationMetric` is 17.859.
- Test episode 0 runs all 63 steps, and the result is "Success".

The results can be different for each run and each seed. Mining has no pinned numbers.

<table>
  <tr>
    <td width="50%" valign="top"><img src="images/mining-training-en.png" alt="The trainer during training: progress, loss and validation metric"></td>
    <td width="50%" valign="top"><img src="images/mining-execution-en.png" alt="Execution and map view"></td>
  </tr>
</table>

Training only produces candidates. The weights go to the network only after you accept a candidate. Changes to the canvas after the start do not affect a running training.

To continue training from accepted weights, connect the `weights` of a candidates module to the `init` of the trainer. The next run then starts from that artifact, not from random weights. The trainer validates the start first, as epoch 0. Only a better epoch replaces the start. The artifact must have the network structure and the readout of the trained network. If not, the trainer shows a problem (ADR 0020).

To make a run wait until the earlier stage passes, connect the `report` of an evaluator to the `gate` of the trainer. Then, in the trainer, select a metric of that evaluator and write a minimum (≥) or a maximum (≤). When you click “Start training”, the trainer reads the current report of that evaluator. In these cases the run does not start, and the trainer shows the reason below the button:

- There is no report.
- The report is stale: the bundle of the evaluator changed after the evaluation.
- The report has no such metric.
- The metric does not meet the condition.

The trainer checks the condition only at the start. A change of the report during a run does not stop the run. This is the same for the browser backend and the Python backend: the workbench checks the condition before it gives the run to the backend. A report is session state, and the workspace does not keep it. Thus, after you open the page again, click “Evaluation” on the evaluator before you start a gated run (ADR 0020).

CAUTION: Do not close the page during training. Browser training runs in a Web Worker, and a closed page stops the training. After you open the page again, the run shows as failed.

## 5. Change the rules

The rules are in the modules of the left column of the training module. You change these modules, not the code.

- Environment parameters: grid side, step limit, bag capacity, resource probabilities, values and settlement.
- Perception parameters: the square view radius.
- Reward weights: step cost, invalid-action cost, success reward, failure cost, value coefficient.
- Code: the scenario (`init`, `input`, `step`, `budget`, `actions`), the reward and the metrics.

The declaration of a parameter gives its range. When a value is out of range, the module shows an error, and the canvas does not let you pack.

Code modules have role pages. Each function that another module calls by protocol has a vertical tab.

- The protocol locks the function header. You can rename a parameter, but you cannot add or remove one.
- Click **?** at the end of the line to open the help window. The window tells who calls the function and when, the parameters, the return value and an example from a real run.
- Hold the pointer over a name to see its type and description.
- A wavy line marks a type error, and the error list is below the editor.

<p align="center"><img src="images/mining-code-en.png" alt="The role page of the reward function and its help window" width="80%"></p>

After you change the scenario, `budget` or the episode kind of a driving partition, the candidates module marks old artifacts as "Different environment". Then you must train again.

## 6. Train in Python

The Python backend uses PyTorch to train the same training bundle.

1. Build the single-file page:

   ```sh
   npm run build
   ```

2. Install the Python dependencies:

   ```sh
   python3 -m venv ~/.cache/neurom-venv
   ~/.cache/neurom-venv/bin/python -m pip install -r training/requirements.txt -r training/requirements-torch.txt
   ```

3. Start the Workspace:

   ```sh
   ~/.cache/neurom-venv/bin/python training/workspace.py --port 18766
   ```

4. Open `http://127.0.0.1:18766/`. The top bar shows "Python workspace connected".
5. On the trainer, set `backend` to `python`, then click "Start training".

The dev server proxies `/api` to `127.0.0.1:18766`. So while the Workspace runs, a page from `npm run dev` can also train in Python. The Workspace holds the Python runs. After you reload the page, the page connects to these runs again.

The [AI / Python training guide](ai-module-training.en.md) gives offline training, the bundle format and a task brief for an AI.

## 7. Deploy on a local chain

This section deploys ADD4 on a local Anvil node, then sends one step transaction.

1. In the first terminal, start Anvil:

   ```sh
   anvil --network monad --port 18545
   ```

2. In the second terminal, deploy the protocol contracts. If the node is freshly started, you must do this step first.

   ```sh
   cd contracts
   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:18545 --unlocked --sender 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 --broadcast
   ```

   The `factory` in the output must be `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0`. This is the official factory of 31337 in `frontend/chain.js`.

3. On an empty canvas, open `?preset=arithmetic-add4`.
4. In the "Add" drawer, under "Blank modules", click "+ On-chain deployment".
5. Drag a wire from the `cands · artifact` port on the right side of the training module to the `artifact` input of the deployment module.
6. On the deployment module, select the network "Local dev · unlocked Anvil account (31337)" and click "Connect".
7. Click "Deploy current artifact". Then click "Verify on-chain module".
8. Under "input 8 bits (LSB first)", turn on bits 0, 2, 4 and 5. This means a = 5 and b = 3.
9. Click "On-chain inference (free eth_call)", then click "step transaction".

You must see these results:

- Deployment plan: 1 weight chunk (704 bytes). The 1 transaction of the deployment is on chain.
- The result of the step transaction is 8, and the module writes "On-chain = local."
- We measured 75,219 gas for one step.

<p align="center"><img src="images/deploy-en.png" alt="The deployment module: on chain, step transaction result 8" width="520"></p>

Deploy, step and reset are transactions. Read-only previews are eth_call. Local dev uses the unlocked Anvil test accounts and does not open a browser wallet. The testnet and the mainnet have no official factory yet, so you cannot deploy or verify on these two networks.

CAUTION: Do not expose an unlocked Anvil node to the internet. If you do, anyone can send transactions from the unlocked accounts.

## 8. Save, share and templates

- The workspace saves itself in the `localStorage` of the browser (key `neurom-workbench`). Artifacts are large, so they go into the IndexedDB of the browser (`neurom-artifacts`) by their content id, and `localStorage` keeps only their ids. The artifacts in IndexedDB are not deleted automatically. Each port and domain has its own save.
- "Save workspace" exports the whole workspace as a JSON file. "Open" imports this file. To use a workspace at a different address, export it first, then import it.
- If a file does not open, the status bar gives the format, the error location and the reason. The current workspace does not change.
- Select modules or a composite, then click "Save as template" to get a template. In the "Templates" drawer, you can instantiate, fork, import and export YAML templates.
- An instance does not follow later changes of its template. The title of each composite shows its source `template id@revision`.

## 9. Keyboard shortcuts

| Action | Keys |
|---|---|
| Fit all | `F` |
| Reset to 100% | `0` |
| Zoom | `⌘ / Ctrl` + wheel, or `+ / −` |
| Pan | wheel, two-finger swipe, middle-button drag, or hold Space and move the pointer |
| Undo / redo | `⌘ / Ctrl Z` / `⌘ / Ctrl Shift Z` or `⌘ / Ctrl Y` |
| Copy / paste | `⌘ / Ctrl C` / `⌘ / Ctrl V` |
| Select all | `⌘ / Ctrl A` |
| Pack / unpack | `⌘ / Ctrl G` / `⌘ / Ctrl Shift G` |
| Delete the selected modules or wire | `Delete` or `Backspace` |
| Add a reroute point on a wire | Alt + click, or double-click the wire |

## 10. Script module

A script module runs JavaScript that you write and draws the result as views. It does inference only. No training bundle contains it, and it does not change an environment hash (ADR 0019).

1. Click 「添加」.
2. Click 「脚本模块」.
3. Click 「单步」.
4. Click 「运行」.
5. Click 「暂停」.
6. Click 「重置」.
7. Click 「✎ 编辑代码」.
8. Type a file name below the file list.
9. Click 「＋ 文件」.
10. Click 「保存并重新运行」.

The results of the steps:

- The new module has a counter example.
- 「单步」 increases the count and 「第 n 轮」 by 1.
- 「运行」 increases the count continuously, and 「暂停」 stops it.
- 「重置」 starts `main` again, and the count goes back to 0.
- The left side of the editor is the file list, and the right side is the code.
- 「保存并重新运行」 starts the script again with the new code. 「取消」 discards the changes that are not saved.

You cannot delete `main.js`.

The default export of `main.js` is `{ layout, views, main }`:

- `layout`: the `columns`, `rows` and `areas` of a CSS grid. If there is no `layout`, the views go in a grid that wraps automatically.
- `views`: maps the cell names of `areas` to Vue components. Each component gets two props, `state` and `run`.
- `main(ctx)`: the loop that you write. Start each round with `await ctx.frame()`. `ctx.state` is the reactive data that the views read.

```js
import { Controls } from '@ui';
import { Board } from './views.js';

export default {
  layout: { columns: '1fr 160px', rows: '1fr', areas: ['board side'] },
  views: { board: Board, side: Controls },
  async main(ctx) {
    ctx.state.t = 0;
    while (true) {
      await ctx.frame();
      ctx.state.t += 1;
    }
  },
};
```

`run` has these members:

- `reset()`, `step()`, `play()`, `pause()` and `toggle()`: reset, step, run, pause, and change between run and pause.
- `steps`: the current round count.
- `running`: true while the rounds run continuously.
- `done`: true when `main` is at its end.

`import { Controls } from '@ui'` gives the built-in run buttons. Files import each other with `import`, for example `import { Board } from './views.js'`. An imported name holds the value at the time of the import.

Drag the bottom-right corner of the module to change its size. The views adapt to the size. When the script fails, the module shows the file, the line and the error message below 「✎ 编辑代码」. The script runs in the sandbox of a view script. It cannot get access to the workbench, the storage or the network.

### Inputs: call networks and code functions

A script module can call the networks and code functions wired into it, and it can read the values wired into it.

1. Click 「✎ 编辑代码」.
2. Under 「函数输入」, type a name, for example `红方`, then click 「＋ 函数输入」.
3. Under 「值输入」, type a name, for example `p`, then click 「＋ 值输入」.
4. Click 「保存并重新运行」.
5. Wire the `ƒ run` of a readout, or a function that a code module exports, into a function input on the left of the module.
6. Wire a value (for example `params` of a Params module) into a value input.

The result of each step:

- Each name becomes a port on the left of the module. The port of a function input has ƒ.
- Under each name, the editor shows the module wired into it. A name that is not saved yet shows 「保存后生效」.
- When you rename, the wires follow the names: by position when the count of a list does not change, else by name.

In the script:

- `await ctx.call.<name>(…args)` calls a function input and gives its result.
- `ctx.values.<name>` reads a value input.

```js
const bits = await ctx.call.view(state, 0);
const out = await ctx.call.红方(bits);
const grid = ctx.values.p.grid;
```

The page runs each call outside the sandbox and sends only the result back to the script:

- A network runs through the `run` of its readout. The argument is an array of 0/1 bits, and the result is the bits of the readout. A bits readout and an argmax readout both work. The network uses its accepted weights. Each call starts from a zero state, so the network keeps no memory across calls.
- A code function runs its program and reads the inputs and constants of its file. The arguments can be numbers, booleans, strings, arrays and records.
- After 「重置」, the calls of the old run that have no reply yet are dropped.

The module reports a problem when:

- A function input is declared but not wired.
- A name is declared two times, or as a function input and as a value input.
- A trainer trains the network that is wired in. As for a tool layer, such a network cannot be called. Freeze a copy: add another network module with the same structure, and wire its `weights` to the candidates.

A call of a name that is not declared, a read of a value input that has no value, and a call that fails give the script an error at that line. An error that the script does not catch shows below 「✎ 编辑代码」.

When a function that a scenario exports is wired to a script module, the scenario check does not report it as a misspelt role.

## Builtin tasks

### Mining

Mining (`mining-task`, REINFORCE): the player digs dirt / coal / gold on a grid. The player can stop in place or deliver at the base. Environment parameters include:

- A 2–16 grid side.
- Steps.
- Bag capacity.
- Resource distribution and values.
- Settlement.
- Base.
- Target value.
- Whether a delivery ends the episode.

The only perception parameter is the square view radius (1..4). Reward coefficients are a separate params module.

The default rules (ADR 0018):

- A 16×16 grid, 63 steps, bag capacity 3.
- Empty / dirt / coal / gold probabilities 0.67 / 0.2 / 0.1 / 0.03.
- Values: dirt 1, coal 2, gold 10.
- Settlement at the base, target value 1.
- "交付后结束回合" (a delivery ends the episode) is off by default. A delivery empties the bag and the episode continues to the step budget, so the player can make several trips.

The `input` of the scenario module encodes 185 input bits:

- Coal and gold of each cell in a 9×9 square view, one bit each (81 + 81 bits). Dirt and empty cells read 0. Cells beyond the radius or off the map read empty.
- The x / y offset of the base (5 bits each, +15).
- The dirt / coal / gold in the bag (2 bits each, saturating at 3).
- Bag full (1 bit).
- Steps left (6 bits).

`input` gives no direction or distance to the nearest target. Delete a line, and the network does not get that item. You can also replace the item with same-width zeros to keep the layout. Environment and perception parameters never enter the network.

The network has 7 action slots. A slot marked "invalid" in the readout map is an invalid action that spends a step. Map random numbers come from the 32-bit linear congruential tables of the random module and are bit-exact in the IR. The default network is FF 185→32→7 (`dense-policy`, int8 weights). The reward is the increment of the settled value. Success = delivered at least once, target value 1.

### Memory map

Memory map (`memory-map-task`, cross-entropy): a 6×6 grid, start (2,2). The target is one of the other 35 cells. An episode has three parts:

- Preview: the target shows once, then it is hidden.
- Wait: D waits.
- Search: at most 8 steps to find the target.

Actions during preview and waiting do not move the player. After the target is hidden, `input` does not encode the target. The shortest-path teacher `target(state)` reads the target directly from the state to make training labels. The network never sees the target. The default network is LIF 55→32→7 with int16 weights (`weightBits: 16`). Memory map has no builtin artifact.

The evaluator groups by delay to give a retention curve. The test partition has 35 targets × delays 0/1/2/4/8/16 = 210 episodes.

Results are different for each run and each seed. This is a memory diagnostic over a finite domain, not generalization to new maps.

### Four-bit arithmetic

Four-bit arithmetic (`arithmetic-add4 / sub4 / mul4`, hinge): three threshold networks with the structures 8→12→5, 8→16→5 and 8→112→8. Each question is one step. All 256 pairs are enumerated. The builtin artifacts are int8 at 100%.

### Combiner

Combiner (`arithmetic-combiner`, REINFORCE): the questions are `op ∈ {*, +, −}` × a × b, 768 in total. The index mod 5 splits them into training / validation / test. The policy network is a single tool layer `{ tools: tools, data: 8 }`. The decision head of the tool layer reads the 11 input bits `op ‖ a ‖ b` directly. The decision head picks one of the frozen builtin ADD4 / SUB4 / MUL4 and the 8 data bits to give it.

Only the chosen network runs. The result bits of the chosen network (zero-extended to 8) are the answer. The builtin policy artifact (int8) answers all 154 test questions correctly. On each question, it picks the matching network and gives it exactly a‖b.

### Tank battle

Tank battle (`tank-battle`, training in stages): a Battle City level and a battle. The template has 4 training modules, and each training module trains one network. Stage 1 · 模仿 (imitation) and stage 2 · 对战训练 (battle training) each have one for 中 and one for 大. Stage 1 imitates the teacher of the scene in the level. In the level, the network drives our tank, and the patrol bots of the scene drive the enemy tanks. Stage 2 starts from the weights of stage 1 (ADR 0020) and plays against the battle bot of the scene on the battle map (ADR 0022). After the training, the script module 坦克对战 plays the two stage 2 networks against each other (ADR 0019).

The scenario module holds the rules:

- The layout of the map at the start is fixed. It is the layout of stage 1 of the original game, made smaller to 9×9. A cell is empty, brick or steel. The base is at the bottom centre (4, 8), with a ring of bricks around it.
- We have 1 tank with 1 life. The tank starts at (2, 8), two cells to the left of the base, and faces up.
- There are 6 actions: up, right, down, left, fire, wait. A move action always changes the facing. If the target cell is off the map, a wall, the base or an enemy, the tank only turns.
- There are 6 enemies in total. The first enemy is there at the start. After that, every 8 steps, the next enemy comes if fewer than 3 enemies are on the map and the spawn cell is empty. The spawn cells are in row 0, at x 0, 4 and 8, in turn.
- A bot moves forward in its direction. If it cannot go into the next cell, or with the turn probability (0.1), it changes its direction and does not move in this step. The new direction is down with a probability of one half. If not, it is up, right or left at random. If the bot has no bullet in flight, it fires forward with the fire probability (0.3). It does not aim.
- Each tank has a maximum of 1 bullet in flight. A bullet flies 2 cells per step. When a bullet hits a brick, the bullet and that brick cell disappear. When a bullet hits steel or leaves the map, the bullet disappears. When our bullet and an enemy bullet meet, both disappear. Enemy bullets fly through enemies and do not hurt them.
- In one step, our tank moves or fires first. Then each enemy patrols and fires, then each bullet flies 2 cells. At the end, a new enemy can come.
- When we destroy 6 enemies, we win the level. When our tank is hit, or any bullet hits the base (our bullets too), we lose. The episode also ends after 200 steps, and that is not a win.
- On each step, the scene writes the trail of each bullet in that step to `trails` in the state: the start cell, the direction, the number of cells flown, the last cell and the reason for the stop. The reason is: still in flight, a brick, steel or the map edge, a base, a tank, a clash in one cell with another bullet, or a clash where two bullets pass through each other. A bullet that is fired and stops in the same step also has a trail.

The Params module holds all counts and probabilities: 回合步数 (steps), 敌人总数 (enemies in total), 同时在场的敌人最多 (enemies on the map at one time), 敌人出现的间隔步数 (steps between enemies), 机器人转向概率 (turn probability), 转向时朝下的概率 (probability of down after a turn) and 机器人开火概率 (fire probability). The random numbers come from the random module, with the seed of each episode. Each enemy uses 3 draws in each step.

`input` gives 492 bits, and the full map is visible. The first 486 bits are 6 channels of 81 bits (1 bit for each cell, row by row): bricks, steel, base, enemy tanks, enemy bullets, our tank. Then come the facing of our tank (4 bits), whether our bullet is in flight (1 bit) and the bias (1 bit).

The first map was 13×13, with 1020 input bits. On 13×13, the agreement of 中 with the teacher stopped at about 0.7 (4000 epochs, 396 seconds in node). 大 got only 0.86 after 2500 epochs (319 seconds in node), and more training takes more than 5 minutes. Thus the map is 9×9.

The teacher `teacher(state)` is a function that the scene exports. It gives the target bits of the 6 action slots of our tank. When several actions are equally good, all of them are 1. It examines the rules in this order and uses the first rule that gives an action:

1. If an enemy bullet will hit our tank in the next step, move to a side of the bullet. If our tank faces the bullet and our bullet is not in flight, fire is equally good, because the two bullets disappear together.
2. If an enemy is in the same row or column and only empty cells, bricks or tanks are between them, turn to that enemy. If our tank faces it, fire. If our bullet is still in flight, wait.
3. If an enemy faces the base, go along a shortest path to the nearest cell that can aim at such an enemy.
4. If not, go along a shortest path to the nearest cell that can aim at any enemy.
5. If no rule gives an action, wait. An example is a map with no enemy.

A move action does not go into a cell that an enemy bullet hits in the next step. The line of sight stops at steel and at the base. Thus the teacher does not fire when the bullet would hit our own base first. On the seeds 1 to 200, the teacher itself won 110 levels. Our tank was hit in 81 levels, and the base was hit in 9 levels. The teacher destroyed 4.5 enemies on average.

Stage 1 · 模仿 has two training modules, for 中 and 大. Each frame has one trainer and one loop box:

- 中 is FF 492→32→32→6.
- 大 is FF 492→128→128→128→6.

Both networks use `dense-policy` and int16 weights. The argmax readout maps the 6 slots to the actions 0 to 5. Both trainers use cross-entropy, the objective is the `teacher` of the scene, and exploration is 0.1. No metric connects to the trainers, so each trainer keeps the model with the highest greedy accuracy on the validation seeds. The other settings of the two trainers are different:

- 中: 5000 epochs, 16 episodes per epoch, lr 0.005.
- 大: 1500 epochs, 8 episodes per epoch, lr 0.003.

With fewer epochs or a smaller lr, the agreement of 中 does not get to 0.9. With exploration 0.25 or 0.5, the results are worse than with 0.1.

Each structure has its own candidates, evaluator, report, execution and replay. The evaluator reports 4 metrics on 256 fixed test seeds: 过关率 (share of levels won), 平均击毁数 (mean number of destroyed enemies), 基地保住的比例 (share of levels where the base stays) and 和教师一致的比例 (agreement with the teacher). In one episode, the agreement is the share of steps where our action is in the target bits of the teacher. The scene counts these steps in `State.agree`. The evaluator gives the mean over the episodes.

Results of stage 1 measured in the browser (trainer seed 1, evaluation on 256 test seeds):

| Structure | Time | Levels won | Destroyed enemies | Base stays | Agreement with the teacher |
| --- | --- | --- | --- | --- | --- |
| 中 | 432 s | 0.301 | 3.84 | 0.934 | 0.909 |
| 大 | 131 s | 0.313 | 3.72 | 0.914 | 0.927 |

The results in the browser are the same as the results in node with the same settings. The time changes with the speed of the computer. Both agreements are more than 0.9, so the two gates of stage 2 pass.

The replay view draws the map (bricks, steel, base), our tank, the enemy tanks and the bullets in flight. The map comes from `cells` in the state, so a destroyed brick is not drawn. A destroyed base is grey with a cross. Below the map are the step, our action, the number of destroyed enemies and the result. Move the history slider of the view to see an episode step by step.

When the execution makes a step, the replay plays an animation of that step. The bullets fly along their `trails` at a constant speed of 2 cells per step. The tanks act before the bullets, so a tank slides one cell and turns in the first half of the step. A brick disappears when the bullet gets to it. At the stop of a bullet, a short effect shows: a brick breaks, steel gives a spark, a tank or a base explodes, or two bullets give a flash.

The duration of the animation of one step is the mean of the last 4 intervals between the arrivals of steps, limited to 80 to 600 ms. When the interval is more than 600 ms (for example, a single step), the duration is 200 ms. If a new step arrives before the animation of the last step ends, the last step ends in 40 ms, and then the new step plays. Thus the display can be later than the computation, but it does not skip a bullet. When more than 8 steps wait, each step plays for one frame only. When you move the history slider, the replay goes directly to the selected step, without animation.

There is one scene, one Params module, one 对战训练参数 (battle training parameters) module, one random module, one seed partition and one set of 8 metrics. They are outside the frames of the training modules, and they connect to all loops, trainers and evaluators. Thus the scene holds the only copy of the rules. Each frame lists the shared modules that it uses in its slots, for example “场景 · 场景”. Each loop box shows `ƒ scenario ← 场景`.

#### Stage 2 · 对战训练

Stage 2 · 对战训练 (battle training) also has two training modules, for 中 and 大, to the right of stage 1. Each frame has one trainer and one loop box. The networks have the same structures as in stage 1. Both trainers use REINFORCE. The network drives the tank of side 0 on the battle map (see the battle below). The battle bot of the scene drives the tank of side 1.

Two inputs of the trainer connect the stages:

- `init` takes the `weights` of the stage 1 candidates of the same structure. The training starts from the weights that stage 1 accepted, and it does not calibrate the biases.
- `gate` takes the report of the stage 1 evaluator of the same structure. The condition is `{ metric: 和教师一致的比例, min: 0.9 }`. If there is no report, if the report is stale, or if the value is too low, the trainer does not start and tells why.

The loops use the config `roles` to call 3 other exports of the scene (ADR 0022):

- `duelInit(start)`: the same as `battle`, and it also records the episode seed.
- `duelInput(state)`: the 492 bits that side 0 sees, that is, `view(state, 0)`.
- `duelStep(state, action)`: the battle bot `bot(state, 1)` selects the action of side 1. Then `play` makes the two sides act at the same time. Then the rules of stage 2 decide the result (see below). When the network wins, `success` is true.

Thus the loop boxes show `场景.duelInit`, `场景.duelInput` and `场景.duelStep`. The loops of stage 1 still call `init`, `input` and `step`.

The rules of stage 2 are different from the rules of 坦克对战. The goal is the base of the other side. A destroyed tank only makes the base easier to get:

- When the network destroys the base of the bot, the network wins.
- When the tank of the network is hit, or the base of the network is destroyed, the network loses.
- When the tank of the bot is hit, it leaves the map, and the episode continues. A tank that is not on the map does not act, does not block and does not fire.
- When the episode gets to its last step (200) without a win, the network loses. Thus there is no draw.

The battle bot examines the rules in this order and uses the first rule that gives an action:

1. If a bullet of the other side will hit the bot in the next step, move to a side. If the bot faces the bullet and its own bullet is not in flight, fire is equally good.
2. If the tank or the base of the other side is in the line of sight, turn to it. If the bot faces it, fire. If its own bullet is still in flight, wait.
3. If not, go along the shortest path to the nearest cell that sees the tank or the base of the other side.
4. If no rule gives an action, wait.

The line of sight stops at steel and at the map edge. The battle bot does not fire at its own base, and it does not go into a cell that a bullet hits in the next step. When several actions are equally good, it selects one at random. Then, with the random-action probability, it does a random action. The random numbers come from the episode seed and the step.

The parameters of stage 2 are in a separate Params module, 对战训练参数. Thus the bundles of stage 1 do not change, and its artifacts stay compatible:

- 对战机器人的随机动作概率 (random-action probability of the battle bot): 0.2.
- 打掉对方基地的奖励 (reward for the base of the other side): 1.
- 击毁对方坦克的奖励 (reward for the tank of the other side): 0.3.
- 输的奖励 (reward for a loss): −1.
- 每步的代价 (cost of a step): 0.002.

The reward is `duelReward(transition)`, which the scene exports. A win gets the reward for the base, and a loss gets the reward for a loss. The step where the tank of the bot is hit also gets the reward for the tank. Each step subtracts the cost of a step, so a faster win gives a higher return. A destroyed tank is only a means, so its reward is less than the reward for the base.

The two trainers have the same settings: 2400 epochs, 32 episodes per epoch, lr 0.002, entropy 0.01, `gamma` 1. No metric connects to the trainers, so each trainer selects the model with the highest mean return on the validation seeds. The evaluator has the reward and 4 metrics: 胜率 (win rate), 击毁对方坦克的比例 (share with the tank of the bot destroyed), 我方坦克被击中的比例 (share with our tank hit) and 超时的比例 (share that runs out of steps). These 4 metrics are also outside the frames, and the two evaluators share them.

The order of the training:

1. In “训练器（中）”, click “Start training”.
2. When the training ends, click “Accept” on a candidate in “候选（中）”.
3. In “评估器（中）”, click “Evaluation”.
4. When the gate of “训练器（中，阶段 2）” shows that it passed, click “Start training” in that trainer.
5. When the training ends, click “Accept” on a candidate in “候选（中，阶段 2）”.
6. In “评估器（中，阶段 2）”, click “Evaluation”.
7. In “训练器（大）”, click “Start training”.
8. When the training ends, click “Accept” on a candidate in “候选（大）”.
9. In “评估器（大）”, click “Evaluation”.
10. When the gate of “训练器（大，阶段 2）” shows that it passed, click “Start training” in that trainer.
11. When the training ends, click “Accept” on a candidate in “候选（大，阶段 2）”.
12. In “评估器（大，阶段 2）”, click “Evaluation”.

Results against the battle bot on 200 test seeds (node, trainer seed 1). “Our base lost” means that the bot destroyed the base of the network:

| Network | Win rate | Bot tank destroyed | Our tank hit | Our base lost | Out of steps | Mean steps of a win |
| --- | --- | --- | --- | --- | --- | --- |
| Wait only | 0 | 0 | 0.305 | 0.695 | 0 | |
| 中, stage 2 | 0.72 | 0.765 | 0.02 | 0.26 | 0 | 20.0 |
| 大, stage 2 | 0.65 | 0.63 | 0.04 | 0.31 | 0 | 18.5 |

- The stage 2 networks usually destroy the tank of the bot first and then attack the base. Of the 144 wins of 中, 124 came after the tank of the bot was destroyed.
- In most of the losses, the bot destroyed the base of the network first.
- With trainer seed 2, the win rate of 中 was 0.675, and of 大 0.68.
- In node, with 4 trainings at the same time, 中 took 114 s and 大 took 210 s.

The start of stage 2 comes from measurements (trainer seed 1, win rate on 200 test seeds):

| Start of stage 2 | 中 | 大 |
| --- | --- | --- |
| Weights of the former level stage | 0.66 | 0.47 |
| Weights of stage 1 (now) | 0.72 | 0.65 |
| Random weights | 0.865 | 0.055 |

The template had a level stage before. It trained in the level with REINFORCE, and the battle training started from its weights. It taught the network to stand still and fire. In the level this works, because the enemies walk into the line of fire. But the battle bot attacks the base, and a network that stands still loses its base.

The networks of the level stage win no episode against the bot, because they did not train on a map with an enemy base. Thus the stage was removed. From random weights, 大 learns nothing, and the trainer selected the model of epoch 60.

#### Battle

The battle has two frozen networks, “中（对战）” and “大（对战）”, with the same structures as in the training modules. Their `weights` come from the stage 2 candidates. A script cannot call a network that a trainer trains, so the battle uses separate network modules. The script module 坦克对战 has 5 function inputs:

- `红方` (red) and `蓝方` (blue): the readout `run` of the two networks. In the template, red is 中 and blue is 大.
- `battle`, `view` and `play`: the battle functions that the scene exports.

The rules of the battle are also only in the scene. The level and the battle use the same code for movement, bullets, bricks, steel and hits. The battle is different from the level in these items:

- The map has a base at each end. Rows 4 to 8 are the same as in the level map. Rows 0 to 3 are rows 5 to 8 turned 180°.
- There are no bots. Red is side 0, with its base at the bottom. Blue is side 1, with its base at the top.
- The tank of each side starts on an empty cell in the two bottom rows of its side. The seed sets the start cells.
- The two sides act at the same time. When the two tanks go into the same cell, both tanks only turn.
- A side loses when a bullet hits its tank or its own base. When both sides lose in one step, or after 200 steps, the battle is a draw.

`view(state, side)` gives the 492 bits that one side sees, in the order of the `input` of the level. Blue sees the map turned 180°, so each side has its base at the bottom, as in the level. The base of the other side is a target, so it is in the enemy tank channel together with the other tank. `play(state, a, b)` gets the action of each side on the map of that side, and changes the action of blue into the world direction.

The script has 3 files:

- `main.js`: the layout and `main`. Each 「重置」 (reset) starts a new battle, and its seed is its number.
- `game.js`: the flow of one battle. On each step, it calls `view` and the network of each side. Then, with the random-action probability, a side does a random action. At the end of the step, it calls `play`. The random-action probability is `RANDOM`, 0.1 by default. The random numbers come from a fixed seed, so a battle gives the same result again.
- `views.js`: the 3 views. The battlefield shows the map, the two bases, the two tanks and the bullets in flight. The battlefield plays the animation of each step as the replay does, with the same rules for the duration. The side panel shows `Controls`, the battle number, the seed, the random-action probability, the result and the state of both sides. The log shows the actions of both sides on each step, with `*` for a random action, and the result in the last line. The side panel and the log show the latest step directly.

To swap the places of the two networks, swap the wires of `红方` and `蓝方`.

The order of the battle:

1. Accept a candidate in “候选（中，阶段 2）” and one in “候选（大，阶段 2）”.
2. In “坦克对战”, click 「运行」 (run). When a battle ends, click 「重置」 (reset) for the next battle.

You can also click one time: click ▶ 「运行到这里」 (run up to here, ADR 0023) in the header of “坦克对战”. It goes up from this module:

- When a candidates module has a compatible accepted artifact, it does not train again.
- When nothing is accepted, it trains, then it accepts the candidate that the trainer selected.
- When a gate needs a report that is missing or stale, it evaluates first.

Then the script starts again and plays. The status bar shows each step. When a gate does not pass, the chain stops and tells why. The candidates, trainers, evaluators and executions in the training modules also have this button.

A headless script measured the battle on the seeds 1 to 200. It runs `game.js` of the battle script and the page side of its calls. The two networks are the stage 2 networks (trainer seed 1). Each row has 400 battles, from the two seats together:

| Random-action probability | 中 won | 大 won | Draws |
| --- | --- | --- | --- |
| 0 | 152 | 212 | 36 |
| 0.1 | 159 | 221 | 20 |

坦克对战 still uses the rules of the battle: a hit on the tank or on the base wins, and 200 steps without a result is a draw.

- From the two seats together, 大 won more battles.
- The former networks from the level stage, with the random-action probability 0, gave 135 wins of 中, 46 wins of 大 and 219 draws. The current networks decrease the draws to 36.

`frontend/templates/artifacts/artifacts.test.js` pins the four-bit arithmetic and combiner numbers. Mining, the memory map and the tank battle have no pinned numbers. Scenarios run as interpreted IR, and the cost is training speed. [Section 11 of the design document](design.en.md#11-correctness-and-performance) shows the main work of each step.

`frontend/templates/tank-battle.test.js` checks the rules of the level through the runner on fixed seeds. It also checks the target bits of the teacher on fixed states. The rule checks are:

- A bullet removes a brick, and steel stops a bullet.
- Two bullets that meet disappear.
- Enemies come one by one, with a maximum of 3 on the map.
- Enemy bullets do not hurt enemies.
- Our bullet on the base loses, and 6 destroyed enemies win.
- The end of the steps is not a win.
- The trail of each bullet agrees with the result of the rules: a bullet fired into the brick next to the tank, a flight of 2 cells, a brick 2 cells away, steel or the map edge, a hit on a tank, a hit on the base, and two bullets that go into one cell or pass through each other.

The teacher checks are:

- The teacher dodges bullets.
- It fires through a brick.
- It intercepts an enemy that faces the base first.
- It does not fire at its own base.
- It marks each shortest path.

The battle checks use the calls of the script module:

- The map does not change when it turns 180°. Blue sees the same bits as red sees in the turned battle. The rules are the same for both sides.
- A hit on the tank or the base of the other side wins. When both sides lose in one step, or at the end of the steps, the battle is a draw.
- The battle records the trails of both bullets with the code of the level.
- A battle through the calls of the script gives the same result as direct calls of the scene functions and the networks.
- A swap of the wires swaps the places. With the random-action probability 0 and 0.1, a seed gives the same result again.

The stage 2 checks are:

- The `init` of a stage 2 trainer takes the stage 1 candidates of the same structure. Its `gate` takes the stage 1 evaluator of the same structure. The gate does not pass at an agreement of 0.89, and it passes at 0.9. It also does not pass without a report or with a stale report.
- The training starts from the weights that stage 1 accepted. The objective of the trainer is `duelReward` of the scene.
- The start of the loop is the start of `battle`, and the input of the network is `view(state, 0)`.
- A change of the battle training parameters does not change the environment of the stage 1 bundles.
- The battle bot fires at a tank that it sees. It turns to the tank first, and it waits while its own bullet flies.
- The battle bot moves to a side of a bullet, and it does not fire along the line to its own base.
- When the tank of the bot is hit, it leaves the map, and the episode continues. A tank that is not on the map does not act. The destroyed base of the bot wins.
- Our tank hit is a loss. The end of the steps is also a loss, and there is no draw.
- When the network only waits, it loses each episode. A seed gives the same random actions again.
- The base of the other side gets 1, the tank of the other side gets the reward for the tank, a loss gets −1, and each step subtracts the cost of a step.

### What is learned and what is designed

| Component | Nature | Evidence |
|---|---|---|
| ADD4 / SUB4 / MUL4 modules | trained threshold neural networks (8→12→5, 8→16→5, 8→112→8). QAT, int8 weights with a scale per layer | 100% over all 256 pairs |
| The combiner's policy | learned: one tool layer has a decision head 11 → 3 choices + 8 data bits. The tool layer learns by REINFORCE which tool to call and which bits to give it. The tool weights are frozen. The reward looks only at the answer | template `arithmetic-combiner`. All 154 test questions are right. On each question, the right tool is picked and gets a‖b |
| Tool layers and bit wires | designed: a tool layer runs only the chosen tool on each step. It gives the zero-extended result to the next layers or out as the output. Bit wires slice and concatenate bit vectors | `frontend/core/loop.js`, `frontend/runtime/dense-policy.js`, module kinds `network` / `bits` |
| Mining / memory policies | learned: REINFORCE trains the mining FF 185→32→7, and cross-entropy trains the memory-map LIF 55→32→7. Both are integer networks | the user trains them on the canvas, no builtin artifact. Each training produces new candidates |
| Scenario rules | designed: the scenario module and other code modules in the templates | `frontend/templates/*.yaml` |
| The deploy button | local Anvil: deploy, verify, step and reset clicked for real. Public-chain signing is not verified | real receipts, event summaries and persistent potentials, checked item by item against the local integer results |

Modules are immutable. To improve a module, train a new module. Each module gets an exhaustive check over its own input space, and these checks make the composition correct.

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| `?preset=…` places no example | The canvas is not empty. `preset` works only on an empty canvas | In the "Files" drawer, click "Clear entire workspace", then open the address again. You can also place the example from "Add → Examples" |
| The top bar shows "Python workspace not connected" | The Workspace does not run | Browser training still works. To train in Python, start the Workspace as [section 6](#6-train-in-python) tells |
| The dev server address is not 5173 | Port 5173 is in use, so Vite uses a different port | Use the address that the terminal shows. Each address has its own workspace save |
| The page is blank or shows a module error | `http.server` or `file://` serves the sources | Use `npm run dev`, or open the built `frontend/dist/neurom-studio.html` |
| A conflict panel opens with the page | The local workspace save does not restore | Click "Export local save" first. Then open a corrected file, or discard the local save |
| The execution or the evaluator says that the network has no accepted weights | Mining and the memory map have no builtin artifact | Train first, then click "Accept" on a candidate |
| A candidate shows "Different environment" | After the training, you changed the scenario, `budget` or the episode kind of a partition | Train again |
| Deployment does not work on the testnet or the mainnet | These two networks have no official factory yet | Use Local dev (Anvil) |
| Local dev cannot verify or cannot find the factory | The protocol contracts are not deployed on a freshly started Anvil node | Run `Deploy.s.sol` as step 2 of [section 7](#7-deploy-on-a-local-chain) tells |
