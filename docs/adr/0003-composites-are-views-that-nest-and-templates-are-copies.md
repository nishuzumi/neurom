---
status: accepted
---

# A composite is a view over the flat module graph, composites nest, and template instances are copies

## Context

Users group modules into composites on the canvas, and templates put such groups of modules onto the canvas. Many parts of the system read the module graph: the loop executor, bundles, deployment and undo history. If composites go into the module graph, each of these parts must handle them. ComfyUI also expands subgraphs into a flat graph for execution. A task expands to a dozen or more modules, and users must be able to use "one task" as a unit and compose it further. Configurations on the canvas get trained and an artifact pins its bundle, so a change to a template must not change modules that are already on the canvas.

## Decision

### 1. A composite is a view

- A composite exists only in the canvas layout (`graph.groups`).
- Wires always connect member ports in the module graph, the loop executor, bundles, deployment and undo history.
- When a composite is collapsed, the canvas draws the wires that cross its boundary again, onto the sockets of the composite node. The id of such a socket is `${member flow id}/${port}`.
- The canvas does not draw wires between members of a collapsed composite.
- Each wiring gesture first resolves the socket back to the member port. Only then does the gesture go to the module graph.

### 2. Composites nest

- The members of a composite are modules or other composites.
- Each module or composite has a maximum of one parent.
- Nesting has no depth limit.
- A collapsed composite shows as one node, with only the member ports in its `expose` list.
- An expanded composite is a frame around its members. A composite expands in place into this frame, and you edit it in place.

### 3. A template instance is a copy

- When you instantiate a template (`neurom-template`), the workbench copies the modules and wires of the template onto the canvas with new ids. Then it wraps them in a composite.
- The composite records only its origin, `template: {id, revision}`.
- If you edit or delete the template after this, the existing instances do not change.
- If you save an instance back as a template, you get a new id or a new revision.
- A template does not refer to other templates.
- A template can declare nested groups of its own modules. Nesting across templates occurs on the canvas.

## Considered Options

- **Composite node at the domain level.** The composite declares its own inputs and outputs, and the compiler expands it at compile time. Bundles, the loop executor, deployment and undo history all must change. ComfyUI also expands subgraphs into a flat graph for execution. So this option gives no semantic gain.
- **Edit in a separate canvas level, as in ComfyUI.** In-place expansion gives one nesting style and no breadcrumb navigation.
- **No nesting.** Without nesting, you cannot use "one task" as a unit and compose it further.
- **Instances follow template updates.** Configurations that are already trained will change silently. Also, the bundle pinned in an artifact will not agree with the modules on the canvas.

## Consequences

- The connection logic does not handle composites.
- The executable graph stays flat.
- If you pack a selection that contains composites, you get a parent composite. The members of those composites stay in them.
- The `expose` list of a composite is stored data: the `expose` of the template, or the choice of the user. It does not come from the wires.
