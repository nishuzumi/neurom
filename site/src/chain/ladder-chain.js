// ladder-chain.js — the chain of the ladder: one rule for the ladder page (src/config.js), the workbench
// (frontend/chain.js) and the name service (api/names.js), so the three cannot disagree. A disagreement breaks the
// name service: the page signs a name message with its chain id, and the service checks the signature with its own.
// The pages pass `import.meta.env` (read when Vite builds them). The name service passes `process.env` (read when
// the Vercel function runs, which sees the same `VITE_` variables).
import deployments from '../../data/deployments.json' with { type: 'json' };

/** The chain id of the ladder: `VITE_LADDER_CHAIN_ID`, else the first public chain of `data/deployments.json` with
 *  a ladder address, else the local dev node (31337). */
export function ladderChainId(env) {
  if (env.VITE_LADDER_CHAIN_ID) return Number(env.VITE_LADDER_CHAIN_ID);
  const deployed = Object.entries(deployments).find(([id, d]) => /^\d+$/.test(id) && d.ladder && !d.local);
  return deployed ? Number(deployed[0]) : 31337;
}
