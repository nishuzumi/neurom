// The page publishes core chain data before optional names and historical gas totals.
// Each reader allows one request at a time. A new block queues one refresh.
import { computed, inject, markRaw, onScopeDispose, provide, shallowReactive, shallowRef, watch } from 'vue';
import { createLadderClient } from '../chain/client.js';
import { fetchNames } from './names.js';
import { addressKey } from './format.js';

const LADDER = Symbol('ladder');
/** The ladder data that the root provided. */
export const useLadder = () => inject(LADDER);
/** The entry of module `module` in `entries`, or undefined. */
export const entryOf = (entries, module) => entries.find(e => addressKey(e.module) === addressKey(module));
/** The entries of `entries` that account `owner` registered (none when `owner` is empty). */
export const entriesOf = (entries, owner) => (owner ? entries.filter(e => addressKey(e.owner) === addressKey(owner)) : []);

const RECENT = 20;
const EMPTY = () => ({ config: null, entries: [], recent: [], recentLoaded: false, block: 0, names: {}, error: null, loaded: false });

/**
 * Loads core data first. Only the main route needs recent challenges and gas totals. Called once, by the root.
 * `signer()` and `includeRecent()` are getters of reactive state. The result is a shallowReactive object:
 * `{ config, entries, recent, recentLoaded, block, names, error, loaded, client, tick, refreshName(module), refresh() }`.
 */
export function provideLadder({ config, provider, signer, includeRecent }) {
  const client = computed(() => markRaw(createLadderClient({ provider, signer: signer() ?? undefined, ladder: config.ladder })));
  const tick = shallowRef(0);
  const state = shallowReactive({
    ...EMPTY(),
    get client() { return client.value; },
    get tick() { return tick.value; },
    refreshName(module) { delete namesCache[addressKey(module)]; tick.value += 1; },
    refresh() { recentCache.stale = true; tick.value += 1; },
  });
  let namesCache = {};
  let recentCache = { count: -1, items: [], stale: true };
  let flight = null;
  let namesFlight = null;

  // the block poll: one request per polling interval, a tick per new block
  let live = true, last = -1, timer = null;
  const poll = async () => {
    try {
      const block = await provider.getBlockNumber();
      if (live && block !== last) {
        last = block;
        state.block = block;
        tick.value += 1;
      }
    } catch { /* The next poll reads the block again. */ }
    if (live) timer = setTimeout(poll, provider.pollingInterval);
  };
  poll();
  onScopeDispose(() => { live = false; clearTimeout(timer); if (flight) flight.live = false; });

  // a new client or scope of data: a new flight, fresh caches
  watch([client, includeRecent], () => {
    if (flight) flight.live = false;
    flight = { busy: false, again: false, recentBusy: false, live: true };
    namesCache = {};
    recentCache = { count: -1, items: [], stale: true };
    Object.assign(state, EMPTY());
  }, { immediate: true });

  watch([client, includeRecent, tick], () => {
    if (!config.ladder) { state.loaded = true; state.error = null; return; }
    const f = flight;
    if (!f?.live) return;
    if (f.busy) { f.again = true; return; }

    const readNames = modules => {
      const missing = [...new Set(modules.map(addressKey))].filter(m => !(m in namesCache));
      if (!missing.length || namesFlight) return;
      namesFlight = f;
      fetchNames(missing).then(found => {
        if (!f.live) return;
        for (const m of missing) namesCache[m] = found[m] ?? null;
        state.names = { ...namesCache };
      }, () => { /* Names do not block chain data. */ }).finally(() => {
        if (namesFlight === f) namesFlight = null;
      });
    };
    const readRecent = async () => {
      if (!includeRecent() || f.recentBusy) return;
      f.recentBusy = true;
      try {
        const count = Number(await client.value.contract.challengeCount());
        const cached = recentCache;
        if (cached.count !== count || cached.stale || cached.items.some(c => c.status === 1)) {
          const items = await client.value.recentChallenges({ count: RECENT });
          if (!f.live) return;
          recentCache = { count, items, stale: false };
        }
        if (!f.live) return;
        const recent = recentCache.items;
        state.recent = recent;
        state.recentLoaded = true;
        readNames(recent.flatMap(c => [c.challenger, c.defender]));
      } catch (error) {
        if (f.live) state.error = error;
      } finally { f.recentBusy = false; }
    };

    f.busy = true;
    (async () => {
      try {
        do {
          f.again = false;
          try {
            const [cfg, entries] = await Promise.all([client.value.config(), client.value.entries()]);
            if (!f.live) return;
            Object.assign(state, { config: cfg, entries, error: null, loaded: true });
            readNames(entries.map(e => e.module));
            void readRecent();
          } catch (error) {
            if (f.live) Object.assign(state, { error, loaded: true });
          }
        } while (f.again && f.live);
      } finally { f.busy = false; }
    })();
  }, { immediate: true });

  provide(LADDER, state);
  return state;
}
