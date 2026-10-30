// editor/workbench-context.ts — what module bodies see of the workbench. index.ts provides it once at the editor
// root. Bodies `inject(WORKBENCH)` and read graph/resolution/sessions. They mutate only through `edit()` (config
// changes, history-recorded) or session methods. Everything here is untyped domain JS from frontend/core. The shapes
// below name the parts bodies rely on. Sessions are created lazily per node and disposed when the node leaves the
// graph.
import { inject, type InjectionKey, type Ref, type ShallowRef } from 'vue';

export type Problem = { node: string; port?: string; wire?: string; message: string; incomplete?: boolean };

/** frontend/core/graph.js ModuleGraph. */
export interface GraphJSON { format: string; nodes: GraphNode[]; wires: Wire[]; groups: Group[] }
interface NodeSpec { id?: string; kind: string; title?: string; x?: number; y?: number; config?: Record<string, unknown>; uiSize?: { w?: number; h?: number } | null; uiCollapsed?: boolean; uiFolded?: string[] }
interface GroupSpec { id?: string; title?: string; members?: string[]; template?: { id: string; revision: number } | null; collapsed?: boolean; columns?: string[][] | null; x?: number; y?: number; w?: number; h?: number }
export interface ModuleGraph {
  version: number;
  nodes: Map<string, GraphNode>;
  wires: Map<string, Wire>;
  groups: Map<string, Group>;
  /** throws GraphError when missing (use `nodes.get` for a soft lookup) */
  node(id: string): GraphNode;
  hasNode(id: string): boolean;
  addNode(spec: NodeSpec): GraphNode;
  setConfig(id: string, config: Record<string, unknown>): GraphNode;
  patchConfig(id: string, patch: Record<string, unknown>): GraphNode;
  moveNode(id: string, x: number, y: number): GraphNode;
  setTitle(id: string, title: string): GraphNode;
  setUi(id: string, ui: { uiSize?: { w?: number; h?: number } | null; uiCollapsed?: boolean; uiFolded?: string[] }): GraphNode;
  removeNode(id: string): void;
  ports(id: string): { inputs: PortDecl[]; outputs: PortDecl[] };
  producers(node: string, port: string): { wire: Wire; node: string; port: string }[];
  consumers(node: string, port: string): { wire: Wire; node: string; port: string }[];
  wiresOf(node: string): Wire[];
  canConnect(spec: WireSpec): { ok: boolean; reason: string };
  connect(spec: WireSpec): Wire;
  disconnect(id: string): void;
  group(id: string): Group;
  parentOf(id: string): Group | null;
  createGroup(spec: GroupSpec): Group;
  addToGroup(groupId: string, memberId: string): void;
  removeFromGroup(memberId: string): void;
  removeGroup(groupId: string, opts?: { deleteMembers?: boolean }): void;
  memberNodes(groupId: string): string[];
  setExpose(groupId: string, expose: { node: string; port: string }[]): void;
  setGroupLoop(groupId: string, loopId: string | null): Group;
  setPrefab(groupId: string, prefab: Prefab | null): Group;
  exposedPorts(groupId: string): { node: string; port: string; direction: 'input' | 'output' }[];
  setGroupLayout(groupId: string, layout: { x?: number; y?: number; w?: number; h?: number; collapsed?: boolean; title?: string; columns?: string[][] | null }): Group;
  resolved(): Resolution;
  problems(): Problem[];
  toJSON(): GraphJSON;
  /** Admit a description (`toJSON`'s shape): nodes, wires (retried until no more connect), groups and their members,
   *  exposes, loop marks and prefab records. `fresh`: new ids, references translated (untranslatable ones dropped).
   *  `strict` (default): the first refusal throws and rolls back, else the call returns refusals as notes. */
  admit(description: Pick<GraphJSON, 'nodes' | 'wires' | 'groups'>, options?: { fresh?: boolean; dx?: number; dy?: number; strict?: boolean }): { ids: Map<string, string>; notes: string[] };
  subscribe(fn: () => void): () => void;
}
/** `uiFolded`: the tool ports whose sub-canvas the network card folds */
export interface GraphNode { id: string; kind: string; title: string; x: number; y: number; config: Record<string, unknown>; uiSize?: { w?: number; h?: number } | null; uiCollapsed?: boolean; uiFolded?: string[] }
type WireKind = 'value' | 'call';
export interface WireSpec { kind: WireKind; from: { node: string; port: string }; to: { node: string; port: string }; id?: string }
export interface Wire extends WireSpec { id: string }
/** `loop`: the loop node this group is the box of (its view, and the body itself follows the wires). */
export interface Group { id: string; title: string; template?: { id: string; revision: number } | null; members: string[]; expose: { node: string; port: string; direction?: 'input' | 'output' }[]; collapsed: boolean; loop?: string | null; prefab?: Prefab | null; columns?: string[][] | null; x: number; y: number; w: number; h: number }
/** core/prefab.js: the slots a template declares and its wires outside them, on the instance's group. */
export interface Prefab {
  slots: { id: string; title: string; node: string; port: string; create: { kind: string; title?: string; config?: Record<string, unknown>; ports: Record<string, string> }[] }[];
  expect: WireSpec[];
}
/** core/prefab.js prefabState: each slot read against the wires, and the expected wires that are missing. */
export interface PrefabState {
  slots: (Prefab['slots'][number] & { dir: 'in' | 'out' | null; wire: WireKind | null; required: boolean; many: boolean; open: boolean; filled: string[] })[];
  missing: (WireSpec & { index: number })[];
}
/** `loop`: a value input a cycle may close through (next-step semantics: a loop's `action`, a network's `weights`). */
export interface PortDecl { id: string; wire: WireKind; type?: unknown; constraint?: unknown; signature?: unknown; required?: boolean; many?: boolean; handle?: string; doc?: string | null; loop?: boolean }

/** frontend/core/resolve.js Resolution. */
export interface Resolution {
  problems: Problem[];
  portsOf(id: string): { inputs: PortDecl[]; outputs: PortDecl[] };
  typeOf(id: string, port: string): unknown;
  inTypeOf(id: string, port: string): unknown;
  refsOf(id: string): Record<string, unknown>;
  problemsOf(id: string): Problem[];
  /** wire id → the typed call behind a call wire whose call checked (resolve.js callOne info) */
  calls: Map<string, unknown>;
  callSite(id: string, port: string): unknown;
  callSites(id: string, port: string): unknown[];
}

/** frontend/core/store.js Workspace. */
export interface Workspace {
  graph: ModuleGraph;
  templates: Map<string, unknown>;
  runs: Map<string, unknown>;
  artifacts: Map<string, unknown>;
  datasets: Map<string, unknown>;
  settings: Record<string, unknown>;
  artifact(id: string): unknown | null;
  template(id: string, revision?: number | null): unknown | null;
  addTemplate(template: unknown): unknown; removeTemplate(id: string, revision: number): void;
  addRun(run: unknown): unknown; updateRun(id: string, patch: unknown): unknown; removeRun(id: string): void;
  addArtifact(artifact: unknown): Promise<unknown>; removeArtifact(id: string): void;
  addDataset(meta: unknown): unknown; removeDataset(id: string): void;
  updateSettings(patch: Record<string, unknown>): Record<string, unknown>;
  subscribe(fn: (what: string) => void): () => void;
}

/** Common session shape (frontend/core/sessions/*): cached snapshot + subscribe, plus kind-specific mutators. Snapshots
 *  are plain data. Bodies narrow them locally. */
interface Session<S = Record<string, unknown>> { snapshot(): S; subscribe(fn: (snap: S) => void): () => void; dispose(): void }
export type Snap = Record<string, unknown>;
interface TrainerSession extends Session<Snap> { start(): Promise<string>; cancel(runId?: string): void; recover(): void; remove(runId: string): void }
interface CandidatesSession extends Session<Snap> { accept(id: string): void; clearAccepted(): void; preview(id: string | null): void; importArtifact(json: unknown): Promise<unknown>; exportArtifact(id: string): string; remove(id: string): void }
interface NetworkSession extends Session<Snap> { select(id: string | null): Promise<unknown>; adopt(id: string): Promise<unknown>; importArtifact(json: unknown): Promise<unknown> }
interface EvaluatorSession extends Session<Snap> { run(role?: string): Promise<unknown>; clear(): void }
interface ExecutionSession extends Session<Snap> { setEpisode(ep: unknown): void; reset(): void; step(action?: number | null): void; run(interval?: number): void; pause(): void; setInterval(ms: number): void }
interface DeploymentSession extends Session<Snap> { bind(artifactId: string | null): void; setChainId(id: unknown): void; setLabel(label: string): void; setEpisode(ep: unknown): void; setInputBits(bits: number[]): void; connect(): Promise<unknown>; plan(): Promise<unknown>; deploy(): Promise<unknown>; verify(): Promise<unknown>; readState(): Promise<unknown>; preview(): Promise<unknown>; reset(): Promise<unknown>; step(action?: number): Promise<unknown>; infer(): Promise<unknown>; refresh(): Promise<unknown> }
interface DatasetSession extends Session<Snap> { import(text: string, opts?: { format?: 'auto' | 'csv' | 'json'; name?: string | null }): Promise<unknown>; preview(n?: number): unknown }
interface SessionMap { trainer: TrainerSession; candidates: CandidatesSession; network: NetworkSession; evaluator: EvaluatorSession; execution: ExecutionSession; deployment: DeploymentSession; dataset: DatasetSession }
export type SessionKind = keyof SessionMap;
export type SessionOf<K extends SessionKind> = SessionMap[K];

/** Python Workspace client (frontend/core/sessions/workspace-client.js). */
export interface WorkspaceClient { connect(): Promise<unknown>; submit(run: unknown): Promise<unknown>; list(): Promise<unknown[]>; get(id: string): Promise<unknown>; cancel(id: string): Promise<unknown>; postArtifact(a: unknown): Promise<unknown>; follow(id: string, onUpdate: (snap: unknown) => void, opts?: unknown): { promise: Promise<unknown>; stop(): void } }

export interface Workbench {
  workspace: Workspace;
  graph: ModuleGraph;
  /** Bumps on every graph/workspace change. Watch it to recompute derived state. */
  version: Ref<number>;
  resolution(): Resolution;
  /** Created lazily per (kind, node), and disposed when the node is removed. Throws if the node is not of that kind. */
  session<K extends SessionKind>(kind: K, nodeId: string): SessionOf<K>;
  /** History-recorded mutation. Bodies wrap every graph mutation (config, title) in this. */
  edit(label: string, fn: () => void): void;
  status(message: string, tone?: 'ok' | 'warn' | 'bad'): void;
  python: { client: WorkspaceClient | null; connected: Ref<boolean> };
  /** the latest request to show an export's code (EditorRuntime.revealCode). A code body owning `node` answers it. */
  reveal: ShallowRef<{ node: string; name: string; seq: number } | null>;
  /** 「运行到这里」 (ADR 0023, core/sessions/run-chain.js): the module that the chain runs for and its step now (null
   *  when no chain runs). `run` starts a chain. It reports through `status` and never throws. */
  chain: { target: ShallowRef<string | null>; step: ShallowRef<string | null>; run(nodeId: string): void };
  /** the latest request of the chain to play a script module. The script body of `node` answers it. */
  play: ShallowRef<{ node: string; seq: number } | null>;
}

export const WORKBENCH: InjectionKey<Workbench> = Symbol('neurom.workbench');

/** Bodies call this in setup(). It throws outside the editor. */
export function useWorkbench(): Workbench {
  const wb = inject(WORKBENCH, null);
  if (!wb) throw new Error('WORKBENCH not provided');
  return wb;
}
