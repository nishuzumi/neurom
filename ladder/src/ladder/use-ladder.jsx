// ladder/use-ladder.jsx — the data of the page in one context: the contract configuration, the ladder, the recent
// challenges, the names and the current block. The hook re-reads on every new block of the read provider. The client
// (`../chain/client.js`) is the only path to the chain.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createLadderClient } from '../chain/client.js';
import { fetchNames } from './names.js';
import { addressKey } from './format.js';

const LadderContext = createContext(null);
/** The ladder data of the nearest LadderProvider. */
export const useLadder = () => useContext(LadderContext);

const RECENT = 20;

/** Loads and refreshes the ladder data. `signer` (nullable) makes the client able to send. */
export function LadderProvider({ config, provider, signer, children }) {
  const client = useMemo(() => createLadderClient({ provider, signer: signer ?? undefined, ladder: config.ladder, factory: config.factory, chainId: config.chainId }), [provider, signer, config.ladder, config.factory, config.chainId]);
  const [state, setState] = useState({ config: null, entries: [], recent: [], block: 0, names: {}, error: null, loaded: false });
  const [tick, setTick] = useState(0);
  const namesRef = useRef({});
  /** The recent challenges as last read, with the challenge count then: recentChallenges reads receipts, so the
   *  page re-reads it only when the count changed or a challenge in the window is still playing. */
  const recentRef = useRef({ count: -1, items: [], stale: true });

  // a new block → a new read. The page polls the block number itself: with ethers 6, `provider.on('block')` right after
  // `provider.off('block')` (React StrictMode runs each effect twice in development) can leave no listener at all, and
  // then the page never refreshes.
  useEffect(() => {
    let live = true, last = -1, timer = null;
    const poll = async () => {
      try {
        const b = await provider.getBlockNumber();
        if (live && b !== last) { last = b; setTick(n => n + 1); }
      } catch { /* the next poll tries again */ }
      if (live) timer = setTimeout(poll, provider.pollingInterval);
    };
    poll();
    return () => { live = false; clearTimeout(timer); };
  }, [provider]);

  useEffect(() => {
    if (!config.ladder) { setState(s => ({ ...s, loaded: true, error: null })); return undefined; }
    let on = true;
    (async () => {
      try {
        const [cfg, block, entries, count] = await Promise.all([client.config(), provider.getBlockNumber(), client.ladder({ fromRank: 1 }), client.contract.challengeCount().then(Number)]);
        const cached = recentRef.current;
        if (cached.count !== count || cached.stale || cached.items.some(c => c.status === 1)) {
          const items = await client.recentChallenges({ count: RECENT });
          recentRef.current = { count, items, stale: false };
        }
        const recent = recentRef.current.items;
        const modules = [...entries.map(e => e.module), ...recent.flatMap(c => [c.challenger, c.defender])];
        const missing = modules.filter(m => !(addressKey(m) in namesRef.current));
        if (missing.length) {
          try {
            const found = await fetchNames(missing);
            for (const m of missing) namesRef.current[addressKey(m)] = found[addressKey(m)] ?? null;
          } catch { /* the names are decoration: the page shows short addresses until the service answers */ }
        }
        if (on) setState({ config: cfg, entries, recent, block, names: { ...namesRef.current }, error: null, loaded: true });
      } catch (e) {
        if (on) setState(s => ({ ...s, error: e, loaded: true }));
      }
    })();
    return () => { on = false; };
  }, [client, provider, config.ladder, tick]);

  const value = useMemo(() => ({
    ...state,
    client,
    tick,
    /** Forget the cached name of `module` (after the owner set it), then re-read. */
    refreshName(module) { delete namesRef.current[addressKey(module)]; setTick(n => n + 1); },
    refresh() { recentRef.current.stale = true; setTick(n => n + 1); },
  }), [state, client, tick]);
  return <LadderContext.Provider value={value}>{children}</LadderContext.Provider>;
}
