import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../server/store.mjs';

async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-minimal-store-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return { root, dataDir: path.join(root, 'state') }; }

test('serializes concurrent chat updates and preserves private local history, rename, archive and settings across restart', async t => {
  const { root, dataDir } = await fixture(t); const store = await Store.open({ dataDir }); t.after(() => store.close());
  const project = await store.createProject({ name: 'Synthetic roots', roots: [root, path.join(root, 'second')] });
  const first = await store.createChat({ projectId: project.id }); const second = await store.createChat({ projectId: project.id, title: 'Other chat' });
  await Promise.all(Array.from({ length: 30 }, (_, index) => store.appendMessage(index % 2 ? first.id : second.id, { role: 'user', text: `Synthetic ${index}` })));
  await store.updateChat(first.id, { title: 'Manual name', archived: true, nativeThreadId: 'native-synthetic', model: null, reasoning: null });
  await store.updateSettings({ theme: 'light', selectedChatId: first.id });
  const clone = store.snapshot(); clone.chats[0].title = 'Must not affect store';
  assert.equal(store.snapshot().chats[0].title, 'Manual name');
  assert.equal((await fs.stat(dataDir)).mode & 0o777, 0o700); assert.equal((await fs.stat(path.join(dataDir, 'state.json'))).mode & 0o777, 0o600);
  await store.close(); const reopened = await Store.open({ dataDir }); t.after(() => reopened.close());
  assert.deepEqual(reopened.snapshot().chats.map(chat => chat.messages.length), [15, 15]);
  assert.equal(reopened.snapshot().settings.theme, 'light'); assert.equal(reopened.snapshot().chats[0].nativeThreadId, 'native-synthetic'); assert.equal(reopened.snapshot().chats[0].archived, true);
  await reopened.updateChat(first.id, { archived: false }); assert.equal(reopened.snapshot().chats[0].archived, false);
});

test('restart retires process-bound requests and streaming statuses while keeping native resume identity', async t => {
  const { root, dataDir } = await fixture(t); const store = await Store.open({ dataDir });
  const project = await store.createProject({ name: 'Synthetic', roots: [root] }); const chat = await store.createChat({ projectId: project.id });
  await store.updateChat(chat.id, { status: 'awaiting_approval', nativeThreadId: 'resume-me', pendingRequests: [{ id: 5, method: 'item/commandExecution/requestApproval', params: { command: 'synthetic' }, kind: 'approval', allowedDecisions: ['accept', 'decline'] }] });
  await store.appendMessage(chat.id, { role: 'assistant', text: 'Incomplete response', status: 'streaming' }); await store.close();
  const reopened = await Store.open({ dataDir }); t.after(() => reopened.close()); const recovered = reopened.snapshot().chats[0];
  assert.equal(recovered.status, 'interrupted'); assert.deepEqual(recovered.pendingRequests, []); assert.equal(recovered.messages[0].status, 'interrupted'); assert.equal(recovered.nativeThreadId, 'resume-me');
});

test('malformed or unsupported state fails closed without replacing transcript bytes', async t => {
  const { dataDir } = await fixture(t); const store = await Store.open({ dataDir }); await store.close(); const file = path.join(dataDir, 'state.json');
  for (const source of ['{broken', JSON.stringify({ format: 't3-code-minimal', version: 1, projects: [], chats: [], settings: { telemetry: true } })]) {
    await fs.writeFile(file, source); await assert.rejects(Store.open({ dataDir }), { code: 'INVALID_STATE' }); assert.equal(await fs.readFile(file, 'utf8'), source); await assert.rejects(fs.stat(path.join(dataDir, 'store.lock')), { code: 'ENOENT' });
  }
});

test('rejects symlinked data, state, lock and connection paths without following their target', async t => {
  const { root, dataDir } = await fixture(t); const outside = path.join(root, 'private-target'); await fs.writeFile(outside, 'unchanged');
  await fs.symlink(root, dataDir); await assert.rejects(Store.open({ dataDir }), { code: 'UNSAFE_STATE_PATH' }); await fs.unlink(dataDir); await fs.mkdir(dataDir);
  for (const name of ['state.json', 'store.lock', 'connection.json', 'launch.html']) {
    await fs.symlink(outside, path.join(dataDir, name)); await assert.rejects(Store.open({ dataDir }), { code: 'UNSAFE_STATE_PATH' }); assert.equal(await fs.readFile(outside, 'utf8'), 'unchanged'); await fs.unlink(path.join(dataDir, name));
  }
});

test('single-instance lock refuses live owners and malformed locks, then safely recovers an absent owner', async t => {
  const { dataDir } = await fixture(t); const store = await Store.open({ dataDir }); await assert.rejects(Store.open({ dataDir }), { code: 'STORE_LOCKED' }); await store.close(); const lock = path.join(dataDir, 'store.lock');
  await fs.writeFile(lock, 'broken', { mode: 0o600 }); await assert.rejects(Store.open({ dataDir }), { code: 'INVALID_LOCK' }); assert.equal(await fs.readFile(lock, 'utf8'), 'broken');
  await fs.writeFile(lock, JSON.stringify({ pid: 2147483647, nonce: 'old-instance' })); const recovered = await Store.open({ dataDir }); await recovered.close(); await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
});

test('failed mutations do not poison later writes or accept arbitrary settings, malformed details or identity rewrites', async t => {
  const { root, dataDir } = await fixture(t); const store = await Store.open({ dataDir }); t.after(() => store.close()); const project = await store.createProject({ name: 'Synthetic', roots: [root] }); const chat = await store.createChat({ projectId: project.id });
  assert.throws(() => store.updateSettings({ endpoint: 'https://unapproved.invalid' }), { code: 'INVALID_STATE' });
  assert.throws(() => store.updateChat(chat.id, { id: 'changed' }), { code: 'INVALID_STATE' });
  await assert.rejects(store.appendMessage(chat.id, { role: 'assistant', text: 'bad', details: JSON.parse('{"constructor":"invalid"}') }), { code: 'INVALID_STATE' });
  await assert.rejects(store.appendMessage(chat.id, { role: 'assistant', text: 'x'.repeat(1024 * 1024 + 1) }), { code: 'INVALID_STATE' });
  const message = await store.appendMessage(chat.id, { role: 'assistant', kind: 'reasoning', text: 'Safe synthetic text', status: 'streaming' }); await store.updateMessage(chat.id, message.id, { text: 'Completed synthetic text', status: 'completed' });
  assert.equal(store.snapshot().chats[0].messages.length, 1); assert.equal(store.snapshot().chats[0].messages[0].text, 'Completed synthetic text');
  await store.updateChat(chat.id, { model: 'synthetic-model', reasoning: 'high' });
  await store.updateChat(chat.id, { model: null, reasoning: null });
  assert.equal(Object.hasOwn(store.snapshot().chats[0], 'model'), false); assert.equal(Object.hasOwn(store.snapshot().chats[0], 'reasoning'), false);
});

test('refuses unrelated directories and state path replacement during a running instance', async t => {
  const { root, dataDir } = await fixture(t); await fs.mkdir(dataDir); await fs.writeFile(path.join(dataDir, 'unrelated.txt'), 'keep'); await assert.rejects(Store.open({ dataDir }), { code: 'UNSAFE_STATE_PATH' }); await fs.unlink(path.join(dataDir, 'unrelated.txt'));
  const store = await Store.open({ dataDir }); t.after(() => store.close()); const target = path.join(root, 'outside'); await fs.writeFile(target, 'keep'); const stateFile = path.join(dataDir, 'state.json'); await fs.unlink(stateFile); await fs.symlink(target, stateFile);
  await assert.rejects(store.updateSettings({ theme: 'light' }), { code: 'UNSAFE_STATE_PATH' }); assert.equal(await fs.readFile(target, 'utf8'), 'keep'); assert.equal(store.snapshot().settings.theme, 'dark');
});
