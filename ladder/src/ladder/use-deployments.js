// ladder/use-deployments.js — the modules the current account deployed through the official Factory, read from the
// archive of the Factory through the client. The composable follows the block tick of the ladder data: every tick it
// reads one number, `deploymentCount(deployer)`, and re-reads the list only when that number changed, when the account
// changed or after `reload()`. So a deployment made in the workbench appears on the next block without a manual copy
// of the address, and an unchanged archive costs one request a block.
import { shallowReactive, shallowRef, watch } from 'vue';
import { useLadder } from './use-ladder.js';
import { addressKey } from './format.js';

const EMPTY = Object.freeze([]);

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
  const reloads = shallowRef(0);
  const reload = () => { cache = { deployer: null, count: -1, items: EMPTY }; reloads.value += 1; };
  const same = d => addressKey(state.deployer) === addressKey(d);
  const kept = d => (same(d) ? state.items : EMPTY);

  watch([() => ladder.client, deployer, () => ladder.tick, reloads], ([client, d], _, onCleanup) => {
    if (!d) { Object.assign(state, { deployer: null, items: EMPTY, count: -1, loading: false, error: null }); return; }
    let on = true;
    onCleanup(() => { on = false; });
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
