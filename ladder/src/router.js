// router.js — the views of the ladder page by the URL hash: `#/` the main page, `#/entries` my entries,
// `#/challenge/<id>` a challenge in progress, `#/replay/<id>` a replay. `#<section>` on the main page scrolls to it.
// The page is `/ladder/` of the site (site.js). The hrefs here are hash only, so they stay on the page wherever the
// site serves it. A link from another page of the site is `${site.ladder}${href.replay(id)}`.
import { shallowRef } from 'vue';

function parseRoute(h) {
  const m = /^#\/(entries|challenge|replay)(?:\/([^/?]+))?/.exec(h);
  if (!m) return { view: 'main', id: null, section: h.startsWith('#/') ? null : h.slice(1) || null };
  return { view: m[1], id: m[2] ?? null, section: null };
}

let current = null;
/** The current route as a ref: `{ view, id, section }` with view `main` | `entries` | `challenge` | `replay`. */
export function useRoute() {
  if (!current) {
    current = shallowRef(parseRoute(location.hash));
    addEventListener('hashchange', () => { current.value = parseRoute(location.hash); });
  }
  return current;
}

/** The href of a view: a hash, relative to the ladder page. */
export const href = {
  main: section => (section ? `#${section}` : '#/'),
  entries: () => '#/entries',
  challenge: id => `#/challenge/${id}`,
  replay: id => `#/replay/${id}`,
};

/** Go to a route. */
export const go = h => { location.hash = h; };
