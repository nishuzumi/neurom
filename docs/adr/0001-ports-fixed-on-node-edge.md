---
status: accepted
---

# Ports are fixed on the node edge at their own row, and all nodes use one port band

## Context

The canvas has two node kinds: modules (`ModuleNode.vue`) and composites (`GroupNode.vue`). Both kinds show ports, and wires connect to these ports. A port must stay next to its name, so that you can see which wire belongs to which port. A port is one concept, so it must look and act the same on each node kind.

## Decision

- The two node kinds use the same port band (`frontend/editor/NodePorts.vue`) and the same wiring model (`frontend/editor/wiring.ts`).
- Each port has exactly one socket, as in ComfyUI.
- The socket is fixed on the node edge at the row of the port.
- Inputs are on the left, and outputs are on the right.
- All wires on a port leave from the socket of that port.
- Each wire gets one palette colour (`wire-palette.js`). Two wires on the same node do not have the same colour.

## Considered Options

- **Geometric docking.** The endpoint of a wire goes to the side of the node that faces the other end. Several endpoints on the same side spread out automatically. When the other node moves, the endpoint jumps. Then the port does not align with the name in its row, and you cannot see which wire belongs to which port.
- **A port implementation for each node kind.** Each kind will drift into its own look and interaction (fonts, colours, ring positions), but a port is one concept.

## Consequences

- The Handle id of a port is the port id, without a wire id.
- A port has exactly one Handle, independent of the number of wires on it.
- All that a port row shows comes from its `PortSpec`.
- The port band has no slots or switches for one specific node.
