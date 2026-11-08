// editor/renderers/viem-global.js — the part of viem that the script sandbox gets as the global `viem` (ADR 0028). The
// `viemGlobal` plugin of vite.config.ts bundles this file with esbuild into one classic script at build time, and
// script-frame.js inlines that script before the runtime of a script module, as it inlines Vue. A script module uses
// it through `ctx.chain.<name>` (a client made here) and for ABI work: parseAbi, encodeFunctionData, decodeEventLog…
export {
  createPublicClient, createTestClient, createWalletClient, custom, publicActions, walletActions,
  parseAbi, parseAbiItem, encodeFunctionData, decodeFunctionResult, decodeErrorResult, decodeEventLog, parseEventLogs,
  encodeAbiParameters, decodeAbiParameters, keccak256, pad, toHex, hexToBigInt, hexToNumber, getAddress, zeroAddress,
} from 'viem';
