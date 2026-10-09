---
status: accepted
---

# The route of a wire is presentation: reroute points on the wire, not nodes

## Context

Users must be able to adjust the path of a wire on the canvas. The path of a wire changes only the drawing. It does not change what the program computes. So the mechanism must not add data to the module graph or to the program.

## Decision

- Only reroute points decide the path of a wire.
- Reroute points are an ordered list of points on the wire.
- The appearance of the wire stores them (`edge-presentation.ts`). The workspace saves them in its canvas settings under the wire id.
- Each point uses the coordinates of its wire: fractions of the wire length, along the wire and perpendicular to it.
- Reroute points change only the drawing. They do not go into the module graph or into the program IR. The native reroute points of ComfyUI work in the same way.

## Considered Options

- **Reroute node.** A reroute node is a real node with one input and one output. It goes into the data structure of the graph, but we only need to adjust the drawing.
- **A relay output on a module that gives an input again without change.** It expresses the same thing as "one output connected to several inputs". It adds a port that can make cycles, together with the rules for that port. It also makes "how to draw this wire" a part of the program.

## Consequences

- Reroute points scale with the wire when the wire becomes longer or shorter.
- The module graph and the program IR stay free of drawing data.
