---
status: accepted
---

# A trainer can start from weights and wait for a gate

## Context

The tank battle trains each network in stages. Stage 1 imitates a teacher with cross-entropy. Stage 2 plays against the scripted bot with REINFORCE. Stage 2 must continue from the result of stage 1, and it must not start before stage 1 passes a test. A trainer has one method and one objective (ADR 0009). Each run starts from random weights. A partition gives only the Start records, and a scenario cannot see the progress of a run. So stages need several trainers, and the canvas must show how they connect.

## Decision

A trainer gets two optional value inputs. Both are general: they are not specific to a task.

- `init` takes a `weights` handle, for example from the candidates of the earlier stage. The run starts from the weights of that accepted artifact, not from random weights. The artifact must have the structure and readout of the trained network. This is the same check as for a frozen network. Without the wire, the run starts from random weights as before.
- `gate` takes the `report` handle of an evaluator. The configuration of the trainer gives the condition `gate: { metric, min?, max? }`: a metric name, and a minimum, a maximum or both. When a run starts, the trainer reads the current report of that evaluator. If there is no report, if the report is stale, if the report has no such metric, or if the metric does not meet the condition, the trainer does not start and tells why.

Each training module trains one network. A stage has one training module for each network structure. The stages go from left to right, and the `init` and `gate` wires connect them.

## Considered Options

- **A gate that a person checks.** The docs give the minimum and the user decides. Nothing stops a run that starts too early.
- **One trainer with several phases.** The engine switches method and checks the gate by itself. The canvas then does not show the stages, and the engine change is larger.
- **A parameter that switches the stage.** This works only when the method stays the same. The stages are then not visible as a sequence.
- **One training module for each stage, with a trainer for each structure.** The template of the tank battle used this at first. A frame then holds several networks that share nothing in the frame, and the user did not see which frame trains which network. So each training module now trains one network, also when the canvas gets more frames.

## Consequences

- The trainer in JS and the trainer in Python both start from the weights of `init`. The bundle carries them as `init: { artifactId, model }`. The parity corpus records the validation of three start models (`starts`), and both trainers must report it as epoch 0.
- The start is the exact integers of the artifact: the codes, the biases, the scale and k of each layer, and the LIF thresholds. The real-unit shadows get the values of these integers. The first update quantises the shadows again by the rule of ADR 0015. The Adam moments start at zero.
- A run from `init` does not calibrate the biases. The calibration sets the bias of each plain layer from random rollouts, so it would overwrite the start. Thus `calibrationEpisodes` and `initCurrent` have no effect when `init` has a wire.
- The trainer validates the start before the first epoch and reports it as epoch 0. The start is the first best model, so only a strictly better epoch replaces it. If no epoch is better, the selected epoch is 0 and the candidate has the model of the start.
- `init` is a `loop` port. Thus a trainer can also take the weights of its own candidates and continue its last accepted run.
- Without the `init` wire, the bundle has no `init`. The bundle hash and the training result stay as before.
- A report is session state (it is not saved with the workspace). After a reload, run the evaluator again before a gated run.
- A gate reads the report at the start of a run only. A later change to the report does not stop a run.
- The workbench checks the gate before it gives a run to a backend. Thus the gate applies to the browser backend and to the Python backend in the same way. The bundle does not carry the gate or its condition, so a gated bundle has the same hash as before.
- The problems of the graph contain only the static part of the gate: a `gate` wire without a complete condition, and a metric name that is not a metric of that evaluator. Only an evaluator has a `report` output, so a wire from another output into `gate` is refused.
- Arrange does not wrap a row between two adjacent layers that both hold a training module. Thus the stages stay in one row from left to right, also when the canvas has many layers.
- Self-play is not part of this decision. A later decision can let a scenario call a network as a function.
