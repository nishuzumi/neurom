// monad.js — the limits of Monad execution that the workbench, the ladder page, the fixtures and the scripts share.
// Monad charges the gas limit of a transaction, not the gas it uses, so every sender must use this one value.

/** The largest gas limit of one Monad transaction. Module deployments cap at it, ladder plays send exactly it. */
export const TX_GAS_LIMIT = 30_000_000;
