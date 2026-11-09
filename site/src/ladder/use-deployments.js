// ladder/use-deployments.js — the modules the current account deployed through the official Factory, read from the
// archive of the Factory through the client. The archive of an account grows only when the account deploys a module.
// The account deploys in the workbench, at /studio/, in another tab or window. So the composable does not follow the
// block tick. It reads one number, `deploymentCount(deployer)`, when the account changed, after `reload()`, when the
// page becomes visible or gets the focus again (the user comes back from the workbench), and at most once a minute
// of block ticks for a workbench window that is open beside this one. It re-reads the list only when that number
// changed. An unchanged archive costs no request a block.
import { onScopeDispose, shallowReactive, shallowRef, watch } from 'vue';
import { useLadder } from './use-ladder.js';
import { addressKey } from './format.js';

const EMPTY = Object.freeze([]);
/** The longest time without a count read while the page stays in front. */
const STALE_MS = 60_000;

/**
 * `deployer()` is a getter of the account. → a shallowReactive `{ items, loaded, error, reload }`. `items` are the
 * deployments of the account (client.deploymentsOf) in deployment order, empty until the first read of this account
 * finished. `loaded` is true once the list belongs to the account. `error` is the last read error, with the last good
 * list kept.
 */
export function useDeployments(deployer) {
  const ladder = useLadder();
  const state = shallowReactive({ deployer: null, items: EMPTY, count: -1, loading: false, error: null });
  let cache = { deployer: null, count: -1, items: EMPTY };
  const wake = shallowRef(0);
  let readAt = 0;
  const reload = () => { cache = { deployer: null, count: -1, items: EMPTY }; wake.value += 1; };
  const same = d => addressKey(state.deployer) === addressKey(d);
  const kept = d => (same(d) ? state.items : EMPTY);

  // the signals of a possible deployment: the page comes back in front, or a minute of blocks passed
  const back = () => { if (document.visibilityState === 'visible') wake.value += 1; };
  window.addEventListener('focus', back);
  document.addEventListener('visibilitychange', back);
  onScopeDispose(() => { window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back); });
  watch(() => ladder.tick, () => { if (Date.now() - readAt >= STALE_MS) wake.value += 1; });

  watch([() => ladder.client, deployer, wake], ([client, d], _, onCleanup) => {
    if (!d) { Object.assign(state, { deployer: null, items: EMPTY, count: -1, loading: false, error: null }); return; }
    let on = true;
    onCleanup(() => { on = false; });
    readAt = Date.now();
    (async () => {
      try {
        const count = await client.deploymentCount(d);
        const c = cache;
        if (addressKey(c.deployer) !== addressKey(d) || c.count !== count) {
          if (on) Object.assign(state, { deployer: d, items: kept(d), count, loading: true, error: null });
          const items = await client.deploymentsOf(d);
          cache = { deployer: d, count, items };
        }
        if (on) Object.assign(state, { deployer: d, items: cache.items, count, loading: false, error: null });
      } catch (e) {
        if (on) Object.assign(state, { deployer: d, items: kept(d), loading: false, error: e });
      }
    })();
  }, { immediate: true });

  return shallowReactive({
    get items() { return kept(deployer()); },
    get loaded() { return same(deployer()) && !state.loading && state.count >= 0; },
    get error() { return same(deployer()) ? state.error : null; },
    reload,
  });
}
