import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CodexSession } from '../server/codex.mjs';
import { createApplication } from '../server/server.mjs';
import { authorizeRoots, gitStatus } from '../server/workspace.mjs';

const execute = promisify(execFile);

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 't3-independent-security-'));
  const root = path.join(base, 'workspace'); const staticDir = path.join(base, 'assets');
  await fs.mkdir(root); await fs.mkdir(staticDir);
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><p>Synthetic static app</p>');
  await fs.writeFile(path.join(base, 'outside.html'), 'SYNTHETIC_PRIVATE_OUTSIDE');
  await fs.symlink(path.join(base, 'outside.html'), path.join(staticDir, 'escape.html'));
  const app = await createApplication({ dataDir: path.join(base, 'state'), roots: [root], port: 0, staticDir });
  t.after(async () => { await app.close(); await fs.rm(base, { recursive: true, force: true }); });
  return { app, base, root, staticDir };
}

function request(app, requestPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(`${app.url}${requestPath}`, { method, headers }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, text: Buffer.concat(chunks).toString('utf8') }));
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

test('independent auth checks reject hostile hosts/origins, CSRF forms, query tokens and removed routes', async t => {
  const { app } = await fixture(t);
  const auth = { Authorization: `Bearer ${app.token}` };
  for (const route of ['/api/bootstrap', '/api/events', `/api/bootstrap?token=${app.token}`]) assert.equal((await request(app, route)).status, 401);
  for (const headers of [
    { ...auth, Host: 'hostile.invalid' },
    { ...auth, Origin: 'https://hostile.invalid' },
    { ...auth, Origin: 'null' },
    { ...auth, 'Sec-Fetch-Site': 'cross-site' },
    { ...auth, 'X-Forwarded-Host': `127.0.0.1:${app.port}` },
  ]) assert.equal((await request(app, '/api/bootstrap', { headers })).status, 403);
  const csrf = await request(app, '/api/projects', { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '{"name":"synthetic","roots":[]}' });
  assert.equal(csrf.status, 415);
  const bootstrap = await request(app, '/api/bootstrap', { headers: auth });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.headers['access-control-allow-origin'], undefined);
  assert.equal(bootstrap.text.includes(app.token), false);
  for (const route of ['/api/relay/install', '/api/providers/install', '/api/update', '/api/title', '/api/feedback', '/api/auth/login']) assert.equal((await request(app, route, { headers: auth })).status, 404);
  assert.deepEqual(JSON.parse(bootstrap.text).chats, []);
});

test('independent static checks deny private paths and symlinks with a restrictive resource policy', async t => {
  const { app } = await fixture(t);
  const index = await request(app, '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-security-policy'], /default-src 'none'/);
  assert.match(index.headers['content-security-policy'], /connect-src 'self'/);
  assert.match(index.headers['content-security-policy'], /frame-src 'none'/);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  for (const route of ['/escape.html', '/%2e%2e/outside.html', '/%252e%252e/outside.html', '/.codex/auth.json', '/%00.html', '/%5c..%5coutside.html']) {
    const result = await request(app, route);
    assert.ok(result.status >= 400, `${route} must be refused`);
    assert.doesNotMatch(result.text, /SYNTHETIC_PRIVATE_OUTSIDE/);
  }
  const connection = await fs.stat(app.connectionFile);
  assert.equal(connection.mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(app.connectionFile))).mode & 0o777, 0o700);
});

test('independent approval parser rejects inactive/stale turns and respects restrictive native decisions', async () => {
  const session = new CodexSession({ cwd: process.cwd(), roots: [process.cwd()] });
  session.threadId = 'synthetic-thread';
  const frames = []; const shown = [];
  session._write = frame => frames.push(frame);
  session.on('request', value => shown.push(value));
  const incoming = id => ({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'synthetic-thread', turnId: 'synthetic-turn', command: 'printf synthetic', availableDecisions: ['decline', 'cancel'] } });
  session._serverRequest(incoming(1));
  assert.equal(shown.length, 0);
  assert.equal(frames.at(-1).error.code, -32601);
  session.turnId = 'synthetic-turn';
  session._serverRequest(incoming(2));
  assert.deepEqual(shown[0].allowedDecisions, ['decline', 'cancel']);
  await assert.rejects(session.respond({ requestId: 2, result: { decision: 'accept' } }));
  await session.respond({ requestId: 2, result: { decision: 'decline' } });
  assert.deepEqual(frames.at(-1).result, { decision: 'decline' });
  session.turnId = null;
  session._serverRequest(incoming(3));
  assert.equal(shown.length, 1);
  assert.equal(frames.at(-1).error.code, -32601);
  session.closed = true;
});

test('independent executable boundary refuses workspace shadowing through relative PATH entries', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 't3-executable-boundary-'));
  const root = path.join(base, 'workspace'); const tools = path.join(base, 'trusted-tools');
  await fs.mkdir(root); await fs.mkdir(tools);
  const originalPath = process.env.PATH;
  let systemGit;
  for (const directory of originalPath.split(path.delimiter).filter(path.isAbsolute)) {
    const candidate = path.join(directory, 'git');
    try { await fs.access(candidate, 1); systemGit = candidate; break; } catch { /* Inspect existing absolute search entries only. */ }
  }
  assert.ok(systemGit);
  await execute(systemGit, ['init', '-q'], { cwd: root });
  const marker = path.join(root, 'must-not-execute');
  const malicious = `#!/bin/sh\nprintf synthetic > '${marker}'\nexit 42\n`;
  await fs.writeFile(path.join(root, '.git', 'git'), malicious, { mode: 0o755 });
  await fs.writeFile(path.join(root, 'synthetic-approved-codex'), malicious, { mode: 0o755 });
  const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
  await fs.writeFile(path.join(tools, 'synthetic-approved-codex'), `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o755 });
  const session = new CodexSession({ executable: 'synthetic-approved-codex', cwd: root, roots: [root] });
  t.after(async () => { process.env.PATH = originalPath; await session.close(); await fs.rm(base, { recursive: true, force: true }); });
  process.env.PATH = `.${path.delimiter}${tools}${path.delimiter}${originalPath}`;
  await gitStatus(await authorizeRoots([root]), root).catch(() => {});
  const gitRan = await fs.access(marker).then(() => true, () => false);
  await fs.unlink(marker).catch(() => {});
  await session.start().catch(() => {});
  const codexRan = await fs.access(marker).then(() => true, () => false);
  assert.equal(gitRan, false, 'Git executable must not resolve in repository metadata');
  assert.equal(codexRan, false, 'Codex executable must not resolve in its project cwd');
});
