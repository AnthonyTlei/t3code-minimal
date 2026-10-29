import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { CodexSession } from './codex.mjs';
import { resolveExecutable } from './executable.mjs';
import { privateSocket } from './bridge.mjs';
import { createBrowserLaunchFile } from './launch.mjs';
import { authorizeRoots, resolvePath, listFiles, readFile, gitDiff, gitStatus, createWorktree } from './workspace.mjs';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));
const MAX_BODY = 1024 * 1024;
const BUSY = new Set(['running', 'awaiting_approval', 'awaiting_input']);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };

function problem(message, status = 400, code = 'INVALID_REQUEST') { const error = new Error(message); error.status = status; error.code = code; return error; }
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw problem('Unsupported request fields');
  return value;
}
function headers(response) {
  response.setHeader('Content-Security-Policy', CSP);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cache-Control', 'no-store');
}
function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
async function body(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw problem('JSON content type is required', 415);
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw problem('Request exceeds 1 MiB', 413, 'REQUEST_LIMIT');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw problem('Malformed JSON'); }
}
function authenticated(request, token) {
  const supplied = request.headers.authorization;
  if (typeof supplied !== 'string' || supplied.length > 200) return false;
  const actual = Buffer.from(supplied); const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function createApplication({ dataDir, roots, executable = 'codex', port = 3777, staticDir = DIST, sessionFactory, socketPath, bridgeReady, token = randomBytes(32).toString('base64url') } = {}) {
  if (!Array.isArray(roots) || roots.length === 0) throw problem('At least one explicit --root is required');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw problem('Invalid port');
  const allowedRoots = await authorizeRoots(roots);
  if (socketPath && (!bridgeReady || !sessionFactory || port === 0)) throw problem('Private socket mode requires an explicit host bridge and public loopback port');
  if (socketPath) await privateSocket(socketPath);
  const codexExecutable = socketPath ? executable : await resolveExecutable(executable);
  const staticRoot = await fs.realpath(staticDir);
  if (!(await fs.stat(path.join(staticRoot, 'index.html'))).isFile()) throw problem('Build the web UI before starting');
  const store = await Store.open({ dataDir });
  const sessions = new Map(); const sessionStarts = new Map(); const clients = new Map(); const pendingChats = new Set();
  let closing = false; let address; let connectionFile; let browserLaunch;
  const snapshot = () => ({ ...store.snapshot(), roots: allowedRoots, runtime: { cli: 'existing', testMode: Boolean(sessionFactory && !socketPath), mode: socketPath ? 'host-bridge' : 'native' } });
  const findChat = id => {
    const chat = store.snapshot().chats.find(entry => entry.id === id);
    if (!chat) throw problem('Chat not found', 404, 'NOT_FOUND');
    return chat;
  };
  const findProject = id => {
    const project = store.snapshot().projects.find(entry => entry.id === id);
    if (!project) throw problem('Project not found', 404, 'NOT_FOUND');
    return project;
  };
  const isBusy = chat => {
    const native = sessions.get(chat.id)?.session;
    return BUSY.has(chat.status) || pendingChats.has(chat.id) || Boolean(native?.turnId || native?.startingTurn || native?.pendingApprovals?.size);
  };
  async function projectRoots(project) {
    for (const root of project.roots) {
      const canonical = await resolvePath(allowedRoots, root);
      if (canonical !== root) throw problem('A project root changed; authorize it again', 403, 'ROOT_CHANGED');
    }
    return project.roots;
  }
  function sendEvent(client, event) {
    const state = clients.get(client);
    if (!state || client.destroyed) return;
    const encoded = `data: ${JSON.stringify(event)}\n\n`;
    if (state.blocked) {
      const key = event.type === 'chat' ? event.chat.id : event.type;
      if (event.type === 'snapshot') state.pending.clear();
      state.pending.set(key, encoded);
      if ([...state.pending.values()].reduce((total, value) => total + Buffer.byteLength(value), 0) > 40 * 1024 * 1024) client.destroy();
      return;
    }
    state.blocked = !client.write(encoded);
  }
  function notify(chatId) {
    if (closing) return;
    const event = chatId ? { type: 'chat', chat: findChat(chatId) } : { type: 'snapshot', ...snapshot() };
    for (const client of clients.keys()) sendEvent(client, event);
  }
  async function updateChat(id, patch) { const chat = await store.updateChat(id, patch); notify(id); return chat; }
  async function appendMessage(id, value) { const message = await store.appendMessage(id, value); notify(id); return message; }
  function enqueue(entry, work) {
    entry.queue = entry.queue.then(work).catch(async () => {
      entry.failed = true;
      try { await updateChat(entry.chatId, { status: 'error', pendingRequests: [] }); } catch { /* State remains preserved if its limit or storage is exhausted. */ }
      for (const client of clients.keys()) sendEvent(client, { type: 'error', message: 'Could not persist agent activity. The chat was stopped.' });
      await entry.session.close().catch(() => {});
    });
  }
  async function messageFor(entry, key, role, kind) {
    const existing = entry.messages.get(key);
    if (existing) return existing;
    const message = await appendMessage(entry.chatId, { role, kind, text: '', status: 'streaming' });
    entry.messages.set(key, message.id);
    return message.id;
  }
  async function addDelta(entry, key, delta, role = 'assistant', kind = 'text') {
    const id = await messageFor(entry, key, role, kind);
    const message = findChat(entry.chatId).messages.find(item => item.id === id);
    await store.updateMessage(entry.chatId, id, { text: message.text + delta }); notify(entry.chatId);
  }
  async function finishMessages(entry, status) {
    const chat = findChat(entry.chatId);
    for (const id of entry.messages.values()) {
      const message = chat.messages.find(item => item.id === id);
      if (message && ['pending', 'streaming'].includes(message.status)) await store.updateMessage(chat.id, id, { status });
    }
    entry.messages.clear();
  }
  async function handleEvent(entry, event) {
    if (closing || sessions.get(entry.chatId) !== entry) return;
    const chat = findChat(entry.chatId);
    if (event.type === 'thread') await updateChat(chat.id, { nativeThreadId: event.threadId });
    else if (event.type === 'message_delta') await addDelta(entry, `message:${event.itemId ?? 'assistant'}`, event.delta);
    else if (event.type === 'reasoning_delta') await addDelta(entry, `reasoning:${event.itemId ?? 'reasoning'}`, event.delta, 'activity', 'reasoning');
    else if (event.type === 'activity_delta') await addDelta(entry, `activity:${event.itemId ?? 'command'}`, event.delta, 'activity', 'activity');
    else if (event.type === 'activity') {
      const item = event.item;
      if (['userMessage', 'reasoning'].includes(item.type)) return;
      const key = `${item.type === 'agentMessage' ? 'message' : 'activity'}:${item.id || event.itemId || item.type}`;
      const id = await messageFor(entry, key, item.type === 'agentMessage' ? 'assistant' : 'activity', item.type === 'agentMessage' ? 'text' : 'activity');
      const current = findChat(chat.id).messages.find(message => message.id === id);
      const nextText = item.type === 'agentMessage' ? (item.text || current.text) : (item.aggregatedOutput || current.text || (item.command ? `${item.command}\n` : '') || item.title || item.explanation || item.type);
      // Full command output can exceed the transcript detail cap; text has its own larger bound.
      const { aggregatedOutput, changes, ...detail } = item;
      await store.updateMessage(chat.id, id, { text: nextText, details: detail, status: event.stage === 'completed' ? 'completed' : 'streaming' }); notify(chat.id);
    } else if (event.type === 'turn_started') await updateChat(chat.id, { status: 'running', startedAt: Date.now() });
    else if (event.type === 'request_resolved') {
      await updateChat(chat.id, { pendingRequests: chat.pendingRequests.filter(request => request.id !== event.requestId) });
    } else if (event.type === 'turn_completed') {
      const interrupted = ['interrupted', 'cancelled', 'canceled'].includes(event.status);
      const failed = Boolean(event.message) || event.status === 'failed';
      await finishMessages(entry, interrupted ? 'interrupted' : failed ? 'error' : 'completed');
      await updateChat(chat.id, { status: interrupted ? 'interrupted' : failed ? 'error' : 'idle', pendingRequests: [], finishedAt: Date.now() });
      if (failed) await appendMessage(chat.id, { role: 'system', kind: 'error', text: 'Codex reported a turn error. No work was retried.', status: 'error' });
    } else if (event.type === 'error') {
      await appendMessage(chat.id, { role: 'system', kind: 'error', text: event.message, status: 'error' });
      if (!event.willRetry && !entry.session.turnId && !entry.session.startingTurn) await updateChat(chat.id, { status: 'error' });
    }
  }
  async function sessionFor(chat) {
    const existing = sessions.get(chat.id);
    if (existing && !existing.session.closed && !existing.failed) return existing;
    if (sessionStarts.has(chat.id)) return sessionStarts.get(chat.id);
    const creating = createSession(chat);
    sessionStarts.set(chat.id, creating);
    try { return await creating; } finally { sessionStarts.delete(chat.id); }
  }
  async function createSession(chat) {
    const previous = sessions.get(chat.id);
    if (previous) await previous.queue;
    const project = findProject(chat.projectId); const projectAllowed = await projectRoots(project);
    const cwd = await resolvePath(projectAllowed, chat.workspaceRoot);
    const session = sessionFactory ? sessionFactory({ executable: codexExecutable, cwd, roots: projectAllowed }) : new CodexSession({ executable: codexExecutable, cwd, roots: projectAllowed });
    const entry = { chatId: chat.id, session, queue: Promise.resolve(), messages: new Map(), failed: false };
    sessions.set(chat.id, entry);
    session.on('event', event => enqueue(entry, () => handleEvent(entry, event)));
    session.on('request', request => enqueue(entry, async () => {
      if (sessions.get(chat.id) !== entry) return;
      const current = findChat(chat.id);
      await updateChat(chat.id, { status: request.kind === 'question' ? 'awaiting_input' : 'awaiting_approval', pendingRequests: [...current.pendingRequests, request] });
    }));
    session.on('exit', () => enqueue(entry, async () => {
      if (closing || sessions.get(chat.id) !== entry) return;
      const current = findChat(chat.id);
      if (BUSY.has(current.status) || entry.messages.size) {
        await finishMessages(entry, 'interrupted');
        await updateChat(chat.id, { status: 'interrupted', pendingRequests: [], finishedAt: Date.now() });
        await appendMessage(chat.id, { role: 'system', kind: 'error', text: 'Codex exited. This turn was interrupted and was not retried.', status: 'error' });
      }
    }));
    return entry;
  }

  async function api(request, response, url) {
    if (!authenticated(request, token)) throw problem('A local session token is required', 401, 'UNAUTHORIZED');
    if (request.headers['sec-fetch-site'] === 'cross-site') throw problem('Cross-site requests are not allowed', 403, 'ORIGIN_REJECTED');
    const origin = request.headers.origin;
    if (origin !== undefined && !address.origins.includes(origin)) throw problem('Origin is not allowed', 403, 'ORIGIN_REJECTED');
    if (['GET', 'HEAD'].includes(request.method) && Number(request.headers['content-length'] || 0) > 0) throw problem('Unexpected request body');
    const route = url.pathname;
    if (request.method === 'GET' && route === '/api/bootstrap') return json(response, snapshot());
    if (request.method === 'GET' && route === '/api/events') {
      if (clients.size >= 8) throw problem('Too many event streams', 429, 'STREAM_LIMIT');
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const stream = { blocked: false, pending: new Map() }; clients.set(response, stream);
      response.on('drain', () => {
        stream.blocked = false;
        for (const [key, encoded] of stream.pending) {
          stream.pending.delete(key);
          if (!response.write(encoded)) { stream.blocked = true; break; }
        }
      });
      sendEvent(response, { type: 'snapshot', ...snapshot() });
      const heartbeat = setInterval(() => { if (!stream.blocked) stream.blocked = !response.write(': heartbeat\n\n'); }, 15_000); heartbeat.unref();
      response.once('close', () => { clearInterval(heartbeat); clients.delete(response); }); return;
    }
    if (request.method === 'POST' && route === '/api/projects') {
      const input = object(await body(request), ['name', 'roots']);
      if (!Array.isArray(input.roots) || input.roots.length === 0) throw problem('Choose at least one authorized root');
      const canonical = [];
      for (const root of input.roots) canonical.push(await resolvePath(allowedRoots, root));
      const approved = await authorizeRoots(canonical);
      const project = await store.createProject({ name: input.name, roots: approved }); notify(); return json(response, project, 201);
    }
    if (request.method === 'POST' && route === '/api/chats') {
      const input = object(await body(request), ['projectId', 'title', 'workspaceRoot']);
      const project = findProject(input.projectId); await projectRoots(project);
      const cwd = input.workspaceRoot ? await resolvePath(project.roots, input.workspaceRoot) : project.roots[0];
      const chat = await store.createChat({ projectId: project.id, ...(input.title === undefined ? {} : { title: input.title }), workspaceRoot: cwd }); notify(); return json(response, chat, 201);
    }
    const match = route.match(/^\/api\/chats\/([a-f0-9-]+)(?:\/(messages|cancel|responses))?$/);
    if (match) {
      let chat = findChat(match[1]); const action = match[2];
      if (request.method === 'PATCH' && !action) {
        const input = object(await body(request), ['title', 'archived', 'model', 'reasoning', 'workspaceRoot']);
        chat = findChat(chat.id);
        if (isBusy(chat) && Object.keys(input).some(key => key !== 'title')) throw problem('Wait for or cancel the active turn first', 409, 'CHAT_BUSY');
        if ('workspaceRoot' in input) {
          if (chat.nativeThreadId || sessions.has(chat.id) || sessionStarts.has(chat.id)) throw problem('Start a new chat to change its workspace after its CLI has started', 409);
          input.workspaceRoot = await resolvePath(await projectRoots(findProject(chat.projectId)), input.workspaceRoot);
        }
        if ('model' in input || 'reasoning' in input) {
          // Validated against the installed CLI when a turn is explicitly sent.
          for (const key of ['model', 'reasoning']) if (key in input && input[key] !== null && (typeof input[key] !== 'string' || !input[key] || input[key].length > 300)) throw problem(`Invalid ${key}`);
        }
        return json(response, await updateChat(chat.id, input));
      }
      if (request.method === 'POST' && action === 'messages') {
        const input = object(await body(request), ['text', 'model', 'reasoning']);
        chat = findChat(chat.id);
        if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > MAX_BODY - 1024) throw problem('Enter a prompt below 1 MiB');
        if (chat.archived) throw problem('Unarchive this chat before sending', 409);
        if (isBusy(chat)) throw problem('This chat already has an active turn', 409, 'CHAT_BUSY');
        pendingChats.add(chat.id);
        try {
          const entry = await sessionFor(chat);
          await appendMessage(chat.id, { role: 'user', text: input.text, kind: 'text', status: 'completed' });
          await updateChat(chat.id, { status: 'running', startedAt: Date.now(), pendingRequests: [] });
          await entry.session.startThread(chat.nativeThreadId ? { resumeId: chat.nativeThreadId } : {});
          await entry.queue;
          if (entry.cancelled) throw problem('Cancelled before the turn started', 409, 'CANCELLED');
          const model = input.model ?? chat.model; const reasoning = input.reasoning ?? chat.reasoning;
          await entry.session.prompt({ text: input.text, ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}) });
          await entry.queue;
          return json(response, { accepted: true }, 202);
        } catch (error) {
          await updateChat(chat.id, { status: sessions.get(chat.id)?.cancelled ? 'interrupted' : 'error', pendingRequests: [] });
          await appendMessage(chat.id, { role: 'system', kind: 'error', text: error.message || 'Could not start Codex. No work was retried.', status: 'error' });
          throw error;
        } finally { pendingChats.delete(chat.id); }
      }
      if (request.method === 'POST' && action === 'cancel') {
        object(await body(request), []);
        chat = findChat(chat.id);
        const entry = sessions.get(chat.id);
        if (!entry || !isBusy(chat)) throw problem('There is no active turn', 409);
        let result;
        if (!entry.session.turnId) {
          entry.cancelled = true;
          await entry.session.close();
          await updateChat(chat.id, { status: 'interrupted', pendingRequests: [], finishedAt: Date.now() });
          result = { interrupted: true };
        } else result = await entry.session.interrupt();
        await entry.queue;
        return json(response, result);
      }
      if (request.method === 'POST' && action === 'responses') {
        const input = object(await body(request), ['requestId', 'result']); chat = findChat(chat.id); const entry = sessions.get(chat.id);
        if (!entry || !chat.pendingRequests.some(item => item.id === input.requestId)) throw problem('This request is no longer pending', 409);
        const result = await entry.session.respond(input); await entry.queue;
        const current = findChat(chat.id);
        if (BUSY.has(current.status) && current.pendingRequests.length === 0) await updateChat(chat.id, { status: entry.session.turnId ? 'running' : 'idle' });
        return json(response, result);
      }
    }
    if (request.method === 'GET' && route === '/api/capabilities') {
      const chat = findChat(url.searchParams.get('chatId'));
      const entry = await sessionFor(chat); return json(response, await entry.session.capabilities());
    }
    if (request.method === 'PATCH' && route === '/api/settings') {
      const settings = await store.updateSettings(await body(request)); notify(); return json(response, settings);
    }
    if (request.method === 'GET' && ['/api/files', '/api/file', '/api/diff', '/api/git-status'].includes(route)) {
      const project = findProject(url.searchParams.get('projectId')); const authorized = await projectRoots(project);
      const root = url.searchParams.get('root') ?? project.roots[0]; const file = url.searchParams.get('path');
      if (route === '/api/files') return json(response, await listFiles(authorized, { root, ...(file ? { path: file } : {}) }));
      if (route === '/api/file') { const result = await readFile(authorized, file); return json(response, { ...result, text: result.content }); }
      await resolvePath(authorized, root);
      // Linked-worktree metadata can live in another explicitly authorized startup root.
      if (route === '/api/git-status') return json(response, await gitStatus(allowedRoots, root));
      return json(response, await gitDiff(allowedRoots, { root, ...(file ? { path: file } : {}) }));
    }
    if (request.method === 'POST' && route === '/api/worktrees') {
      const input = object(await body(request), ['projectId', 'root', 'destination', 'branch']);
      const project = findProject(input.projectId); await projectRoots(project);
      // Both source and destination require startup authorization; one repo is not permission for a sibling.
      await resolvePath(project.roots, input.root);
      const worktree = await createWorktree(allowedRoots, { root: input.root, destination: input.destination, ...(input.branch ? { branch: input.branch } : {}) });
      const worktreeRoot = worktree.path ?? worktree.destination;
      const nextProject = await store.createProject({ name: `${project.name} · ${input.branch || 'worktree'}`, roots: [worktreeRoot] });
      notify(); return json(response, { worktree, project: nextProject }, 201);
    }
    throw problem('Route not found', 404, 'NOT_FOUND');
  }

  const server = http.createServer(async (request, response) => {
    headers(response);
    try {
      if (closing) throw problem('Server is shutting down', 503);
      if (!address.hosts.includes(request.headers.host) || request.headers['x-forwarded-host'] || request.headers['x-forwarded-proto']) throw problem('Host is not allowed', 403, 'HOST_REJECTED');
      if (!socketPath && !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) throw problem('Loopback access only', 403);
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.length > 16_384) throw problem('Invalid request target');
      const url = new URL(request.url, address.url);
      if (url.pathname === '/healthz' && request.method === 'GET') {
        if (request.headers.origin && !address.origins.includes(request.headers.origin)) throw problem('Origin is not allowed', 403, 'ORIGIN_REJECTED');
        return json(response, { status: 'ok', ready: Boolean(!closing && (!bridgeReady || bridgeReady())), version: '0.1.1' });
      }
      if (url.pathname.startsWith('/api/')) return await api(request, response, url);
      if (request.method !== 'GET' && request.method !== 'HEAD') throw problem('Method not allowed', 405);
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(part => part === '..' || part.startsWith('.'))) throw problem('Invalid asset path', 404);
      const filename = decoded === '/' ? 'index.html' : decoded.slice(1);
      const asset = path.join(staticDir, filename);
      const actual = await fs.realpath(asset);
      if (!(actual.startsWith(`${staticRoot}${path.sep}`)) || (await fs.lstat(asset)).isSymbolicLink()) throw problem('Asset not found', 404);
      const type = MIME[path.extname(asset)]; if (!type) throw problem('Asset type is not served', 404);
      const data = await fs.readFile(actual); response.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length }); response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      const status = error.status ?? (error.code === 'NOT_FOUND' || error.code === 'ENOENT' ? 404 : ['EACCES', 'ROOT_ESCAPE', 'UNSAFE_PATH'].includes(error.code) ? 403 : 400);
      json(response, { error: { code: typeof error.code === 'string' ? error.code : 'OPERATION_FAILED', message: error.message || 'Operation failed' } }, status);
    }
  });
  server.requestTimeout = 35_000; server.headersTimeout = 10_000; server.maxHeadersCount = 40;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath ? { path: socketPath, exclusive: true } : { host: '127.0.0.1', port, exclusive: true }, resolve); });
    if (socketPath) await fs.chmod(socketPath, 0o600);
    const actualPort = socketPath ? port : server.address().port; const url = `http://127.0.0.1:${actualPort}`;
    address = { url, port: actualPort, hosts: [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`], origins: [url, `http://localhost:${actualPort}`] };
    connectionFile = path.join(store.dataDir, 'connection.json');
    try { const stat = await fs.lstat(connectionFile); if (stat.isSymbolicLink() || !stat.isFile()) throw problem('Unsafe connection file'); await fs.unlink(connectionFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const connection = await fs.open(connectionFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await connection.writeFile(JSON.stringify({ url: `${url}/#token=${token}` }) + '\n'); } finally { await connection.close(); }
    browserLaunch = await createBrowserLaunchFile(store.dataDir, `${url}/#token=${token}`);
  } catch (error) { server.close(); await store.close(); throw error; }
  return {
    ...address, token, connectionFile, launchFile: browserLaunch.path, launchUri: browserLaunch.uri, snapshot, store,
    async close() {
      if (closing) return; closing = true;
      for (const client of clients.keys()) client.end(); clients.clear();
      const stopped = new Promise(resolve => server.close(resolve));
      server.closeIdleConnections();
      await Promise.all([...sessions.values()].map(entry => entry.session.close().catch(() => {})));
      await Promise.all([...sessions.values()].map(entry => entry.queue));
      await fs.unlink(connectionFile).catch(() => {}); await fs.unlink(browserLaunch.path).catch(() => {}); await store.close(); await stopped;
    },
  };
}
