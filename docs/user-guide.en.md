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
10. [Builtin tasks](#builtin-tasks)
11. [Troubleshooting](#troubleshooting)

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

- The workspace saves itself in the `localStorage` of the browser (key `neurom-workbench`). Each port and domain has its own save.
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

`frontend/templates/artifacts/artifacts.test.js` pins the four-bit arithmetic and combiner numbers. Mining and the memory map have no pinned numbers. Scenarios run as interpreted IR, and the cost is training speed. [Section 11 of the design document](design.en.md#11-correctness-and-performance) shows the main work of each step.

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
