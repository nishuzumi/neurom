# contracts

[中文](README.md) · **English**

This project uses Foundry ≥ 1.8.0. `foundry.toml` sets `network = "monad"` (Monad pricing, MIP-8 paged storage, 128 KB code limit). A full weight chunk is 112 KiB, more than the Ethereum EIP-170 limit of 24,576 bytes. Thus a weight chunk deploys only on chains with a raised code limit, for example Monad (or `anvil --network monad`). `optimizer_runs` is set high. The reason is that the engines run on every step, and a module is a clone, so the code size is paid once.

| File | Contents |
|---|---|
| `src/modules/` | The structure below (ADR 0014, 0016, 0017). It contains `Roles`, `FactoryProxy` and `ModuleFactory`. It contains the engines `DensePolicyEngine` / `ThresholdLayersEngine`, which share `EngineBase`. It contains the module implementation `NeuromModule` and its clone `ModuleClone`. It contains the interfaces `INeuromModule` / `IEngine`. |
| `test/Modules.t.sol` | 40 regression tests, which cover these areas. Integer semantics: hand models, arbitrary I→H→O widths, multi-layer FF / LIF, tool layers in FF / LIF and a trailing tool layer. All of these tests compare with the JS integer executor. Every model whose weights fit int8 runs at weightBits 8 and 16. Threshold-layer scores and activations. A region's shift k scales as Σ·2^k + b. Each LIF layer uses its own threshold. int8 −128 / 127 / negative weights and the 40-row memory path. These items are hand-computed or checked in the test. A network across two weight chunks. A gas check that only the chosen tool runs. Network tools: the potentials of a LIF tool are in the state of the calling session. These potentials change only when the tool is chosen, clear on the session's reset, and stay apart per session and per caller. A LIF selector's own state comes before the state of its tool. When a network with its own tool layer is a tool, the state of its tool is nested inside. The gas of a step that chooses a LIF tool vs an FF tool, and of each further nesting level. Weight chunks are content-addressed, and an existing chunk is skipped. One transaction creates the missing chunks and the module, all or nothing. A chunk used twice is sent once. The Factory refuses an engine id without a latest version, a version not listed for the engine id and a missing chunk. The Factory also refuses a bad shape (bits / shift / threshold included), wrong weight bytes and an unofficial tool. The Factory also refuses tools nested deeper than 3 (`depth`) and a state over 256 with the tools' states (`state`). The engine cannot write state. Engine versions are add-only and belong to one engine id. The latest version must be an added version. After the latest version moves, a module keeps its version. A deployment can name an older version. Only ADMIN grants / revokes roles and manages versions. Only UPGRADER upgrades the factory. ADMIN can grant itself UPGRADER. After a factory upgrade, `count`, `isModule`, `depthOf`, the chunks, the artifact index and the module implementation stay. The decisions of every module do not change. initialize runs only once. The owner is the deployer, moves in two steps and has no other power. Only the Factory's clones are modules. Isolation of instance / caller / session. Deployment gas and step gas at both weight widths on Monad rules. |
| `scripts/export_abi.py` | Generates `frontend/abi/*.json` (ModuleFactory, NeuromModule, Roles) from Solidity. Supports `--check` and `--out`. |
| `script/Deploy.s.sol` | Deploys Roles, and the broadcasting account holds ADMIN and UPGRADER. Deploys the ModuleFactory implementation and its FactoryProxy, initialised in the same transaction. Then deploys one version of each engine id, adds it and sets it latest. Returns every address. |
| `script/EngineVersion.s.sol` | `add()`: adds a deployed engine version to the versions of an engine id (new or existing) and sets it latest. `setLatest()`: makes an added version the latest again (see "Adding an engine version"). |
| `script/HandOverRoles.s.sol` | `grant()` / `revoke()`: gives both protocol roles from the broadcasting account to a multisig (see "Roles and handover"). |
| `scripts/engine-version-check.mjs` | The bit-for-bit check before you add an engine version (see "Adding an engine version"). The fixed input set is in `scripts/engine-cases.mjs`. The tests are `scripts/engine-version-check.test.mjs` (`npm test`, candidate versions in `test/VersionCandidates.sol`). |
| `scripts/list-roles.mjs` | Read-only. Lists the accounts that hold ADMIN and UPGRADER on a network (see "Roles and handover"). The tests are `scripts/list-roles.test.mjs` (`npm test`). |

```sh
forge test --network monad -vv          # -vv prints the gas measurements
forge script script/Deploy.s.sol --rpc-url monad_testnet --private-key $PK --broadcast
python3 contracts/scripts/export_abi.py            # from the repository root
python3 contracts/scripts/export_abi.py --check
```

`export_abi.py` finds its paths independently of the working directory. It uses `forge` from PATH. To select a version, use `--forge` or `FORGE`. It requires Foundry ≥ 1.8.0, which supports the project configuration.

Local integration uses two terminals, and the second terminal is in `contracts/`:

```sh
anvil --network monad --port 18545
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:18545 --unlocked --sender 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 --broadcast
```

The addresses come from the deploy output. If you deploy from the default account 0 on a freshly started anvil, the FactoryProxy (the official factory) gets the 31337 `factory` address in `frontend/chain.js`. The workbench uses this address as is, so you do not enter it. After a testnet / mainnet deployment, write the address into the `factory` of that network in `CHAINS`. Local development uses the Anvil test accounts above.

CAUTION: Do not expose an unlocked node to the public network. If you do, anybody can send transactions from the unlocked accounts.

## Structure (ADR 0014, ADR 0016, ADR 0017)

- **Weight chunk**: a contract whose code is a STOP byte followed by up to 114,688 bytes (112 KiB) of weights.
  - 112 KiB is the largest size whose creation fits one transaction on Monad: the gas estimate + 10% stays within the 30M limit per transaction.
  - `ModuleFactory.createChunk(data)` creates the chunk with CREATE2. The salt is `keccak256(data)`, and the init code is the fixed `CHUNK_INIT`. `CHUNK_INIT` calls the Factory's `chunkData()` back to get the content.
  - Thus the address depends only on the Factory and the content hash. Anybody can calculate the address with `chunkAddress(id)`.
  - The Factory creates identical content only once. It returns an existing chunk, not an error.
- **Roles** `Roles`: the powers of the protocol, not upgradeable.
  - ADMIN grants and revokes both roles (`grantRole` / `revokeRole`, events `RoleGranted` / `RoleRevoked`) and manages the engine versions.
  - UPGRADER upgrades the factory.
  - The deployer starts with both roles. Roles has no nominate-and-accept. A handover is: grant to the new holder, check (`hasRole`), revoke the old holder (see "Roles and handover").
  - Revoking the last ADMIN is final.
  - A module's owner is not a role.
- **Factory proxy** `FactoryProxy`: the address of the official factory.
  - It is an EIP-1967 proxy, with the implementation address at the EIP-1967 slot. It sends every call with DELEGATECALL to the `ModuleFactory` implementation. Thus the factory's state is in the proxy and stays after upgrades.
  - Only an UPGRADER of Roles can call `upgradeToAndCall(implementation, data)`. This Roles is fixed at construction (immutable), and no implementation can touch it.
  - The new implementation must report the same `roles()`. An upgrade emits `Upgraded(implementation)`. The proxy is never sealed.
  - The constructor DELEGATECALLs the factory's `initialize()` once. `initialize()` creates the module implementation, so `NeuromModule.factory` is the proxy.
- **Engine version**: an immutable contract that computes one engine id, with no proxy.
  - `Deploy.s.sol` deploys one version of each id: `DensePolicyEngine` (`dense-policy`) and `ThresholdLayersEngine` (`threshold-layers`).
  - All versions of one id compute the same, bit for bit. A numerics change is a new id.
  - The factory lists the versions with these functions:
    - `addVersion(engineId, version)`: only ADMIN can call it. A version is never changed or removed. An address is a version of one id only. The event is `VersionAdded`.
    - `setLatest(engineId, version)`: only ADMIN can call it. `version` must be an added version of that id. The event is `LatestSet`.
    - `versionsOf`, `latestOf`, `engineIdOf`: read the version data.
  - A module STATICCALLs `run(kind, inputs, outputs, shape, chunks, tools, state, input)`. The engine reads the chunks itself with EXTCODECOPY and returns scores, action, counts and voltages. The engine cannot write anything.
- **Module contract**: a clone of the Factory's `NeuromModule` implementation (`ModuleClone`).
  - The clone is 55 bytes of code followed by the module's identity: engine version, engineId, artifactId, taskId, kind, widths, shape, chunk addresses, tools.
  - The clone DELEGATECALLs the implementation with the call data plus the identity, and returns the result unchanged.
  - The identity is in code and cannot change. A read of the identity does not access storage.
  - The module calls its engine version directly, for life. Nobody can change this version, not its owner and not the protocol.
  - The module's own storage holds the state of each (actor, session) and `owner()`. At first, `owner()` is the deployer.
  - The owner moves only after `nominateOwner` and then `acceptOwnership`. The owner has no other power.
  - The module holds no funds. A paying contract (the mining game) reads `owner()` and pays the owner.
- **Factory** `ModuleFactory.deploy({ engineId, version, kind, inputs, outputs, shape, tools, chunks, artifactId, taskId }, data)`: deploys a module in one transaction.
  - If `version` is address(0), the Factory uses the latest version of `engineId`. If not, `version` must be one of the listed versions of `engineId`.
  - The order in the transaction: first the Factory checks everything, then it creates the chunks that `data` brings, then it creates the module.
  - `data[k]` is the content of chunk k, and its hash must equal `chunks[k]`. If the chunk exists, the Factory skips it. An empty `data[k]` means that the chunk exists, or that an earlier slot sends the same chunk.
  - If the Factory cannot create the module, the whole transaction reverts and leaves no chunk.
  - `checkDeploy(spec, data)` is the same checks as a view. It refuses for the same reasons and creates nothing.
  - The Factory refuses these conditions (the refusal reason is in parentheses):
    - An engine id without a latest version (`engine`).
    - A `version` not listed for `engineId` (`version`).
    - A chunk that does not exist after the creation step (`chunk`). The Factory calculates the address again from the content hash.
    - A shape that the engine refuses, for example `layers` / `hidden` / `ticks`.
    - Chunks whose total bytes do not match the shape (`weights`).
    - A tool that is not a module of this Factory (`tool`).
    - Tools nested deeper than `MAX_TOOL_DEPTH` = 3 (`depth`).
    - An identity too long for a module clone (`args`).
  - The reason for the nesting limit: a step runs, recursively, only the tool that each tool layer chooses. A network has at most 8 tool layers, so a step makes up to Σ_{i=1..d} 8^i tool calls. That is 584 at d = 3 and 4,680 at d = 4. Each level costs at least one more call into a module and its engine. On Monad rules, a warm call costs about 24k gas. This floor alone is about 14M at 3 levels, within one 30M transaction, and about 112M at 4 levels.
  - The Factory records these items:
    - `isModule`.
    - The nesting depth of each module, `depthOf(module)`: 0 without tools, else 1 + the deepest depth of its tools.
    - The index per artifact, `modulesOf(artifactId)`. When the bridge deploys tools, it uses this index for reuse. An artifactId is only the deployer's claim, so the bridge verifies it before reuse.
    - The `ModuleDeployed` event, with the engine version.
  - Chunks and modules are created only through the Factory. `createChunk` has only two uses: to create some chunks first when one transaction cannot hold them all, and to resume.
  - Registration does not certify training quality.

One model can create several modules. The weights are fixed, and the LIF potentials (with the states of its tools) belong to each module.

`descriptor()` contains these fields:

- `engineId`.
- `artifactId`: the content hash of a `neurom-module` artifact.
- `taskId`: the sha256 of `env` in the artifact's bundle, that is, envHash.
- The ports and the state width.
- `factory`: the proxy.
- `engine`: the module's engine version.

`shape()`, `chunks()` and `tools()` read the remaining identity. Only the Factory's `isModule` proves that the Factory created an address. The reason is that a clone of the same implementation by another party also has the same `factory` in its descriptor.

## Engines

The weights are stored by column (`EngineBase`, ADR 0014 / 0015). Each affine map has one region, with width w = the module's weightBits (8 or 16). The layout of a region is:

- The first `cols` columns hold the weights. Column i holds the weight of every row (neuron) for input i, each a big-endian two's-complement w-bit integer.
- Each 32-byte word holds 256 / w weights. Row j is element j, and element 0 is in the most significant byte. Each column is padded with zeros to whole words.
- The last column holds the biases, **always int16**, 16 per word.

A region of `rows` rows and `cols` columns takes `cols · ⌈rows · w / 256⌉ · 32 + ⌈rows / 16⌉ · 32` bytes. For w = 16, this value is `(cols + 1) · ⌈rows / 16⌉ · 32`. Each region has its own shift k (0..20): `z[j] = (Σ_i W[j,i]·x[i]) · 2^k + f·b[j]`.

The calculation in a step is:

- Each input that is 1 (or has a nonzero spike count) adds its whole column to 32-bit lanes at once.
- int16: each word splits into even / odd lanes, and a lane holds the weight + 32768.
- int8: each word splits into four lane words by row mod 4, and a lane holds the weight + 128.
- At the end, the offset is removed and the sums shift left by k.
- Up to 32 rows, the lanes stay on the stack (one int8 word, one or two int16 words). For more rows, the lanes go through memory.

The numerics are equal to the integer executors in `frontend/runtime/`, bit for bit.

`dense-policy` (`DensePolicyEngine`) has a shape of three words:

- `shape[0]`: 32 bits per layer, which hold hidden − 1 or K − 1, D − 1, R − 1, and the tool-layer flag.
- `shape[1]`:
  - [0, 8) is the layer count, [8, 16) is ticks, [16, 24) is leakShift.
  - [24, 32) is weightBits (8 or 16), [32, 48) is reset (int16).
  - Layer l has two shifts. The shift of the plain / choice region is at [48 + 10l, 53 + 10l).
  - The shift of the data region of layer l is at [53 + 10l, 58 + 10l), and it is 0 for a plain layer.
  - The shift of the output region is at [128, 133). When the last layer is a tool layer, this shift is 0.
  - Every k ≤ 20. The bits above the last layer and from bit 133 are zero.
- `shape[2]`: 32 bits per layer, the threshold of a plain layer. The FF threshold is exactly 1, and the LIF threshold is 1..2^31 − 1. The bits for a tool layer and above the last layer are 0.

check() has three more refusals:

- "bits": weightBits is not 8 / 16.
- "shift": a k > 20, or a k where no region is.
- "threshold": a threshold that does not obey the rules above.

The limits on layers and state are:

- A network has 1..8 layers. A plain layer has hidden 1..256.
- A tool layer has K / D / R 1..256. When the last layer is a tool layer, outputs = R.
- The total state is at most 256 (`state`). The state includes the plain LIF neurons and the state width of every tool.

The weight regions are:

- One region of `hidden` rows per plain layer.
- Two regions per tool layer: K choice rows and D data rows. Of the data rows, only the rows that the chosen tool reads are computed.
- Then the region of the output layer, unless the last layer is a tool layer.

A tool can be any module of the same Factory: FF, LIF or a network with its own tool layers. The condition is inputs ≤ D and outputs ≤ R.

The state of a module (width W = `stateWidth`) has this order:

- First come the module's own potentials. For LIF, these are the potentials of every plain layer, in layer order. FF has no potentials.
- Then comes the state of each tool, in layer order and then wire order. The state of a network tool is its own state, recursively in the same layout. A stateless tool takes 0 bits.

The state of a tool belongs to the calling session:

- The tool's state is in the (actor, session) state of the calling module. The tool module's own storage is not used.
- The tool's state advances only on the steps that choose the tool. On other steps, it does not change.
- When the caller's session is reset, the tool's state is cleared too.
- Two sessions or two callers never share the tool's state.

Below, `I[j] = (Σ_i W[j,i]·x[i]) · 2^k + b[j]`.

- FF (kind 0): a plain layer gives `a[j] = (I[j] >= 1)` to the next layer. FF has no state.
- LIF (kind 1): tool layers cut the network into segments. A segment runs all `ticks`.
  - Per tick, each layer calculates `V[j] = V[j] - (V[j] >> leakShift) + I[j]` (arithmetic shift). If `V[j] >= threshold_l` (the layer's own threshold), the layer counts a spike and sets `V[j]` to `reset`.
  - The first layer of a segment calculates I once from the segment input. A later layer calculates I from the spikes of the layer before in the same tick.
  - The potentials of every plain layer persist across calls. Only reset clears them.
- Tool layer (greedy):
  - The tool layer calculates K choice logits and D data logits on the layer before. FF reads the activations of the layer before. LIF reads the spike counts of the layer before in the segment, with the biases × ticks.
  - If no plain layer comes before the tool layer in its segment, the tool layer reads the segment input bits, with the biases unscaled.
  - The choice is the first maximum. A data bit is logit > 0.
  - **Only the chosen tool is called**: `forwardFrom(its state slice, the first inputs data bits)`. The next state that the tool returns replaces the slice.
  - If the length of the next state is wrong, the revert reason is "tool". If the tool's own potentials go out of int32, the revert reason is "volt".
  - Result bit k = (score_k ≥ 0), zero-extended to R bits.
  - The next layer reads `result ‖ the layer before`. For FF, the part from the layer before is its activations / the bits it read. For LIF, that part is whether each neuron fired at least once in the segment / the segment input.
- Output: `scores[a] = (Σ_j W[a,j]·x[j]) · 2^k + m·b[a]`. m = 1 for FF, and m = ticks for LIF. x is the activations / spike counts of the last layer.
  - When the last layer is a tool layer, its R result bits are the output, and the scores are +1 / −1.
  - The action is the first maximum. counts are the activations / spike counts of every plain layer, in layer order.

`threshold-layers` (`ThresholdLayersEngine`) has a shape of two words:

- `shape[0]`: `width_l` starts at bit 16·l. l = 0 is the inputs, l = L is the outputs, 1 ≤ L ≤ 8, and each width is 1..256.
- `shape[1]`: [0, 8) is weightBits (8 or 16). The shift k of map l (the map that produces width_{l+1}) is at [8 + 5l, 13 + 5l), with k ≤ 20. The bits above the last map are zero.

Each layer has one region, with `th` in the int16 bias column. An activation is `Σ W·x · 2^k − th ≥ 0`. The values `Σ W·x · 2^k − th` of the last layer are the scores.

A module supplies these functions:

- `forward`: execution from the resting state.
- `peek`: read-only prediction from the existing session.
- `step`: execution that writes state.
- `reset`: clears the session's state.
- `peekAs` / `stateOf`: state queries for any actor.

The writing actor is always msg.sender, so nobody can forge the state of another party. State is isolated by actor / session. The int32 potentials are packed 8 per storage word. A stateless module (FF without stateful tools) returns an empty state.

`forwardFrom(state, inputBits)` runs one decision from a given packed state. The packed state is ⌈stateWidth / 8⌉ words, and another length reverts with "state". It reads and writes no storage, and its voltages are the next state. A selector's engine uses it to run a tool whose state is in the calling session.

`step` emits a `Stepped` event. The digest of the event covers scores, action, counts and voltages, so you can check the state at the block of the receipt.

The web bridge `frontend/module-chain.js` deploys as follows:

- The bridge validates the artifact and encodes its weights into column-major chunks.
- The bridge creates the chunks not yet on chain together with the module in one `deploy` transaction.
- If the gas estimate (+ 10%) is more than the limit per transaction (30M on Monad), the bridge first creates missing chunks.
  - It uses one `createChunk` transaction for each chunk.
  - It continues until the module and the remaining chunks fit in the last transaction.
- If a single chunk alone does not fit, the bridge gives a clear error.
- Before any transaction, the bridge asks the Factory with `checkDeploy`. A refused module costs no transaction. Thus a failed estimate can only mean too little gas.
- The bridge never sends a chunk that is already on chain again. Thus an interrupted deployment continues from the missing chunk.
- A network with tool layers deploys its tools first. Every network tool is its own module. If the Factory already holds a module for the same artifact and that module passes verification, the bridge uses it again.
- A deployment uses the latest engine version by default. The caller can also name a version (`version`). New tools use the latest version of their own id.
- A code tool cannot be deployed.

The verification covers the selector and each of its tools, so it requires the artifacts of the tools. The verification checks these items:

- `isModule`.
- The descriptor.
- The engine contract is a version that the factory lists for the module's engine id. The bridge also reports which version: its number, and if it is the latest.
- The shape.
- The chunk addresses, calculated again from the artifact's content.

After a transaction, the bridge checks the Stepped digest and the state at the block of the receipt. The on-chain format / task identity does not prove the business meaning of arbitrary bit bindings. Applications still must define correct observations and action interpretation.

## Adding an engine version

An engine version is immutable (ADR 0017). A cheaper or fixed engine is a new version of the same id. Every version of one id must compute the same, bit for bit. Before ADMIN adds a new version, check it against the latest version of the id on chain:

1. Deploy the candidate: `forge create src/modules/<File>.sol:<Contract> --rpc-url <url> --private-key $PK --broadcast`.
2. From the repository root, run the check (it needs `anvil`):

   ```sh
   node contracts/scripts/engine-version-check.mjs --rpc-url <url> --factory <ModuleFactory proxy> --engine dense-policy --candidate <candidate address>
   ```

   The script starts a local `anvil --fork-url <url>`. This is a fork of the target network at its latest block. The target can be a local Anvil or any RPC. The script stops the fork at the end.

   On the fork, the script deploys through the bridge every case of the fixed input set that uses this engine. A case that uses the engine through a tool also counts. Then the script runs each case two times from the same state:

   - First run: the code of the latest version is at the address of every version of the id.
   - Second run: the code at these addresses is replaced with the code of the candidate.

   The code replacement uses `anvil_setCode`, only on the fork. Some tools come from the network, and the bridge uses them again. These tools also run on the latest version first, then on the candidate. This includes modules on an older version. The script compares the scores, action, counts and next state of every decision. A revert on one side only is also a difference.

3. Read the output and the exit code of the script:

   - Exit code 0: zero differences. The script prints the two transactions that an ADMIN sends, in order: `addVersion(engineId, candidate)` and `setLatest(engineId, candidate)` to the factory. The script also prints the matching `cast send`s.
   - Exit code 1: differences. The script prints the first input that differs: case, input or step of the session, input bits, which fields differ, and both values. The script also prints the number of differences per case, and no transaction.
   - Exit code 2: nothing to check. The cause is one of these:
     - The engine id has no latest version.
     - The candidate address has no code.
     - The candidate is already a version.
     - No case uses the engine.

   The script never sends anything to the target network.

4. If the check shows zero differences, an ADMIN sends the two transactions, or runs the script below.

   After this, new deployments use the new version. Existing modules keep their versions.

The fixed input set (`scripts/engine-cases.mjs`) contains every builtin artifact and these generated networks:

- FF and LIF.
- One layer and several layers.
- Each column path of the engine: ≤ 16 / ≤ 32 rows on the stack, more rows in memory, row counts off the lane grid.
- Weights over several chunks.
- Tool layers in FF and LIF networks: after a plain layer, or first in a segment.
- A deep threshold network.

Each generated network is built once per weight width of the model format. The weight widths come from `WEIGHT_BITS` in `frontend/runtime/dense-policy.js`: int8 and int16. The generation rules are:

- The weights come from the whole code range of the width, with both extreme codes included.
- The biases and thresholds come from the whole int16 range.
- Each region has its own scale and shift k: 7–9 for int8, 0–1 for int16. Thus both widths have k > 0.
- The threshold of a LIF layer is scale·2^k (1.0 real unit, the same as the trainer sets it).

To add a width, do not change anything here. When `WEIGHT_BITS` contains the width, the input set covers it.

Networks of at most 8 input bits run every input. Wider networks run 32 inputs of varied density. A LIF case is one session of 16 steps, and the script compares the next state at each step. The check of `dense-policy` has 19 cases and 480 decisions.

### Adding a version with the script

```sh
cd contracts
ENGINE=<engine id> VERSION=<the new version's address> FACTORY=<ModuleFactory proxy> forge script script/EngineVersion.s.sol --sig 'add()' --rpc-url <url> --private-key $PK --broadcast
ENGINE=<engine id> VERSION=<an added version> FACTORY=<ModuleFactory proxy> forge script script/EngineVersion.s.sol --sig 'setLatest()' --rpc-url <url> --private-key $PK --broadcast
```

`add()` adds `VERSION` to the versions of `keccak256(ENGINE)` and sets it latest. `setLatest()` makes a version already added to that id the latest again. For example, use it to go back to the previous version when the latest version is faulty. The broadcasting account must hold ADMIN. A new engine id does not need a factory upgrade.

Before it sends anything, the script refuses two types of address:

- `add()` refuses an address that is already a version (of any id).
- `setLatest()` refuses an address that is not a version of `ENGINE`.

The factory also refuses these two types of address, because a version is never changed or removed.

The workbench bridge knows only the `ENGINES` of `frontend/core/kinds/network.js`. To deploy with a new engine id from the workbench, first connect its executor and encoding there.

## Roles and handover

The broadcasting account of `Deploy.s.sol` starts with both protocol roles (ADR 0016). Before mainnet, give both roles to a multisig. Roles has no nominate-and-accept, so the handover has this order: grant, check, revoke.

CAUTION: Do not revoke the deployer's roles before you prove that the multisig works. Revoking the last ADMIN is final.

To see who holds which role (read-only, from the repository root), run:

```sh
node contracts/scripts/list-roles.mjs --rpc-url <url> --factory <ModuleFactory proxy> --from-block <block Roles was deployed in>
```

The script reads the factory's `roles()`. Then it collects the accounts from the `RoleGranted` events of Roles, because Roles keeps no list of holders. Then it confirms each account with `hasRole` at the latest block. The output has one line per holder, and `(none)` for a role that nobody holds.

The script reads the events with `eth_getLogs` in windows of `--block-range` blocks (default 1000, a usual RPC limit). With `--from-block` (default 0), the script does not scan the chain before Roles existed. The block number is in the receipts of `broadcast/Deploy.s.sol/<chain id>/run-latest.json`.

Do the handover in `contracts/`, with the deployer's key. `MULTISIG` is the address of the multisig on that network.

1. Grant: run `FACTORY=<ModuleFactory proxy> MULTISIG=<address> forge script script/HandOverRoles.s.sol --sig 'grant()' --rpc-url <url> --private-key $PK --broadcast`.

   The multisig gets ADMIN and UPGRADER.

2. Check: run `list-roles.mjs`. Both roles must show the deployer and the multisig.
3. Make the multisig prove that it can act as ADMIN: from the multisig, send Roles a `grantRole(ADMIN, multisig)`.

   Make the calldata with `cast calldata 'grantRole(bytes32,address)' $(cast keccak neurom.role.admin) <multisig>`. The multisig already holds this role, so this transaction changes nothing. It succeeds only for an ADMIN.

4. Revoke: run the same command with `--sig 'revoke()'` in place of the `--sig` value.

   The script revokes the deployer's UPGRADER, then its ADMIN. If `MULTISIG` is not another account that holds both roles, the script refuses before it sends anything.

5. Run `list-roles.mjs` again. Both roles must show only the multisig.

## Gas

`forge test --network monad -vv` (`testGasOfMiningNetworks`) gives the table below. The measurement conditions are:

- Synthetic weights in ±100 (within int8), shift 0, about 21 ones per input.
- Without the transaction base fee of 21,000. The forge isolate mode (on with `network = "monad"`) runs each call as a transaction, so the numbers include the calldata cost.
- "Deploy" is one `deploy` that creates the chunk and the module. "Redeploy" is a second module on the same chunk.
- One step is a single call with cold accounts. The test also makes the module account cold, so the call pays one more cold access. In a real transaction, the module is the target of the transaction and is warm from the start. A game is 63 `forward` calls in one call.
- [benchmark/](../benchmark/README.en.md) gives the receipt gas of real step transactions. For example, one step transaction of FF 185→32→7 int8 is 100,287 (base fee included).

| Network | weightBits | Deploy (chunk + module, one call) | Redeploy (module only) | forward | step | 63-step game |
|---|---|---|---|---|---|---|
| FF 185→32→7 | 8 | 1,996,410 | 337,236 | 91,000 | 116,689 | 3,258,388 |
| FF 185→32→7 | 16 | 3,295,015 | 337,262 | 91,794 | 117,090 | 3,286,572 |
| FF 185→64→32→7 | 8 | 3,825,933 | 338,491 | 145,575 | 170,244 | 6,573,514 |
| FF 185→64→32→7 | 16 | 6,910,465 | 338,517 | 156,403 | 180,372 | 7,168,575 |

int8 makes the chunk about half the size. In compute, one int8 column word splits into four lane words by row mod 4. This is about the same work as the four lane words from two int16 words. Thus up to 32 rows, a game costs about the same at both widths. Wider layers are slightly cheaper at int8, because int8 reads fewer words.

A single step transaction pays for some cold account accesses: the engine version, the module implementation and the chunk, 10,100 each on Monad. A game of many steps in one transaction pays for them once.

### Monad rules and Ethereum rules

To compare the two rule sets, use the receipts of real transactions: see the section "Monad network results" of the root README and [benchmark/](../benchmark/README.en.md). Do not use `testGasOfMiningNetworks` for this comparison. It measures in the frame of the test contract itself, the memory of this frame grows during the test, and Ethereum charges memory quadratically. Thus its Ethereum numbers are too high.

The differences between the two chains come from the Monad price rules ([Opcode Pricing](https://docs.monad.xyz/developer-essentials/opcode-pricing)):

- A cold account access costs 10,100 on Monad and 2,600 on Ethereum. The first write of a fresh storage slot in a page costs 27,900 on Monad and 22,100 on Ethereum. Thus a redeploy (module only) and a single step cost more on Monad.
- Memory expansion is linear on Monad and quadratic on Ethereum. Thus calls that use much memory cost less on Monad, for example a 63-step game or a very large network (see the root README).

A comparison with `hardfork = "monad:MonadNine"` (before MIP-8) gives the effect of MIP-8. From MonadNine to MonadTen, a deploy costs 16,400–16,500 gas less, and a redeploy costs 8,400 gas less. forward, step and the game do not change.

### Benchmarks

The scripts in [benchmark/](../benchmark/README.en.md) measured the section "Monad network results" of the root README. That folder gives the steps of each script, and the check of `anvil --network monad` against the Monad testnet.

The step in the benchmarks is smaller than the step in the table above, for two reasons:

- The gasUsed of a receipt includes the base fee of 21,000 and the calldata.
- The trained mining network gets on average 14.3 ones per input. The synthetic input has about 21.
