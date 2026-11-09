// names.test.js — the name service through its HTTP interface (ticket 07). The database is PGlite in the process.
// The owner check is an injected map in the format tests and the real ladder contract on a local anvil in the last test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { ethers } from 'ethers';
import { ensureSchema, openTestDatabase } from './db.js';
import { createNameHandler } from './names-http.js';
import { NAME_RULE, createNameService, isBanned, ladderOwnerOf, nameMessage, validateName } from './names.js';
import banned from '../data/banned-words.json' with { type: 'json' };
import { NO_FOUNDRY } from '../../frontend/anvil.fixture.js';
import { localLadder } from '../../frontend/ladder.fixture.js';

const CHAIN = 31337;
const wallets = [0, 1, 2].map(i => ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, `m/44'/60'/0'/0/${i}`));
const modules = ['0x' + '11'.repeat(20), '0x' + '22'.repeat(20), '0x' + '33'.repeat(20), '0xAbCd' + '00'.repeat(18)];

/** A service over a fresh PGlite with `owners` (module → wallet index) as the ladder, mounted on an HTTP server. */
async function serve(t, { owners = {}, adminToken = 'secret' } = {}) {
  const db = await openTestDatabase();
  await ensureSchema(db);
  const ownerOf = async module => (module in owners ? wallets[owners[module]].address.toLowerCase() : null);
  const service = createNameService({ db, chainId: CHAIN, ownerOf, banned: banned.words });
  const server = http.createServer(createNameHandler({ service, adminToken }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await db.close(); });
  const api = async (method, query = '', { body, token } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(`${base}/api/names${query}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const signed = async (wallet, module, name) => ({ module, name, signature: await wallet.signMessage(nameMessage({ chainId: CHAIN, module, name })) });
  return { api, signed, service, db };
}

test('the message has a fixed format: four lines with the chain id, the module in lower case and the name verbatim', () => {
  assert.equal(nameMessage({ chainId: 31337, module: modules[3], name: 'My Tank' }), `NEUROM ladder name\nchain: 31337\nmodule: ${modules[3].toLowerCase()}\nname: My Tank`);
});

test('format: 3 to 24 characters of letters, digits, space, _ and -; banned words are case-insensitive and ignore separators', () => {
  assert.equal(validateName('ab'), 'name_length');
  assert.equal(validateName('a'.repeat(25)), 'name_length');
  assert.equal(validateName(42), 'name_length');
  assert.equal(validateName('坦克'), 'name_length');
  assert.equal(validateName('tank 坦克'), 'name_chars');
  assert.equal(validateName('a.b.c'), 'name_chars');
  assert.equal(validateName('tank\n123'), 'name_chars');
  assert.equal(validateName('Tank_1-A b'), null);
  assert.equal(validateName('a'.repeat(24)), null);
  assert.ok(NAME_RULE.test('abc') && !NAME_RULE.test('ab'));
  assert.equal(isBanned('F_u-c K tank', ['fuck']), true);
  assert.equal(isBanned('classic', ['ass']), true, 'the check is a substring check, so the data file carries only long words');
  assert.equal(isBanned('classic', banned.words), false);
  assert.equal(validateName('ShitHappens', banned.words), 'name_banned');
  assert.equal(validateName('Clean Name', banned.words), null);
});

test('GET reads a batch: no names, then the set names under lower-case keys; a bad address and an oversized batch are 400', async t => {
  const { api, signed } = await serve(t, { owners: { [modules[0]]: 0, [modules[1]]: 1 } });
  assert.deepEqual(await api('GET', `?modules=${modules[0]},${modules[1]}`), { status: 200, body: { names: {} } });
  assert.deepEqual(await api('GET'), { status: 200, body: { names: {} } });
  assert.equal((await api('POST', '', { body: await signed(wallets[0], modules[0], 'Alpha Tank') })).status, 200);
  assert.equal((await api('POST', '', { body: await signed(wallets[1], modules[1], 'beta') })).status, 200);
  const r = await api('GET', `?modules=${modules[0].toUpperCase().replace('0X', '0x')},${modules[1]},${modules[2]}`);
  assert.deepEqual(r, { status: 200, body: { names: { [modules[0]]: 'Alpha Tank', [modules[1]]: 'beta' } } });
  assert.equal((await api('GET', '?modules=0x12')).body.error, 'invalid_module');
  assert.equal((await api('GET', `?modules=${Array(201).fill(modules[0]).join(',')}`)).body.error, 'bad_request');
});

test('POST refuses a bad format, a banned word, a bad signature, a module that is not entered and a signer that is not the owner', async t => {
  const { api, signed } = await serve(t, { owners: { [modules[0]]: 0 } });
  const expect = async (body, status, error) => { const r = await api('POST', '', { body }); assert.equal(r.status, status, JSON.stringify(r.body)); assert.equal(r.body.error, error); };
  await expect(await signed(wallets[0], modules[0], 'ab'), 400, 'name_length');
  await expect(await signed(wallets[0], modules[0], 'a*b*c'), 400, 'name_chars');
  await expect(await signed(wallets[0], modules[0], 'bull shit'), 400, 'name_banned');
  await expect({ module: modules[0], name: 'Fine Name', signature: 'nope' }, 400, 'bad_signature');
  await expect({ module: modules[0], name: 'Fine Name' }, 400, 'bad_signature');
  await expect({ module: '0x1234', name: 'Fine Name', signature: '0x' }, 400, 'invalid_module');
  await expect({ ...await signed(wallets[0], modules[0], 'Fine Name'), name: 'Other Name' }, 403, 'not_owner');
  await expect(await signed(wallets[1], modules[0], 'Fine Name'), 403, 'not_owner');
  await expect(await signed(wallets[0], modules[1], 'Fine Name'), 403, 'not_entered');
  const wrongChain = { module: modules[0], name: 'Fine Name', signature: await wallets[0].signMessage(nameMessage({ chainId: 1, module: modules[0], name: 'Fine Name' })) };
  await expect(wrongChain, 403, 'not_owner');
  assert.equal((await api('POST', '', { body: '{not json' })).body.error, 'bad_json');
  assert.equal((await api('PUT')).status, 405);
  assert.deepEqual((await api('GET', `?modules=${modules[0]}`)).body.names, {}, 'nothing was stored');
  const ok = await api('POST', '', { body: await signed(wallets[0], modules[0], 'Fine Name') });
  assert.deepEqual(ok, { status: 200, body: { module: modules[0], name: 'Fine Name', owner: wallets[0].address.toLowerCase() } });
});

test('names are unique without regard to case, a set name does not change, an admin clear allows one more set, and the cleared name is free', async t => {
  const { api, signed } = await serve(t, { owners: { [modules[0]]: 0, [modules[1]]: 1, [modules[2]]: 2 } });
  assert.equal((await api('POST', '', { body: await signed(wallets[0], modules[0], 'Red Baron') })).status, 200);
  let r = await api('POST', '', { body: await signed(wallets[1], modules[1], 'red BARON') });
  assert.deepEqual([r.status, r.body.error], [409, 'name_taken']);
  r = await api('POST', '', { body: await signed(wallets[0], modules[0], 'Second Name') });
  assert.deepEqual([r.status, r.body.error, r.body.name], [409, 'name_set', 'Red Baron']);
  r = await api('POST', '', { body: await signed(wallets[0], modules[0], 'Red Baron') });
  assert.equal(r.body.error, 'name_set', 'the same name again is also a change request');

  assert.equal((await api('DELETE', `?module=${modules[0]}`)).status, 401, 'no token');
  assert.equal((await api('DELETE', `?module=${modules[0]}`, { token: 'wrong' })).status, 401);
  assert.deepEqual((await api('GET', `?modules=${modules[0]}`)).body.names, { [modules[0]]: 'Red Baron' });
  assert.deepEqual(await api('DELETE', `?module=${modules[0]}`, { token: 'secret' }), { status: 200, body: { module: modules[0], cleared: true } });
  assert.deepEqual((await api('GET', `?modules=${modules[0]}`)).body.names, {});
  assert.deepEqual((await api('DELETE', `?module=${modules[0]}`, { token: 'secret' })).body, { module: modules[0], cleared: false });
  assert.equal((await api('DELETE', '?module=0x12', { token: 'secret' })).body.error, 'invalid_module');

  assert.equal((await api('POST', '', { body: await signed(wallets[1], modules[1], 'red BARON') })).status, 200, 'the cleared name is free');
  assert.equal((await api('POST', '', { body: await signed(wallets[0], modules[0], 'Red Baron') })).body.error, 'name_taken');
  assert.equal((await api('POST', '', { body: await signed(wallets[0], modules[0], 'Comeback') })).status, 200, 'one more set after the clear');
  assert.equal((await api('POST', '', { body: await signed(wallets[0], modules[0], 'Third') })).body.error, 'name_set');
  assert.deepEqual((await api('GET', `?modules=${modules.slice(0, 3).join(',')}`)).body.names, { [modules[0]]: 'Comeback', [modules[1]]: 'red BARON' });
});

test('a service without an admin token refuses every DELETE', async t => {
  const { api } = await serve(t, { adminToken: '' });
  assert.equal((await api('DELETE', `?module=${modules[0]}`, { token: '' })).status, 401);
});

test('the owner check reads entryOwner from the ladder contract on anvil: the registering account sets the name, another account and a module that is not entered are refused', { skip: NO_FOUNDRY, timeout: 300_000 }, async t => {
  const chain = await localLadder();
  t.after(() => chain.stop());
  const artifact = JSON.parse(fs.readFileSync(new URL('../data/artifacts/mid.json', import.meta.url), 'utf8'));
  const { module } = await chain.enter(artifact);
  const other = { address: modules[2] };
  const ownerOf = ladderOwnerOf({ rpc: chain.url, ladder: chain.ladder });
  assert.equal(await ownerOf(module), chain.signer.address.toLowerCase());
  assert.equal(await ownerOf(other.address), null);

  const db = await openTestDatabase();
  await ensureSchema(db);
  const service = createNameService({ db, chainId: CHAIN, ownerOf, banned: banned.words });
  const server = http.createServer(createNameHandler({ service, adminToken: 'secret' }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.close(); await db.close(); });
  const post = async body => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/names`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const sign = (signer, m, name) => signer.signMessage(nameMessage({ chainId: CHAIN, module: m, name }));

  const stranger = await chain.provider.getSigner(1);
  let r = await post({ module, name: 'Mid Tank', signature: await sign(stranger, module, 'Mid Tank') });
  assert.deepEqual([r.status, r.body.error, r.body.owner], [403, 'not_owner', chain.signer.address.toLowerCase()]);
  r = await post({ module: other.address, name: 'Mid Tank', signature: await sign(chain.signer, other.address, 'Mid Tank') });
  assert.deepEqual([r.status, r.body.error], [403, 'not_entered']);
  r = await post({ module, name: 'Mid Tank', signature: await sign(chain.signer, module, 'Mid Tank') });
  assert.deepEqual(r, { status: 200, body: { module: module.toLowerCase(), name: 'Mid Tank', owner: chain.signer.address.toLowerCase() } });
});
