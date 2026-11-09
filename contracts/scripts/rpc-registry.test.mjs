// The RPC aliases of foundry.toml ([rpc_endpoints], the --rpc-url names of the forge scripts) against the registry of
// the site (site/data/deployments.json). The registry is the one source of the RPC of a chain. forge needs its own
// aliases, so this test fails when the two files disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FOUNDRY_TOML = new URL('../foundry.toml', import.meta.url);
const DEPLOYMENTS = new URL('../../site/data/deployments.json', import.meta.url);

/** The forge alias of each chain id of the registry that forge deploys to. */
const ALIASES = { 10143: 'monad_testnet', 143: 'monad_mainnet' };

/** The `name = "url"` pairs of the [rpc_endpoints] table of `toml`. */
function rpcEndpoints(toml) {
  const table = toml.split(/^\[rpc_endpoints\]\s*$/m)[1]?.split(/^\[/m)[0];
  assert.ok(table, 'foundry.toml has an [rpc_endpoints] table');
  return Object.fromEntries([...table.matchAll(/^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/gm)].map(m => [m[1], m[2]]));
}

test('the forge RPC aliases of foundry.toml are the RPCs of deployments.json', () => {
  const endpoints = rpcEndpoints(readFileSync(FOUNDRY_TOML, 'utf8'));
  const registry = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'));
  for (const [chainId, alias] of Object.entries(ALIASES)) {
    assert.equal(endpoints[alias], registry[chainId]?.rpc, `${alias} (chain ${chainId})`);
  }
});
