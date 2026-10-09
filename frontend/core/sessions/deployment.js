// core/sessions/deployment.js — the runtime behind one deployment node. It holds:
//   - the Factory module contract for one explicit `neurom-module` artifact on the selected network
//   - the (account, session-label) chain session that deploy / verify opens
//   - a local mirror that must agree with the chain step by step
// The mirror runs an episode of the artifact's own environment (core/runner.js over artifact.bundle.env). The
// artifact's readout drives the episode when the artifact's loop is only that dense network and its readout (input →
// network → readout → action). Otherwise explicit input bits drive it. DOM-free: a Vue panel renders snapshot() and
// calls the operations.
// Each decision the chain makes here (infer, preview, step) gets one check against the local integer executor on the
// same input. The check compares scores, counts and voltages item by item. Read-only calls report a disagreement. A step
// transaction that disagrees kills the session (STATE_MISMATCH), and the local episode does not advance.
// Deploying creates the module with the artifact's weight chunks that are not on chain yet. It uses one transaction
// unless the chunks do not fit (ADR 0014). A network with tool layers deploys its network tools first. Each tool is its
// own module, reused when the Factory already holds one that verifies against the tool's artifact. Then the network
// deploys the selector with the tool addresses. The tool artifacts come from the workspace. Verification covers the
// selector and every tool. It recomputes the descriptor, engine, shape and chunk addresses from the artifact. The engine
// is a version the Factory lists for its engine id, and the session keeps which one. The local mirror calls the tools
// too.
// The deployment plan comes from chain.planDeployment (read-only). The session asks for it on plan(), after connect,
// before deploying and after every mined transaction of a deployment. The plan counts the chunks needed and the chunks
// already on chain, and lists the transactions still to send. The run lists the transactions mined so far. Both belong
// to (artifact, network) and show only while those are current. A deployment that fails midway keeps its mined
// transactions. Deploying again sends only what the chain still lacks (the bridge checks everything first).
//
// Authority:
//   - Every node shares workspace.settings.chainId.
//   - The Factory is the official one of that network (CHAINS[chainId].factory, ADR 0016). A network without one
//     deploys, plans and verifies nothing and says so.
//   - node.config.deployments[chain] is the persisted deployment record.
//   - The artifact is the explicitly bound id (bind()) or the accepted artifact of the candidates node wired into
//     `artifact`.
// Every chain call goes through the `chain` adapter (frontend/module-chain.js by default). The adapter reports a
// persistent call as done only when receipt, commitment and read-back state agree.
//
// Invalidation: the chain session dies when the network, label, account or artifact changes. It also dies when a step
// disagrees with the local model (STATE_MISMATCH) and on dispose(). Every async operation captures the revision at its
// start and re-checks it after each await. One operation at a time per node.
import { createEnv } from '../runner.js';
import { artifactSpec } from '../store.js';
import { deploymentProblem, ownTools } from '../kinds/network.js';
import { readout as readoutOf } from '../readout.js';
import { createExecutor } from './executor.js';
import { trainedOf, trainedTools, toolCaller, INPUT } from '../loop.js';
import { selectEpisode, observable, SessionError, producerNode, shortId } from './common.js';
import { tablesFor } from './pinned.js';
import * as moduleChain from '../../module-chain.js';
import { CHAINS, explorerTx, explorerAddress, DEFAULT_CHAIN_ID } from '../../chain.js';
import { t, onLocaleChange } from '../../i18n.js';

const DEFAULT_SESSION_LABEL = 'session-1';
const sameArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Number(v) === Number(b[i]));
const short = v => `${String(v).slice(0, 8)}…${String(v).slice(-4)}`;
/** Key of a chain id inside node.config.deployments. */
const depKey = chainId => String(chainId);

/**
 * @param {object} o
 * @param {import('../store.js').Workspace} o.workspace
 * @param {string} o.nodeId
 * @param {(chainId:number) => Promise<{provider, signer, address, chainId}>} o.connectChain   the application's wallet
 * @param {object} [o.chain]     module-chain.js-shaped adapter { planDeployment, deployModule, verifyModule, inferModule, stepModule, resetModule, moduleState, sessionId }.
 *                               planDeployment / deployModule / verifyModule take `{ artifacts }` (id → artifact) for a selector's tools.
 *                               deployModule also takes `onProgress` (one event per transaction sent and mined), verifyModule the expected `factory`.
 *                               deployModule and verifyModule return the module's `engineVersion` ({ address, number, latest }), which the session keeps.
 * @param {object} [o.chains]    { CHAINS, explorerTx, explorerAddress } (frontend/chain.js). Each network names its official `factory` or null.
 * @param {object} [o.datasets]  dataset store for envs that read a table
 */
export function createDeploymentSession({ workspace, nodeId, connectChain, chain = moduleChain, chains = { CHAINS, explorerTx, explorerAddress }, datasets = null, onStatus = () => {} }) {
  if (typeof connectChain !== 'function') throw new SessionError(t('部署会话需要 connectChain'));
  const graph = workspace.graph;
  const view = observable(build);
  const offLocale = onLocaleChange(() => view.notify('refresh'));
  const offWorkspace = workspace.subscribe(() => { if (!disposed) { sync(); view.notify('workspace'); } });

  // ------------------------------------------------------------------ state
  let session = null, busy = false, revision = 0, disposed = false, override = null;
  let env = null, local = null, traj = [], preview = null, inputBits = null, label = DEFAULT_SESSION_LABEL, selection = null, lastInfer = null;
  let status = { tone: 'info', text: '', tx: null };
  /** The latest deployment plan / run, each tagged with the (artifactId, chainId) it describes. */
  let plan = null, run = null, planSeq = 0;

  const node = () => (graph.hasNode(nodeId) && graph.node(nodeId).kind === 'deployment' ? graph.node(nodeId) : null);
  const boundId = () => override ?? producerNode(graph, nodeId, 'artifact', 'candidates')?.config.accepted ?? null;
  const artifactOf = () => { const id = boundId(); return id ? workspace.artifact(id) : null; };
  /** The selected network and its official Factory (null where none is deployed yet). */
  const settings = () => { const chainId = Number(workspace.settings.chainId ?? DEFAULT_CHAIN_ID); return { chainId, factory: chains.CHAINS[chainId]?.factory ?? null }; };
  /** Why nothing can be deployed or verified on network `s`, else null. */
  const noFactory = s => (s.factory ? null : t('{name} 还没有官方 Factory：这个网络上暂时不能部署和核对。', { name: chains.CHAINS[s.chainId]?.name ?? s.chainId }));
  const record = (n, chainId) => n?.config.deployments[depKey(chainId)] ?? null;
  const tx = (chainId, hash, gasUsed = null) => ({ hash, url: chains.explorerTx(chainId, hash), short: short(hash), gasUsed: gasUsed === null ? null : String(gasUsed) });
  function say(tone, text, txRef = null) { status = { tone, text, tx: txRef }; try { onStatus(text); } catch { /* optional */ } }
  const progress = text => { say('busy', text); view.notify('status'); };
  const current = (x, a, s) => !!x && !!a && x.artifactId === a.id && x.chainId === s.chainId;
  /** A planned or mined transaction in words: what it creates, prefixed by the tool it deploys. */
  function txLabel(x, topId) {
    const what = x.kind === 'chunk' ? t('创建权重块（{bytes} 字节）', { bytes: x.bytes.toLocaleString() })
      : x.chunks.length ? t('模块合约 + {count} 个权重块（{bytes} 字节）', { count: x.chunks.length, bytes: x.bytes.toLocaleString() }) : t('模块合约');
    return x.artifactId === topId ? what : t('工具 {id}：{what}', { id: shortId(x.artifactId), what });
  }
  /** Ask the chain for the plan of `a` now. Only the latest request lands. */
  async function replan(w, a, chainId, factory) {
    const seq = ++planSeq;
    const p = await chain.planDeployment(w.provider, factory, a, { artifacts, from: w.address });
    if (seq === planSeq && !disposed) { plan = { ...p, artifactId: a.id, chainId }; view.notify('plan'); }
    return p;
  }
  const planNote = p => t('权重块需要 {needed} 个，链上已有 {onChain} 个。要发送 {txs} 笔交易。', { needed: p.chunks.length, onChain: p.chunks.filter(c => c.onChain).length, txs: p.transactions.length });

  function clearLocal() { env = null; local = null; traj = []; preview = null; lastInfer = null; }
  function invalidate(reason) {
    revision++; const had = !!session; session = null; clearLocal();
    if (had) say('warn', t('{reason} 重新“部署”或“核对”后才能继续。', { reason }));
  }
  /** The session only survives while workspace still describes the same network and artifact. */
  function sync() {
    if (!session) return;
    const n = node(); if (!n) { invalidate(t('模块节点已不存在，会话作废。')); return; }
    const a = artifactOf(), s = settings();
    if (!a || a.id !== session.artifactId) invalidate(t('当前产物已变化，会话作废。'));
    else if (session.chainId !== s.chainId) invalidate(t('网络已切换，会话作废。'));
  }
  function requireSession() { sync(); if (!session) throw new SessionError(t('还没有链上会话。先点“部署当前产物”或“核对链上模块”。')); return session; }

  // ------------------------------------------------------------------ the local mirror
  const trained = a => trainedOf(a.bundle.loop);
  const net = a => trained(a).structure;
  const readoutSpecOf = a => trained(a).readout;
  const executor = a => { const tr = trained(a), n = a.bundle.loop.nodes[tr.id]; return createExecutor(a.model, net(a), { tools: n.tools ? toolCaller(tr.id, n) : null }); };
  const artifacts = id => workspace.artifact(id) ?? null;
  /** Why the artifact cannot be deployed: the chain limits (core/kinds/network.js deploymentProblem), then a missing tool
   *  artifact (a tool's own tools included). */
  const deployProblemOf = a => {
    const tools = trainedTools(a.bundle.loop), nets = list => list.filter(tool => tool.kind === 'net').flatMap(tool => [tool, ...nets(ownTools(tool))]);
    return deploymentProblem(artifactSpec(a), tools)
      ?? nets(tools).filter(tool => !artifacts(tool.artifactId)).map(tool => t('工具产物 {id} 不在工作区：部署和核对工具层都需要它', { id: tool.artifactId ? shortId(tool.artifactId) : '?' }))[0] ?? null;
  };
  /** The artifact's loop is its network alone: the env's input bits in, its readout's action out. */
  const episodic = a => {
    const tr = trained(a), loop = a.bundle.loop;
    return tr.structure.engine === 'dense-policy' && loop.nodes[tr.id].in.node === INPUT && loop.action.node === tr.readoutId && loop.action.port === 'action';
  };
  const episodeOf = a => selectEpisode(a.bundle, selection);
  async function freshEnv(a) {
    const e = createEnv(a.bundle.env, { tables: await tablesFor(a.bundle, datasets) });
    e.reset(episodeOf(a));
    return e;
  }
  const bitsFor = a => { const I = net(a).inputs; if (!inputBits) return new Array(I).fill(0); if (inputBits.length !== I) throw new SessionError(t('输入需要 {width} 位', { width: I })); return inputBits; };
  const actionName = (a, action) => a.bundle.env?.actions?.[action] ?? null;
  /** The decision items a module reports and the local mirror must reproduce. */
  const DECISION = ['scores', 'counts', 'voltages'];
  /**
   * One decision on chain and on the local mirror. `call()` asks the chain, then `mirror()` runs the local executor on
   * the same input: fresh, peeked or stepped, by the operation's own persistence rule. `mirror()` runs only after the
   * chain answers, so a failed call never moves the mirror. → `{ chain, local, same }`, same = every DECISION item agrees.
   */
  async function decide(cur, call, mirror) {
    const onChain = await call(); cur();
    const loc = mirror();
    return { chain: onChain, local: loc, same: DECISION.every(k => sameArr(loc[k], onChain[k])) };
  }
  const stateMismatch = text => Object.assign(new SessionError(text), { code: 'STATE_MISMATCH' });
  /** `decide`'s result `d` on explicit input bits (stateless modules) as the panel shows it: chain and local scores,
   *  each read out. */
  const bitsDecision = (a, source, bits, d, txRef) => {
    const read = scores => { const r = readoutOf(readoutSpecOf(a), scores); return { scores, action: r.action, bits: r.bits }; };
    return { source, bits, chain: read(d.chain.scores), local: read(d.local.scores), same: d.same, tx: txRef };
  };

  // ------------------------------------------------------------------ snapshot
  function build() {
    sync();
    const n = node(), s = settings();
    const chainList = Object.entries(chains.CHAINS).map(([id, c]) => ({ id: Number(id), name: c.name, local: !!c.local }));
    const common = { nodeId, chains: chainList, chainId: s.chainId, chainName: chains.CHAINS[s.chainId]?.name ?? String(s.chainId), factory: s.factory, factoryUrl: s.factory ? chains.explorerAddress(s.chainId, s.factory) : null, factoryProblem: noFactory(s), label, busy, status };
    if (!n || disposed) return { ...common, dead: disposed ? t('部署会话已释放') : t('部署模块已不存在'), artifact: null, artifactProblem: null, deployProblem: null, deployment: null, deployPlan: null, deployRun: null, session: null, can: {}, reasons: {}, episode: null, history: [], preview: null, last: null, infer: null, inputBits: null };
    const a = artifactOf(), dep = record(n, s.chainId);
    let deployProblem = null;
    if (a) { try { deployProblem = deployProblemOf(a); } catch (e) { deployProblem = e.message; } }
    const artifactProblem = a ? null : boundId() ? t('产物 {id} 不存在', { id: shortId(boundId()) }) : t('没有产物：先在候选模块接受一份权重，或显式绑定。');
    const seat = session ? null : t('还没有链上会话。先点“部署当前产物”或“核对链上模块”。');
    const busyWhy = busy ? t('上一笔操作（{what}）还在进行。', { what: t(busy) }) : null;
    const epi = a ? episodic(a) : false;
    const reasons = {
      connect: busyWhy,
      deploy: busyWhy ?? common.factoryProblem ?? artifactProblem ?? deployProblem,
      plan: busyWhy ?? common.factoryProblem ?? artifactProblem ?? deployProblem,
      verify: busyWhy ?? common.factoryProblem ?? (dep ? null : t('这个网络上还没有部署记录')) ?? artifactProblem,
      state: busyWhy ?? seat,
      preview: busyWhy ?? seat ?? (epi ? null : t('无状态模块用“链上推理”')),
      reset: busyWhy ?? seat ?? (epi ? null : t('无状态模块没有回合')),
      step: busyWhy ?? seat ?? (!epi ? null : !env ? t('先点“新一局”，发送 reset 交易开局') : env.done ? t('这个回合已结束。点“新一局”') : null),
      infer: busyWhy ?? seat ?? (epi ? t('回合式模块用“只读预览”') : null),
    };
    const can = Object.fromEntries(Object.entries(reasons).map(([k, why]) => [k, why === null]));
    const n_ = a ? net(a) : null;
    const p = current(plan, a, s) ? plan : null, ran = current(run, a, s) ? run : null;
    const deployPlan = p && {
      needed: p.chunks.length, onChain: p.chunks.filter(c => c.onChain).length, bytes: p.chunks.reduce((sum, c) => sum + c.bytes, 0),
      tools: p.tools.map(x => ({ artifactId: x.artifactId, short: shortId(x.artifactId), address: x.address })),
      transactions: p.transactions.map(x => ({ kind: x.kind, tool: x.tool, label: txLabel(x, a.id), gas: x.gas })),
    };
    const deployRun = ran && { done: ran.done.map(x => ({ kind: x.kind, label: txLabel(x, a.id), tx: tx(s.chainId, x.txHash, x.gasUsed) })), sending: ran.sending, failed: ran.failed, finished: ran.finished };
    return {
      ...common, dead: null,
      artifact: a ? { id: a.id, short: shortId(a.id), engine: n_.engine, kind: n_.kind, inputs: n_.inputs, outputs: n_.outputs, layers: n_.layers, weightBits: n_.weightBits, ...(n_.engine === 'dense-policy' ? { ticks: n_.ticks, leak_shift: n_.leak_shift } : {}), episodic: epi,
        tools: trainedTools(a.bundle.loop).map(tool => ({ kind: tool.kind, artifactId: tool.artifactId ?? null, short: tool.artifactId ? shortId(tool.artifactId) : null })) } : null,
      bound: override !== null, artifactProblem, deployProblem,
      deployment: dep ? { ...dep, tx: dep.txHash ? tx(s.chainId, dep.txHash) : null, stale: !!a && dep.artifactId !== a.id } : null, deployPlan, deployRun,
      session: session ? { ...session } : null, sessionId: session?.sessionHex ?? null, can, reasons,
      episode: env ? { record: env.start, state: env.state, t: env.t, done: env.done, budget: env.budget, steps: traj.length, gasUsed: traj.reduce((x, r) => x + Number(r.tx.gasUsed ?? 0), 0), success: env.done ? traj[traj.length - 1]?.success ?? false : null } : null,
      selection, actions: a?.bundle.env?.actions ?? null, preview, last: traj.length ? traj[traj.length - 1] : null, history: traj.slice(), infer: lastInfer, inputBits,
    };
  }

  // ------------------------------------------------------------------ guarded operations
  async function guarded(what, fn) {
    if (disposed) throw new SessionError(t('部署会话已释放'));
    if (busy) { say('warn', t('上一笔操作（{what}）还在进行。', { what: t(busy) })); view.notify('status'); return view.snapshot(); }
    const rev = revision, owner = node(), s = settings(), artifactId = boundId();
    busy = what; view.notify('status');
    const cur = () => {
      sync();
      const now = settings();
      if (disposed || rev !== revision || !owner || node() !== owner || s.chainId !== now.chainId || artifactId !== boundId()) throw new SessionError(t('操作期间会话已作废。交易可能已经提交，请重新核对。'));
    };
    try { await fn(cur); }
    catch (e) {
      if (disposed) return view.snapshot();
      if (e.code === 'STATE_MISMATCH') invalidate(t('链上结果与本地整数模型不一致。'));
      say('warn', t('{what}失败：{error}', { what: t(what), error: e.shortMessage || e.message }));
    } finally { busy = false; if (!disposed) view.notify('session'); }
    return view.snapshot();
  }
  async function wallet(chainId, cur) {
    const w = await connectChain(chainId); cur();
    if (session && w.address.toLowerCase() !== session.account.toLowerCase()) { invalidate(t('账户已改变。会话已作废。')); throw new SessionError(t('请重新核对链上模块')); }
    return w;
  }
  const context = () => { const n = node(); if (!n) throw new SessionError(t('部署模块已不存在')); const a = artifactOf(); if (!a) throw new SessionError(t('没有产物')); return { n, a, ...settings() }; };
  const open = (chainId, address, artifactId, account, tools = [], engineVersion = null) => { session = { chainId, address, artifactId, account, tools, engineVersion, sessionHex: chain.sessionId(label) }; clearLocal(); };
  const toolNote = tools => (tools.length ? ' ' + t('工具模块：{tools}。', { tools: tools.map(x => shortId(x.address) + (x.reused === true ? t('（复用）') : x.reused === false ? t('（新部署）') : '')).join(' · ') }) : '');
  const sessionHex = () => session?.sessionHex ?? null;

  /** Why `a` cannot be planned or deployed on network `s`, else null. */
  const undeployable = (a, s) => noFactory(s) ?? deployProblemOf(a);
  const connect = () => guarded('连接', async cur => {
    const { a, chainId, factory } = context(); const w = await wallet(chainId, cur);
    let note = '';
    if (!undeployable(a, { chainId, factory })) {
      try { note = ' ' + planNote(await replan(w, a, chainId, factory)); } catch (e) { note = ' ' + t('部署计划查询失败：{error}', { error: e.shortMessage || e.message }); }
      cur();
    }
    say('ok', t('已连接 {address} · {chain}。', { address: w.address, chain: chains.CHAINS[chainId]?.name ?? chainId }) + note);
  });
  /** Read-only: what deploying the current artifact would send now. */
  const planDeploy = () => guarded('部署计划', async cur => {
    const { a, chainId, factory } = context();
    const problem = undeployable(a, { chainId, factory }); if (problem) throw new SessionError(problem);
    const w = await wallet(chainId, cur);
    const p = await replan(w, a, chainId, factory); cur();
    if (run?.finished) run = null;   // a finished run's rows give way to what deploying again would send
    say('info', t('部署计划（只读，不发交易）：') + planNote(p));
  });
  const deploy = () => guarded('部署', async cur => {
    const { n, a, chainId, factory } = context();
    const problem = undeployable(a, { chainId, factory }); if (problem) throw new SessionError(problem);
    const w = await wallet(chainId, cur); progress(t('正在查询链上已有的权重块与工具模块…'));
    const p = await replan(w, a, chainId, factory); cur();
    const mine = run = { artifactId: a.id, chainId, total: p.transactions.length, done: [], sending: false, failed: null, finished: false };
    const onProgress = e => {
      if (disposed || run !== mine) return;
      if (e.stage === 'sending') {
        mine.sending = true;
        progress(t('第 {k} / {n} 笔交易：{what}… 等待签名与确认。', { k: mine.done.length + 1, n: Math.max(mine.total, mine.done.length + 1), what: txLabel(e, a.id) }));
        return;
      }
      mine.sending = false; mine.done.push(e);
      if (current(plan, a, { chainId })) {   // cross it off now. The chain's own answer (replan) follows
        const k = plan.transactions.findIndex(x => x.artifactId === e.artifactId && x.kind === e.kind);
        plan = { ...plan, chunks: plan.chunks.map(c => (e.chunks.includes(c.address) ? { ...c, onChain: true } : c)), transactions: plan.transactions.filter((_, j) => j !== k) };
      }
      view.notify('progress');
      replan(w, a, chainId, factory).catch(() => { /* the mined transaction is already crossed off. The next plan refines the rest */ });
    };
    let r;
    try { r = await chain.deployModule(w.signer, factory, a, { artifacts, onProgress }); }
    catch (e) {
      if (disposed || run !== mine) throw e;
      mine.sending = false; mine.failed = e.shortMessage || e.message;
      let left = '?';
      try { left = (await replan(w, a, chainId, factory)).transactions.length; } catch { /* unknown until the next plan */ }
      if (!mine.done.length) throw e;
      throw new SessionError(t('已上链 {done} 笔交易，它们不会重发。再点“部署当前产物”，只发送还缺的 {left} 笔。原因：{error}', { done: mine.done.length, left, error: mine.failed }));
    }
    cur();
    mine.finished = true;
    graph.patchConfig(n.id, { deployments: { ...n.config.deployments, [depKey(chainId)]: { address: r.address, artifactId: a.id, txHash: r.txHash } } });
    const tools = (r.tools ?? []).map(x => ({ artifactId: x.artifactId, address: x.address, reused: x.reused }));
    open(chainId, r.address, a.id, w.address, tools, r.engineVersion ?? null);
    const chunks = r.chunks ?? [];
    say('ok', t('已部署：模块 {address}，{txs} 笔交易共用 gas {gas}。权重块 {count} 个，其中新建 {created} 个。链上描述符、引擎与权重块 = 当前产物。', {
      address: r.address, txs: r.transactions?.length ?? 1, gas: Number(r.gasUsed).toLocaleString(), count: chunks.length, created: chunks.filter(c => c.created).length,
    }) + toolNote(tools), tx(chainId, r.txHash, r.gasUsed));
    try { await replan(w, a, chainId, factory); } catch { /* the deployment stands. The counts refresh on the next plan */ }
  });
  const verify = () => guarded('核对', async cur => {
    const { n, a, chainId, factory } = context();
    const noOfficial = noFactory({ chainId, factory }); if (noOfficial) throw new SessionError(noOfficial);
    const dep = record(n, chainId); if (!dep) throw new SessionError(t('本网络没有部署记录'));
    const w = await wallet(chainId, cur);
    const h = await chain.verifyModule(w.provider, dep.address, a, { artifacts, factory }); cur();
    const tools = (h?.toolModules ?? []).map(x => ({ artifactId: x.artifactId, address: x.address }));
    open(chainId, dep.address, a.id, w.address, tools, h?.engineVersion ?? null);
    say('ok', t('核对通过：{address} 上的模块 = 当前产物 {artifact}…。调用者 {account}。', { address: dep.address, artifact: a.id.slice(0, 12), account: w.address }) + toolNote(tools));
  });
  const readState = () => guarded('读取状态', async cur => {
    const sess = requireSession(), w = await wallet(sess.chainId, cur);
    const v = await chain.moduleState(w.provider, sess.address, sess.account, sessionHex()); cur();
    say('info', t('链上为（{account}，会话 {label}）保存的膜电位：{voltages}', { account: sess.account, label, voltages: v.length ? v.join(' ') : t('无（FF / 阈值层模块无状态）') }));
  });
  /** Free eth_call on explicit input bits (stateless modules), compared with the local integer model. */
  const infer = () => guarded('链上推理', async cur => {
    const sess = requireSession(), { a } = context();
    if (episodic(a)) throw new SessionError(t('回合式模块用“只读预览”'));
    const bits = bitsFor(a), w = await wallet(sess.chainId, cur);
    const d = await decide(cur, () => chain.inferModule(w.provider, sess.address, bits, { mode: 'forward', session: sessionHex(), from: sess.account }), () => executor(a).step(bits));
    lastInfer = bitsDecision(a, 'infer', bits, d, null);
    say(d.same ? 'ok' : 'warn', t('链上分数 {scores} → {got}，本地 {local}。{verdict}', { scores: d.chain.scores.join(' '), got: lastInfer.chain.action, local: lastInfer.local.action, verdict: d.same ? t('链上 = 本地。') : t('不一致！') }));
  });
  /** Free eth_call of the next decision (the stored state in a LIF episode, rest otherwise), compared with the local mirror peeked on the same input. */
  const preview_ = () => guarded('只读预览', async cur => {
    const sess = requireSession(), { a } = context();
    if (!episodic(a)) throw new SessionError(t('无状态模块用“链上推理”'));
    const w = await wallet(sess.chainId, cur);
    const inGame = !!(env && !env.done), e = inGame ? env : await freshEnv(a), input = e.input(), mode = inGame && local.stateful ? 'peek' : 'forward';
    const { chain: r, same } = await decide(cur, () => chain.inferModule(w.provider, sess.address, input, { mode, session: sessionHex(), from: sess.account }), () => (inGame ? local : executor(a)).peek(input));
    const read = readoutOf(readoutSpecOf(a), r.scores);
    preview = { ...r, same, source: 'preview', mode, input, action: read.action, actionName: actionName(a, read.action), tx: null, state: e.state };
    if (!same) { say('warn', t('只读预览（eth_call {mode}）：链上决策与本地整数模型不一致。', { mode })); return; }
    say('info', t('只读预览（eth_call {mode}）：策略选择 {action}（{name}）。预览不发交易，不推进回合，也不改链上状态。要走这一步，点“走一步”发交易。', { mode, action: read.action, name: actionName(a, read.action) ?? read.action }));
  });
  const reset = () => guarded('新一局', async cur => {
    const sess = requireSession(), { a } = context();
    if (!episodic(a)) throw new SessionError(t('无状态模块没有回合'));
    const w = await wallet(sess.chainId, cur); progress(t('正在发送 reset 交易（清空链上为你保存的状态）…'));
    const r = await chain.resetModule(w.signer, sess.address, sessionHex()); cur();
    env = await freshEnv(a); local = executor(a); traj = []; preview = null;
    say('ok', t('新一局已开始：reset gas {gas}。每点一次“走一步”发一笔 step 交易。', { gas: Number(r.gasUsed).toLocaleString() }), tx(sess.chainId, r.txHash, r.gasUsed));
  });
  const step = () => guarded('走一步', async cur => {
    const sess = requireSession(), { a } = context();
    if (!episodic(a)) {
      const bits = bitsFor(a), w = await wallet(sess.chainId, cur); progress(t('发送 step 交易… 等待确认。'));
      const d = await decide(cur, () => chain.stepModule(w.signer, sess.address, bits, sessionHex()), () => executor(a).step(bits));
      if (!d.same) throw stateMismatch(t('链上结果与本地整数模型不一致。'));
      const ref = tx(sess.chainId, d.chain.txHash, d.chain.gasUsed);
      lastInfer = bitsDecision(a, 'step', bits, d, ref);
      say('ok', t('step 交易：分数 {scores} → {got}，gas {gas}。', { scores: d.chain.scores.join(' '), got: lastInfer.chain.action, gas: Number(d.chain.gasUsed).toLocaleString() }), ref);
      return;
    }
    if (!env) throw new SessionError(t('先点“新一局”，发送 reset 交易开局')); if (env.done) throw new SessionError(t('这个回合已结束。点“新一局”'));
    const w = await wallet(sess.chainId, cur); const input = env.input(); progress(t('发送 step 交易… 等待确认。'));
    const { chain: r, same } = await decide(cur, () => chain.stepModule(w.signer, sess.address, input, sessionHex()), () => local.step(input));
    if (!same) throw stateMismatch(t('链上决策与本地整数状态不一致。本地环境没有推进。'));
    const read = readoutOf(readoutSpecOf(a), r.scores);
    const tr = env.step(read.action); preview = null;
    traj.push({ t: traj.length, input, action: read.action, actionName: actionName(a, read.action), scores: r.scores, counts: r.counts, voltages: r.voltages, done: tr.done, truncated: tr.truncated, success: tr.success, next: tr.next, tx: tx(sess.chainId, r.txHash, r.gasUsed) });
    const tail = env.done ? ' ' + (tr.success ? t('本局结束：成功。') : t('本局结束：未达目标。')) : '';
    say('ok', t('第 {step} 步：策略选择 {action}（{name}），gas {gas}。链上分数 / 放电 / 膜电位与本地逐项一致。动作映射与环境推进在本地执行。{tail}', { step: traj.length, action: read.action, name: actionName(a, read.action) ?? read.action, gas: Number(r.gasUsed).toLocaleString(), tail }), traj[traj.length - 1].tx);
  });

  // ------------------------------------------------------------------ settings & inputs
  function requireAlive() { if (disposed || !node()) throw new SessionError(t('部署会话已释放或部署模块已不存在')); }
  function setChainId(chainId) {
    requireAlive();
    const id = Number(chainId); if (!chains.CHAINS[id]) throw new SessionError(t('不支持的链 id：{chainId}', { chainId }));
    if (settings().chainId !== id) { workspace.updateSettings({ chainId: id }); invalidate(t('网络已切换，会话作废。')); }
    view.notify('settings'); return view.snapshot();
  }
  function setLabel(next) {
    requireAlive();
    const v = String(next ?? '').trim() || DEFAULT_SESSION_LABEL;
    if (v !== label) { label = v; invalidate(t('会话标签已改。链上状态按会话分开，所以这个会话作废。')); }
    view.notify('label'); return view.snapshot();
  }
  function bind(artifactId) {
    requireAlive();
    if (artifactId !== null && !workspace.artifact(artifactId)) throw new SessionError(t('产物 {id} 不存在', { id: shortId(artifactId) }));
    override = artifactId; sync(); if (session && session.artifactId !== boundId()) invalidate(t('当前产物已变化，会话作废。'));
    view.notify('bind'); return view.snapshot();
  }
  function setEpisode(sel) {
    requireAlive(); revision++; selection = sel ?? null;
    if (env || preview) { env = null; local = null; traj = []; preview = null; say('info', t('回合已改变。点“新一局”发送 reset 交易，然后继续。')); }
    view.notify('inputs'); return view.snapshot();
  }
  function setInputBits(bits) {
    requireAlive(); revision++;
    if (bits !== null && (!Array.isArray(bits) || bits.some(b => b !== 0 && b !== 1))) throw new SessionError(t('输入位必须是 0/1 数组'));
    inputBits = bits; lastInfer = null; view.notify('inputs'); return view.snapshot();
  }

  function refresh() { if (!disposed) { sync(); view.notify('refresh'); } return view.snapshot(); }
  function dispose() { if (disposed) return; disposed = true; revision++; session = null; clearLocal(); busy = false; offLocale(); offWorkspace(); view.notify('dispose'); view.clear(); }
  return { snapshot: view.snapshot, subscribe: view.subscribe, refresh, bind, setChainId, setLabel, setEpisode, setInputBits, connect, plan: planDeploy, deploy, verify, readState, preview: preview_, reset, step, infer, dispose };
}
