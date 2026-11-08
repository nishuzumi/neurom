import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeError } from 'ethers';
import { describeChainError } from './chain-error.js';

const RAW_TX = '0x02f8ab0180843b9aca00deadbeefsecretsignedtransactionbytes';
const payload = { method: 'eth_sendRawTransaction', params: [RAW_TX], id: 7, jsonrpc: '2.0' };
const FUNDS_CLAIM = /insufficient|余额|balance|funds/i;
const leaks = text => text.includes(RAW_TX) || text.includes('eth_sendRawTransaction') || /tok-secret|cookie|\[object Object\]/.test(text);

test('nothing and plain application errors pass through', () => {
  assert.equal(describeChainError(null), '');
  assert.equal(describeChainError(undefined), '');
  assert.equal(describeChainError(new Error('链上结果与本地整数模型不一致。')), '链上结果与本地整数模型不一致。');
  assert.equal(describeChainError('节点超时'), '节点超时');
  const formatted = 'Wallet balance is insufficient: insufficient funds (code -32000)';
  assert.equal(describeChainError(formatted), formatted, 'a stored diagnostic is not formatted again');
});

test('an ethers UNKNOWN_ERROR wrapper shows the node reason and code, not the wrapper phrase, and does not claim funds', () => {
  const error = makeError('could not coalesce error', 'UNKNOWN_ERROR', { error: { code: -32000, message: 'nonce too low' }, payload });
  const text = describeChainError(error);
  assert.ok(text.includes('nonce too low'), text);
  assert.ok(text.includes('-32000'), text);
  assert.ok(!/coalesce/i.test(text), text);
  assert.ok(!FUNDS_CLAIM.test(text), text);
  assert.ok(!leaks(text), text);
});

test('an ethers node never leaks its full message, even when its shortMessage is a generic phrase', () => {
  for (const short of ['unknown error', 'could not coalesce error', 'internal error']) {
    const text = describeChainError(makeError(short, 'UNKNOWN_ERROR', { payload }));
    assert.ok(!leaks(text), text);
    assert.ok(!text.includes(short), text);
    assert.ok(text.includes('UNKNOWN_ERROR'), text);
  }
});

test('nonce, gas-price, rate-limit, network and revert diagnostics are preserved and never read as insufficient funds', () => {
  for (const message of ['nonce too low', 'replacement transaction underpriced', 'gas price below minimum',
    'intrinsic gas too low', 'request limit reached', 'too many requests', 'network error: ECONNRESET', 'execution reverted: not owner']) {
    const inner = { code: -32000, message };
    for (const error of [
      makeError('could not coalesce error', 'UNKNOWN_ERROR', { error: inner, payload }),
      { code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: inner } },
      new Error('request failed', { cause: inner }),
    ]) {
      const text = describeChainError(error);
      assert.ok(text.includes(message), text);
      assert.ok(text.includes('-32000'), text);
      assert.ok(!FUNDS_CLAIM.test(text), text);
      assert.ok(!leaks(text), text);
    }
  }
});

test('insufficient funds stays recognisable, with the node diagnostic and code, through every wrapper shape', () => {
  const inner = { code: -32000, message: 'insufficient funds for gas * price + value: have 0 want 21000000000000' };
  for (const error of [
    makeError('insufficient funds for intrinsic transaction cost', 'INSUFFICIENT_FUNDS', { transaction: { to: '0x1' }, info: { error: inner, payload } }),
    makeError('could not coalesce error', 'UNKNOWN_ERROR', { error: inner, payload }),
    { code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: inner } },
    new Error('Privy request failed', { cause: inner }),
  ]) {
    const text = describeChainError(error);
    assert.ok(text.includes(inner.message), text);
    assert.ok(text.includes('-32000'), text);
    assert.ok(!leaks(text), text);
  }
  const bare = describeChainError(makeError('insufficient funds for intrinsic transaction cost', 'INSUFFICIENT_FUNDS', { transaction: { to: '0x1' } }));
  assert.ok(bare.includes('insufficient funds for intrinsic transaction cost') && bare.includes('INSUFFICIENT_FUNDS'), bare);
});

test('user rejection keeps the provider text and code; a bare numeric RPC code is not a rejection or a funds claim', () => {
  const rejected = makeError('user rejected action', 'ACTION_REJECTED', { action: 'sendTransaction', reason: 'rejected', info: { payload, error: { code: 4001, message: 'User rejected the request.' } } });
  for (const error of [rejected, { code: 4001, message: 'User rejected the request.' }]) {
    const text = describeChainError(error);
    assert.ok(text.includes('User rejected the request.') && text.includes('4001'), text);
    assert.ok(!leaks(text), text);
  }
  const text = describeChainError({ code: -32000, message: 'already known' });
  assert.ok(text.includes('already known') && text.includes('-32000'), text);
  assert.ok(!FUNDS_CLAIM.test(text), text);
});

test('a wrapper without any underlying reason does not repeat the wrapper phrase, does not claim funds, and carries the best code', () => {
  const text = describeChainError(makeError('could not coalesce error', 'UNKNOWN_ERROR', { error: { code: -32603 }, payload }));
  assert.ok(text.includes('-32603'), text);
  assert.ok(!/coalesce/i.test(text) && !FUNDS_CLAIM.test(text), text);
  assert.ok(!leaks(text), text);
  assert.notEqual(describeChainError(makeError('could not coalesce error', 'UNKNOWN_ERROR', { payload })),
    describeChainError(makeError('could not coalesce error', 'UNKNOWN_ERROR', { error: { code: -32603 }, payload })), 'the inner code is surfaced');
});

test('wrapper traversal is cycle-safe and bounded, and data fields are never used as text', () => {
  const loop = { code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: null } };
  loop.data.originalError = loop;
  loop.error = loop;
  loop.cause = loop;
  const looped = describeChainError(loop);
  assert.ok(looped.includes('-32603') && !leaks(looped), looped);

  let deep = { code: -32000, message: 'nonce too low' };
  for (let i = 0; i < 40; i++) deep = { message: 'could not coalesce error', error: deep };
  assert.ok(!describeChainError(deep).includes('nonce too low'), 'beyond the depth bound: no reason, no crash');

  const secret = { message: 'Internal JSON-RPC error.', data: { originalError: { message: 'nonce too low', data: { authToken: 'tok-secret', headers: { cookie: 'c' } } } } };
  const text = describeChainError(secret);
  assert.ok(text.includes('nonce too low') && !leaks(text), text);
  const bytes = describeChainError({ code: -32603, message: 'Internal JSON-RPC error.', data: 'tok-secret-or-revert-bytes' });
  assert.ok(!bytes.includes('tok-secret') && bytes.includes('-32603'), bytes);
});
