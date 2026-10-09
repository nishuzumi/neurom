---
status: accepted
---

# One reader per format and no migration, and a local save that cannot be restored is kept for the user to export or discard

## Context

The workbench reads several file formats: workspaces, templates, bundles, artifacts and programs. Each format can change. Code that converts files of another shape must carry task-specific mapping, and ADR 0004 keeps such mapping out of code. Template copies are independent of their template (ADR 0003). Saves are only in the browser of the user, and they never go on chain. Without migration, the workbench can find a local save that it cannot restore.

## Decision

### 1. One reader per format

The workbench has exactly one reader for each file format. The format tag of a file names its type. The formats are:

- workspace: `neurom-workbench` (graph `neurom-graph`)
- template: `neurom-template`
- bundle: `neurom-bundle`
- artifact: `neurom-module`
- program: `neurom-program`

The reader validates each file strictly:

- A file with a different format tag or a different shape fails this validation.
- The message is the normal message of the validation, for example an unknown field or a missing field, with its path.
- The workbench does not rewrite the file.

A format changes in place. The reader, the builtin templates, the artifacts and the fixtures change together. The workbench contains no migration code.

The workbench never converts artifacts.

### 2. A local save that cannot be restored

If the workbench cannot restore the local save, it shows a conflict panel. These are the causes:

- The save is not JSON.
- The save has a different format tag.
- The save fails validation, for example with an unknown field or a missing field.

The conflict panel shows these items:

- The format that the workbench found.
- The path where validation failed.
- The reason.

The workbench keeps the save without changes. While the panel is open, the tab writes nothing. There is no autosave. If another tab writes a save during that time, the workbench asks about it only after the panel closes.

The panel gives the user these choices:

- Export the save. The user can then convert it, for example with the help of an AI.
- Open a corrected file in place of the save.
- Discard the save and start empty. This needs a confirmation, because it deletes the save.

A converted file goes through the same strict validation as all other files. If it is wrong, the workbench refuses it.

An opened file that the workbench cannot restore needs no panel. The workbench refuses it with the same detail, and the current workspace stays.

Workspace settings are free-form data. Thus a save can contain a setting that the workbench does not read, and the save loads without a conflict.

## Considered Options

- **An importer that converts files of another shape.** It will carry task-specific mapping in code (against ADR 0004). Also, it will need a new verification after each template change.
- **Upgrading saved template copies on restore.** Copies are independent of their template (ADR 0003). The recognition of another shape of one template is a special case, and this case grows with each change.
- **Convert artifacts in the workbench.** A deployed module pins the content hash of its artifact on chain (`artifactId`). A converted artifact has a different hash, so it does not verify against the module.

## Consequences

- If an opened file fails validation, the load fails and the status bar shows the reason. The canvas does not change.
- A user or an AI can convert only what they can read about. Thus the documentation describes the shape of each format.
- Autosave needs a state in which it does not write. While a conflict is open, the workbench does not replace the save.
