// names.js — the name service of the ladder (ticket 07), without HTTP. A name belongs to one entry (a module address).
// The owner of the entry sets the name once with an EIP-191 signature of `nameMessage(...)`. The service checks the
// signer against the owner on the ladder contract through the injected `ownerOf`. An admin clear removes the name,
// then the owner can set a name again, once. The page imports `nameMessage` and `validateName` from here, so the page
// and the service always agree on the message and the format.
import { Contract, JsonRpcProvider, ZeroAddress, isAddress, verifyMessage } from 'ethers';

/** A name: 3 to 24 characters, English letters, digits, space, `_` and `-`. */
export const NAME_RULE = /^[A-Za-z0-9 _-]{3,24}$/;
const NAME_MIN = 3;
const NAME_MAX = 24;
/** The most modules one batch read takes. */
export const BATCH_LIMIT = 200;

/** Every `error` code that the name service sends: the refusals of this module and of names-http.js, `internal`
 *  for an unexpected exception (names-http.js) and `misconfigured` when api/names.js cannot build the handler.
 *  The page maps each code to a message (site/src/ladder/errors.js), and site/src/ladder/errors.test.js checks it. */
export const ERROR_CODES = Object.freeze([
  'invalid_module', 'name_length', 'name_chars', 'name_banned', 'bad_signature', 'bad_json', 'bad_request',
  'not_entered', 'not_owner', 'name_set', 'name_taken', 'unauthorized', 'method_not_allowed', 'body_too_large',
  'internal', 'misconfigured',
]);

/** A refusal of the service: `status` is the HTTP status, `code` one of ERROR_CODES, `details` extra fields. */
export class NameError extends Error {
  constructor(status, code, details = {}) {
    if (!ERROR_CODES.includes(code)) throw new Error(`NameError: unknown code ${JSON.stringify(code)}. Add it to ERROR_CODES.`);
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The text that the owner signs (EIP-191 personal message). The module address is in lower case, the name is
 *  exactly the name that the request sends. */
export function nameMessage({ chainId, module, name }) {
  return `NEUROM ladder name\nchain: ${Number(chainId)}\nmodule: ${String(module).toLowerCase()}\nname: ${name}`;
}

/** The lower-case form of a name that decides equality. */
const nameKey = name => name.toLowerCase();

/** True when `name` contains one of `words` after lower-casing and removal of space, `_` and `-`. */
export function isBanned(name, words) {
  const collapsed = name.toLowerCase().replace(/[ _-]/g, '');
  return words.some(word => collapsed.includes(word.toLowerCase().replace(/[ _-]/g, '')));
}

/** The refusal code of `name` (`name_length`, `name_chars`, `name_banned`), or null when the name is valid. */
export function validateName(name, words = []) {
  if (typeof name !== 'string' || name.length < NAME_MIN || name.length > NAME_MAX) return 'name_length';
  if (!NAME_RULE.test(name)) return 'name_chars';
  if (isBanned(name, words)) return 'name_banned';
  return null;
}

const requireModule = module => {
  if (typeof module !== 'string' || !isAddress(module)) throw new NameError(400, 'invalid_module', { module });
  return module.toLowerCase();
};

const LADDER_OWNER_ABI = ['function entryOwner(address module) view returns (address)'];
/** The production `ownerOf`: reads `entryOwner(module)` from the ladder contract at `ladder` over `rpc` (a URL or an
 *  ethers provider). Returns the owner in lower case, or null when the module is not an entry. */
export function ladderOwnerOf({ rpc, ladder }) {
  if (!isAddress(ladder)) throw new Error(`ladder address is not valid: ${ladder}`);
  const provider = typeof rpc === 'string' ? new JsonRpcProvider(rpc) : rpc;
  const contract = new Contract(ladder, LADDER_OWNER_ABI, provider);
  return async module => {
    const owner = await contract.entryOwner(module);
    return owner === ZeroAddress ? null : owner.toLowerCase();
  };
}

/**
 * The service over `db` (db.js) for one chain. `ownerOf(module)` → the owner address or null. `banned` is the word
 * list (data/banned-words.json `words`).
 */
export function createNameService({ db, chainId, ownerOf, banned }) {
  const chain = Number(chainId);
  return {
    /** The active names of `modules` → `{ [module in lower case]: name }`. Modules without a name are absent. */
    async names(modules) {
      if (!Array.isArray(modules) || modules.length > BATCH_LIMIT) throw new NameError(400, 'bad_request', { limit: BATCH_LIMIT });
      const keys = modules.map(requireModule);
      if (!keys.length) return {};
      const rows = await db.query('SELECT module, name FROM entry_names WHERE chain_id = $1 AND cleared_at IS NULL AND module = ANY($2::text[])', [chain, keys]);
      return Object.fromEntries(rows.map(r => [r.module, r.name]));
    },

    /** Set the name of `module`. `signature` signs `nameMessage({ chainId, module, name })`. → `{ module, name, owner }`. */
    async set({ module, name, signature }) {
      const key = requireModule(module);
      const problem = validateName(name, banned);
      if (problem) throw new NameError(400, problem, { min: NAME_MIN, max: NAME_MAX });
      let signer;
      try { signer = verifyMessage(nameMessage({ chainId: chain, module: key, name }), signature).toLowerCase(); }
      catch { throw new NameError(400, 'bad_signature'); }
      const owner = (await ownerOf(key))?.toLowerCase();
      if (!owner) throw new NameError(403, 'not_entered', { module: key });
      if (owner !== signer) throw new NameError(403, 'not_owner', { module: key, owner, signer });
      const taken = await db.query('SELECT module, name FROM entry_names WHERE chain_id = $1 AND cleared_at IS NULL AND (module = $2 OR name_key = $3)', [chain, key, nameKey(name)]);
      const mine = taken.find(r => r.module === key);
      if (mine) throw new NameError(409, 'name_set', { module: key, name: mine.name });
      if (taken.length) throw new NameError(409, 'name_taken', { name });
      try {
        await db.query('INSERT INTO entry_names (chain_id, module, name, name_key, owner, signature) VALUES ($1, $2, $3, $4, $5, $6)', [chain, key, name, nameKey(name), owner, signature]);
      } catch (e) {
        if (e.code === '23505') throw new NameError(409, 'name_taken', { name });
        throw e;
      }
      return { module: key, name, owner: owner.toLowerCase() };
    },

    /** Admin: clear the active name of `module`. → true when a name was active. */
    async clear(module) {
      const key = requireModule(module);
      const rows = await db.query('UPDATE entry_names SET cleared_at = now() WHERE chain_id = $1 AND module = $2 AND cleared_at IS NULL RETURNING name', [chain, key]);
      return rows.length > 0;
    },
  };
}
