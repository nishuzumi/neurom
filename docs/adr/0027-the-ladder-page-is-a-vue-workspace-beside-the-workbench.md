---
status: proposed
---

# The ladder page is a Vue workspace beside the workbench

## Context

The file `.scratch/ladder/research-monad-1ct-wallets.md` is on the branch `prototype/tank-ladder` (commit `2b12472`).

The tank ladder (ADR 0026) needs a page for players and viewers: login, the ladder, entry registration, challenges and replays. The page sends all transactions of a challenge without a wallet popup for each one. The research picked the Privy embedded wallet with `showWalletUIs: false` (`.scratch/ladder/research-monad-1ct-wallets.md`). Privy supports this through its React SDK. The documentation of its vanilla SDK, `@privy-io/js-sdk-core`, says that it is a low-level library, and that a project must speak to the Privy team before it uses it (https://docs.privy.io/recipes/core-js).

The workbench is a Vue app. Its Vite root is `frontend/`, and `frontend/build.mjs` makes one self-contained HTML file. The ladder page is a hosted site on Vercel with API functions for names, so its build is different.

The page needs code of the workbench: the chain bridge, the chain configuration and ABIs, the scenario runtime and the template for replays and parity, and the document of the view script frame. A view script runs in a sandboxed iframe, so a page in any framework can show it.

The first version of the page was a React app, because the Privy React SDK needs a React tree. Since then, `frontend/wallet/privy.js` wraps the SDK in a session object. A host gives the session one empty element, and the session renders the Privy provider there. The workbench, a Vue app, already uses the session this way. So the SDK no longer decides the framework of the page.

## Decision

- The page is the npm workspace `ladder/` at the repo root. It is also the root directory of the Vercel project.
- The page is a Vue 3 app, like the workbench: single-file components with `<script setup>`, plain JavaScript. The page shares the locale state of the workbench, so one `t()` serves both.
- The page uses the Privy React SDK only through `frontend/wallet/privy.js`. React and react-dom stay root dependencies for the SDK. No authored page code is React.
- The page imports the modules of `frontend/` that it needs. It does not copy them.
- Chain calls use ethers, as the chain bridge does. viem appears only as the chain object that Privy needs.
- The logic of the name service is in plain modules. The Vercel functions only call them, so the tests do not need the Vercel runtime.
- Data that changes is in data files of the page: the banned words and the measured gas of each step. The page reads the contract configuration from the contract.
- The ladder contract and the port of the scene are in `contracts/src/ladder/`. The parity fixture is beside its consumer: JS writes the episodes, and forge plays them again.
- The site has three pages on one origin: the home page at `/`, the ladder at `/ladder/` and the workbench at `/studio/`. The home page says what NEUROM is and links to the two apps. The home page and the ladder are two inputs of one Vite build in `ladder/` (`index.html` and `ladder/index.html`). The views of the ladder stay hash routes under `/ladder/` (`#/entries`, `#/challenge/<id>`, `#/replay/<id>`). `/ladder` and `/studio` redirect to the directory URL (`ladder/vercel.json`, and the dev plugin).
- The participation guide at `/guide/` is a static page of the same build (`ladder/guide/index.html`). It holds the Chinese and the English text. Its links to the pages of the site are paths, so it works on any domain. `/guide` redirects to `/guide/`.
- The site also serves the workbench at `/studio/`. The build of `ladder/` runs `frontend/build.mjs --hosted` after its own build. The pages stay separate builds, but they have one origin, so one Privy login serves all. The hosted workbench trains in the browser only: it does not look for a Python workspace. The local workbench does not change.
- In development, the dev server of `ladder/` serves the same three paths (`ladder/vite.config.js`), with the proxy of the root `vite.config.ts` to the Python workspace. So the paths of the site are the same in development and in production, and one port serves all pages.
- The three pages share one site navigation, in this order: the wordmark `NEUROM` to `/`, 坦克擂台赛 to `/ladder/`, 工作台 to `/studio/`, GitHub. The home page and the ladder render it with `ladder/src/components/SiteBar.vue`. The workbench renders it in its own header, only when it is served under `/studio/`. The workbench and the ladder share the brand tokens of `frontend/ui/brand.css` and the light look of the ladder.

## Considered Options

- **React for the page (the first version).** The Privy React SDK fit without an adapter. But the repo had two UI frameworks for authored code, two i18n adapters, and a second dev server for the workbench in local development.
- **A second Vue entry in `frontend/`.** It shares the dependencies, but the single-file build and the hosted build would share one Vite configuration. A merged page is not necessary for one login: one origin is enough.
- **Vue with `@privy-io/js-sdk-core`.** The React SDK would leave the repo. But Privy asks for contact before use, and the iframe and message wiring of the embedded wallet becomes our code.
- **A separate repository.** The page would need a copy or a package of the chain bridge and the scenario runtime, and the parity of the replay would depend on a version.

## Consequences

- All authored UI code of the repo is Vue. React is a dependency of `frontend/wallet/privy.js` only.
- The root `package.json` gets `"workspaces": ["ladder"]`. The root `npm test` also runs the tests of `ladder/`. The local workbench build (`npm run build`) does not change.
- The Vercel build reads files outside `ladder/`. The project must allow this.
- A change of the chain bridge or the scenario runtime can break the page. The tests of the ladder client run against the same modules on a local anvil.
- The workbench and the page share one Privy integration (`frontend/wallet/privy.js`), one App ID and the same embedded wallet. Privy keeps the login per origin. On the site, `/ladder/` and `/studio/` share one origin, so a user logs in once. In local development, `ladder/scripts/dev-chain.mjs` serves all pages on one port, so the same is true there. A workbench started with the root `npm run dev` is on another origin and needs its own login.
- The Vercel build takes longer, because it also builds the workbench. The site serves the workbench as one HTML file of about 9 MB.
