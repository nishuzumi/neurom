// foundry.mjs — the Foundry binaries and a local anvil, shared by the contract commands and the tests over anvil
// (frontend/anvil.fixture.js, contracts/scripts/*.test.mjs).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';

/** The path of Foundry's `name` binary — `$NAME`, `~/.foundry/bin/name`, else `name` on PATH — or null when missing. */
export function foundryBinary(name) {
  for (const p of [process.env[name.toUpperCase()], path.join(os.homedir(), '.foundry', 'bin', name)]) if (p && fs.existsSync(p)) return p;
  try { execFileSync(name, ['--version'], { stdio: 'ignore' }); return name; } catch { return null; }
}

const freePort = () => new Promise((resolve, reject) => { const srv = net.createServer(); srv.unref(); srv.on('error', reject); srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); });
const reachable = port => new Promise(resolve => { const c = net.connect(port, '127.0.0.1', () => { c.end(); resolve(true); }); c.on('error', () => resolve(false)); });

/**
 * `anvil --network <network> ...args` on a free port, once it accepts connections → `{ url, provider, stop }`. The
 * network defaults to monad. Anvil also stops when this process exits. Throws when anvil is missing or does not start
 * (with its stderr).
 */
export async function startAnvil(args = [], { network = 'monad' } = {}) {
  const anvil = foundryBinary('anvil');
  if (!anvil) throw new Error('needs anvil (Foundry) on PATH or in ANVIL');
  const port = await freePort();
  const proc = spawn(anvil, ['--network', network, ...args, '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  const kill = () => { proc.kill(); process.off('exit', kill); };
  process.once('exit', kill);
  let stderr = '', failed = null;
  proc.on('error', e => { failed = e; });
  proc.stderr.on('data', d => { stderr += d; });
  for (let i = 0; !(await reachable(port)); i++) {
    if (i > 600 || failed || proc.exitCode !== null) { kill(); throw new Error(`anvil did not start: ${failed?.message || stderr.trim() || 'no output'}`); }
    await new Promise(r => setTimeout(r, 50));
  }
  const url = `http://127.0.0.1:${port}`, provider = new ethers.JsonRpcProvider(url, undefined, { pollingInterval: 10, staticNetwork: true });
  return { url, provider, stop: () => { provider.destroy(); kill(); } };
}

/** Run `command args` (cwd, env added) → `{ code, stdout, stderr }`. */
export function run(command, args, { cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    p.on('error', reject);
    p.on('close', code => resolve({ code, stdout, stderr }));
  });
}
