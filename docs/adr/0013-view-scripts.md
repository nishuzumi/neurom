---
status: accepted
---

# View scripts: a view can draw with its own JavaScript, in a sandbox

## Context

The built-in renderers of a view cannot draw every picture. An example is a map whose side length is in params. An author must be able to draw such a picture without a change to State. Code that draws must not get the privileges of the workbench page. This ADR builds on ADR 0004 and ADR 0011. It does not change what a code module is (ADR 0005).

## Decision

A view can pick one of four built-in renderers (`grid`, `series`, `table`, `kv`), or it can run its own script in a sandbox. `path` and `marks` point a built-in renderer at the data. The script reads the static values of the training module.

1. Renderer `script`. The view has `config.script`. This is plain JavaScript, not a code module (no IR, types or roles). The script defines `const component` (a Vue 3 component with the prop `ctx`) or `function render(ctx, el)`. The global `Vue` is available. The view calls the script again on each new `ctx` (a step, the history scrubber, an edit). The script can keep state between calls.
2. Sandboxed frame. The script runs in `<iframe sandbox="allow-scripts" srcdoc>` without `allow-same-origin`. The frame has the full build of Vue inlined and a CSP (`default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:`). The script has no access to the DOM, storage, wallet or network of the workbench. Data goes in by `postMessage`. Only the content height and errors come out.
3. `ctx` contains these items:
   - What the view is wired to. This is a report, or the `state`, `history`, `t` and other outputs of an execution at the scrubbed step.
   - `ctx.modules`: every member of the nearest training module, keyed by title. If the scenario module of one of its loops is outside it (an environment that several training modules share), `ctx.modules` also holds that scenario module. Each member is `{ <port>: value }` for its outputs with a static value (`core/bundle.js staticPorts`).
   - `ctx.errors`: the members that the system cannot evaluate.

   While a member view uses a script, titles in that training module and its shared scenario must be unique.
4. A view without a script uses a built-in renderer.

## Considered Options

- **Only the built-in renderers.** If the renderers cannot draw something, the author must push it into State. This changes the environment and its hash, and artifacts must bind again, only to draw a picture.
- **A `draw(state)` role in IR.** This is safe and typed. But the IR limits it (static widths, no strings or DOM).
- **A component that runs in the page.** An imported template would run with the privileges of the page.
- **A separate component module wired into views.** This needs a new kind, a new wire and a new handle type. Templates are copies in any case (ADR 0003).
- **Declared inputs wired into the view.** Dependencies are visible, and the system checks them on rename. But each value needs one wire.
- **Libraries from a CDN allow-list.** This prevents offline use. It also gives the data to third-party code.
- **Plain JS, the runtime-only build of Vue, or `.vue` files.** These options need manual redraws, have no templates, or need an SFC compiler. Templates are what make a component short. Inside the sandbox, `'unsafe-eval'` gives no additional permissions.

## Consequences

- Bundles do not collect views. Thus a view or its script changes no environment hash.
- The lookup by title is an intentional exception to the rule "a module's exposure comes from its own declarations" (AGENTS.md). The script still reads declared outputs. Only the lookup is by title (as `transition.loop.<title>`, ADR 0010). If the user renames a member that a script reads, this is not a wiring problem. The script finds `undefined`.
- Each change sends the full `ctx` again by structured clone, with the history (a maximum of 4096 steps).
- The full build of Vue increases the size of the single-file build.
- Templates contain a second language. A code module is IR-compiled. A view script only draws.
