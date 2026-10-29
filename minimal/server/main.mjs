#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplication } from './server.mjs';
import { resolveExecutable } from './executable.mjs';
import { HostBridge } from './bridge.mjs';
import { CodexSession } from './codex.mjs';

export function parseArgs(args) {
  const options = { roots: [], dataDir: path.join(os.homedir(), '.t3code-local'), executable: 'codex', port: 3777, open: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--open') { options.open = true; continue; }
    if (flag === '--host-bridge') { options.hostBridge = true; continue; }
    if (!['--root', '--data-dir', '--codex', '--port', '--socket'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = args[++i]; if (!value || value.startsWith('--') || value.includes('\0')) throw new Error(`A value is required for ${flag}`);
    if (flag === '--root') options.roots.push(path.resolve(value));
    if (flag === '--data-dir') options.dataDir = path.resolve(value);
    if (flag === '--codex') options.executable = value;
    if (flag === '--socket') options.socketPath = path.resolve(value);
    if (flag === '--port') { if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('Invalid port'); options.port = Number(value); }
  }
  if (!options.roots.length) throw new Error('Provide at least one explicit --root directory');
  if (Boolean(options.hostBridge) !== Boolean(options.socketPath)) throw new Error('--host-bridge and --socket must be selected together');
  if (options.hostBridge && options.port === 0) throw new Error('Host bridge mode requires a fixed public loopback port');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('T3 Code Local\n\nnode minimal/server/main.mjs --root /approved/workspace [--root /another/root]\n  --data-dir /private/state  Local transcripts and settings (default ~/.t3code-local)\n  --codex /approved/codex    Existing CLI only; no download or configuration override\n  --port 3777               Loopback port; 0 chooses an available port\n  --open                    Open the private launch URL in your default browser\n  --host-bridge --socket PATH  Private Docker stdio transport (managed by Make/Compose)');
    return;
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 24) throw new Error('Use the documented Node 24 runtime');
  const bridge = options.hostBridge ? await HostBridge.listen(path.join(path.dirname(options.socketPath), 'broker.sock')) : null;
  let app;
  try {
    app = await createApplication({ ...options, ...(bridge ? { bridgeReady: () => bridge.ready, sessionFactory: config => new CodexSession({ ...config, spawnProcess: config => bridge.open(config) }) } : {}) });
  } catch (error) { await bridge?.close(); throw error; }
  console.log(`T3 Code Local: ${app.url}\nPrivate browser launch URL is in ${app.connectionFile}\nCodex starts only for an explicit chat or capability request. Press Ctrl-C to stop.`);
  if (options.open) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
    if (command) {
      try { const opener = await resolveExecutable(command); const child = spawn(opener, [app.launchUri], { shell: false, stdio: 'ignore' }); child.on('error', () => console.error('Could not open the browser. Use the private launch.html file.')); child.unref(); }
      catch { console.error('Could not find the browser opener in an absolute PATH directory. Use the private connection file.'); }
    }
  }
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await app.close(); await bridge?.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`T3 Code Local could not start: ${error.message}`); process.exitCode = 1; });
