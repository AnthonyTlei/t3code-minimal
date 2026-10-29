import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveExecutable } from '../server/executable.mjs';
import { HostBridge } from '../server/bridge.mjs';
import { createApplication } from '../server/server.mjs';

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 't3ps-'));
  await fs.chmod(temporary, 0o700);
  const base = await fs.realpath(temporary);
  const socketPath = path.join(base, 'broker.sock');
  const bridge = await HostBridge.listen(socketPath);
  const socket = net.connect({ path: socketPath });
  let buffer = ''; const frames = []; const waiters = [];
  socket.setEncoding('utf8'); socket.on('error', () => {});
  socket.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const waiter = waiters.shift(); if (waiter) waiter(frame); else frames.push(frame);
    }
  });
  const next = () => frames.length ? Promise.resolve(frames.shift()) : new Promise(resolve => waiters.push(resolve));
  assert.deepEqual(await next(), { type: 'ready' });
  t.after(async () => { socket.destroy(); await bridge.close(); await fs.rm(base, { recursive: true, force: true }); });
  async function child() {
    const opening = bridge.open({ cwd: base });
    const request = await next(); assert.equal(request.type, 'open');
    socket.write(JSON.stringify({ type: 'opened', id: request.id }) + '\n');
    return { process: await opening, id: request.id };
  }
  return { base, bridge, socket, socketPath, next, child };
}

test('independent bridge review rejects malformed host protocol and retires active sessions without replay', async t => {
  const f = await fixture(t); const { process } = await f.child();
  const exited = once(process, 'exit'); const closed = once(f.socket, 'close');
  f.socket.write('{"type":"unsupported","id":"untrusted"}\n');
  await Promise.all([exited, closed]);
  assert.equal(f.bridge.ready, false); assert.equal(f.bridge.children.size, 0);
  await assert.rejects(f.bridge.open({ cwd: f.base }), /host bridge/);
});

test('independent bridge review preserves the first private gateway and rejects a second connection', async t => {
  const f = await fixture(t); const second = net.connect({ path: f.socketPath }); second.on('error', () => {});
  await once(second, 'close'); assert.equal(f.bridge.ready, true);
  const { process, id } = await f.child(); const output = once(process.stdout, 'data');
  f.socket.write(JSON.stringify({ type: 'stdout', id, data: Buffer.from('synthetic host output').toString('base64') }) + '\n');
  assert.equal((await output)[0].toString(), 'synthetic host output');
  assert.equal((await fs.stat(f.socketPath)).mode & 0o777, 0o600);
});

test('independent bridge review closes an overfull transport instead of abandoning an uncancelled host process', async t => {
  const f = await fixture(t); const { process } = await f.child();
  f.socket.pause();
  const failed = once(process.stdin, 'error');
  for (let attempt = 0; attempt < 20 && !process.stdin.destroyed; attempt++) process.stdin.write(Buffer.alloc(1024 * 1024, 65));
  await failed;
  assert.equal(f.bridge.ready, false, 'a failed full channel must disconnect so the host retires its owned CLI processes');
});

test('independent health review exposes no credentials or workspace information and cannot launch native work', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 't3ph-')); await fs.chmod(temporary, 0o700);
  const base = await fs.realpath(temporary); const staticDir = path.join(base, 'static'); const workspace = path.join(base, 'workspace');
  await fs.mkdir(staticDir); await fs.mkdir(workspace); await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html>');
  let launches = 0;
  const socketPath = path.join(base, 'http.sock');
  const app = await createApplication({ roots: [workspace], dataDir: path.join(base, 'state'), port: 3777, staticDir, socketPath,
    bridgeReady: () => true, sessionFactory: () => { launches++; throw new Error('Health must not start a CLI'); } });
  t.after(async () => { await app.close(); await fs.rm(base, { recursive: true, force: true }); });
  const request = (url, headers = {}) => new Promise((resolve, reject) => {
    http.get({ socketPath, path: url, headers: { Host: '127.0.0.1:3777', ...headers } }, response => {
      let data = ''; response.on('data', chunk => { data += chunk; }); response.on('end', () => resolve({ status: response.statusCode, data }));
    }).on('error', reject);
  });
  const health = await request('/healthz'); assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.data), { status: 'ok', ready: true, version: '0.1.1' });
  assert.equal(health.data.includes(app.token), false); assert.equal(health.data.includes(workspace), false); assert.equal(launches, 0);
  assert.equal((await request('/api/bootstrap')).status, 401);
  assert.equal((await request('/healthz', { Origin: 'https://hostile.invalid' })).status, 403);
});

test('independent supervisor review requires its private nonce to stop the owned manager and preserves data', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 't3pc-')); const base = await fs.realpath(temporary);
  const state = path.join(base, 'private'); const workspace = path.join(base, 'workspace'); await fs.mkdir(workspace);
  const modulePath = fileURLToPath(new URL('../../scripts/manage.py', import.meta.url));
  const python = await resolveExecutable('python3');
  const code = `import importlib.util,json,os,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('manager',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nm.STATE=Path(sys.argv[2]);m.prepare_state()\nsynthetic='import sys;print(\\'{"type":"ready"}\\',flush=True);sys.stdin.buffer.read()'\nm.command=lambda config,*args,**kwargs:[sys.executable,'-c',synthetic]\nm.docker_local=lambda include_endpoint=False: ('synthetic-docker','unix:///synthetic') if include_endpoint else 'synthetic-docker'\nconfig={'version':1,'roots':[sys.argv[3]],'codex':sys.executable,'port':0,'uid':os.getuid(),'gid':os.getgid()}\nm.Runtime(config,'synthetic-private-control-nonce').run()\n`;
  const child = spawn(python, ['-c', code, modulePath, state, workspace], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let diagnostic = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { diagnostic += chunk; });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'close'); } await fs.rm(base, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('gateway listening')) resolve(); });
    child.once('close', () => reject(new Error('Synthetic manager failed: ' + diagnostic)));
  });
  const identity = JSON.parse(await fs.readFile(path.join(state, 'run', 'manager.json'), 'utf8'));
  assert.equal(identity.pid, child.pid); assert.equal((await fs.stat(path.join(state, 'run', 'manager.json'))).mode & 0o777, 0o600);
  const command = (operation, nonce) => new Promise((resolve, reject) => {
    const socket = net.connect({ path: path.join(state, 'run', 'control.sock') }); let buffer = '';
    socket.setEncoding('utf8'); socket.once('connect', () => socket.write(JSON.stringify({ command: operation, nonce }) + '\n'));
    socket.on('data', chunk => { buffer += chunk; }); socket.once('end', () => resolve(JSON.parse(buffer))); socket.once('error', reject);
  });
  assert.equal((await command('stop', 'wrong-nonce')).ok, false);
  assert.equal((await command('status', identity.nonce)).ok, true);
  await fs.writeFile(path.join(state, 'preserved-synthetic.txt'), 'must remain');
  const exited = once(child, 'close'); assert.equal((await command('stop', identity.nonce)).ok, true); assert.equal((await exited)[0], 0);
  assert.equal(await fs.readFile(path.join(state, 'preserved-synthetic.txt'), 'utf8'), 'must remain');
  assert.equal(output.includes(identity.nonce), false); assert.equal(diagnostic.includes(identity.nonce), false);
});
