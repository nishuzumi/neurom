// editor/modules/registry.ts — the editor's per-kind body table. ModuleNode.vue (the host box: title, badges, ports,
// resize) renders `BODIES[kind].body` with `{ nodeId }`. A body only renders content. Its root fills the host
// (width:100%) and never sets min-width (AGENTS.md). An optional `head` (same props) renders the kind's header actions
// left of the collapse button, visible while collapsed too. The host's natural size is editor/sizes.ts. Kinds without
// an entry get an empty frame.
import type { Component } from 'vue';
import TextBody from './TextBody.vue';
import ParamsBody from './ParamsBody.vue';
import ParamsHead from './ParamsHead.vue';
import CodeBody from './CodeBody.vue';
import DatasetBody from './DatasetBody.vue';
import PartitionBody from './PartitionBody.vue';
import RandomBody from './RandomBody.vue';
import ReadoutBody from './ReadoutBody.vue';
import NetworkBody from './NetworkBody.vue';
import TrainerBody from './TrainerBody.vue';
import CandidatesBody from './CandidatesBody.vue';
import EvaluatorBody from './EvaluatorBody.vue';
import ExecutionBody from './ExecutionBody.vue';
import ViewBody from './ViewBody.vue';
import DeploymentBody from './DeploymentBody.vue';
import BitsBody from './BitsBody.vue';
import LoopBody from './LoopBody.vue';

interface BodyEntry { body: Component; head?: Component }
/** props: `{ nodeId: string }`. The body reads everything else through `useWorkbench()` (workbench-context.ts). */
export const BODIES: Record<string, BodyEntry> = {
  text: { body: TextBody },
  params: { body: ParamsBody, head: ParamsHead },
  code: { body: CodeBody },
  dataset: { body: DatasetBody },
  partition: { body: PartitionBody },
  random: { body: RandomBody },
  readout: { body: ReadoutBody },
  network: { body: NetworkBody },
  trainer: { body: TrainerBody },
  candidates: { body: CandidatesBody },
  evaluator: { body: EvaluatorBody },
  execution: { body: ExecutionBody },
  view: { body: ViewBody },
  deployment: { body: DeploymentBody },
  bits: { body: BitsBody },
  loop: { body: LoopBody },
};
