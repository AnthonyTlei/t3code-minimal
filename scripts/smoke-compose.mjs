import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
const temporary = await fs.mkdtemp('/tmp/t3pkg-');
const base = await fs.realpath(temporary);
const project = path.join(base, `t3code-local-${version}`);
const temporaryProjectName = 't3local-' + createHash('sha256').update(project).digest('hex').slice(0, 12);
const workspace = path.join(base, 'workspace');
const report = { result: 'incomplete', platform: `${os.platform()}/${os.arch()}`, checks: [], model: 'deterministic host fake CLI', secretsRetained: false };
const env = { ...process.env, T3_MINIMAL_SYNTHETIC_MARKER: 'compose-host-inheritance' };
let started = false; let browser; let syntheticVolume = temporaryProjectName + '_appdata'; const secrets = [];
const sanitized = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value));
const run = async (command, args, cwd = project) => execute(command, args, { cwd, env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
const manage = (...args) => run('python3', ['scripts/manage.py', ...args]);
const make = (...args) => run('make', args);
const check = name => report.checks.push(name);
async function freePort() {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
async function waitChat(url, token, id, predicate, action) {
  const controller = new AbortController();
  const response = await fetch(url + '/api/events', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  try {
    await action();
    for (;;) {
      const chunk = await reader.read(); assert.equal(chunk.done, false); buffer += decoder.decode(chunk.value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (!frame.startsWith('data: ')) continue;
        const event = JSON.parse(frame.slice(6)); const chat = event.type === 'chat' ? event.chat : event.chats?.find(value => value.id === id);
        if (chat?.id === id && predicate(chat)) return chat;
      }
    }
  } finally { controller.abort(); await reader.cancel().catch(() => {}); }
}

try {
  await run('tar', ['-xzf', path.join(source, 'release', `t3code-local-${version}.tar.gz`), '-C', base], source);
  await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'example.txt'), 'before\n');
  await run('git', ['init', '-q'], workspace); await run('git', ['add', 'example.txt'], workspace);
  await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Synthetic baseline'], workspace);
  await fs.writeFile(path.join(workspace, 'example.txt'), 'after\n');
  // Capture the real Make open handoff without opening the user's desktop browser.
  const openerBin = path.join(base, 'opener-bin'); await fs.mkdir(openerBin);
  const openerCapture = path.join(base, 'opener.json');
  await fs.writeFile(path.join(openerBin, process.platform === 'darwin' ? 'open' : 'xdg-open'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(openerCapture)},JSON.stringify(process.argv.slice(2)),{mode:384});\n`, { mode: 0o755 });
  env.PATH = [openerBin, path.dirname(process.execPath), env.PATH].join(path.delimiter);
  const port = await freePort();
  await manage('configure', '--root', workspace, '--root', project, '--codex', path.join(source, 'minimal/test/fake-codex.mjs'), '--port', String(port));
  await make('doctor');
  started = true;
  await make('up'); await make('health'); await make('status');
  check('extracted archive configured, built prebuilt image, started with Make, and passed doctor/status/health');
  let launch; let url; let token;
  async function connect() {
    launch = JSON.parse(await fs.readFile(path.join(project, '.local-state/run/connection.json'), 'utf8')).url;
    const parsed = new URL(launch); url = parsed.origin; token = new URLSearchParams(parsed.hash.slice(1)).get('token'); secrets.push(token);
    const identity = JSON.parse(await fs.readFile(path.join(project, '.local-state/run/manager.json'), 'utf8')); secrets.push(identity.nonce);
  }
  await connect();
  await make('open');
  let openerArgs;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { openerArgs = JSON.parse(await fs.readFile(openerCapture, 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(openerArgs?.length, 1); const launchUri = openerArgs[0];
  assert.equal(launchUri.startsWith('file://'), true); assert.equal(launchUri.includes(token), false); assert.equal(launchUri.includes('#'), false);
  assert.equal((await fs.stat(fileURLToPath(launchUri))).mode & 0o777, 0o600);
  check('make open gives the OS opener only a private file URI, with no bearer capability in argv');
  const api = async (route, method = 'GET', data) => {
    const response = await fetch(url + route, { method, headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const value = await response.json(); assert.ok(response.ok, `${method} ${route}: ${value.error?.message || 'Local request failed'}`); return value;
  };
  assert.equal((await fetch(url + '/api/bootstrap')).status, 401);
  assert.deepEqual(await (await fetch(url + '/healthz')).json(), { status: 'ok', ready: true, version });
  assert.equal((await fs.readdir(workspace)).some(name => name.startsWith('.fake-codex')), false);
  check('health is private-data-free and no CLI starts on cold start or readiness checks');
  const workspaceProject = await api('/api/projects', 'POST', { name: 'Docker workspace', roots: [workspace] });
  const first = await api('/api/chats', 'POST', { projectId: workspaceProject.id, title: 'Docker browser' });
  const second = await api('/api/chats', 'POST', { projectId: workspaceProject.id, title: 'Independent Docker chat' });
  const privateProject = await api('/api/projects', 'POST', { name: 'Packaging root', roots: [project] });
  const privateRead = await fetch(url + `/api/file?projectId=${privateProject.id}&path=${encodeURIComponent(path.join(project, '.local-state/run/manager.json'))}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.ok([403, 404].includes(privateRead.status)); check('workspace overlap cannot expose masked private control state');
  browser = await chromium.launch({ headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const requests = []; const errors = [];
  page.on('request', request => requests.push(request.url())); page.on('pageerror', error => errors.push(error.message));
  await page.goto(launchUri); await page.getByText('Connected locally', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Docker browser', exact: true }).first().click();
  async function send(text) { await page.getByRole('textbox', { name: 'Message Codex' }).fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click(); }
  await send('container browser'); await page.getByRole('article', { name: 'assistant message' }).filter({ hasText: 'Synthetic response: container browser' }).waitFor();
  await send('approval'); await page.getByRole('button', { name: 'Approve once', exact: true }).click();
  await page.getByRole('article', { name: 'assistant message' }).filter({ hasText: 'Approval decision: accept' }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), ''); assert.deepEqual(errors, []);
  assert.ok(requests.every(request => request === launchUri || request.startsWith(url)));
  await page.screenshot({ path: path.join(source, 'output/playwright/compose-workspace.png'), fullPage: true });
  check('real browser loaded container assets, streamed host-CLI work and answered one-time approval through Docker stdio');
  const active = await waitChat(url, token, second.id, chat => chat.status === 'running', () => api(`/api/chats/${second.id}/messages`, 'POST', { text: 'hold' }));
  assert.equal(active.status, 'running');
  await waitChat(url, token, second.id, chat => chat.status === 'interrupted', () => api(`/api/chats/${second.id}/cancel`, 'POST', {}));
  const question = await waitChat(url, token, first.id, chat => chat.status === 'awaiting_input', () => api(`/api/chats/${first.id}/messages`, 'POST', { text: 'question' }));
  await waitChat(url, token, first.id, chat => chat.status === 'idle' && chat.messages.some(message => message.text === 'Answer: B'), () => api(`/api/chats/${first.id}/responses`, 'POST', { requestId: question.pendingRequests[0].id, result: { answers: { choice: { answers: ['B'] } } } }));
  check('independent sessions, native questions and cancellation work through the packaged host bridge');
  const startup = JSON.parse(await fs.readFile(path.join(workspace, '.fake-codex-startup.json'), 'utf8'));
  assert.deepEqual(startup.args, ['app-server']); assert.equal(startup.cwd, workspace); assert.equal(startup.marker, env.T3_MINIMAL_SYNTHETIC_MARKER);
  const worktree = await api('/api/worktrees', 'POST', { projectId: workspaceProject.id, root: workspace, destination: path.join(workspace, 'isolated'), branch: 'docker-isolation' });
  assert.deepEqual((await api(`/api/git-status?projectId=${worktree.project.id}&root=${encodeURIComponent(worktree.project.roots[0])}`)).entries, []);
  const diff = await api(`/api/diff?projectId=${workspaceProject.id}&root=${encodeURIComponent(workspace)}`); assert.match(diff.diff, /-before\n\+after/);
  check('existing host CLI argv/environment are preserved, and container Git diffs/worktrees stay functional');
  await api(`/api/chats/${first.id}`, 'PATCH', { title: 'Persisted Docker history', archived: true });
  const nativeId = (await api('/api/bootstrap')).chats.find(chat => chat.id === first.id).nativeThreadId;
  await page.goto('about:blank'); await make('restart'); await connect(); await make('health');
  let snapshot = await api('/api/bootstrap'); assert.equal(snapshot.chats.find(chat => chat.id === first.id).title, 'Persisted Docker history'); assert.equal(snapshot.chats.find(chat => chat.id === first.id).archived, true);
  await api(`/api/chats/${first.id}`, 'PATCH', { archived: false });
  await waitChat(url, token, first.id, chat => chat.status === 'idle' && chat.messages.some(message => message.text === 'Synthetic response: Docker resume'), () => api(`/api/chats/${first.id}/messages`, 'POST', { text: 'Docker resume' }));
  snapshot = await api('/api/bootstrap'); assert.equal(snapshot.chats.find(chat => chat.id === first.id).nativeThreadId, nativeId);
  const identityBefore = await fs.readFile(path.join(project, '.local-state/run/manager.json'), 'utf8'); await make('on');
  assert.equal(await fs.readFile(path.join(project, '.local-state/run/manager.json'), 'utf8'), identityBefore);
  check('restart preserves history/native resume and repeated make on is idempotent');
  const { stdout: logs } = await manage('logs', '--no-follow'); for (const secret of secrets) assert.equal(logs.includes(secret), false);
  const composeProject = temporaryProjectName;
  const { stdout: ids } = await run('docker', ['ps', '--filter', `label=com.docker.compose.project=${composeProject}`, '--format', '{{.ID}}']);
  const id = ids.trim(); assert.ok(id);
  const { stdout: inspection } = await run('docker', ['inspect', id]); const container = JSON.parse(inspection)[0];
  assert.equal(container.HostConfig.NetworkMode, 'none'); assert.equal(container.HostConfig.ReadonlyRootfs, true); assert.deepEqual(container.HostConfig.CapDrop, ['ALL']); assert.deepEqual(container.HostConfig.PortBindings, {});
  assert.ok(!container.Mounts.some(mount => mount.Source?.includes('docker.sock')));
  syntheticVolume = container.Mounts.find(mount => mount.Destination === '/data')?.Name;
  assert.ok(syntheticVolume?.startsWith(composeProject + '_'));
  const { stdout: denied } = await run('docker', ['exec', id, 'node', '-e', 'const s=require("node:net").connect({host:"198.51.100.42",port:443});s.on("connect",()=>process.exit(1));s.on("error",e=>{console.log(e.code);process.exit(e.code==="ENETUNREACH"?0:1)});']);
  assert.match(denied, /ENETUNREACH/); check('actual container is network-none/read-only/capability-dropped with no ports or Docker socket; isolated positive probe is blocked');
  const { stdout: imagePlatform } = await run('docker', ['image', 'inspect', container.Image, '--format', '{{.Os}}/{{.Architecture}}']);
  report.image = container.Image; report.browser = browser.version(); report.container = { platform: imagePlatform.trim(), networkMode: container.HostConfig.NetworkMode, readonly: true, capDrop: container.HostConfig.CapDrop };
  await browser.close(); browser = null;
  await make('off'); started = false;
  await assert.rejects(fs.stat(path.join(project, '.local-state/run/launch.html')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(project, '.local-state/run/connection.json')), { code: 'ENOENT' });
  await assert.rejects(make('health'));
  await run('docker', ['volume', 'inspect', syntheticVolume]);
  check('logs omit exact launch/control tokens and make off preserves state while health fails');
  started = true; await make('up', 'NO_BUILD=1'); await connect(); await make('health');
  assert.equal((await api('/api/bootstrap')).chats.find(chat => chat.id === first.id).title, 'Persisted Docker history');
  await make('off'); started = false;
  check('NO_BUILD=1 starts the staged image after complete shutdown and retains persisted history');
  report.sourceHashes = {};
  for (const relative of ['Dockerfile', 'compose.yaml', 'Makefile', 'scripts/manage.py', ...(await fs.readdir(path.join(source, 'minimal/server'))).filter(name => name.endsWith('.mjs')).map(name => 'minimal/server/' + name)]) {
    report.sourceHashes[relative] = createHash('sha256').update(await fs.readFile(path.join(project, relative))).digest('hex');
  }
  report.result = 'pass';
  console.log(`Compose release smoke passed: ${report.checks.length} checks; browser, host fake CLI, restart/resume, private state and no-network container verified.`);
} catch (error) {
  report.result = 'fail'; report.error = error.message;
  try {
    const { createHash } = await import('node:crypto'); const name = 't3local-' + createHash('sha256').update(project).digest('hex').slice(0, 12);
    const { stdout } = await run('docker', ['ps', '--filter', `label=com.docker.compose.project=${name}`, '--format', '{{.ID}}']);
    if (stdout.trim()) {
      const { stdout: metadata } = await run('docker', ['exec', stdout.trim(), 'node', '-e', 'const fs=require("node:fs");console.log(JSON.stringify({uid:process.getuid(),files:["/data/private","/data/private/state.json","/data/private/store.lock","/data/private/connection.json"].map(path=>{try{const s=fs.lstatSync(path);return{path,uid:s.uid,gid:s.gid,mode:s.mode&511}}catch{return{path,missing:true}}})}))']);
      report.failureMetadata = JSON.parse(metadata);
    }
  } catch { /* Preserve only metadata from a still-owned synthetic container. */ }
  console.error(`Compose release smoke failed: ${sanitized(error.message)}`); process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (started) await make('off').catch(() => {});
  // Remove only this ephemeral smoke project's synthetic volume after checking retention.
  if (syntheticVolume) {
    try {
      const { stdout } = await run('docker', ['volume', 'inspect', syntheticVolume]);
      if (JSON.parse(stdout)[0].Labels?.['com.docker.compose.project'] === temporaryProjectName) await run('docker', ['volume', 'rm', syntheticVolume]);
    } catch { /* No synthetic volume was created, or Docker is unavailable. */ }
  }
  await fs.mkdir(path.join(source, 'output/packaging'), { recursive: true });
  await fs.writeFile(path.join(source, 'output/packaging/compose-smoke.json'), sanitized(JSON.stringify(report, null, 2)) + '\n');
  await fs.rm(base, { recursive: true, force: true });
}
