// api/names.js — the Vercel function of the name service. It only wires the environment to server/names.js and
// server/names-http.js. Environment: DATABASE_URL (Neon), ADMIN_TOKEN (bearer token of DELETE), LADDER_CHAIN_ID
// (the entry of data/deployments.json), LADDER_RPC_URL and LADDER_ADDRESS (optional overrides of that entry).
import { readFileSync } from 'node:fs';
import { ensureSchema, openDatabase } from '../server/db.js';
import { createNameHandler } from '../server/names-http.js';
import { createNameService, ladderOwnerOf } from '../server/names.js';

const json = name => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));

/** The handler from `env`. Thrown errors name the missing variable. */
export async function handlerFromEnv(env) {
  const chainId = Number(env.LADDER_CHAIN_ID);
  const deployment = json('deployments.json')[chainId];
  if (!deployment) throw new Error(`LADDER_CHAIN_ID ${env.LADDER_CHAIN_ID} is not in data/deployments.json`);
  const rpc = env.LADDER_RPC_URL || deployment.rpc, ladder = env.LADDER_ADDRESS || deployment.ladder;
  if (!ladder) throw new Error(`no ladder address for chain ${chainId}: set LADDER_ADDRESS or data/deployments.json`);
  const db = await openDatabase(env.DATABASE_URL);
  await ensureSchema(db);
  const service = createNameService({ db, chainId, ownerOf: ladderOwnerOf({ rpc, ladder }), banned: json('banned-words.json').words });
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
