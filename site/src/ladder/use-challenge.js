// The root keeps one transaction task active across route changes.
// Saved challenge IDs include the account. Other accounts do not resume them.
// Timeout settlement uses expire. Automatic attempts stop after one failure.
import { computed, inject, provide, shallowReactive, shallowRef, watch } from 'vue';
import { addressKey } from './format.js';

const CHALLENGE = Symbol('challenge');
/** The running challenge that the root provided. */
export const useChallenge = () => inject(CHALLENGE);
const KEY = 'ladder.active-challenge';

/** The challenge that localStorage remembers as `{ id, account }`, or null. */
function readRemembered() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return v && Number.isFinite(Number(v.id)) ? { id: Number(v.id), account: addressKey(v.account) } : null;
  } catch { return null; }
}

/** The running challenge: `{ run, busy, start(challenger, defender), resume(id, …), expire(id, …), expireAttempted(id),
 *  dismiss(), remembered() }`. Called once, by the root, with the ladder data and the wallet it provides (a component
 *  cannot inject what it provides itself). */
export function provideChallenge(ladder, wallet) {
  const account = computed(() => addressKey(wallet.address));
  /** `run`: { id, challenger, defender, kind: 'play' | 'expire', account, progress, result, error,
   *           phase: 'starting' | 'playing' | 'done' | 'failed' } */
  const run = shallowRef(null);
  const working = shallowRef(false);
  let busy = false;
  // Each account attempts automatic settlement once for each challenge.
  // A failed attempt needs an explicit retry.
  const expireAttempts = new Set();

  const track = async (label, task) => {
    if (busy) throw new Error('busy');
    busy = true;
    working.value = true;
    const remember = label.kind === 'play';
    // Account changes hide the old run and discard late state updates.
    const mine = { ...label, account: account.value, phase: 'starting', progress: null, result: null, error: null };
    const update = patch => {
      const r = run.value;
      if (r && r.account === mine.account && r.kind === mine.kind) run.value = { ...r, ...patch(r) };
    };
    run.value = mine;
    try {
      const onProgress = p => {
        if (remember && p?.id !== undefined && p.id !== null) localStorage.setItem(KEY, JSON.stringify({ id: p.id, account: mine.account }));
        update(r => ({ id: p?.id ?? r.id ?? null, phase: 'playing', progress: p }));
      };
      const result = await task(onProgress);
      if (remember) localStorage.removeItem(KEY);
      update(r => ({ id: result?.id ?? r.id ?? null, phase: 'done', result }));
      ladder.refresh();
      return result;
    } catch (error) {
      update(() => ({ phase: 'failed', error }));
      ladder.refresh();
      throw error;
    } finally { busy = false; working.value = false; }
  };

  const challenge = shallowReactive({
    get run() { return run.value; },
    get busy() { return working.value; },
    start: (challenger, defender) => track({ id: null, challenger, defender, kind: 'play' }, onProgress => ladder.client.challenge(challenger, defender, { onProgress })),
    resume: (id, challenger, defender) => track({ id, challenger, defender, kind: 'play' }, onProgress => ladder.client.resume(id, { onProgress })),
    /** Sends a timeout settlement transaction unless the challenge is settled. Records the attempt for expireAttempted. */
    expire: (id, challenger, defender) => {
      if (busy) return Promise.reject(new Error('busy'));
      expireAttempts.add(`${id}:${account.value}`);
      return track({ id, challenger, defender, kind: 'expire' }, onProgress => ladder.client.expire(id, { onProgress }));
    },
    /** Whether this page already tried to settle `id` with the current account (so the view does not try again by itself). */
    expireAttempted: id => expireAttempts.has(`${id}:${account.value}`),
    dismiss: () => { run.value = null; },
    /** The id that localStorage remembers from a page that was closed during a challenge of the current account, or null. */
    remembered: () => { const v = readRemembered(); return v && v.account === account.value ? v.id : null; },
  });

  // an account that goes away or changes ends nothing on chain: the challenge stays resumable through `remembered`
  watch([() => wallet.signer, account], ([signer, acc]) => { const r = run.value; if (!(signer && r && r.account === acc)) run.value = null; });

  provide(CHALLENGE, challenge);
  return challenge;
}
