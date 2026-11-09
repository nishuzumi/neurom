import { test } from 'node:test';
import assert from 'node:assert/strict';
import deployments from '../../data/deployments.json' with { type: 'json' };
import { ladderChainId } from './ladder-chain.js';
import { handlerFromEnv } from '../../api/names.js';

test('VITE_LADDER_CHAIN_ID selects the chain; without it the default is a public chain with a ladder', () => {
  assert.equal(ladderChainId({ VITE_LADDER_CHAIN_ID: '31337' }), 31337);
  const chain = ladderChainId({});
  const entry = deployments[chain];
  assert.ok(entry && entry.ladder && !entry.local, `default chain ${chain} has a ladder and is not local`);
});

test('the name service takes its chain from VITE_LADDER_CHAIN_ID, the variable of the page', async () => {
  await assert.rejects(handlerFromEnv({ VITE_LADDER_CHAIN_ID: '424242' }), /chain 424242 .*not in data\/deployments\.json/);
  // a known chain passes the chain checks and stops at the database
  await assert.rejects(handlerFromEnv({ VITE_LADDER_CHAIN_ID: '10143' }), /DATABASE_URL is not set/);
});
