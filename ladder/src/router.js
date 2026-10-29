// router.js — the views of the page by the URL hash: `#/` the main page, `#/entries` my entries,
// `#/challenge/<id>` a challenge in progress, `#/replay/<id>` a replay. `#<section>` on the main page scrolls to it.
import { useSyncExternalStore } from 'react';

const subscribe = cb => { addEventListener('hashchange', cb); return () => removeEventListener('hashchange', cb); };
const hash = () => location.hash;

/** The current route: `{ view, id }` with view `main` | `entries` | `challenge` | `replay`. */
export function useRoute() {
  const h = useSyncExternalStore(subscribe, hash, () => '');
  return parseRoute(h);
}

export function parseRoute(h) {
  const m = /^#\/(entries|challenge|replay)(?:\/([^/?]+))?/.exec(h ?? '');
  if (!m) return { view: 'main', id: null, section: (h ?? '').startsWith('#/') ? null : (h ?? '').slice(1) || null };
  return { view: m[1], id: m[2] ?? null, section: null };
}

/** The href of a view. */
export const href = {
  main: section => (section ? `#${section}` : '#/'),
  entries: () => '#/entries',
  challenge: id => `#/challenge/${id}`,
  replay: id => `#/replay/${id}`,
};

/** Go to a route. */
export const go = h => { location.hash = h; };
