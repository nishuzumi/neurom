// ladder/use-challenge.jsx — the challenge the page runs: one at a time per account. It survives view changes (the
// runner lives at the root). The id of the running challenge is in localStorage, so a page that comes back within
// the timeout can continue it (`client.resume`). The client sends every transaction without a wallet popup.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLadder } from './use-ladder.jsx';

const ChallengeContext = createContext(null);
export const useChallenge = () => useContext(ChallengeContext);
const KEY = 'ladder.active-challenge';

/** The running challenge: `{ run, status, start(challenger, defender), resume(id), dismiss() }`. */
export function ChallengeProvider({ signer, children }) {
  const { client, refresh } = useLadder();
  /** `run`: { id, challenger, defender, progress, result, error, phase: 'starting' | 'playing' | 'done' | 'failed' } */
  const [run, setRun] = useState(null);
  const busy = useRef(false);

  const track = useCallback(async (label, task) => {
    if (busy.current) throw new Error('busy');
    busy.current = true;
    setRun({ ...label, phase: 'starting', progress: null, result: null, error: null });
    try {
      const onProgress = p => {
        if (p?.id !== undefined && p.id !== null) localStorage.setItem(KEY, String(p.id));
        setRun(r => ({ ...r, id: p?.id ?? r?.id ?? null, phase: 'playing', progress: p }));
      };
      const result = await task(onProgress);
      localStorage.removeItem(KEY);
      setRun(r => ({ ...r, id: result?.id ?? r?.id ?? null, phase: 'done', result }));
      refresh();
      return result;
    } catch (error) {
      setRun(r => ({ ...r, phase: 'failed', error }));
      refresh();
      throw error;
    } finally { busy.current = false; }
  }, [refresh]);

  const value = useMemo(() => ({
    run,
    busy: run?.phase === 'starting' || run?.phase === 'playing',
    start: (challenger, defender) => track({ id: null, challenger, defender }, onProgress => client.challenge(challenger, defender, { onProgress })),
    resume: (id, challenger, defender) => track({ id, challenger, defender }, onProgress => client.resume(id, { onProgress })),
    dismiss: () => setRun(null),
    /** The id that localStorage remembers from a page that was closed during a challenge, or null. */
    remembered: () => { const v = localStorage.getItem(KEY); return v ? Number(v) : null; },
  }), [run, track, client]);

  // a signer that goes away ends nothing on chain: the challenge stays resumable through `remembered`
  useEffect(() => { if (!signer) setRun(null); }, [signer]);

  return <ChallengeContext.Provider value={value}>{children}</ChallengeContext.Provider>;
}
