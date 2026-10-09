// anvil.fixture.js — test fixture for the tests that drive the production ethers bridge (module-chain.js) and the
// deployment session over real contracts. It builds the contracts (forge build) and starts a fresh
// anvil --network monad. The network option gives Monad's code-size limit, because weight chunks reach 112 KiB.
// From account 0, it deploys what contracts/script/Deploy.s.sol deploys, in the same order:
//   - Roles.
//   - The ModuleFactory implementation behind its FactoryProxy. This is the official factory for 31337. That order
//     fixes its address (see frontend/chain.js).
//   - One version of each engine id, added and set as latest.
// Tests skip with NO_FOUNDRY.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { ethers } from 'ethers';
import { foundryBinary, startAnvil } from '../contracts/scripts/foundry.mjs';

const CONTRACTS = new URL('../contracts/', import.meta.url);
/** The forge binary (null when missing). */
export const FORGE = foundryBinary('forge');
/** `skip` reason for node:test when Foundry is missing, else false. */
export const NO_FOUNDRY = FORGE && foundryBinary('anvil') ? false : 'needs Foundry (forge, anvil)';

/** The contract `id` from contracts/out — `Name` (in `Name.sol`) or `File.sol:Name` — deployed by `signer` with
 *  `args` → the deployed contract. */
export async function deployOut(signer, id, ...args) {
  const [file, name] = id.includes(':') ? id.split(':') : [`${id}.sol`, id];
  const out = JSON.parse(fs.readFileSync(new URL(`out/${file}/${name}.json`, CONTRACTS), 'utf8'));
  const c = await new ethers.ContractFactory(out.abi, out.bytecode.object, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

/** A fresh anvil with the protocol on it → `{ url, provider, signer, factory, roles, engines, otherFactory, stop }`.
 *  `factory` is the proxy. `engines` maps an engine id name → its version 1. `otherFactory()` deploys a second,
 *  unofficial factory the same way, with the same engine versions, and returns its proxy address. `network` is the
 *  anvil network family (monad by default; the benchmarks also use ethereum). */
export async function localChain({ network = 'monad' } = {}) {
  execFileSync(FORGE, ['build', '--skip', 'test'], { cwd: CONTRACTS, stdio: 'ignore' });
  const { url, provider, stop } = await startAnvil([], { network });
  try {
    const signer = await provider.getSigner(0);
    const deploy = (name, ...args) => deployOut(signer, name, ...args);
    /** Roles, the implementation and its proxy (initialised in the same transaction) → the factory at the proxy. */
    const factoryWithRoles = async () => {
      const roles = await deploy('Roles');
      const implementation = await deploy('ModuleFactory', await roles.getAddress());
      const proxy = await deploy('FactoryProxy', await implementation.getAddress(), implementation.interface.encodeFunctionData('initialize', []));
      return { roles, factory: implementation.attach(await proxy.getAddress()) };
    };
    const register = async (factory, engines) => {
      for (const [name, version] of Object.entries(engines)) {
        await (await factory.addVersion(ethers.id(name), version)).wait();
        await (await factory.setLatest(ethers.id(name), version)).wait();
      }
    };
    const { roles, factory } = await factoryWithRoles(), engines = {};
    for (const [name, contract] of [['dense-policy', 'DensePolicyEngine'], ['threshold-layers', 'ThresholdLayersEngine']]) engines[name] = await (await deploy(contract)).getAddress();
    await register(factory, engines);
    const otherFactory = async () => { const other = (await factoryWithRoles()).factory; await register(other, engines); return other.getAddress(); };
    return { url, provider, signer, factory: await factory.getAddress(), roles: await roles.getAddress(), engines, otherFactory, stop };
  } catch (e) { stop(); throw e; }
}
