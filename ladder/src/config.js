// config.js — the network of the page. The chain comes from `data/deployments.json`, selected by `VITE_LADDER_CHAIN_ID`
// (default: the first chain of the file with a ladder address, else 31337). The dev script (scripts/dev-chain.mjs)
// overrides the RPC and the addresses through `VITE_LADDER_RPC`, `VITE_LADDER_FACTORY` and `VITE_LADDER_ADDRESS`,
// because its anvil runs on a free port. Everything else about the contest (δ, range, cooldown…) is read from the
// contract through the client, never from here.
import deployments from '../data/deployments.json' with { type: 'json' };

const env = import.meta.env ?? {};

/** The chains of deployments.json by id (number). */
export const DEPLOYMENTS = Object.fromEntries(Object.entries(deployments).filter(([k]) => /^\d+$/.test(k)).map(([k, v]) => [Number(k), v]));

/** The chain id the page runs on. */
export function chainIdOf() {
  if (env.VITE_LADDER_CHAIN_ID) return Number(env.VITE_LADDER_CHAIN_ID);
  const deployed = Object.entries(DEPLOYMENTS).find(([, v]) => v.ladder && !v.local);
  return deployed ? Number(deployed[0]) : 31337;
}

/** `{ chainId, name, rpc, explorer, local, factory, ladder, privyAppId }` of the page. `ladder` or `factory` is
 *  null when the season is not deployed on the chain. */
export function pageConfig() {
  const chainId = chainIdOf();
  const d = DEPLOYMENTS[chainId];
  if (!d) throw new Error(`chain ${chainId} is not in data/deployments.json`);
  return {
    chainId,
    name: d.name,
    rpc: env.VITE_LADDER_RPC || d.rpc,
    explorer: d.explorer ?? null,
    local: !!d.local,
    factory: env.VITE_LADDER_FACTORY || d.factory,
    ladder: env.VITE_LADDER_ADDRESS || d.ladder,
    privyAppId: env.VITE_PRIVY_APP_ID || null,
    /** The index of the anvil account the page uses as the local dev signer. */
    devAccount: Number(env.VITE_DEV_ACCOUNT ?? 1),
  };
}

/** The explorer link of a transaction or an address, or null on a chain without explorer. */
export const explorerLink = (config, kind, value) => (config.explorer ? `${config.explorer}/${kind}/${value}` : null);
