// api/names.js — the Vercel function of the name service. It only wires the environment to server/names.js and
// server/names-http.js. Environment: DATABASE_URL (Neon), ADMIN_TOKEN (bearer token of DELETE),
// VITE_LADDER_CHAIN_ID and VITE_LADDER_ADDRESS (the same variables as the page: the chain by the rule of
// src/chain/ladder-chain.js, and an optional override of its ladder), LADDER_RPC_URL (optional, server only, so a
// private RPC with a key stays out of the page).
import deployments from '../data/deployments.json' with { type: 'json' };
import bannedWords from '../data/banned-words.json' with { type: 'json' };
import { ladderChainId } from '../src/chain/ladder-chain.js';
import { ensureSchema, openDatabase } from '../server/db.js';
import { createNameHandler } from '../server/names-http.js';
import { createNameService, ladderOwnerOf } from '../server/names.js';

/** The handler from `env`. Thrown errors name the missing variable. */
export async function handlerFromEnv(env) {
  const chainId = ladderChainId(env);
  const deployment = deployments[chainId];
  if (!deployment) throw new Error(`chain ${chainId} (VITE_LADDER_CHAIN_ID) is not in data/deployments.json`);
  const rpc = env.LADDER_RPC_URL || deployment.rpc, ladder = env.VITE_LADDER_ADDRESS || deployment.ladder;
  if (!ladder) throw new Error(`no ladder address for chain ${chainId}: set VITE_LADDER_ADDRESS or data/deployments.json`);
  const db = await openDatabase(env.DATABASE_URL);
  await ensureSchema(db);
  const service = createNameService({ db, chainId, ownerOf: ladderOwnerOf({ rpc, ladder }), banned: bannedWords.words });
  return createNameHandler({ service, adminToken: env.ADMIN_TOKEN ?? '' });
}

let ready = null;
export default async function handler(req, res) {
  ready ??= handlerFromEnv(process.env).catch(e => { ready = null; throw e; });
  let run;
  try { run = await ready; } catch (e) {
    console.error(e);
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'misconfigured' }));
  }
  return run(req, res);
}
