// The role listing and the scripted handover on a local Anvil (frontend/anvil.fixture.js): the command against the
// network, the HandOverRoles script broadcast to it. Skipped without Foundry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { FORGE, NO_FOUNDRY, localChain } from '../../frontend/anvil.fixture.js';
import RolesABI from '../../frontend/abi/Roles.json' with { type: 'json' };
import { listRoles } from './list-roles.mjs';
import { run } from './foundry.mjs';

const CONTRACTS = new URL('../', import.meta.url);
const COMMAND = new URL('./list-roles.mjs', import.meta.url);

test('the deployer holds ADMIN and UPGRADER on a fresh Anvil, and after the scripted handover only the multisig does', { skip: NO_FOUNDRY, timeout: 120_000 }, async () => {
  const chain = await localChain();
  try {
    const deployer = chain.signer.address, multisig = (await chain.provider.getSigner(1)).address;
    const holders = async () => { const r = await listRoles({ rpcUrl: chain.url, factory: chain.factory }); return [r.roles, r.holders.ADMIN, r.holders.UPGRADER]; };
    assert.deepEqual(await holders(), [chain.roles, [deployer], [deployer]]);

    const listed = await run(process.execPath, [COMMAND.pathname, '--rpc-url', chain.url, '--factory', chain.factory]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`^ADMIN +${deployer}$`, 'm'));
    assert.match(listed.stdout, new RegExp(`^UPGRADER +${deployer}$`, 'm'));

    const handover = (sig, to = multisig) => run(FORGE, ['script', 'script/HandOverRoles.s.sol', '--sig', sig, '--rpc-url', chain.url, '--unlocked', '--sender', deployer, '--broadcast'],
      { cwd: CONTRACTS.pathname, env: { FACTORY: chain.factory, MULTISIG: to } });
    const nonce = await chain.provider.getTransactionCount(deployer);
    for (const [to, reason] of [[multisig, /does not hold both roles/], [deployer, /is the broadcasting account/]]) {
      const early = await handover('revoke()', to);
      assert.notEqual(early.code, 0, `revoke refused for ${to}`);
      assert.match(early.stdout + early.stderr, reason);
    }
    assert.equal(await chain.provider.getTransactionCount(deployer), nonce, 'nothing was sent');

    const granted = await handover('grant()');
    assert.equal(granted.code, 0, granted.stdout + granted.stderr);
    assert.deepEqual(await holders(), [chain.roles, [deployer, multisig], [deployer, multisig]], 'the check between the two runs');
    const revoked = await handover('revoke()');
    assert.equal(revoked.code, 0, revoked.stdout + revoked.stderr);
    assert.deepEqual(await holders(), [chain.roles, [multisig], [multisig]]);
  } finally { chain.stop(); }
});

test('the listing reads the logs in windows of blockRange blocks, from the block Roles was deployed in', { skip: NO_FOUNDRY, timeout: 60_000 }, async () => {
  const chain = await localChain();
  try {
    const deployer = chain.signer.address, multisig = (await chain.provider.getSigner(1)).address;
    const roles = new ethers.Contract(chain.roles, RolesABI, chain.signer);
    await (await roles.grantRole(await roles.UPGRADER(), multisig)).wait();
    const deployed = 1;                                                     // Roles: the fixture's first transaction
    assert.equal((await chain.provider.getTransactionReceipt((await chain.provider.getBlock(deployed)).transactions[0])).contractAddress, chain.roles);
    const r = await listRoles({ rpcUrl: chain.url, factory: chain.factory, fromBlock: deployed, blockRange: 1 });
    assert.deepEqual([r.holders.ADMIN, r.holders.UPGRADER], [[deployer], [deployer, multisig]]);
  } finally { chain.stop(); }
});
