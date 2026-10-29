import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { browserCheck } from './browser-check.mjs';

const base = await fs.mkdtemp(path.join(os.tmpdir(), 't3-egress-'));
const root = path.join(base, 'workspace');
await fs.mkdir(root);
await fs.writeFile(path.join(root, 'synthetic.txt'), 'synthetic fixture only\n');
const output = process.env.T3_AUDIT_OUTPUT || '/audit-output';
const phases = []; const processes = [{ pid: process.pid, role: 'audit-driver' }];
const transientCapabilities = new Set();
async function sourceHashes() {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await walk('/app/minimal/server'); await walk('/app/dist'); files.push('/app/minimal/test/fake-codex.mjs');
  const result = {};
  for (const filename of files.sort()) result[filename.slice(5)] = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
  return result;
}
const auditedSources = await sourceHashes();
const mark = name => phases.push({ name, unixTimeMs: Date.now() });
const sockets = new Set(); const httpPaths = [];
const decoy = http.createServer((request, response) => {
  httpPaths.push(request.url);
  if (request.url === '/redirect') { response.writeHead(302, { Location: '/final' }); response.end(); }
  else if (request.url === '/redirect-blocked') { response.writeHead(302, { Location: 'http://198.51.100.43:8080/final' }); response.end(); }
  else { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('local positive control'); }
});
decoy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
decoy.on('upgrade', (request, socket) => {
  httpPaths.push(request.url);
  const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.once('data', () => socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8])));
});
await new Promise(resolve => decoy.listen(0, '127.0.0.1', resolve));
const dns = dgram.createSocket('udp4'); let dnsQueries = 0;
dns.on('message', (message, peer) => {
  dnsQueries++;
  const header = Buffer.from(message.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 6); header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 127, 0, 0, 1]);
  dns.send(Buffer.concat([header, message.subarray(12), answer]), peer.port, peer.address);
});
await new Promise(resolve => dns.bind(0, '127.0.0.1', resolve));

const forkOwned = (filename, args = []) => {
  const child = fork(fileURLToPath(new URL(filename, import.meta.url)), args, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  processes.push({ pid: child.pid, role: filename.includes('probe') ? 'positive-control-descendant' : 'wrapper-backend' });
  return child;
};
const request = async (app, route, method = 'GET', body) => {
  const response = await fetch(app.url + route, { method, headers: { Authorization: `Bearer ${app.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, value: await response.json() };
};
async function waitChat(app, id, predicate) {
  const abort = new AbortController();
  const response = await fetch(app.url + '/api/events', { signal: abort.signal, headers: { Authorization: `Bearer ${app.token}` } });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffered = '';
  try {
    for (;;) {
      const part = await reader.read(); assert.equal(part.done, false, 'SSE ended before expected state');
      buffered += decoder.decode(part.value, { stream: true });
      let end;
      while ((end = buffered.indexOf('\n\n')) >= 0) {
        const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        if (!frame.startsWith('data: ')) continue;
        const event = JSON.parse(frame.slice(6));
        const chat = event.type === 'chat' ? event.chat : event.chats?.find(value => value.id === id);
        if (chat?.id === id && predicate(chat)) return chat;
      }
    }
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
}
let backend; let probe;
const watchdog = setTimeout(() => { backend?.kill('SIGTERM'); probe?.kill('SIGTERM'); process.exitCode = 1; }, 80_000); watchdog.unref();
try {
  mark('positive-controls');
  probe = forkOwned('./probe-child.mjs', [JSON.stringify({ httpPort: decoy.address().port, dnsPort: dns.address().port })]);
  const [positive] = await once(probe, 'message'); await once(probe, 'exit');
  assert.deepEqual(positive.successfulDns, ['127.0.0.1']);
  assert.notEqual(positive.blockedDns, 'UNEXPECTED_SUCCESS'); assert.notEqual(positive.blockedTcp, 'UNEXPECTED_SUCCESS');
  assert.equal(positive.redirect.redirected, true); assert.equal(positive.websocket, 'opened');
  assert.notEqual(positive.blockedRedirect, 'UNEXPECTED_SUCCESS'); assert.equal(positive.blockedWebsocket, 'error');
  assert.deepEqual(httpPaths, ['/redirect', '/final', '/ws', '/redirect-blocked']); assert.equal(dnsQueries, 1);
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => decoy.close(resolve)); dns.close();

  mark('wrapper-cold-start');
  backend = forkOwned('./backend-child.mjs', [JSON.stringify({ roots: [root], dataDir: path.join(base, 'state'), executable: fileURLToPath(new URL('../test/fake-codex.mjs', import.meta.url)), staticDir: '/app/dist', port: 0 })]);
  let [app] = await once(backend, 'message'); assert.equal(app.type, 'ready'); transientCapabilities.add(app.token);
  assert.equal((await request(app, '/api/bootstrap')).status, 200);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.fake-codex')), false);
  mark('wrapper-idle-20000ms');
  const idleAbort = new AbortController();
  const idleStream = await fetch(app.url + '/api/events', { signal: idleAbort.signal, headers: { Authorization: `Bearer ${app.token}` } });
  const idleReader = idleStream.body.getReader(); let idleText = '';
  const readingIdle = (async () => { for (;;) { const part = await idleReader.read(); if (part.done) break; idleText += new TextDecoder().decode(part.value); } })();
  await new Promise(resolve => setTimeout(resolve, 20_000)); idleAbort.abort(); await readingIdle.catch(() => {}); await idleReader.cancel().catch(() => {});
  assert.match(idleText, /: heartbeat/, '20s idle did not observe the SSE heartbeat');
  const project = (await request(app, '/api/projects', 'POST', { name: 'Audit synthetic', roots: [root] })).value;
  const one = (await request(app, '/api/chats', 'POST', { projectId: project.id })).value;
  const two = (await request(app, '/api/chats', 'POST', { projectId: project.id })).value;
  const run = async (chatId, text, predicate) => {
    const finished = waitChat(app, chatId, predicate);
    const result = await request(app, `/api/chats/${chatId}/messages`, 'POST', { text });
    assert.equal(result.status, 202); return finished;
  };
  mark('wrapper-normal-stream');
  await run(one.id, 'synthetic audit chat', chat => chat.status === 'idle' && chat.messages.some(message => message.text === 'Synthetic response: synthetic audit chat'));
  mark('wrapper-concurrent-and-approval');
  const approval = await run(one.id, 'approval', chat => chat.status === 'awaiting_approval');
  await run(two.id, 'parallel synthetic audit', chat => chat.status === 'idle' && chat.messages.some(message => message.text === 'Synthetic response: parallel synthetic audit'));
  const approved = waitChat(app, one.id, chat => chat.status === 'idle' && chat.messages.some(message => message.text === 'Approval decision: accept'));
  assert.equal((await request(app, `/api/chats/${one.id}/responses`, 'POST', { requestId: approval.pendingRequests[0].id, result: { decision: 'accept' } })).status, 200); await approved;
  mark('wrapper-question');
  const question = await run(one.id, 'question', chat => chat.status === 'awaiting_input');
  const answered = waitChat(app, one.id, chat => chat.status === 'idle' && chat.messages.some(message => message.text === 'Answer: A'));
  await request(app, `/api/chats/${one.id}/responses`, 'POST', { requestId: question.pendingRequests[0].id, result: { answers: { choice: { answers: ['A'] } } } }); await answered;
  mark('wrapper-cancel');
  assert.equal((await request(app, `/api/chats/${one.id}/messages`, 'POST', { text: 'hold' })).status, 202);
  const cancelled = waitChat(app, one.id, chat => chat.status === 'interrupted'); await request(app, `/api/chats/${one.id}/cancel`, 'POST', {}); await cancelled;
  mark('wrapper-native-error');
  const failed = waitChat(app, two.id, chat => chat.status === 'interrupted'); await request(app, `/api/chats/${two.id}/messages`, 'POST', { text: 'crash' }); await failed;
  mark('wrapper-malformed-settings');
  assert.equal((await request(app, '/api/settings', 'PATCH', { theme: 'unapproved' })).status, 400);
  assert.equal((await request(app, '/api/update', 'POST', {})).status, 404);
  mark('sandboxed-browser-attempt');
  await request(app, '/api/settings', 'PATCH', { selectedChatId: one.id });
  const browserAudit = await browserCheck(app);
  mark('wrapper-shutdown'); backend.send({ type: 'close' });
  const [stopped] = await once(backend, 'message'); assert.equal(stopped.type, 'stopped'); await once(backend, 'exit');
  const state = JSON.parse(await fs.readFile(path.join(base, 'state', 'state.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(state), /sk-synthetic-secret/);
  mark('wrapper-restart-resume');
  backend = forkOwned('./backend-child.mjs', [JSON.stringify({ roots: [root], dataDir: path.join(base, 'state'), executable: fileURLToPath(new URL('../test/fake-codex.mjs', import.meta.url)), staticDir: '/app/dist', port: 0 })]);
  [app] = await once(backend, 'message'); assert.equal(app.type, 'ready'); transientCapabilities.add(app.token);
  const restarted = (await request(app, '/api/bootstrap')).value;
  assert.equal(restarted.chats.find(chat => chat.id === one.id).nativeThreadId, state.chats.find(chat => chat.id === one.id).nativeThreadId);
  await run(one.id, 'resumed synthetic audit', chat => chat.status === 'idle' && chat.messages.some(message => message.text === 'Synthetic response: resumed synthetic audit'));
  const wire = (await fs.readFile(path.join(root, '.fake-codex-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(wire.some(message => message.method === 'thread/resume'));
  const allowedMethods = new Set(['initialize', 'initialized', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt']);
  assert.ok(wire.every(message => message.method === undefined || allowedMethods.has(message.method)), 'Unexpected native helper or metadata method');
  backend.send({ type: 'close' }); await once(backend, 'message'); await once(backend, 'exit');
  await fs.writeFile(path.join(base, 'state', 'state.json'), '{malformed');
  mark('wrapper-malformed-state-cold-start');
  backend = forkOwned('./backend-child.mjs', [JSON.stringify({ roots: [root], dataDir: path.join(base, 'state'), executable: fileURLToPath(new URL('../test/fake-codex.mjs', import.meta.url)), staticDir: '/app/dist', port: 0 })]);
  const [malformed] = await once(backend, 'message'); assert.equal(malformed.type, 'failed'); await once(backend, 'exit');
  assert.deepEqual(await sourceHashes(), auditedSources, 'Application source changed during audit; rerun against a stable build');
  for (const entry of await fs.readdir(output, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const content = await fs.readFile(path.join(output, entry.name), 'utf8');
    for (const capability of transientCapabilities) assert.equal(content.includes(capability), false, 'Session capability appeared in retained audit output');
  }
  for (const capability of transientCapabilities) assert.equal(JSON.stringify(browserAudit).includes(capability), false, 'Browser evidence retained a session capability');
  mark('finished');
  await fs.writeFile(path.join(output, 'exercise.json'), JSON.stringify({ result: 'pass', capabilityLeakCheck: { status: 'pass', checkedCapabilityCount: transientCapabilities.size }, processes, phases, sourceHashes: auditedSources, browserAudit, positiveControls: { ...positive, httpPaths, dnsQueries }, appScenarios: ['cold start', '20000 ms idle and SSE heartbeat', 'stream', 'concurrent chats', 'approval', 'question', 'cancel', 'native error', 'malformed settings', 'removed route', 'shutdown', 'restart/resume', 'native helper absence', 'malformed persisted state'], limits: ['synthetic fake CLI only', browserAudit.status === 'pass' ? 'sandboxed browser tested with bounded idle and hostile markup' : 'sandboxed browser could not launch; see browserAudit diagnostics', 'not a deployment-host verification', 'network-none test namespace, not a production deployment topology'] }, null, 2) + '\n');
  console.log('Runtime exercise passed; token-free evidence written.');
} finally {
  clearTimeout(watchdog); backend?.kill('SIGTERM'); probe?.kill('SIGTERM');
  for (const socket of sockets) socket.destroy(); decoy.close(); try { dns.close(); } catch {}
  await fs.rm(base, { recursive: true, force: true });
}
