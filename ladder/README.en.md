# The site and the tank ladder page (`ladder/`)

This directory is the NEUROM site: the home page, the page of the tank battle contest, the participation guide and the name service (ADR 0026, ADR 0027). It is an npm workspace of the repo root and the root directory of the Vercel project. The site has four pages on one origin: the home page at `/`, the ladder at `/ladder/`, the workbench at `/studio/` and the participation guide at `/guide/`. Local development and the live site use the same paths. The pages use Vue 3 and Vite, as the workbench does. The login uses the Privy session of `frontend/wallet/privy.js`, which mounts the Privy React SDK into one element the page gives it. The page imports the workbench modules of `../frontend/` directly. It does not copy code.

## Directories

- `index.html` and `src/home/`: the home page. `ladder/index.html` and `src/`: the ladder page. `guide/index.html` and `src/guide/main.js`: the participation guide. It is a static page in Chinese and English that tells a player how to train from zero, deploy, register and challenge. The three pages are three inputs of one Vite build (`vite.config.js`). `src/chain/` is the ladder client without UI. It reads the ladder contract and the archive of the official Factory (`deploymentsOf`: the modules one account deployed and their English IDs). `src/components/SiteBar.vue` is the site top bar that the home page and the ladder share. `src/i18n.js` and `src/i18n/en.json` are the English entries of the page.
- `api/`: the Vercel functions. `api/names.js` only wires the environment to the modules of `server/`.
- `server/`: the logic of the name service (`names.js`), the HTTP layer (`names-http.js`) and the database (`db.js`, `schema.sql`).
- `data/`: data that changes. `banned-words.json` is the banned word list, `step-gas.json` is the measured gas of a step, `deployments.json` is the RPC, the official Factory and the ladder contract of each chain.

## Local run

One command starts the whole local stack:

```
ANVIL=~/.foundry/bin/anvil FORGE=~/.foundry/bin/forge node ladder/scripts/dev-chain.mjs
```

The script does this:

1. Builds the contracts, starts a fresh `anvil --network monad` and deploys the protocol and the ladder (`frontend/ladder.fixture.js`). `--board-size 3` deploys the ladder with a board of 3 ranks, so the default entries fill it and the page shows entries off the board.
2. Registers a few entries from anvil accounts 0 and 2. By default it uses the trained 中 and 大 networks in `ladder/data/artifacts/`. If `.scratch/jolt/` on this machine has other artifacts, it registers them too. `--artifacts a.json,b.json` selects other files. `--no-seed` registers nothing, so the ladder starts empty.
3. Plays a few challenges to the end. `--no-play` skips this step.
4. Starts the name service on PGlite in the process, mounts it at `/api/names` of the page and names the registered entries.
5. Starts one Vite dev server for each login account, pointed at this anvil through `VITE_LADDER_RPC`, `VITE_LADDER_FACTORY` and `VITE_LADDER_ADDRESS`. The first server uses `--port` (default 5174). Each next server uses the next port. Each server serves the home page at `/` and the ladder at `/ladder/`.
6. Each server serves the workbench (`frontend/`) at `/studio/`, as the live site does. The workbench uses the same chain, the same official Factory and the login account of that server. Train there, give the candidate an English ID, deploy it, then choose it on the ladder page from the modules this account deployed and register: the whole flow runs locally. The Python workspace of the workbench goes through the proxy of the root `vite.config.ts`.

The Log in button of each page uses one account of the anvil default mnemonic (`VITE_DEV_ACCOUNT`). By default there is one page, with account 1. It owns no entry at the start, so the whole flow (deploy, register, challenge, name) can be walked locally. The private keys of these accounts are public: local development only.

`--fork` deploys nothing. It starts a local fork of Monad testnet instead (ADR 0028): the fork entry of `data/deployments.json`, with its chain id and port, the same command as `forkCommand` of `frontend/chain.js`. The fork keeps the board, the official Factory and the ladder of the real chain, so it registers nothing and plays nothing. The pages and the workbench use the fork entry, and the chain node of a template reaches the same node.

To try several users, list the account indices (0 to 9) with `--accounts`. Each account gets one page on its own port, so each page keeps its own login. All pages use the same chain and the same name service. For example:

```bash
npm run dev:chain -w ladder -- --accounts 1,3,4,5,6,7 --no-seed
```

This starts 6 pages on the ports 5174 to 5179, with an empty ladder. `/ladder/` of each port is the ladder and `/studio/` is the workbench.

To start only the local-chain page, run `VITE_LADDER_CHAIN_ID=31337 npm run dev -w ladder`. The ladder is at `/ladder/`. It uses the local RPC in `data/deployments.json`. The name service is not available. The workbench is at `/studio/` of the same port. Without a chain selection, the page prefers a public chain with a ladder address.

## Testnet season

The contracts are on Monad Testnet (Chain ID `10143`). The web pages still run locally.

| Item | Value |
|---|---|
| Unified Factory | [`0xC059cCfbc7A8654e9c96d5da66bc6aE3a3ffffd2`](https://testnet.monadscan.com/address/0xC059cCfbc7A8654e9c96d5da66bc6aE3a3ffffd2) |
| Ladder contract | [`0xEF5fb216c86bC439Fd6eC48B4531CAf079ad463b`](https://testnet.monadscan.com/address/0xEF5fb216c86bC439Fd6eC48B4531CAf079ad463b) |
| Ladder deployment block | `78216316` |
| Season end block | `84827030` (`admin` can move it with `setEndBlock`; `endBlock()` on chain is the current value) |
| Ladder `admin` | `0x646D80bc9aEE2c383769CF546768a45f942b54CB` |
| RPC | `https://testnet-rpc.monad.xyz` |

The workbench and ladder share `data/deployments.json`. Run:

```bash
VITE_LADDER_CHAIN_ID=10143 npm run dev -w ladder
```

The home page is at `/`, the ladder at `/ladder/`, the workbench at `/studio/`. Select `Monad Testnet (10143)` in the deployment module. The workbench and ladder share `frontend/wallet/privy.js` and the same Privy user's embedded EVM wallet. Neither page substitutes an external wallet. The two pages have one origin, so one login is enough, and the addresses match, which the submission page needs to list the corresponding archive.

Without login configuration, the ladder can still read ranks, rules and replays. Do not put deployment keys in `VITE_*` variables. Public web pages and the name service still need Vercel, Privy and Neon configuration.

The previous ladder contract `0x8671257deEb3A3c296C56530Bf54eCAD9bC78fF2` passed all 5 testnet checks. Challenge `#1` ran 6 episodes and 270 steps. The score was `2 : 2`, with a successful defense. The archive stores the English IDs of both verification modules. These modules only check deployment and the contest flow.

The current ladder contract only adds `setEndBlock`. The contest rules did not change, so the 5 checks did not run again. After the deployment, `admin` called `setEndBlock` once on chain with the same end block, and the contract emitted `EndBlockChanged`. A call from another account reverted `NotAdmin`.

Public RPC endpoints limit log query ranges. The client reads at most 100 blocks per query and sends each RPC request separately. Contest log queries stop at the challenge deadline. They do not scan later empty blocks.

## Challenge results and replays

The page shows the result from the current wallet's side. The challenger sees "Challenge succeeded" or "Challenge failed". The defender sees "Defense succeeded" or "Defense failed". Spectators and logged-out users see the winner. Timeout results state "timeout". Scores always use the order "challenger : defender".

The full player stops at the last step of the selected episode. It does not select the next episode automatically. Click "Last step" to inspect the latest recorded frame. A completed episode shows the terminal frame and its result text. Manual episode selection, steps and slider changes pause playback.

Background updates for the same challenge do not reset playback position. The challenge page reads one update at a time, so new blocks do not discard slow RPC results. Settled challenges do not reload the replay on each block. The home page repeats only completed episodes with a winner. It excludes draws and unfinished episodes. From recent challenges, it selects the newest challenge with an eligible episode.

The home page keeps the original episode numbers. If no recent challenge has an eligible episode, the home page shows "No episode has a winner yet". Full replays retain all episodes.

The page shows challenge status before it reads the replay. Configuration and ranks do not wait for historical gas or names. Only the main page reads gas totals for recent challenges. Each reader permits one query at a time. A new block queues one refresh. Replays and historical gas share the historical logs already read.

## Timeout settlement

When the challenge page is open, the challenger's wallet automatically submits timeout settlement. The page calls `expire` with the node's gas estimate. The page attempts automatic settlement once for each challenge and account. If signing or submission fails, click "Retry settlement". Spectators pay only after they click "Settle timeout". No background service sends transactions after you close the page.


## Wallet and node errors

`could not coalesce error` is an outer error from the wallet library. This error alone does not mean that the wallet balance is insufficient.

The workbench and ladder share `frontend/chain-error.js`. The page shows the specific reason and code from nested errors. The page reports insufficient balance only when the error states this condition. The page identifies rejected signatures separately. Without a specific reason, the page states that the wallet or node gave no reason. The ladder gives priority to custom contract errors.


## Environment variables

Page (Vite, read at build time):
Both Vite configurations read `.env.local` from the repository root, not `ladder/.env.local`. Both pages share `VITE_PRIVY_APP_ID` and chain configuration. Privy keeps the login state per origin. The live site and the local ladder dev server both serve the workbench at `/studio/`, on the origin of the ladder, so one login is enough. A workbench started alone with the root `npm run dev` has another origin and needs its own login. Never put an App Secret or wallet private key in `VITE_*`.


- `VITE_PRIVY_APP_ID`: the shared Privy app ID. Public chains use the Privy embedded wallet for login and signatures. Without it, the ladder is read-only. Local dev (31337) always uses public Anvil development accounts and shows the LOCAL DEV label.
- `VITE_LADDER_CHAIN_ID`: the chain of the page, a key of `data/deployments.json`. Default: the first chain of the file with a ladder address, else 31337.
- `VITE_LADDER_RPC`, `VITE_LADDER_FACTORY`, `VITE_LADDER_ADDRESS`: optional. Override the RPC, the official Factory and the ladder address of `deployments.json`. The dev script uses them to point at its anvil.
- `VITE_DEV_ACCOUNT`: the index of the local dev account in the mnemonic, default 1.

The configuration of the contract (δ, range, board size, cooldown, timeout, maximum weight size, season end block) is read from the contract, never written in the page.

Name service (Vercel functions):

- `DATABASE_URL`: the connection string of Neon Postgres. The Vercel Marketplace sets it when you add Neon.
- `ADMIN_TOKEN`: the bearer token of the admin clear. Without it, every `DELETE` is refused.
- `LADDER_CHAIN_ID`: the chain of the service, a key of `data/deployments.json`.
- `LADDER_RPC_URL`: optional. Overrides the RPC of `deployments.json`.
- `LADDER_ADDRESS`: optional. Overrides the ladder address of `deployments.json`.

## The pages

The home page (`/`) introduces NEUROM: what it is, the flow from the canvas to the ladder, the features, the numbers of the Monad network results, and the links to the workbench, the ladder and the documents. The text of the home page comes from the README of the repo.

The main page of the ladder (`/ladder/`) is one long page: the top bar, the hero in two columns (left: title, one line, the 3-step guide and the buttons, right: the dark panel that plays the latest challenge), the data strip, the sticky numbered nav on the left, then 4 sections: start, ladder, rules, recent challenges. The layout follows Open Kernel Challenge and HashSmash. The visual style follows mojo.devnads.com.

The three pages share one site top bar, in the same order: the wordmark `NEUROM` to `/`, then Tank Ladder (`/ladder/`), Workbench (`/studio/`) and GitHub. The top bar of the ladder also has its own section links and the wallet.

Three more views of the ladder switch on the URL hash (for example `/ladder/#/entries`):

- `#/entries` my entries: choose one of the modules the current account deployed and register it. The module is deployed first in the deployment module of the workbench, with an English ID, through the official Factory, on this chain. The page reads the modules this account deployed (English ID, address, structure, artifact) from the archive of the official Factory. It does not read events or the local storage of the browser. A module already on the ladder shows its rank and cannot be chosen. After a deployment in the workbench, the list updates at the next block. You do not copy an address. The page shows the chain and the official Factory the contract records. It sends only the register transaction: it deploys nothing and no longer imports or uploads JSON. The contract records the entry under the account that sends the register transaction, whoever deployed the module. After the registration you can name the entry. The name is the display name of the contest. It is not the English ID of the module.
- `#/challenge/<id>` a challenge in progress: the 6 episodes as cells, the current step, the transactions in flight and confirmed, then the result and the rank change. After you close the page and come back, you continue from my entries.
- `#/replay/<id>` a replay: the tank board in the dark panel, segmented tabs for the 6 episodes, the step slider below.

`src/replay/scene.js` rebuilds a replay: the scene of the template (`battle` and `play`), the seed and the actions of the events give the state of every step. The replay view script of the template draws it in a sandboxed iframe (`frontend/editor/renderers/script-frame.js`). The page copies no rules.

The page reaches the chain only through `src/chain/client.js`. `src/ladder/errors.js` maps the custom errors of the contract and the error codes of the name service to messages.

## Name service API

All paths are `/api/names`. A refusal returns `{ "error": "<code>", ... }`. The page maps each code to a message.

- `GET /api/names?modules=0xa,0xb`: batch read. Returns `{ "names": { "0xa": "Name" } }`. The address keys are lower case. An address without a name is absent. One request takes at most 200 addresses.
- `POST /api/names` with body `{ "module", "name", "signature" }`: set a name. Returns `{ "module", "name", "owner" }`.
- `DELETE /api/names?module=0xa` with header `Authorization: Bearer <ADMIN_TOKEN>`: admin clear. Returns `{ "module", "cleared": true|false }`.

Error codes: `invalid_module`, `name_length`, `name_chars`, `name_banned`, `bad_signature`, `bad_json`, `bad_request` (400), `not_entered`, `not_owner` (403), `name_set`, `name_taken` (409), `unauthorized` (401), `method_not_allowed` (405), `body_too_large` (413).

The text that the page signs comes from `nameMessage({ chainId, module, name })` in `server/names.js`. The format is fixed: 4 lines, separated by `\n`:

```
NEUROM ladder name
chain: <chain id, decimal>
module: <module address, lower case>
name: <the name, verbatim>
```

The signature is an EIP-191 personal message (`signer.signMessage(text)` in ethers). The server recovers the signer, then compares it with `entryOwner(module)` of the ladder contract. The signer must be the account that registered the entry.

Rules: a name is 3 to 24 characters, English letters, digits, space, `_` and `-` only. Names are case-insensitive and unique. After a set, the name does not change. After an admin clear, the owner can set a name one more time. The banned word check is case-insensitive and ignores space, `_` and `-`.

## Tests

```
npm test -w ladder
```

The database is PGlite in the process. The owner check runs against the real ladder contract on a local anvil. Without Foundry, the chain test skips. The root `npm test` also runs these tests.

## Deployment on Vercel

1. Create a Vercel project with Root Directory `ladder`.
2. Enable "Include source files outside of the Root Directory in the Build Step". The build reads modules of `../frontend/`.
3. Keep the default Install Command. Vercel runs `npm install` in the repo root, because the root `package.json` declares the workspace.
4. `ladder/vercel.json` sets the Build Command `npm run build` and the Output Directory `dist`. The build makes the home page, the ladder page and the participation guide first. Then `frontend/build.mjs --hosted` makes the workbench into `dist/studio/index.html`. The site serves the home page at `/`, the ladder at `/ladder/`, the workbench at `/studio/` and the participation guide at `/guide/` (ADR 0027). `/ladder`, `/studio` and `/guide` redirect to the URL with the slash. The live workbench trains in the browser only and does not connect to a Python workspace.
5. Add Neon from the Marketplace, then set the environment variables above.

## Deploying a season (testnet and mainnet)

`scripts/deploy-wizard.sh` walks a human through everything a season on Monad needs: the chain first, then Vercel, Neon and Privy, then one walk through the live page. Each stage does one thing; captured values go to `ladder/.env.deploy-<network>` (gitignored), and a re-run offers every saved value as the default.

```
ladder/scripts/deploy-wizard.sh                     # Monad testnet (10143)
ladder/scripts/deploy-wizard.sh --network mainnet   # Monad mainnet (143)
ladder/scripts/deploy-wizard.sh --dry-run           # list the stages and the tools found only
```

It needs Foundry ≥ 1.8 (`FORGE=` points at forge), Node ≥ 22.12 and a done `npm install`. With the Vercel CLI installed, the script sets the environment variables itself; without it, it lists names and values for the project settings page.

Stages:

1. Tools, and the chain id the RPC reports.
2. The deployer's private key (pasted or generated). After deploying the protocol this account holds its ADMIN and UPGRADER roles; on mainnet keep it as the admin key.
3. Fund the deployer. Testnet: the faucet opens; mainnet: transfer. A full run needs about 30 MON: ~16.3M gas for the protocol, ~3M for the ladder, about 20 MON for the chain checks of stage 8. Monad charges the gas limit, not the gas used.
4. The official Factory: paste the FactoryProxy address when the protocol is already on this chain, else the script deploys it with `contracts/script/Deploy.s.sol`.
5. The season end block. The script measures the block rate for 10 seconds and suggests a block from a number of days; the human may change it. Before the season ends, the deployer key can move the end block with `setEndBlock` (see `contracts/README.en.md`). After the season ends, nobody can change it.
6. The ladder contract: `contracts/script/DeployLadder.s.sol` with the configuration of the spec; export `LADDER_*` variables before running the wizard to change it (see the script's comment).
7. The Factory and ladder addresses go into the chain's entry of `data/deployments.json` (only those two lines change); commit the file afterwards.
8. The chain checks (next section).
9. The Vercel project: Root Directory `ladder`, "Include source files outside of the Root Directory in the Build Step" on.
10. Neon from the Vercel Marketplace, connected to the project's Production and Preview environments; `DATABASE_URL` is injected. The name service creates its table on its first request.
11. In Privy, enable email and automatic EVM wallet creation under Authentication → Login methods. Enable Disable confirmation modals under Authentication → Advanced. Disable smart wallets. Add the origin of the site under Basics → Domains and clients. The ladder and the workbench share this origin. To log in on a local workbench too, also add the origin of the local workbench. All pages must use the same App ID.
12. Vercel environment variables: `VITE_PRIVY_APP_ID`, `VITE_LADDER_CHAIN_ID`, `LADDER_CHAIN_ID`, `LADDER_RPC_URL`, `LADDER_ADDRESS`, `ADMIN_TOKEN` (generated). The testnet run writes Production and Preview, the mainnet run replaces Production only. Then redeploy.
13. A walk through the live page: log in, set an English ID and deploy in the workbench, choose the module and register, challenge, set a name. Confirm that no confirmation modal appeared during the whole challenge.
14. (mainnet) The known limits go into the contest rules: gas-limit pricing, challengers must be plain EOAs, the end block and who can move it, δ and range, cooldown, timeout.

## Chain checks (`scripts/verify-chain.mjs`)

The facts the prototype proved only on anvil, proved again on the real network:

- An EIP-7702 delegated account carries code (the script prints its size: 23 bytes, `0xef0100` and the target).
- `challenge` refuses that account with `NotEoa`, while a plain EOA passes that check (it is refused for another reason).
- A challenge between two entries runs from the contract to settlement. The script deploys two copies of the 中 network through the Factory (39,840 weight bytes). The script changes the last padding byte to make distinct entries for each run. The English ID includes a salt and the time. The script registers both modules, starts the challenge and calls `advance` until settlement. Each play transaction has a 30M gas limit. A challenge runs at most 600 steps. The transaction count depends on the scene seed.
- The gas per step against the `mid-mid` numbers of `data/step-gas.json`; a deviation over 30% fails, because the page estimates costs from these numbers.

```
ANVIL=… FORGE=… node ladder/scripts/verify-chain.mjs --anvil                       # self-test on a fresh anvil --network monad
DEPLOYER_PRIVATE_KEY=0x… node ladder/scripts/verify-chain.mjs --rpc https://testnet-rpc.monad.xyz [--ladder 0x…]
```

`--ladder` defaults to the chain's address in `data/deployments.json`. The script prints the gas of every transaction, what the deployer actually paid, and PASS/FAIL per check; the exit code is 1 on any failure. A run on a real network costs about 20 MON at a 100 gwei base fee.
