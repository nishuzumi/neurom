// config.js — the network of the page. The chain comes from the registry of frontend/chain.js (`data/deployments.json`),
// selected by `VITE_LADDER_CHAIN_ID` (default: the first public chain of the file with a ladder address, else 31337).
// The dev script (scripts/dev-chain.mjs) overrides the RPC and the addresses through `VITE_LADDER_RPC`,
// `VITE_LADDER_FACTORY` (both applied by frontend/chain.js) and `VITE_LADDER_ADDRESS`, because its anvil runs on a free
// port. Everything else about the contest (δ, range, cooldown…) is read from the contract through the client, never
// from here.
import { CHAINS } from '../../frontend/chain.js';

const env = import.meta.env ?? {};

/** The chain id the page runs on. */
function chainIdOf() {
  if (env.VITE_LADDER_CHAIN_ID) return Number(env.VITE_LADDER_CHAIN_ID);
  const deployed = Object.entries(CHAINS).find(([, v]) => v.ladder && !v.local);
  return deployed ? Number(deployed[0]) : 31337;
}

/** `{ chainId, name, rpc, explorer, local, factory, ladder, privyAppId, devAccount }` of the page. `ladder` or
 *  `factory` is null when the season is not deployed on the chain. The 工作台 link of the page is `/studio/` on the
 *  same origin (ADR 0027), in development and in production. */
export function pageConfig() {
  const chainId = chainIdOf();
  const d = CHAINS[chainId];
  if (!d) throw new Error(`chain ${chainId} is not in data/deployments.json`);
  return {
    chainId,
    name: d.name,
    rpc: d.rpc,
    explorer: d.explorer ?? null,
    local: !!d.local,
    factory: d.factory,
    ladder: env.VITE_LADDER_ADDRESS || d.ladder,
    privyAppId: env.VITE_PRIVY_APP_ID || null,
    /** The index of the anvil account the page uses as the local dev signer. */
    devAccount: Number(env.VITE_DEV_ACCOUNT ?? 1),
  };
}
