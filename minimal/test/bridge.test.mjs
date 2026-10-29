import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { HostBridge } from '../server/bridge.mjs';
import { CodexSession } from '../server/codex.mjs';
import { createApplication } from '../server/server.mjs';
import { parseArgs } from '../server/main.mjs';

const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 't3b-')); await fs.chmod(directory, 0o700);
  const base = await fs.realpath(directory); const workspace = path.join(base, 'work'); await fs.mkdir(workspace);
  const brokerPath = path.join(base, 'broker.sock'); const bridge = await HostBridge.listen(brokerPath);
  t.after(async () => { await bridge.close(); await fs.rm(base, { recursive: true, force: true }); });
  return { base, workspace, brokerPath, bridge };
}
async function gateway(socketPath) {
  const socket = net.connect({ path: socketPath }); let buffer = ''; const children = new Map();
  const send = value => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n'); };
  const ready = new Promise(resolve => {
    socket.setEncoding('utf8'); socket.on('data', chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (message.type === 'ready') resolve();
        else if (message.type === 'open') {
          const child = spawn(fake, ['app-server'], { cwd: message.cwd, env: process.env, shell: false, stdio: ['pipe', 'pipe', 'ignore'] }); children.set(message.id, child);
          send({ type: 'opened', id: message.id });
          child.stdout.on('data', data => send({ type: 'stdout', id: message.id, data: data.toString('base64') }));
          child.once('exit', (code, signal) => { children.delete(message.id); send({ type: 'exit', id: message.id, code, signal }); });
        } else if (message.type === 'stdin') children.get(message.id)?.stdin.write(Buffer.from(message.data, 'base64'));
        else if (message.type === 'eof') children.get(message.id)?.stdin.end();
        else if (message.type === 'signal') children.get(message.id)?.kill(message.signal);
      }
    });
  });
  socket.on('error', () => {}); socket.once('close', () => { for (const child of children.values()) child.kill('SIGTERM'); });
  await ready; return socket;
}
function event(session, type, predicate = () => true) {
  return new Promise(resolve => { const listener = value => { if (value.type === type && predicate(value)) { session.off('event', listener); resolve(value); } }; session.on('event', listener); });
}

test('private Docker stdio transport streams independent native sessions and preserves one-time decisions', async t => {
  const f = await fixture(t); const socket = await gateway(f.brokerPath); t.after(() => socket.destroy());
  const create = () => new CodexSession({ cwd: f.workspace, roots: [f.workspace], spawnProcess: config => f.bridge.open(config) });
  const first = create(); const second = create(); t.after(async () => { await first.close(); await second.close(); });
  await Promise.all([first.startThread(), second.startThread()]); assert.notEqual(first.threadId, second.threadId);
  const request = once(first, 'request'); await first.prompt({ text: 'approval' }); const [approval] = await request;
  assert.deepEqual(approval.allowedDecisions, ['accept', 'decline', 'cancel']);
  const finishedOther = event(second, 'turn_completed'); await second.prompt({ text: 'parallel bridge' }); await finishedOther;
  const approved = event(first, 'turn_completed'); await first.respond({ requestId: approval.id, result: { decision: 'accept' } }); await approved;
  const started = event(first, 'turn_started'); await first.prompt({ text: 'hold' }); await started;
  const cancelled = event(first, 'turn_completed', value => value.status === 'interrupted'); await first.interrupt(); await cancelled;
  const wire = (await fs.readFile(path.join(f.workspace, '.fake-codex-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const message of wire) if (message.params) for (const key of ['sandbox', 'approvalPolicy', 'config', 'mcp_servers']) assert.equal(key in message.params, false);
});

test('broker loss ends owned sessions without replay and an absent host bridge fails closed', async t => {
  const f = await fixture(t); await assert.rejects(f.bridge.open({ cwd: f.workspace }), /host bridge/);
  const socket = await gateway(f.brokerPath); const session = new CodexSession({ cwd: f.workspace, roots: [f.workspace], spawnProcess: config => f.bridge.open(config) });
  await session.startThread(); const started = event(session, 'turn_started'); await session.prompt({ text: 'hold' }); await started;
  const exited = once(session, 'exit'); socket.destroy(); await exited; assert.equal(session.closed, true); assert.equal(f.bridge.ready, false);
});

test('Unix HTTP health is minimal, reports host readiness and retains API authorization and Host checks', async t => {
  const f = await fixture(t); const staticDir = path.join(f.base, 'static'); await fs.mkdir(staticDir); await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html>');
  const socketPath = path.join(f.base, 'http.sock');
  const app = await createApplication({ roots: [f.workspace], dataDir: path.join(f.base, 'data'), port: 3777, socketPath, staticDir, bridgeReady: () => f.bridge.ready, sessionFactory: config => new CodexSession({ ...config, spawnProcess: config => f.bridge.open(config) }) });
  t.after(() => app.close());
  const get = (route, headers = {}) => new Promise((resolve, reject) => {
    http.get({ socketPath, path: route, headers: { Host: '127.0.0.1:3777', ...headers } }, response => { let data = ''; response.on('data', chunk => { data += chunk; }); response.on('end', () => resolve({ status: response.statusCode, value: JSON.parse(data) })); }).on('error', reject);
  });
  assert.deepEqual((await get('/healthz')).value, { status: 'ok', ready: false, version: '0.1.1' });
  assert.equal((await get('/api/bootstrap')).status, 401); assert.equal((await get('/healthz', { Host: 'hostile.invalid' })).status, 403);
  const socket = await gateway(f.brokerPath); t.after(() => socket.destroy());
  assert.equal((await get('/healthz')).value.ready, true);
  const snapshot = await get('/api/bootstrap', { Authorization: `Bearer ${app.token}` }); assert.equal(snapshot.value.runtime.mode, 'host-bridge');
  assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
});

test('private sockets and bridge-only launch options reject unsafe or incomplete configuration', async t => {
  const f = await fixture(t); const publicDir = path.join(f.base, 'public'); await fs.mkdir(publicDir, { mode: 0o755 });
  await assert.rejects(HostBridge.listen(path.join(publicDir, 'socket')), /private directory/);
  await assert.rejects(HostBridge.listen(f.brokerPath), /already exists/);
  assert.throws(() => parseArgs(['--root', '.', '--socket', '/run/t3/http.sock']), /together/);
  assert.throws(() => parseArgs(['--root', '.', '--host-bridge']), /together/);
  assert.throws(() => parseArgs(['--root', '.', '--host-bridge', '--socket', '/run/t3/http.sock', '--port', '0']), /fixed/);
});
