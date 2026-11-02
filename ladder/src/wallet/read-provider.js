// wallet/read-provider.js — the read provider of the page. The dev signer signs with it too, so it also gives the nonces.
import { JsonRpcProvider } from 'ethers';

/** A JsonRpcProvider of `rpc`. `cacheTimeout: -1` turns off the request cache of ethers (250 ms by default). With the
 *  cache, a transaction sent right after the receipt of the one before it can get the old pending nonce, and the node
 *  refuses it ("nonce has already been used"). */
export function readProvider(rpc, chainId) {
  return new JsonRpcProvider(rpc, chainId, { staticNetwork: true, pollingInterval: 1500, cacheTimeout: -1 });
}
