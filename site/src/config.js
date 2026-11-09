// config.js — the network of the page. The chain comes from the registry of frontend/chain.js (`data/deployments.json`),
// selected by the rule of chain/ladder-chain.js (`VITE_LADDER_CHAIN_ID`, else the first public chain with a ladder).
// The dev script (scripts/dev-chain.mjs) overrides the RPC and the addresses through `VITE_LADDER_RPC`,
// `VITE_LADDER_FACTORY` (both applied by frontend/chain.js) and `VITE_LADDER_ADDRESS`, because its anvil runs on a free
// port. Everything else about the contest (δ, range, cooldown…) is read from the contract through the client, never
// from here.
import { CHAINS } from '../../frontend/chain.js';
import { ladderChainId } from './chain/ladder-chain.js';

const env = import.meta.env ?? {};

/** `{ chainId, name, rpc, explorer, local, factory, ladder, privyAppId, devAccount }` of the page. `ladder` or
 *  `factory` is null when the season is not deployed on the chain. The 工作台 link of the page is `/studio/` on the
 *  same origin (ADR 0027), in development and in production. */
export function pageConfig() {
  const chainId = ladderChainId(env);
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
