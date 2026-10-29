# The tank ladder page (`ladder/`)

This directory is the page and the name service of the tank battle contest (ADR 0026, ADR 0027). It is an npm workspace of the repo root and the root directory of the Vercel project. The page uses React, Vite and the Privy React SDK. The page imports the workbench modules of `../frontend/` directly. It does not copy code.

## Directories

- `src/`: the page. `src/chain/` is the ladder client without UI. `src/i18n.js` and `src/i18n/en.json` are the English entries of the page.
- `api/`: the Vercel functions. `api/names.js` only wires the environment to the modules of `server/`.
- `server/`: the logic of the name service (`names.js`), the HTTP layer (`names-http.js`) and the database (`db.js`, `schema.sql`).
- `data/`: data that changes. `banned-words.json` is the banned word list, `step-gas.json` is the measured gas of a step, `deployments.json` is the RPC, the official Factory and the ladder contract of each chain.

## Local run

One command starts the whole local stack:

```
ANVIL=~/.foundry/bin/anvil FORGE=~/.foundry/bin/forge node ladder/scripts/dev-chain.mjs
```

The script does this:

1. Builds the contracts, starts a fresh `anvil --network monad` and deploys the protocol and the ladder (`frontend/ladder.fixture.js`).
2. Registers a few entries from anvil accounts 0 and 2. By default it uses the trained 中 and 大 networks in `ladder/data/artifacts/`. If `.scratch/jolt/` on this machine has other artifacts, it registers them too. `--artifacts a.json,b.json` selects other files.
3. Plays a few challenges to the end. `--no-play` skips this step.
4. Starts the name service on PGlite in the process, mounts it at `/api/names` of the page and names the registered entries.
5. Starts the Vite dev server (`--port`, default 5174), pointed at this anvil through `VITE_LADDER_RPC`, `VITE_LADDER_FACTORY` and `VITE_LADDER_ADDRESS`.

The Log in button of the page uses account 1 of the anvil default mnemonic (`VITE_DEV_ACCOUNT`). It owns no entry at the start, so the whole flow (register, challenge, name) can be walked in the browser. The private keys of these accounts are public: local development only.

`npm run dev -w ladder` starts only the page. Then the page connects to `http://127.0.0.1:18545` per the `31337` entry of `data/deployments.json`, and the name service is not available.

## Environment variables

Page (Vite, read at build time):

- `VITE_PRIVY_APP_ID`: the Privy app id. With it, the page logs in with the Privy embedded wallet (`showWalletUIs: false`: the transactions of a challenge get no popup each). Without it, the page uses an account of the anvil default mnemonic on the local chain (31337), marked LOCAL DEV in the UI. This is for local development only.
- `VITE_LADDER_CHAIN_ID`: the chain of the page, a key of `data/deployments.json`. Default: the first chain of the file with a ladder address, else 31337.
- `VITE_LADDER_RPC`, `VITE_LADDER_FACTORY`, `VITE_LADDER_ADDRESS`: optional. Override the RPC, the official Factory and the ladder address of `deployments.json`. The dev script uses them to point at its anvil.
- `VITE_DEV_ACCOUNT`: the index of the local dev account in the mnemonic, default 1.

The configuration of the contract (δ, range, cooldown, timeout, maximum weight size, season end block) is read from the contract, never written in the page.

Name service (Vercel functions):

- `DATABASE_URL`: the connection string of Neon Postgres. The Vercel Marketplace sets it when you add Neon.
- `ADMIN_TOKEN`: the bearer token of the admin clear. Without it, every `DELETE` is refused.
- `LADDER_CHAIN_ID`: the chain of the service, a key of `data/deployments.json`.
- `LADDER_RPC_URL`: optional. Overrides the RPC of `deployments.json`.
- `LADDER_ADDRESS`: optional. Overrides the ladder address of `deployments.json`.

## The page

The main page is one long page: the top bar, the hero in two columns (left: title, one line, the 3-step guide and the buttons, right: the dark panel that plays the latest challenge), the data strip, the sticky numbered nav on the left, then 4 sections: start, ladder, rules, recent challenges. The layout follows Open Kernel Challenge and HashSmash. The visual style follows mojo.devnads.com.

Three more views switch on the URL hash:

- `#/entries` my entries: import a model artifact (a file or pasted JSON). The page checks the content id, then deploys and registers. After the registration you can name the entry.
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
4. The Build Command is `npm run build`, the Output Directory is `dist`.
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
5. The season end block. The script measures the block rate for 10 seconds and suggests a block from a number of days; the human may change it. The end block is fixed in the constructor.
6. The ladder contract: `contracts/script/DeployLadder.s.sol` with the configuration of the spec; export `LADDER_*` variables before running the wizard to change it (see the script's comment).
7. The Factory and ladder addresses go into the chain's entry of `data/deployments.json` (only those two lines change); commit the file afterwards.
8. The chain checks (next section).
9. The Vercel project: Root Directory `ladder`, "Include source files outside of the Root Directory in the Build Step" on.
10. Neon from the Vercel Marketplace, connected to the project's Production and Preview environments; `DATABASE_URL` is injected. The name service creates its table on its first request.
11. The Privy app: Ethereum embedded wallets on, "Disable confirmation modals" on (a challenge is up to 20 transactions in a row), the Vercel domain under Allowed origins. The page code also sets `showWalletUIs: false` and wallet creation on login.
12. Vercel environment variables: `VITE_PRIVY_APP_ID`, `VITE_LADDER_CHAIN_ID`, `LADDER_CHAIN_ID`, `LADDER_RPC_URL`, `LADDER_ADDRESS`, `ADMIN_TOKEN` (generated). The testnet run writes Production and Preview, the mainnet run replaces Production only. Then redeploy.
13. A walk through the live page: log in, register, challenge, set a name. Confirm that no confirmation modal appeared during the whole challenge.
14. (mainnet) The known limits go into the contest rules: gas-limit pricing, challengers must be plain EOAs, the end block, δ and range, cooldown, timeout.

## Chain checks (`scripts/verify-chain.mjs`)

The facts the prototype proved only on anvil, proved again on the real network:

- An EIP-7702 delegated account carries code (the script prints its size: 23 bytes, `0xef0100` and the target).
- `challenge` refuses that account with `NotEoa`, while a plain EOA passes that check (it is refused for another reason).
- A challenge between two entries runs from the contract to settlement. The script deploys two twins of the 中 network through the Factory (the last weight byte is padding; a salt makes every run new entries), registers them, starts the challenge with a 30M gas limit and `advance`s until settled. Twins draw every episode, so this is the worst case of mid-mid: 600 steps, 5 transactions.
- The gas per step against the `mid-mid` numbers of `data/step-gas.json`; a deviation over 30% fails, because the page estimates costs from these numbers.

```
ANVIL=… FORGE=… node ladder/scripts/verify-chain.mjs --anvil                       # self-test on a fresh anvil --network monad
DEPLOYER_PRIVATE_KEY=0x… node ladder/scripts/verify-chain.mjs --rpc https://testnet-rpc.monad.xyz [--ladder 0x…]
```

`--ladder` defaults to the chain's address in `data/deployments.json`. The script prints the gas of every transaction, what the deployer actually paid, and PASS/FAIL per check; the exit code is 1 on any failure. A run on a real network costs about 20 MON at a 100 gwei base fee.
