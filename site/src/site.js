// site.js — the pages of the site (ADR 0027): the home page at `/`, the ladder at `/ladder/`, the workbench at
// `/studio/`, the participation guide at `/guide/`. The paths are the same in development (one Vite server,
// site/vite.config.js) and in production (Vercel, `dist/`). The links of the site top bar and of the home page come
// from here, so no component assumes the page it is on.
export const site = Object.freeze({
  home: '/',
  ladder: '/ladder/',
  studio: '/studio/',
  guide: '/guide/',
  github: 'https://github.com/nishuzumi/neurom',
});

/** The URL of a repo document on GitHub. `path` is relative to the repo root, for example `docs/user-guide.md`. */
export const repoDoc = path => `${site.github}/blob/main/${path}`;
