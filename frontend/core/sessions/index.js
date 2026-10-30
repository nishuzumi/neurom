// core/sessions/index.js — the runtime controllers the application consumes (graph_app.js builds one per node kind).
// Every session follows one shape: `snapshot()` (cached plain data), `subscribe(fn) → unsubscribe`, mutators,
// `dispose()`. Durable changes go through the Workspace (the app persists from its subscription). A result a driver
// keeps for itself carries the bundle it pinned (pinned.js). All sessions read the core Workspace and ModuleGraph, and
// no session contains scenario-specific code.
export { createTrainerSession } from './trainer.js';
export { createCandidatesSession } from './candidates.js';
export { createNetworkSession } from './network.js';
export { createEvaluatorSession } from './evaluator.js';
export { createExecutionSession } from './execution.js';
export { createDeploymentSession } from './deployment.js';
export { createDatasetStore, createDatasetSession, reclaimDatasets } from './dataset.js';
export { createRunChain, CHAIN_KINDS } from './run-chain.js';
export { WorkspaceClient } from './workspace-client.js';
