// ladder/names.js — the page side of the name service (`/api/names`, see ladder/README.md). The message the owner
// signs comes from `server/names.js`, so the page and the service never disagree about it.
import { BATCH_LIMIT, nameMessage, validateName } from '../../server/names.js';
import banned from '../../data/banned-words.json' with { type: 'json' };
import { addressKey } from './format.js';

export { validateName };
/** The banned words of the data file, for the check before the request. */
export const BANNED_WORDS = banned.words;

const API = '/api/names';

/** An error of the name service: `nameCode` is the code of the response, `details` the other fields. */
class NameServiceError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.nameCode = code;
    this.details = details;
  }
}

async function readJson(response) {
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const { error, ...details } = body ?? {};
    throw new NameServiceError(error ?? `http_${response.status}`, details);
  }
  return body;
}

/** The names of `modules` → `{ [address in lower case]: name }`. Reads in batches of BATCH_LIMIT. */
export async function fetchNames(modules) {
  const keys = [...new Set(modules.map(addressKey).filter(Boolean))];
  const out = {};
  for (let i = 0; i < keys.length; i += BATCH_LIMIT) {
    const batch = keys.slice(i, i + BATCH_LIMIT);
    const body = await readJson(await fetch(`${API}?modules=${batch.join(',')}`));
    Object.assign(out, body.names ?? {});
  }
  return out;
}

/** Set the name of `module`: the owner signs the message with `signer` (EIP-191), then the service verifies.
 *  → `{ module, name, owner }`. */
export async function setName({ signer, chainId, module, name }) {
  const signature = await signer.signMessage(nameMessage({ chainId, module, name }));
  const response = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ module, name, signature }) });
  return readJson(response);
}
