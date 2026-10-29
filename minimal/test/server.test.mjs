import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server/server.mjs';
import { parseArgs } from '../server/main.mjs';

const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
async function harness(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 't3-local-http-'));
  let root = path.join(temporary, 'workspace'); const staticDir = path.join(temporary, 'static'); const dataDir = path.join(temporary, 'state');
  await fs.mkdir(root); root = await fs.realpath(root); await fs.mkdir(staticDir);
  await fs.writeFile(path.join(root, 'example.txt'), 'local code\n');
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Local test</title>');
  await fs.chmod(fake, 0o755);
  let app = await createApplication({ roots: [root], dataDir, staticDir, executable: fake, port: 0 });
  t.after(async () => { await app.close(); await fs.rm(temporary, { recursive: true, force: true }); });
  const request = async (route, method = 'GET', value, extra = {}) => {
    const response = await fetch(app.url + route, { method, headers: { Authorization: `Bearer ${app.token}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, headers: response.headers, value: await response.json() };
  };
  const project = async () => { const result = await request('/api/projects', 'POST', { name: 'Synthetic project', roots: [root] }); assert.equal(result.status, 201, result.value.error?.message); return result.value; };
  const chat = async projectId => { const result = await request('/api/chats', 'POST', { projectId }); assert.equal(result.status, 201, result.value.error?.message); return result.value; };
  const restart = async () => { await app.close(); app = await createApplication({ roots: [root], dataDir, staticDir, executable: fake, port: 0 }); return app; };
  return { get app() { return app; }, root, dataDir, staticDir, temporary, request, project, chat, restart };
}

async function observe(app, chatId, predicate) {
  const abort = new AbortController();
  const response = await fetch(app.url + '/api/events', { headers: { Authorization: `Bearer ${app.token}` }, signal: abort.signal });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) throw new Error('Event stream ended before expected state');
      buffer += decoder.decode(part.value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (!frame.startsWith('data: ')) continue;
        const event = JSON.parse(frame.slice(6)); const chat = event.type === 'chat' ? event.chat : event.chats?.find(item => item.id === chatId);
        if (chat && chat.id === chatId && predicate(chat)) return chat;
      }
    }
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
}

test('cold start has authenticated API, strict Host/origin/JSON boundaries and no hidden CLI or service routes', async t => {
  const h = await harness(t);
  assert.equal((await fetch(h.app.url + '/api/bootstrap')).status, 401);
  assert.equal((await fetch(h.app.url + '/api/bootstrap?token=' + h.app.token)).status, 401);
  assert.equal((await h.request('/api/bootstrap', 'GET', undefined, { Origin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await h.request('/api/bootstrap', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await h.request('/api/bootstrap', 'GET', undefined, { 'X-Forwarded-Host': 'localhost' })).status, 403);
  const hostileHost = await new Promise((resolve, reject) => {
    const request = http.get(h.app.url + '/api/bootstrap', { headers: { Host: 'rebinding.invalid', Authorization: `Bearer ${h.app.token}` } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); request.on('error', reject);
  });
  assert.equal(hostileHost, 403);
  const malformed = await fetch(h.app.url + '/api/projects', { method: 'POST', headers: { Authorization: `Bearer ${h.app.token}`, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(malformed.status, 415);
  for (const route of ['/api/relay/install', '/api/providers/install', '/api/feedback', '/api/titles/generate', '/api/pricing/refresh', '/api/update']) assert.equal((await h.request(route, 'POST', {})).status, 404);
  assert.deepEqual((await h.request('/api/bootstrap')).value.projects, []);
  assert.equal((await fs.readdir(h.root)).some(name => name.startsWith('.fake-codex')), false);
  const index = await fetch(h.app.url); const policy = index.headers.get('content-security-policy');
  assert.match(policy, /default-src 'none'/); assert.match(policy, /connect-src 'self'/); assert.doesNotMatch(policy, /unsafe-inline|https:/);
  assert.equal((await fs.stat(h.app.connectionFile)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(h.app.connectionFile, 'utf8')).url, h.app.url + '/#token=' + h.app.token);
});

test('real HTTP and fake CLI subprocess stream, persist manual names/settings and resume after restart', async t => {
  const h = await harness(t); const project = await h.project(); const chat = await h.chat(project.id);
  const completion = observe(h.app, chat.id, current => current.status === 'idle' && current.messages.some(message => message.text === 'Synthetic response: hello'));
  assert.equal((await h.request(`/api/chats/${chat.id}/messages`, 'POST', { text: 'hello' })).status, 202);
  const completed = await completion;
  assert.ok(completed.nativeThreadId); assert.ok(completed.messages.some(message => message.role === 'user' && message.text === 'hello'));
  const wire = (await fs.readFile(path.join(h.root, '.fake-codex-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(wire.filter(message => message.method).map(message => message.method), ['initialize', 'initialized', 'thread/start', 'turn/start']);
  for (const message of wire) if (['thread/start', 'turn/start'].includes(message.method)) for (const field of ['sandbox', 'sandboxPolicy', 'approvalPolicy', 'config', 'summary']) assert.equal(field in message.params, false);
  assert.equal((await h.request(`/api/chats/${chat.id}`, 'PATCH', { title: 'Manually named', archived: true })).status, 200);
  assert.equal((await h.request(`/api/chats/${chat.id}/messages`, 'POST', { text: 'no' })).status, 409);
  assert.equal((await h.request('/api/settings', 'PATCH', { theme: 'light' })).status, 200);
  await h.restart();
  let state = (await h.request('/api/bootstrap')).value;
  assert.equal(state.chats[0].title, 'Manually named'); assert.equal(state.chats[0].archived, true); assert.equal(state.settings.theme, 'light');
  await h.request(`/api/chats/${chat.id}`, 'PATCH', { archived: false });
  const resumed = observe(h.app, chat.id, current => current.status === 'idle' && current.messages.some(message => message.text === 'Synthetic response: resumed'));
  await h.request(`/api/chats/${chat.id}/messages`, 'POST', { text: 'resumed' }); await resumed;
  state = (await h.request('/api/bootstrap')).value;
  assert.equal(state.chats[0].nativeThreadId, completed.nativeThreadId);
  const allWire = (await fs.readFile(path.join(h.root, '.fake-codex-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(allWire.some(message => message.method === 'thread/resume' && message.params.threadId === completed.nativeThreadId));
});

test('concurrent chats, native approvals/questions, overlap guards, cancellation and crash recovery work through HTTP', async t => {
  const h = await harness(t); const project = await h.project(); const one = await h.chat(project.id); const two = await h.chat(project.id);
  const waiting = observe(h.app, one.id, chat => chat.status === 'awaiting_approval');
  await h.request(`/api/chats/${one.id}/messages`, 'POST', { text: 'approval' });
  const approval = (await waiting).pendingRequests[0];
  assert.equal((await h.request(`/api/chats/${one.id}/messages`, 'POST', { text: 'overlap' })).status, 409);
  assert.equal((await h.request(`/api/chats/${one.id}`, 'PATCH', { archived: true })).status, 409);
  const otherDone = observe(h.app, two.id, chat => chat.status === 'idle' && chat.messages.some(message => message.text === 'Synthetic response: other'));
  await h.request(`/api/chats/${two.id}/messages`, 'POST', { text: 'other' }); await otherDone;
  assert.equal((await h.request(`/api/chats/${two.id}/responses`, 'POST', { requestId: approval.id, result: { decision: 'accept' } })).status, 409);
  const approved = observe(h.app, one.id, chat => chat.status === 'idle' && chat.messages.some(message => message.text === 'Approval decision: accept'));
  assert.equal((await h.request(`/api/chats/${one.id}/responses`, 'POST', { requestId: approval.id, result: { decision: 'accept' } })).status, 200); await approved;
  const questionWait = observe(h.app, one.id, chat => chat.status === 'awaiting_input');
  await h.request(`/api/chats/${one.id}/messages`, 'POST', { text: 'question' }); const question = (await questionWait).pendingRequests[0];
  const answered = observe(h.app, one.id, chat => chat.status === 'idle' && chat.messages.some(message => message.text === 'Answer: B'));
  await h.request(`/api/chats/${one.id}/responses`, 'POST', { requestId: question.id, result: { answers: { choice: { answers: ['B'] } } } }); await answered;
  await h.request(`/api/chats/${one.id}/messages`, 'POST', { text: 'hold' });
  const cancelled = observe(h.app, one.id, chat => chat.status === 'interrupted');
  assert.equal((await h.request(`/api/chats/${one.id}/cancel`, 'POST', {})).status, 200); await cancelled;
  const interrupted = observe(h.app, two.id, chat => chat.status === 'interrupted' && chat.messages.some(message => message.text.includes('Codex exited')));
  await h.request(`/api/chats/${two.id}/messages`, 'POST', { text: 'crash' }); await interrupted;
  const serialized = JSON.stringify((await h.request('/api/bootstrap')).value);
  assert.doesNotMatch(serialized, /sk-synthetic-secret/);
});

test('roots, settings and model controls fail closed, and large SSE snapshots survive normal backpressure', async t => {
  const h = await harness(t); const project = await h.project(); const chat = await h.chat(project.id);
  assert.equal((await h.request('/api/projects', 'POST', { name: 'Escape', roots: [h.temporary] })).status >= 400, true);
  assert.equal((await h.request(`/api/file?projectId=${project.id}&path=${encodeURIComponent('/etc/passwd')}`)).status >= 400, true);
  const code = await h.request(`/api/file?projectId=${project.id}&path=${encodeURIComponent(path.join(h.root, 'example.txt'))}`);
  assert.equal(code.value.text, 'local code\n');
  assert.equal((await h.request('/api/settings', 'PATCH', { theme: 'cloud' })).status, 400);
  assert.equal((await h.request('/api/settings', 'PATCH', { endpoint: 'https://unapproved.invalid' })).status, 400);
  assert.equal((await h.request(`/api/chats/${chat.id}`, 'PATCH', { approvalPolicy: 'never' })).status, 400);
  const capabilities = await h.request(`/api/capabilities?chatId=${chat.id}`); assert.equal(capabilities.value.models.length, 2);
  await h.request(`/api/chats/${chat.id}`, 'PATCH', { model: 'synthetic-model', reasoning: 'low' });
  assert.equal((await h.request(`/api/chats/${chat.id}`, 'PATCH', { model: null, reasoning: null })).status, 200);
  assert.equal('model' in (await h.request('/api/bootstrap')).value.chats[0], false);
  const text = 'large-history-'.repeat(35_000);
  await h.app.store.appendMessage(chat.id, { role: 'assistant', text, status: 'completed' });
  const large = await observe(h.app, chat.id, current => current.messages.some(message => message.text === text));
  assert.equal(large.messages.at(-1).text.length, text.length);
});

test('launch configuration requires explicit roots and rejects network/policy options', () => {
  assert.throws(() => parseArgs([]), /explicit --root/);
  assert.throws(() => parseArgs(['--root', '.', '--host', '0.0.0.0']), /Unknown option/);
  assert.throws(() => parseArgs(['--root', '.', '--full-access']), /Unknown option/);
  assert.throws(() => parseArgs(['--root', '.', '--port', 'invalid']), /Invalid port/);
  assert.equal(parseArgs(['--root', '.', '--port', '0']).port, 0);
});
