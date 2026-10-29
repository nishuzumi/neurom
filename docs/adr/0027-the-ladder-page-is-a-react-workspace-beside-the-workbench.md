---
status: proposed
---

# The ladder page is a React workspace beside the workbench

## Context

The tank ladder (ADR 0026) needs a page for players and viewers: login, the ladder, entry registration, challenges and replays. The page sends all transactions of a challenge without a wallet popup for each one. The research picked the Privy embedded wallet with `showWalletUIs: false` (`.scratch/ladder/research-monad-1ct-wallets.md`). Privy supports this through its React SDK. The documentation of its vanilla SDK, `@privy-io/js-sdk-core`, says that it is a low-level library, and that a project must speak to the Privy team before it uses it (https://docs.privy.io/recipes/core-js).

The workbench is a Vue app. Its Vite root is `frontend/`, and `frontend/build.mjs` makes one self-contained HTML file. The ladder page is a hosted site on Vercel with API functions for names, so its build is different.

The page needs code of the workbench: the chain bridge, the chain configuration and ABIs, the scenario runtime and the template for replays and parity, and the document of the view script frame. A view script runs in a sandboxed iframe, so a page in any framework can show it.

## Decision

- The page is the npm workspace `ladder/` at the repo root. It is also the root directory of the Vercel project.
- The page uses React and the Privy React SDK.
- The page imports the modules of `frontend/` that it needs. It does not copy them.
- Chain calls use ethers, as the chain bridge does. viem appears only as the chain object that Privy needs.
- The logic of the name service is in plain modules. The Vercel functions only call them, so the tests do not need the Vercel runtime.
- Data that changes is in data files of the page: the banned words and the measured gas of each step. The page reads the contract configuration from the contract.
- The ladder contract and the port of the scene are in `contracts/src/ladder/`. The parity fixture is beside its consumer: JS writes the episodes, and forge plays them again.

## Considered Options

- **A second Vue entry in `frontend/`.** It shares the dependencies, but the single-file build and the hosted build would share one Vite configuration. Privy would need its vanilla SDK.
- **Vue with `@privy-io/js-sdk-core`.** One framework stays in the repo. But Privy asks for contact before use, and the iframe and message wiring of the embedded wallet becomes our code.
- **A separate repository.** The page would need a copy or a package of the chain bridge and the scenario runtime, and the parity of the replay would depend on a version.

## Consequences

- The repo has two UI frameworks. The workbench stays Vue.
- The root `package.json` gets `"workspaces": ["ladder"]`. The root `npm test` also runs the tests of `ladder/`. The workbench build does not change.
- The Vercel build reads files outside `ladder/`. The project must allow this.
- A change of the chain bridge or the scenario runtime can break the page. The tests of the ladder client run against the same modules on a local anvil.
