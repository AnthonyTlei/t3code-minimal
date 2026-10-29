import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 't3-local-release-smoke-'));
let app;
try {
  execFileSync('tar', ['-xzf', path.join(root, 'release', `t3code-local-${version}.tar.gz`), '-C', temporary]);
  const extracted = path.join(temporary, `t3code-local-${version}`);
  const manifest = JSON.parse(await fs.readFile(path.join(extracted, 'MANIFEST.json'), 'utf8'));
  const prefix = `t3code-local-${version}`;
  // Read USTAR headers as data: tar listings hide owner names and PAX metadata.
  const tarBytes = gunzipSync(await fs.readFile(path.join(root, 'release', `${prefix}.tar.gz`)));
  const textField = (header, offset, length) => header.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '').trim();
  for (let offset = 0; offset + 512 <= tarBytes.length; ) {
    const header = tarBytes.subarray(offset, offset + 512); if (header.every(value => value === 0)) break;
    assert.ok(['0', '5', ''].includes(textField(header, 156, 1)), 'Archive contains links or extended metadata');
    assert.equal(parseInt(textField(header, 108, 8), 8), 0, 'Archive contains a builder UID');
    assert.equal(parseInt(textField(header, 116, 8), 8), 0, 'Archive contains a builder GID');
    for (const owner of [textField(header, 265, 32), textField(header, 297, 32)]) assert.ok(['', 'root', '0'].includes(owner), 'Archive contains a builder account name');
    assert.equal(parseInt(textField(header, 136, 12), 8), manifest.sourceDateEpoch, 'Archive contains an unnormalized timestamp');
    const size = parseInt(textField(header, 124, 12), 8); assert.ok(Number.isSafeInteger(size) && size >= 0);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const allowedEntries = new Set([prefix]);
  for (const relative of [...manifest.files.map(file => file.path), 'MANIFEST.json']) {
    const segments = [prefix, ...relative.split('/')];
    for (let length = 1; length <= segments.length; length++) allowedEntries.add(segments.slice(0, length).join('/'));
  }
  const entries = execFileSync('tar', ['-tzf', path.join(root, 'release', `${prefix}.tar.gz`)], { encoding: 'utf8' }).trim().split('\n');
  for (const entry of entries) assert.ok(allowedEntries.has(entry.replace(/\/$/, '')), `Unmanifested archive entry: ${entry}`);
  for (const file of manifest.files) assert.equal(createHash('sha256').update(await fs.readFile(path.join(extracted, file.path))).digest('hex'), file.sha256);
  await assert.rejects(fs.stat(path.join(extracted, 'node_modules')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(extracted, 'minimal', 'test')), { code: 'ENOENT' });
  const workspace = path.join(temporary, 'synthetic-workspace'); await fs.mkdir(workspace);
  const { createApplication } = await import(pathToFileURL(path.join(extracted, 'minimal/server/server.mjs')));
  const executable = path.join(root, 'minimal/test/fake-codex.mjs');
  app = await createApplication({ roots: [workspace], dataDir: path.join(temporary, 'state'), executable, port: 0 });
  const api = async (route, body) => {
    const response = await fetch(app.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${app.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok); return response.json();
  };
  assert.equal((await fetch(app.url)).status, 200);
  const project = await api('/api/projects', { name: 'Release smoke', roots: app.snapshot().roots });
  const chat = await api('/api/chats', { projectId: project.id });
  const stream = await fetch(app.url + '/api/events', { headers: { Authorization: `Bearer ${app.token}` } });
  const reader = stream.body.getReader(); let buffer = ''; const decoder = new TextDecoder();
  await api(`/api/chats/${chat.id}/messages`, { text: 'release archive' });
  let completed = false;
  while (!completed) {
    const { done, value } = await reader.read(); assert.equal(done, false); buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (!frame.startsWith('data: ')) continue;
      const event = JSON.parse(frame.slice(6));
      completed ||= event.type === 'chat' && event.chat.id === chat.id && event.chat.status === 'idle' && event.chat.messages.some(message => message.text === 'Synthetic response: release archive');
    }
  }
  await reader.cancel();
  console.log(`Release smoke passed: ${manifest.files.length} hashes verified, private archive metadata excluded, standalone assets served, authenticated fake-CLI chat streamed, no node_modules or test adapter shipped.`);
} finally { await app?.close(); await fs.rm(temporary, { recursive: true, force: true }); }
