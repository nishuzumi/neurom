// chain-error.js — one readable line for a wallet / RPC / ethers failure.
//
// ethers v6 wraps an RPC failure it does not recognise as `{ code: 'UNKNOWN_ERROR', shortMessage: 'could not coalesce
// error', error: { code: -32000, message: 'nonce too low' }, payload: {…} }`. Its `message` carries the serialised
// request (raw transaction, params), so callers used `shortMessage` and showed the wrapper phrase, never the node's
// reason. Privy and EIP-1193 providers nest the real reason in `cause`, `data.originalError` or `info.error` instead.
// `describeChainError` walks those wrappers, keeps the innermost concrete reason and its code, and never serialises
// payloads or data objects.
import { t } from './i18n.js';

const WRAPPER_FIELDS = ['error', 'cause', 'originalError'];     // where a wrapper keeps the error it wraps
const CONTAINER_FIELDS = ['info', 'data'];                      // plain holders: look at their wrapper fields only
const MAX_DEPTH = 8;
const MAX_DETAIL = 300;

/** Phrases a wrapper uses when it has nothing to say about the cause. */
const GENERIC = [/^could not coalesce error/i, /^internal json-rpc error\.?$/i, /^internal error\.?$/i,
  /^unknown error\.?$/i, /^an unknown error occurred\.?$/i, /^request failed\.?$/i, /^error$/i];

const FUNDS = /insufficient (funds|balance)|exceeds (the )?balance|not enough (funds|balance)/i;
const REJECTED = /user (rejected|denied|cancell?ed)|rejected the request|signature denied/i;

const isObject = v => typeof v === 'object' && v !== null;
const generic = s => GENERIC.some(re => re.test(s.trim()));
const clip = s => s.length > MAX_DETAIL ? s.slice(0, MAX_DETAIL) + '…' : s;

/** The text a node offers for itself, or '' when it is only a wrapper. An ethers node (string `shortMessage`) offers
 *  only that: its `message` embeds the request. Other nodes: `message`, then `reason`. `data` is never text: it may
 *  be revert bytes or a token. */
function ownDetail(node) {
  if (typeof node === 'string') return generic(node) ? '' : clip(node);
  if (!isObject(node)) return '';
  const keys = typeof node.shortMessage === 'string' ? ['shortMessage'] : ['message', 'reason'];
  for (const key of keys) {
    const v = node[key];
    if (typeof v === 'string' && v.trim() && !generic(v)) return clip(v);
  }
  return '';
}

const ownCode = node => isObject(node) && (typeof node.code === 'string' || typeof node.code === 'number') ? node.code : null;

/** Depth-first, wrapper fields only, cycle-safe. Outer node first, deepest last. */
function chain(error) {
  const seen = new Set();
  const out = [];
  const visit = (node, depth) => {
    if (depth > MAX_DEPTH || node == null) return;
    if (typeof node === 'string') { out.push(node); return; }
    if (!isObject(node) || seen.has(node)) return;
    seen.add(node);
    out.push(node);
    for (const key of WRAPPER_FIELDS) visit(node[key], depth + 1);
    for (const holder of CONTAINER_FIELDS) {
      const inner = node[holder];
      if (!isObject(inner) || seen.has(inner)) continue;
      seen.add(inner);
      for (const key of WRAPPER_FIELDS) visit(inner[key], depth + 1);
    }
  };
  visit(error, 0);
  return out;
}

/**
 *   kind    'funds' (INSUFFICIENT_FUNDS or an explicit insufficient-funds diagnostic), 'rejected' (ACTION_REJECTED /
 *           EIP-1193 4001 / explicit user-rejection text), else 'other'. UNKNOWN_ERROR and bare numeric codes are
 *           'other': they are not evidence about balance.
 *   detail  innermost concrete reason, '' when every layer is a generic wrapper
 *   code    code of the node that supplied `detail`, else the innermost code of any kind (UNKNOWN_ERROR last resort)
 */
function classify(error) {
  let kind = 'other';
  let detail = '';
  let detailCode = null;
  let innerCode = null;
  let outerCode = null;
  for (const node of chain(error)) {
    const code = ownCode(node);
    if (code === 'INSUFFICIENT_FUNDS') kind = 'funds';
    else if (code === 'ACTION_REJECTED' || code === 4001) kind = 'rejected';
    if (code !== null) { if (code !== 'UNKNOWN_ERROR') innerCode = code; outerCode ??= code; }
    const text = ownDetail(node);
    if (!text) continue;
    detail = text;
    detailCode = code;
    if (kind === 'other' && FUNDS.test(text)) kind = 'funds';
    else if (kind === 'other' && REJECTED.test(text)) kind = 'rejected';
  }
  return { kind, detail, code: detailCode ?? innerCode ?? outerCode };
}

/** One line for the user. `null`/`undefined` → ''. A plain `Error` keeps its message; a string is returned as is. */
export function describeChainError(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  const { kind, detail, code } = classify(error);
  const codeText = code === null ? '' : String(code);
  if (!detail) {
    if (kind === 'rejected') return t('已在钱包中拒绝签名。');
    if (kind === 'funds') return t('钱包余额不足，付不起这笔交易的费用。');
    if (!isObject(error) && typeof error !== 'string') return String(error);
    return codeText ? t('钱包或节点没有给出失败原因（错误码 {code}）', { code: codeText }) : t('钱包或节点没有给出失败原因。');
  }
  const withCode = codeText && codeText !== 'UNKNOWN_ERROR' && !detail.includes(codeText)
    ? t('{error}（错误码 {code}）', { error: detail, code: codeText }) : detail;
  if (kind === 'rejected') return t('已在钱包中拒绝：{error}', { error: withCode });
  if (kind === 'funds') return t('钱包余额不足：{error}', { error: withCode });
  return withCode;
}
