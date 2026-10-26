// module-chain.js — ModuleFactory / module contract bridge (ethers v6), ADR 0014, ADR 0017.
// One neurom-module artifact → one module contract. The Factory creates it together with its weight chunks. Each
// chunk goes to CREATE2 at its content hash, and the Factory does not create a chunk again when it is already on
// chain. All of this goes in one transaction, unless it does not fit. The module records:
//   - its engine version, for life (the latest of its engine id, unless the deployer names an older one)
//   - its shape, its chunk addresses and its tool addresses.
// The module keeps its state keyed by (actor, session).
// A dense network with tool layers (ADR 0010 §11, ADR 0014) is a selector module that holds the addresses of its tools.
// Each network tool (FF, LIF or with tool layers of its own) is its own module, deployed first. If a module of the
// same artifact is already deployed, the deployment reuses it after verification. The state of a tool is in the
// session of the selector, after the state of the selector (the stateWidth of the module covers both). A code tool
// cannot be deployed.
// A deployment first looks up everything on chain. So when a deployment stops midway, deploying again resumes it.
// planDeployment forecasts a deployment read-only (chunks necessary / on chain, transactions to send).
// Persistent calls (step / reset) are reported as done only when all of these are true:
//   - the receipt is in
//   - the on-chain result commitment equals the pre-executed result
//   - the persisted state, read back, matches.
import FactoryABI from './abi/ModuleFactory.json' with { type: 'json' };
import ModuleABI from './abi/NeuromModule.json' with { type: 'json' };
import { validateArtifact, artifactSpec } from './core/store.js';
import { modelProblem } from './core/sessions/executor.js';
import { envHash } from './core/bundle.js';
import { trainedOf, trainedTools } from './core/loop.js';
import { ENGINES, isToolLayer, deploymentProblem, moduleStateWidth, MAX_PORT, MAX_STATE, MAX_TICKS } from './core/kinds/network.js';
import { DENSE_KINDS as KINDS, encodeDenseWeights } from './runtime/dense-policy.js';
import { encodeThresholdWeights } from './runtime/threshold-layers.js';
import { AbiCoder, Contract, getCreate2Address, isAddress, keccak256, toUtf8Bytes } from 'ethers';
import { t } from './i18n.js';

const ZERO_ADDRESS = '0x' + '0'.repeat(40);
const INT32 = 2147483648;
/** ModuleFactory.MAX_CHUNK_BYTES: the most weight bytes one chunk holds. */
export const CHUNK_BYTES = 114_688;
/** ModuleFactory.CHUNK_INIT: every chunk's init code, so a chunk's address follows from the Factory and its content. */
const CHUNK_INIT = '0x63151ce8865f525f5f6004601c335afa6016575f5ffd5b3d5f5f3e3d5ff3';
/** Monad's per-transaction gas limit (every deployment target is Monad, ADR 0016). The block limit of a node can be lower. */
const MAX_TX_GAS = 30_000_000n;

/** Gas limit for a transaction: the estimate + 10%. The estimate can run on a state one step behind the state that the
 *  transaction executes on (the gas of a LIF step depends on its potentials). Monad charges the limit either way. */
const withMargin = estimate => estimate + estimate / 10n;

// ------------------------------------------------------------------------------------------------ pure helpers

function int(v, name, lo, hi) {
  if (typeof v !== 'bigint') v = BigInt(v);
  if (v < BigInt(lo) || v > BigInt(hi)) throw new Error(t('链上返回的 {name} 越界：{value}（允许 {lo}..{hi}）', { name, value: v, lo, hi }));
  return Number(v);
}

function describe(e) { return e.shortMessage || e.message || String(e); }

function sameInts(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }

function isBit(b) { return b === 0 || b === 1 || b === false || b === true; }

/** `bits`: 0/1 (or boolean) entries → one byte each, the `bytes` a module expects. */
function encodeBits(bits, expected, label) {
  if (!bits || typeof bits.length !== 'number') throw new Error(t('{label}必须是 0/1 数组', { label: t(label) }));
  if (bits.length !== expected) throw new Error(t('{label}必须是 {expected} 位，收到 {count}', { label: t(label), expected, count: bits.length }));
  let hex = '0x';
  for (let i = 0; i < bits.length; i++) {
    if (!isBit(bits[i])) throw new Error(t('{label}第 {index} 位不是 0/1：{value}', { label: t(label), index: i, value: bits[i] }));
    hex += bits[i] ? '01' : '00';
  }
  return hex;
}

/** Session identifier for a label (keccak256 of its UTF-8), or the label itself when it already is a bytes32 hex. */
export function sessionId(label) {
  if (typeof label === 'string' && /^0x[0-9a-fA-F]{64}$/.test(label)) return label.toLowerCase();
  if (typeof label !== 'string' || !label) throw new Error(t('会话标签必须是非空字符串或 bytes32'));
  return keccak256(toUtf8Bytes(label));
}

function requireSession(session) {
  if (typeof session !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(session)) throw new Error(t('会话必须是 bytes32（0x + 64 hex）：{session}', { session }));
  return session.toLowerCase();
}

/** keccak256 of an engine name — the bytes32 engineId a module reports. */
function nameId(name) { return keccak256(toUtf8Bytes(name)); }

function engineOf(id) { return ENGINES.find(n => nameId(n).toLowerCase() === String(id).toLowerCase()) ?? null; }

/** bytes32 task identity of an artifact: sha256 of its bundle's `env` (core/bundle.js envHash) — the same loop ⇒ the same taskId. */
export function taskIdOf(artifact) { return envHash(artifact.bundle); }

/** The shape words of the engine (contracts DensePolicyEngine / ThresholdLayersEngine) for a validated model: the layer
 *  layout, the parameters with the shift k of every region (ADR 0015), and (dense) the fire threshold of each plain layer.
 *  Dense: four words. Words 0 and 1 hold the 64-bit descriptor of layer l at bit 64·(l mod 4) of word ⌊l / 4⌋:
 *  [0, 16) hidden − 1 or K − 1, [16, 32) D − 1, [32, 48) R − 1, bit 48 = tool layer. Word 2 holds the parameters and
 *  shifts. Word 3 holds the thresholds. */
export function shapeOf(model) {
  if (model.format === 'dense-policy') {
    const { layers, ticks, leak_shift: leakShift, reset, weightBits } = model, lif = model.kind === 'lif';
    const layout = [0n, 0n];
    let params = BigInt(layers.length) | (BigInt(ticks) << 8n) | (BigInt(leakShift) << 16n) | (BigInt(weightBits) << 24n) | (BigInt(reset & 0xffff) << 32n), thresholds = 0n;
    layers.forEach((L, l) => {
      const word = l >> 2, at = BigInt(64 * (l & 3)), k = BigInt(48 + 10 * l), th = BigInt(32 * l);
      if (isToolLayer(L)) {
        layout[word] |= ((1n << 48n) | BigInt(L.K - 1) | (BigInt(L.D - 1) << 16n) | (BigInt(L.R - 1) << 32n)) << at;
        params |= (BigInt(L.k_c) << k) | (BigInt(L.k_d) << (k + 5n));
      } else {
        layout[word] |= BigInt(L.hidden - 1) << at;
        params |= BigInt(L.k) << k;
        thresholds |= BigInt(lif ? L.threshold : 1) << th;
      }
    });
    if (model.output) params |= BigInt(model.output.k) << 128n;
    return [...layout, params, thresholds];
  }
  const widths = [model.inputs, ...model.layers.map(L => L.W.length)];
  return [widths.reduce((w, width, l) => w | (BigInt(width) << BigInt(16 * l)), 0n),
    model.layers.reduce((w, L, l) => w | (BigInt(L.k) << BigInt(8 + 5 * l)), BigInt(model.weightBits))];
}

/**
 * Deployment parameters derived from a validated artifact: what the Factory gets and what verify() checks against.
 * `spec` = artifactSpec(artifact). The weights are encoded from `artifact.model`, whose widths must agree
 * (modelProblem against the structure of the trained network).
 * `shape` is the engine's encoding of the model (layout, parameters, per-layer k and thresholds). The `tools` of a dense
 * network are the artifact ids of its tools in layer then wire order (the same order as the selector's addresses).
 * `stateWidth` is the stateWidth of its descriptor (its LIF potentials, then the states of its tools).
 */
export function deploymentOf(artifact) {
  const spec = artifactSpec(artifact), model = artifact.model, tools = trainedTools(artifact.bundle.loop);
  const problem = deploymentProblem(spec, tools) || modelProblem(model, trainedOf(artifact.bundle.loop).structure); if (problem) throw new Error(problem);
  const d = spec.engine === 'dense-policy'
    ? { engine: spec.engine, kind: spec.kind, inputs: spec.inputs, outputs: spec.outputs, stateWidth: moduleStateWidth(spec, tools), weights: encodeDenseWeights(model), tools: tools.map(tool => tool.artifactId) }
    : { engine: spec.engine, kind: 'feedforward', inputs: spec.inputs, outputs: spec.outputs, stateWidth: 0, weights: encodeThresholdWeights(model), tools: [] };
  return { ...d, shape: shapeOf(model) };
}

/** A weight blob (hex) as its chunks, in order: `[{ data, id }]`, each at most CHUNK_BYTES, id = keccak256(data). */
export function weightChunks(weights) {
  const hex = weights.slice(2), size = 2 * CHUNK_BYTES, out = [];
  for (let at = 0; at < hex.length; at += size) { const data = '0x' + hex.slice(at, at + size); out.push({ data, id: keccak256(data) }); }
  return out;
}

/** The address of the chunk with content hash `id` that Factory `factory` creates (ModuleFactory.chunkAddress). */
export function chunkAddress(factory, id) {
  return getCreate2Address(factory, id, keccak256(CHUNK_INIT));
}

// ------------------------------------------------------------------------------------------------ contracts

function contractOf(providerOrSigner, address, abi, what) {
  if (!providerOrSigner) throw new Error(t('缺少 provider / signer'));
  if (!isAddress(address)) throw new Error(t('{what} 地址无效：{address}', { what: t(what), address }));
  return new Contract(address, abi, providerOrSigner);
}

function requireSigner(signer) {
  if (!signer || typeof signer.getAddress !== 'function' || typeof signer.sendTransaction !== 'function') throw new Error(t('需要 signer（可发交易的账户）'));
  return signer;
}

function providerOf(providerOrSigner) { return providerOrSigner.provider || providerOrSigner; }

async function mined(tx, what) {
  const rc = await tx.wait();
  if (!rc || rc.status !== 1) throw new Error(t('{what} 交易回滚：{hash}', { what, hash: rc ? rc.hash : tx.hash }));
  return rc;
}

function eventOf(rc, contract, address, name) {
  const target = address.toLowerCase();
  return rc.logs.filter(l => l.address.toLowerCase() === target)
    .map(l => { try { return contract.interface.parseLog(l); } catch { return null; } })
    .filter(x => x && x.name === name);
}

/** Decode a module decision into safe integers and check the module's own bounds. */
function decodeDecision(res, header) {
  const scores = Array.from(res[0]).map((s, a) => { const v = BigInt(s); if (v < -BigInt(Number.MAX_SAFE_INTEGER) || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(t('scores[{index}] 超出安全整数', { index: a })); return Number(v); });
  if (scores.length !== header.outputs) throw new Error(t('scores 长度 {got} ≠ {want}', { got: scores.length, want: header.outputs }));
  const action = int(res[1], 'action', 0, header.outputs - 1);
  let best = 0; for (let a = 1; a < scores.length; a++) if (scores[a] > scores[best]) best = a;
  if (best !== action) throw new Error(t('链上 action={action} 不是 scores 的首个最大值 {best}', { action, best }));
  const counts = Array.from(res[2]).map((c, j) => int(c, `counts[${j}]`, 0, MAX_TICKS));
  const voltages = decodeVoltages(res[3]);
  if (voltages.length !== header.stateWidth) throw new Error(t('voltages 长度 {got} ≠ 状态宽度 {want}', { got: voltages.length, want: header.stateWidth }));
  return { scores, action, counts, voltages };
}

function decodeVoltages(raw, width) {
  const v = Array.from(raw).map((x, j) => int(x, `voltages[${j}]`, -INT32, INT32 - 1));
  if (width !== undefined && v.length !== width) throw new Error(t('状态长度 {got} ≠ {want}', { got: v.length, want: width }));
  return v;
}

/** On-chain identity of a module: descriptor, shape, chunks and tools (throws when the address is not a module). */
async function readModule(providerOrSigner, address) {
  const c = contractOf(providerOrSigner, address, ModuleABI, '模块');
  let d;
  try { d = await c.descriptor(); }
  catch (e) { throw new Error(t('读取模块 {address} 失败（地址不是模块合约）：{error}', { address, error: describe(e) })); }
  const engine = engineOf(d.engineId);
  if (!engine) throw new Error(t('模块 {address} 使用未知引擎：{engineId}', { address, engineId: d.engineId }));
  const [shape, chunks, tools] = await Promise.all([c.shape(), c.chunks(), c.tools()]);
  return {
    address, engine, engineId: d.engineId, kind: KINDS[int(d.kind, 'kind', 0, 1)], artifactId: d.artifactId, taskId: d.taskId,
    inputs: int(d.inputs, 'inputs', 1, MAX_PORT), outputs: int(d.outputs, 'outputs', 1, MAX_PORT), stateWidth: int(d.stateWidth, 'stateWidth', 0, MAX_STATE),
    factory: d.factory, engineAddress: d.engine, shape: Array.from(shape, BigInt), chunks: Array.from(chunks), tools: Array.from(tools),
  };
}

/** The artifact of tool artifact id `id` through `artifacts(id) → artifact | null`. Throws when it is not available. */
function toolArtifact(artifacts, id) {
  const a = artifacts ? artifacts(id) : null;
  if (!a) throw new Error(t('工具产物 {id} 不在工作区：部署和核对工具层都需要它', { id: String(id).slice(0, 12) }));
  return a;
}

/**
 * A module is the artifact when all of these are true:
 *   - Factory `factory` (the official factory of the network, ADR 0016) created it. The module names it as its factory,
 *     and its `isModule` agrees. A module of any other factory is refused, even with identical code and weights.
 *   - Its descriptor (engine / kind / ports / artifactId / taskId) equals the artifact.
 *   - Its engine contract is a version that the Factory lists for its engine id.
 *   - Its shape is the shape of the artifact.
 *   - Its chunks are exactly the chunks of the artifact's weights (addresses recomputed from their content).
 * The tools of a selector are verified too, against the same Factory. Each address must be a module equal to the
 * artifact of its tool (`artifacts(id)`), in the layer and wire order of the artifact.
 * → the module header plus `engineVersion: { address, number (1 = the first version of the id), latest }` and
 * `toolModules: [{ artifactId, address }]`.
 */
export async function verifyModule(providerOrSigner, address, artifact, { artifacts = null, factory } = {}) {
  if (!factory || !isAddress(factory)) throw new Error(t('核对需要官方 Factory 的地址'));
  const valid = await validateArtifact(artifact);
  const want = deploymentOf(valid);
  const h = await readModule(providerOrSigner, address);
  const mismatch = (k, a, b) => { if (String(a).toLowerCase() !== String(b).toLowerCase()) throw new Error(t('模块 {address} 的 {field} 不符：链上 {chain}，产物 {artifact}', { address, field: k, chain: a, artifact: b })); };
  mismatch('factory', h.factory, factory);
  const f = contractOf(providerOrSigner, factory, FactoryABI, 'ModuleFactory');
  if (!(await f.isModule(address))) throw new Error(t('模块 {address} 不是 Factory {factory} 创建的', { address, factory }));
  mismatch('engine', h.engine, want.engine); mismatch('kind', h.kind, want.kind);
  mismatch('inputs', h.inputs, want.inputs); mismatch('outputs', h.outputs, want.outputs); mismatch('stateWidth', h.stateWidth, want.stateWidth);
  mismatch('artifactId', h.artifactId, valid.id); mismatch('taskId', h.taskId, await taskIdOf(valid));
  const [versions, latest] = await Promise.all([f.versionsOf(h.engineId), f.latestOf(h.engineId)]);
  const number = versions.findIndex(v => v.toLowerCase() === h.engineAddress.toLowerCase()) + 1;
  if (!number) throw new Error(t('模块 {address} 的引擎合约 {engine} 不是 Factory 为 {name} 列出的版本', { address, engine: h.engineAddress, name: h.engine }));
  mismatch('shape', h.shape.join(','), want.shape.join(','));
  mismatch('chunks', h.chunks.join(','), weightChunks(want.weights).map(c => chunkAddress(factory, c.id)).join(','));
  mismatch('tools', h.tools.length, want.tools.length);
  const toolModules = [];
  for (const [k, id] of want.tools.entries()) {
    try { await verifyModule(providerOrSigner, h.tools[k], toolArtifact(artifacts, id), { artifacts, factory }); }
    catch (e) { throw new Error(t('模块 {address} 的工具 {index} 不符：{error}', { address, index: k + 1, error: describe(e) })); }
    toolModules.push({ artifactId: id, address: h.tools[k] });
  }
  return { ...h, engineVersion: { address: h.engineAddress, number, latest: latest.toLowerCase() === h.engineAddress.toLowerCase() }, toolModules };
}

/** The first module that the Factory recorded for artifact `artifact` and that verifies against it, else null. A module
 *  that only claims the artifact id is skipped. A tool with tools of its own verifies them through `artifacts`. */
async function reusableModule(runner, factory, factoryAddress, artifact, artifacts) {
  for (const address of await factory.modulesOf(artifact.id)) {
    try { await verifyModule(runner, address, artifact, { artifacts, factory: factoryAddress }); return address; }
    catch { /* not the artifact: skip it */ }
  }
  return null;
}

/** A module of tool artifact `tool` on the Factory: the first recorded module of its artifact id that verifies. If there
 *  is none, a fresh deployment, its own tools first (`artifacts` resolves them).
 *  → `{ artifactId, address, reused, txHash?, gasUsed?, chunks?, transactions? }`. */
async function toolModule(signer, factory, factoryAddress, tool, artifacts, onProgress) {
  const address = await reusableModule(signer, factory, factoryAddress, tool, artifacts);
  if (address) return { artifactId: tool.id, address, reused: true };
  const r = await deployModule(signer, factoryAddress, tool, { artifacts, onProgress });
  return { artifactId: tool.id, address: r.address, reused: false, txHash: r.txHash, gasUsed: r.gasUsed, chunks: r.chunks, transactions: r.transactions };
}

/** The most gas one transaction may use on the signer's chain: Monad's limit, or the block limit when lower. */
async function txGasCap(signer) {
  const { gasLimit } = await providerOf(signer).getBlock('latest');
  return gasLimit < MAX_TX_GAS ? gasLimit : MAX_TX_GAS;
}

/** The gas estimate of `method(...args)`, or null when the node refuses it. Call it only on a call that the Factory
 *  already accepted (checkDeploy. createChunk refuses only on size). So when such a call fails at the allowance of the
 *  node, it ran out of gas. This is true for all reverts that the out-of-gas inner call can show. */
async function estimated(method, args) {
  try { return await method.estimateGas(...args); }
  catch (e) { if (e.code === 'CALL_EXCEPTION') return null; throw e; }
}

/** The gas limit (estimate + 10%) of `method(...args)` when it fits one transaction of at most `cap`, else null. */
async function fitting(method, args, cap) {
  const estimate = await estimated(method, args);
  if (estimate === null) return null;
  const limit = withMargin(estimate);
  return limit <= cap ? limit : null;
}

/** The weight chunks of blob `weights` on Factory `factoryAddress`, in blob order: weightChunks + `address`, `bytes`,
 *  `repeat` and `onChain`. `repeat` means that an earlier chunk of the blob has the same content, and goes with that one. */
async function chunkSlots(runner, factoryAddress, weights) {
  const out = [];
  for (const c of weightChunks(weights)) {
    const address = chunkAddress(factoryAddress, c.id), first = out.find(x => x.id === c.id);
    out.push({ ...c, address, bytes: (c.data.length - 2) / 2, repeat: !!first, onChain: first ? first.onChain : (await providerOf(runner).getCode(address)) !== '0x' });
  }
  return out;
}

/** The ModuleSpec that the Factory gets for deployment `d` of artifact `valid` with its tool modules at `tools`, on engine
 *  version `version` (null: the latest of its engine id, ModuleSpec.version = address(0)). */
async function specOf(d, valid, tools, slots, version) {
  return { engineId: nameId(d.engine), version: version ?? ZERO_ADDRESS, kind: KINDS.indexOf(d.kind), inputs: d.inputs, outputs: d.outputs, shape: d.shape,
    tools, chunks: slots.map(c => c.id), artifactId: valid.id, taskId: await taskIdOf(valid) };
}

async function checked(factory, spec, data) {
  try { await factory.checkDeploy(spec, data); }
  catch (e) { throw new Error(t('Factory 拒绝部署这个模块：{error}', { error: describe(e) })); }
}

/** A transaction pays TX_BASE before anything it runs: what creating a chunk inside `deploy` saves over createChunk. */
const TX_BASE = 21_000n;

/**
 * The transactions that createModule sends, forecast from estimates. `missing` = the chunks to create (`gas`: the
 * estimate of createChunk). `all` = the estimate of `deploy` when it creates all of them. `all` is null when the node
 * cannot estimate it (over its allowance, or tools not deployed yet).
 * One transaction when `all` fits `cap`. If not, the missing chunks go first, one each, until the module with the rest
 * fits. The own gas of the module is `all` minus what its chunks cost inside it (createChunk − TX_BASE each). When `all`
 * is unknown, the own gas is TX_BASE alone, and the gas of the module transaction is null.
 * → `[{ kind: 'chunk' | 'module', chunks, gas }]`.
 */
function splitByGas(missing, all, cap) {
  if (all !== null && withMargin(all) <= cap) return [{ kind: 'module', chunks: missing, gas: all }];
  const inside = chunks => chunks.reduce((sum, c) => sum + c.gas - TX_BASE, 0n);
  const own = all === null ? null : all - inside(missing);
  const rest = missing.slice(), out = [];
  const last = () => (own ?? TX_BASE) + inside(rest);
  while (rest.length && withMargin(last()) > cap) { const c = rest.shift(); out.push({ kind: 'chunk', chunks: [c], gas: c.gas }); }
  out.push({ kind: 'module', chunks: rest, gas: own === null ? null : last() });
  return out;
}

/** The work of planDeployment for one module (`valid`), its fresh tools first, appended to `plan`. `at` = { runner,
 *  factory, factoryAddress, artifacts, cap, as (estimate overrides: the deployer), reuse (tool artifact id → reused
 *  address), version (the engine version of the top module, null = latest. Tools take the latest of their own engine
 *  id) }. */
async function planModule(at, plan, valid, tool) {
  const d = deploymentOf(valid);
  for (const id of d.tools) {
    if (at.reuse.has(id)) continue;
    const ta = await validateArtifact(toolArtifact(at.artifacts, id)), address = await reusableModule(at.runner, at.factory, at.factoryAddress, ta, at.artifacts);
    at.reuse.set(id, address);
    plan.tools.push({ artifactId: id, address });
    if (!address) await planModule(at, plan, ta, true);
  }
  const slots = await chunkSlots(at.runner, at.factoryAddress, d.weights);
  const earlier = new Set(plan.chunks.map(c => c.address));        // a chunk an earlier module of this plan creates
  const missing = slots.filter(s => !s.repeat && !s.onChain && !earlier.has(s.address));
  for (const s of slots) if (!s.repeat && !earlier.has(s.address)) plan.chunks.push({ artifactId: valid.id, id: s.id, address: s.address, bytes: s.bytes, onChain: s.onChain });
  const tools = d.tools.map(id => at.reuse.get(id));
  let all = null;
  if (tools.every(Boolean) && missing.length === slots.filter(s => !s.repeat && !s.onChain).length) {   // else the Factory would refuse it today
    const spec = await specOf(d, valid, tools, slots, tool ? null : at.version), data = slots.map(s => (missing.includes(s) ? s.data : '0x'));
    await checked(at.factory, spec, data);
    all = await estimated(at.factory.deploy, [spec, data, at.as]);
  }
  for (const c of missing) c.gas = await at.factory.createChunk.estimateGas(c.data, at.as);
  for (const tx of splitByGas(missing, all, at.cap)) {
    plan.transactions.push({ artifactId: valid.id, tool, kind: tx.kind, chunks: tx.chunks.map(c => c.address), bytes: tx.chunks.reduce((sum, c) => sum + c.bytes, 0), gas: tx.gas === null ? null : tx.gas.toString() });
  }
}

/**
 * What deployModule would send for `artifact` now, read-only. `runner`: a provider or signer. `from`: the deployer.
 * The deployer becomes the owner of the module, so the Factory refuses a deployment estimated without one. `version`:
 * as for deployModule.
 * → `{ artifactId, factory, cap, chunks, tools, transactions }`:
 *   - `chunks` = the distinct weight chunks of every module that it creates (`{ artifactId, id, address, bytes, onChain }`,
 *     by their CREATE2 addresses)
 *   - `tools` = each distinct tool artifact with the verified module that it reuses (`address`, null = deployed first)
 *   - `transactions` = in sending order, `{ artifactId, tool, kind: 'chunk' | 'module', chunks (addresses it creates),
 *     bytes, gas (estimate, null when unknown) }`.
 * The grouping follows the rule of createModule, from gas estimates made before anything is sent (splitByGas).
 * deployModule estimates again before each transaction. So a forecast at a boundary can be one transaction off.
 */
export async function planDeployment(runner, factoryAddress, artifact, { artifacts = null, from, version = null } = {}) {
  const valid = await validateArtifact(artifact);
  if (!from || !isAddress(from)) throw new Error(t('部署计划需要部署者地址（from）：模块的 owner 是部署者，估算要以它的身份进行'));
  const factory = contractOf(runner, factoryAddress, FactoryABI, 'ModuleFactory'), cap = await txGasCap(runner);
  const plan = { artifactId: valid.id, factory: factoryAddress, cap: cap.toString(), chunks: [], tools: [], transactions: [] };
  await planModule({ runner, factory, factoryAddress, artifacts, cap, as: { from }, reuse: new Map(), version }, plan, valid, false);
  return plan;
}

/** Create the module of `spec` with its weight chunks (`chunks`: chunkSlots + `created`), all through the Factory.
 *  First the Factory must accept them (checkDeploy: a refused module costs no transaction). When the chunks and the
 *  module fit one transaction, send one (ModuleFactory.deploy with the content of the missing chunks). If not, the
 *  missing chunks go first, one createChunk transaction each, until the module and the remaining chunks fit the last
 *  one. A chunk already on chain is never sent. Fills the `created` / `txHash` of each chunk. Calls
 *  `onProgress({ artifactId, kind, chunks, bytes, stage: 'sending' })` before each transaction and
 *  `{ …, stage: 'mined', txHash, gasUsed }` when it is mined.
 *  → `{ rc, transactions: [{ kind: 'chunk' | 'module', txHash, gasUsed }] }` (rc = the receipt of the module transaction). */
async function createModule(signer, factory, spec, chunks, onProgress) {
  const cap = await txGasCap(signer), transactions = [];
  const data = chunks.map(c => (c.created === null ? c.data : '0x'));
  const report = (kind, sent, extra) => onProgress({ artifactId: spec.artifactId, kind, chunks: sent.map(c => c.address), bytes: sent.reduce((sum, c) => sum + c.bytes, 0), ...extra });
  await checked(factory, spec, data);
  let gasLimit = await fitting(factory.deploy, [spec, data], cap);
  while (gasLimit === null) {
    const next = data.findIndex(x => x !== '0x');
    if (next < 0) throw new Error(t('模块合约单独一笔交易也放不下：估算超过单笔交易上限 {cap} gas', { cap: cap.toLocaleString() }));
    const chunk = chunks[next], limit = await fitting(factory.createChunk, [chunk.data], cap);
    if (limit === null) throw new Error(t('权重块 {index}（{bytes} 字节）单独一笔交易也放不下：估算超过单笔交易上限 {cap} gas', { index: next + 1, bytes: chunk.bytes, cap: cap.toLocaleString() }));
    report('chunk', [chunk], { stage: 'sending' });
    const rc = await mined(await factory.createChunk(chunk.data, { gasLimit: limit }), 'createChunk');
    if ((await providerOf(signer).getCode(chunk.address, rc.blockNumber)) === '0x') throw new Error(t('权重块 {address} 未创建：{hash}', { address: chunk.address, hash: rc.hash }));
    Object.assign(chunk, { created: true, txHash: rc.hash });
    transactions.push({ kind: 'chunk', txHash: rc.hash, gasUsed: rc.gasUsed.toString() });
    report('chunk', [chunk], { stage: 'mined', txHash: rc.hash, gasUsed: rc.gasUsed.toString() });
    data[next] = '0x';
    gasLimit = await fitting(factory.deploy, [spec, data], cap);
  }
  const sent = chunks.filter((_, k) => data[k] !== '0x');
  report('module', sent, { stage: 'sending' });
  const rc = await mined(await factory.deploy(spec, data, { gasLimit }), 'deploy');
  for (const chunk of sent) Object.assign(chunk, { created: true, txHash: rc.hash });
  transactions.push({ kind: 'module', txHash: rc.hash, gasUsed: rc.gasUsed.toString() });
  report('module', sent, { stage: 'mined', txHash: rc.hash, gasUsed: rc.gasUsed.toString() });
  return { rc, transactions };
}

/**
 * Deploy one artifact as one module through the Factory. The steps:
 *   1. Validate the artifact (content hash + bundle).
 *   2. Create the module with artifactId = artifact.id and taskId = taskIdOf(artifact), and the weight chunks that are
 *      not on chain yet (createModule: one transaction when it fits).
 *   3. Check the ModuleDeployed event.
 *   4. Verify the deployed module against the artifact.
 * The tools of a selector come first (`artifacts(id)` resolves their artifacts). When the Factory already holds a
 * module that verifies against a distinct tool artifact, the deployment reuses it. If not, it deploys one. `tools` in
 * the result lists them in layer and wire order. `chunks` lists the own weight chunks of the module and whether this
 * deployment created them. `transactions` lists the transactions of this module (chunks first, the module last).
 * The deployment first looks up everything on chain. So after a failed or abandoned deployment, deploying again sends
 * only what is still missing (chunks by their CREATE2 addresses, tools by verification). `onProgress` (createModule)
 * gets every transaction, also the transactions of the tools.
 * `version`: the engine version address that the module computes with. The Factory must list it for the engine id, or
 * the Factory refuses it. null = the latest when the module is created. Tools deployed fresh take the latest version
 * of their own engine id. `engineVersion` in the result comes from verifyModule.
 */
export async function deployModule(signer, factoryAddress, artifact, { artifacts = null, onProgress = () => {}, version = null } = {}) {
  requireSigner(signer);
  const valid = await validateArtifact(artifact);
  const d = deploymentOf(valid);
  const factory = contractOf(signer, factoryAddress, FactoryABI, 'ModuleFactory');
  const byId = new Map();
  for (const id of d.tools) if (!byId.has(id)) byId.set(id, await toolModule(signer, factory, factoryAddress, await validateArtifact(toolArtifact(artifacts, id)), artifacts, onProgress));
  const tools = d.tools.map(id => byId.get(id));
  const chunks = (await chunkSlots(signer, factoryAddress, d.weights)).map(c => ({ ...c, created: c.repeat || c.onChain ? false : null }));   // a repeat comes with its first occurrence
  const spec = await specOf(d, valid, tools.map(x => x.address), chunks, version);
  const { rc, transactions } = await createModule(signer, factory, spec, chunks, onProgress);
  const ev = eventOf(rc, factory, factoryAddress, 'ModuleDeployed')[0];
  if (!ev) throw new Error(t('deploy 成功但未找到 ModuleDeployed 事件：{hash}', { hash: rc.hash }));
  const a = ev.args;
  if (a.artifactId.toLowerCase() !== valid.id.toLowerCase() || a.engineId.toLowerCase() !== spec.engineId.toLowerCase() || (version !== null && a.engine.toLowerCase() !== version.toLowerCase()) || Number(a.kind) !== spec.kind || Number(a.inputs) !== d.inputs || Number(a.outputs) !== d.outputs) {
    throw new Error(t('ModuleDeployed 事件与产物不符：{hash}', { hash: rc.hash }));
  }
  const address = a.module;
  const { engineVersion } = await verifyModule(signer, address, valid, { artifacts, factory: factoryAddress });
  return { address, id: a.id.toString(), engineVersion, txHash: rc.hash, gasUsed: transactions.reduce((sum, x) => sum + BigInt(x.gasUsed), 0n).toString(), artifactId: valid.id, engine: d.engine, kind: d.kind, inputs: d.inputs, outputs: d.outputs, tools,
    chunks: chunks.map(({ address, id, bytes, created, txHash }) => ({ address, id, bytes, created, txHash })), transactions };
}

/**
 * Read-only decision. mode 'forward' = rest state. mode 'peek' = the stored state of `from` under `session`, nothing
 * persisted.
 */
export async function inferModule(providerOrSigner, address, observation, { mode = 'forward', session, from } = {}) {
  const h = await readModule(providerOrSigner, address);
  const c = contractOf(providerOrSigner, address, ModuleABI, '模块');
  const bytes = encodeBits(observation, h.inputs, '输入位');
  if (mode === 'forward') return decodeDecision(await c.forward(bytes), h);
  if (mode !== 'peek') throw new Error(t('未知模式：{mode}', { mode }));
  if (!from) throw new Error(t('peek 需要 from（读取谁的状态）'));
  if (!isAddress(from)) throw new Error(t('from 地址无效：{address}', { address: from }));
  return decodeDecision(await c.peekAs(from, requireSession(session), bytes), h);
}

function resultHashOf(decision) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(['int256[]', 'uint16', 'uint8[]', 'int32[]'], [decision.scores, decision.action, decision.counts, decision.voltages]));
}

function mismatchError(message, rc, extra = {}) {
  const err = new Error(t('{message}（{hash}）', { message, hash: rc.hash }));
  err.code = 'STATE_MISMATCH'; err.txHash = rc.hash; Object.assign(err, extra);
  return err;
}

/**
 * One persisted decision as the signer under `session`. Pre-executes, sends, then confirms that the mined Stepped
 * commitment and the read-back state equal the pre-execution. If not, throws with code 'STATE_MISMATCH'.
 */
export async function stepModule(signer, address, observation, session) {
  requireSigner(signer);
  const h = await readModule(signer, address);
  const s = requireSession(session);
  const c = contractOf(signer, address, ModuleABI, '模块');
  const bytes = encodeBits(observation, h.inputs, '输入位');
  const who = (await signer.getAddress()).toLowerCase();
  let proposed;
  try { proposed = decodeDecision(await c.step.staticCall(s, bytes), h); }
  catch (e) { throw new Error(t('step 预执行失败：{error}', { error: describe(e) })); }
  const rc = await mined(await c.step(s, bytes, { gasLimit: withMargin(await c.step.estimateGas(s, bytes)) }), 'step');
  const ev = eventOf(rc, c, address, 'Stepped').find(e => e.args.actor.toLowerCase() === who && e.args.session.toLowerCase() === s);
  if (!ev || ev.args.resultHash.toLowerCase() !== resultHashOf(proposed).toLowerCase()) throw mismatchError(t('step 已上链，但交易结果摘要与预执行不符：状态在模拟与打包之间被改动'), rc);
  const stored = decodeVoltages(await c.stateOf(who, s, { blockTag: rc.blockNumber }), h.stateWidth);
  if (!sameInts(stored, proposed.voltages)) throw mismatchError(t('step 已上链但持久化状态与预执行不符'), rc, { proposed: proposed.voltages, stored });
  return { ...proposed, txHash: rc.hash, gasUsed: rc.gasUsed.toString() };
}

/** reset(session) as the signer. Confirmed when the stored state reads back all zero (or empty for stateless modules). */
export async function resetModule(signer, address, session) {
  requireSigner(signer);
  const s = requireSession(session);
  const c = contractOf(signer, address, ModuleABI, '模块');
  const who = await signer.getAddress();
  const rc = await mined(await c.reset(s, { gasLimit: withMargin(await c.reset.estimateGas(s)) }), 'reset');
  const stored = decodeVoltages(await c.stateOf(who, s, { blockTag: rc.blockNumber }));
  if (stored.some(v => v !== 0)) throw mismatchError(t('reset 已上链，但状态没有归零：另一笔交易同时改动了状态'), rc, { stored });
  return { txHash: rc.hash, gasUsed: rc.gasUsed.toString() };
}

/** Stored state of `owner` under `session` (empty for stateless modules). */
export async function moduleState(providerOrSigner, address, owner, session) {
  if (!isAddress(owner)) throw new Error(t('地址无效：{address}', { address: owner }));
  return decodeVoltages(await contractOf(providerOrSigner, address, ModuleABI, '模块').stateOf(owner, requireSession(session)));
}
