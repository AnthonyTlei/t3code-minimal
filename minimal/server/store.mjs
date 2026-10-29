import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_DETAILS = 64 * 1024;
const ACTIVE = new Set(['running', 'awaiting_approval', 'awaiting_input']);
const CHAT_STATUSES = new Set(['idle', ...ACTIVE, 'interrupted', 'error']);
const MESSAGE_STATUSES = new Set(['pending', 'streaming', 'completed', 'interrupted', 'error']);
const ROLES = new Set(['user', 'assistant', 'system', 'activity', 'tool']);
const KINDS = new Set(['text', 'activity', 'reasoning', 'approval', 'question', 'error', 'file_change']);
const CHAT_KEYS = new Set(['id', 'projectId', 'title', 'archived', 'workspaceRoot', 'worktreePath', 'model', 'reasoning', 'nativeThreadId', 'status', 'pendingRequests', 'messages', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt']);
const CHAT_PATCH_KEYS = new Set([...CHAT_KEYS].filter(key => !['id', 'projectId', 'messages', 'createdAt', 'updatedAt'].includes(key)));
const MESSAGE_KEYS = new Set(['id', 'role', 'text', 'kind', 'status', 'details', 'nativeItemId', 'createdAt', 'updatedAt']);
const MESSAGE_PATCH_KEYS = new Set([...MESSAGE_KEYS].filter(key => !['id', 'createdAt'].includes(key)));
const SETTINGS_KEYS = new Set(['theme', 'fontSize', 'wrapCode', 'showActivity', 'selectedChatId']);

function fail(message, code = 'INVALID_STATE') { const error = new Error(message); error.code = code; throw error; }
function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object`);
}
function keys(value, allowed, label) {
  object(value, label);
  if (Object.keys(value).some(key => !allowed.has(key))) fail(`${label} contains an unsupported field`);
}
function string(value, label, max = MAX_TEXT, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max || value.includes('\0')) fail(`${label} is invalid`);
}
function timestamp(value, label) { if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`); }
function json(value, label, max = MAX_DETAILS) {
  const seen = new Set();
  function visit(item, depth = 0) {
    if (depth > 20) fail(`${label} is too deeply nested`);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)) fail(`${label} must contain JSON values`);
    seen.add(item);
    if (Array.isArray(item)) item.forEach(child => visit(child, depth + 1));
    else { object(item, label); for (const [key, child] of Object.entries(item)) { if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${label} contains a forbidden field`); visit(child, depth + 1); } }
    seen.delete(item);
  }
  visit(value);
  if (Buffer.byteLength(JSON.stringify(value)) > max) fail(`${label} is too large`);
}
function validateSettings(settings) {
  keys(settings, SETTINGS_KEYS, 'settings');
  if ('theme' in settings && !['dark', 'light', 'system'].includes(settings.theme)) fail('theme is invalid');
  if ('fontSize' in settings && (!Number.isInteger(settings.fontSize) || settings.fontSize < 12 || settings.fontSize > 24)) fail('fontSize is invalid');
  for (const key of ['wrapCode', 'showActivity']) if (key in settings && typeof settings[key] !== 'boolean') fail(`${key} is invalid`);
  if ('selectedChatId' in settings && settings.selectedChatId !== null) string(settings.selectedChatId, 'selectedChatId', 100);
}
function validateMessage(message) {
  keys(message, MESSAGE_KEYS, 'message');
  string(message.id, 'message id', 100); string(message.text, 'message text', MAX_TEXT, true);
  if (!ROLES.has(message.role)) fail('message role is invalid');
  if ('kind' in message && !KINDS.has(message.kind)) fail('message kind is invalid');
  if ('status' in message && !MESSAGE_STATUSES.has(message.status)) fail('message status is invalid');
  if ('details' in message) json(message.details, 'message details');
  if ('nativeItemId' in message) string(message.nativeItemId, 'native item id', 200);
  timestamp(message.createdAt, 'message createdAt'); timestamp(message.updatedAt, 'message updatedAt');
}
function validateState(state) {
  keys(state, new Set(['format', 'version', 'projects', 'chats', 'settings']), 'state');
  if (state.format !== 't3-code-minimal' || state.version !== 1) fail('Unsupported local state format');
  if (!Array.isArray(state.projects) || state.projects.length > 100 || !Array.isArray(state.chats) || state.chats.length > 500) fail('Project or chat limit exceeded');
  validateSettings(state.settings);
  const projectIds = new Set(); const chatIds = new Set();
  for (const project of state.projects) {
    keys(project, new Set(['id', 'name', 'roots', 'createdAt']), 'project');
    string(project.id, 'project id', 100); string(project.name, 'project name', 200); timestamp(project.createdAt, 'project createdAt');
    if (projectIds.has(project.id)) fail('Duplicate project id'); projectIds.add(project.id);
    if (!Array.isArray(project.roots) || !project.roots.length || project.roots.length > 32) fail('Project roots are invalid');
    for (const root of project.roots) { string(root, 'project root', 4096); if (!path.isAbsolute(root)) fail('Project root must be absolute'); }
    if (new Set(project.roots).size !== project.roots.length) fail('Duplicate project root');
  }
  for (const chat of state.chats) {
    keys(chat, CHAT_KEYS, 'chat');
    string(chat.id, 'chat id', 100); string(chat.projectId, 'chat project', 100); string(chat.title, 'chat title', 300);
    if (chatIds.has(chat.id)) fail('Duplicate chat id'); chatIds.add(chat.id);
    const project = state.projects.find(item => item.id === chat.projectId); if (!project) fail('Chat project is missing');
    if (typeof chat.archived !== 'boolean' || !CHAT_STATUSES.has(chat.status)) fail('Chat status is invalid');
    string(chat.workspaceRoot, 'workspace root', 4096); if (!path.isAbsolute(chat.workspaceRoot)) fail('Workspace root must be absolute');
    for (const key of ['model', 'reasoning', 'nativeThreadId']) if (key in chat) string(chat[key], key, 300);
    if ('worktreePath' in chat) { string(chat.worktreePath, 'worktree path', 4096); if (!path.isAbsolute(chat.worktreePath)) fail('Worktree path must be absolute'); }
    for (const key of ['createdAt', 'updatedAt', 'startedAt', 'finishedAt']) if (key in chat) timestamp(chat[key], key);
    if (!Array.isArray(chat.pendingRequests) || chat.pendingRequests.length > 100) fail('Pending requests are invalid');
    for (const request of chat.pendingRequests) {
      keys(request, new Set(['id', 'method', 'params', 'kind', 'allowedDecisions']), 'pending request');
      if (!(typeof request.id === 'string' && request.id.length <= 200) && !(Number.isSafeInteger(request.id))) fail('Pending request id is invalid');
      string(request.method, 'request method', 300); json(request.params, 'request params');
      if ('kind' in request) string(request.kind, 'request kind', 100);
      if ('allowedDecisions' in request) json(request.allowedDecisions, 'allowed decisions');
    }
    if (!Array.isArray(chat.messages) || chat.messages.length > 5000) fail('Message limit exceeded');
    const messageIds = new Set(); for (const message of chat.messages) { validateMessage(message); if (messageIds.has(message.id)) fail('Duplicate message id'); messageIds.add(message.id); }
  }
  if (state.settings.selectedChatId !== null && state.settings.selectedChatId !== undefined && !chatIds.has(state.settings.selectedChatId)) fail('Selected chat does not exist');
}

async function noSymlink(file, { optional = false, directory = false } = {}) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail('Local state path has an unsafe file type', 'UNSAFE_STATE_PATH');
  if (process.getuid && stat.uid !== process.getuid()) fail(`Local state must be owned by the current user (${path.basename(file)}: expected UID ${process.getuid()}, effective ${process.geteuid?.()}, observed ${stat.uid})`, 'UNSAFE_STATE_PATH');
  return stat;
}
async function privateRead(file, max) {
  const before = await noSymlink(file); const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (actual.ino !== before.ino || actual.dev !== before.dev || actual.size > max) fail('Local state file changed or exceeds its size limit', 'UNSAFE_STATE_PATH');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
function livePid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail('Malformed store lock', 'INVALID_LOCK');
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; return true; }
}

export class Store {
  static async open({ dataDir }) {
    string(dataDir, 'data directory', 4096);
    const requested = path.resolve(dataDir);
    let dir = await noSymlink(requested, { optional: true, directory: true });
    if (!dir) { await fs.mkdir(requested, { recursive: true, mode: 0o700 }); dir = await noSymlink(requested, { directory: true }); }
    const names = await fs.readdir(requested);
    if (names.some(name => !['state.json', 'store.lock', 'connection.json', 'launch.html', 'attachments'].includes(name) && !/^\.state-[a-f0-9-]+\.tmp$/.test(name))) fail('Use a dedicated local state directory', 'UNSAFE_STATE_PATH');
    for (const name of names) await noSymlink(path.join(requested, name), { directory: name === 'attachments' });
    await fs.chmod(requested, 0o700);
    const canonical = await fs.realpath(requested);
    const store = new Store(canonical, dir);
    await store.#acquire();
    try {
      const stateStat = await noSymlink(store.stateFile, { optional: true });
      if (stateStat) {
        const source = await privateRead(store.stateFile, MAX_STATE_BYTES);
        try { store.state = JSON.parse(source); } catch { fail('Local state is malformed; preserve it for recovery', 'INVALID_STATE'); }
        validateState(store.state); await fs.chmod(store.stateFile, 0o600);
      } else store.state = { format: 't3-code-minimal', version: 1, projects: [], chats: [], settings: { theme: 'dark', fontSize: 14, wrapCode: false, showActivity: true, selectedChatId: null } };
      let recovered = !stateStat;
      for (const chat of store.state.chats) {
        if (ACTIVE.has(chat.status) || chat.pendingRequests.length) {
          chat.status = 'interrupted'; chat.pendingRequests = []; chat.finishedAt = Date.now(); chat.updatedAt = chat.finishedAt; recovered = true;
        }
        for (const message of chat.messages) if (['pending', 'streaming'].includes(message.status)) { message.status = 'interrupted'; message.updatedAt = Date.now(); recovered = true; }
      }
      if (recovered) await store.#write(store.state);
      return store;
    } catch (error) { await store.close(); throw error; }
  }

  constructor(dataDir, directoryStat) {
    this.dataDir = dataDir; this.directoryStat = directoryStat; this.stateFile = path.join(dataDir, 'state.json'); this.lockFile = path.join(dataDir, 'store.lock'); this.state = null; this.lockNonce = randomUUID(); this.queue = Promise.resolve(); this.closed = false; this.closing = false; this.closePromise = null;
  }
  async #acquire() {
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle;
      try { handle = await fs.open(this.lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await noSymlink(this.lockFile); let lock;
        try { lock = JSON.parse(await privateRead(this.lockFile, 4096)); } catch { fail('Store lock is malformed; inspect it manually', 'INVALID_LOCK'); }
        keys(lock, new Set(['pid', 'nonce']), 'store lock'); string(lock.nonce, 'lock nonce', 100);
        if (livePid(lock.pid)) fail('Local state is already open in another server', 'STORE_LOCKED');
        const current = await noSymlink(this.lockFile); if (current.ino !== stat.ino || current.dev !== stat.dev) fail('Store lock changed', 'STORE_LOCKED');
        await fs.unlink(this.lockFile); continue;
      }
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: this.lockNonce })); await handle.sync(); } finally { await handle.close(); }
      return;
    }
    fail('Could not acquire local state lock', 'STORE_LOCKED');
  }
  async #directorySafe() {
    const stat = await noSymlink(this.dataDir, { directory: true });
    if (stat.ino !== this.directoryStat.ino || stat.dev !== this.directoryStat.dev) fail('State directory was replaced', 'UNSAFE_STATE_PATH');
  }
  async #write(state) {
    validateState(state); const data = JSON.stringify(state, null, 2) + '\n'; if (Buffer.byteLength(data) > MAX_STATE_BYTES) fail('Local history exceeds the 32 MiB state limit', 'STATE_LIMIT');
    await this.#directorySafe(); await noSymlink(this.stateFile, { optional: true });
    const temporary = path.join(this.dataDir, `.state-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(data); await handle.sync(); } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; } finally { await handle.close(); }
    try { await this.#directorySafe(); await noSymlink(this.stateFile, { optional: true }); await fs.rename(temporary, this.stateFile); }
    catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    const directory = await fs.open(this.dataDir, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
  }
  #mutate(operation) {
    if (this.closing) fail('Store is closing', 'STORE_CLOSED');
    const result = this.queue.then(async () => {
      if (this.closed) fail('Store is closed', 'STORE_CLOSED');
      const next = structuredClone(this.state); const output = operation(next); await this.#write(next); this.state = next; return structuredClone(output);
    });
    this.queue = result.catch(() => {}); return result;
  }
  snapshot() { if (this.closed) fail('Store is closed', 'STORE_CLOSED'); return structuredClone(this.state); }
  createProject({ name, roots }) {
    return this.#mutate(state => { const project = { id: randomUUID(), name, roots: structuredClone(roots), createdAt: Date.now() }; state.projects.push(project); return project; });
  }
  createChat({ projectId, title = 'New chat', workspaceRoot, worktreePath }) {
    return this.#mutate(state => {
      const project = state.projects.find(item => item.id === projectId); if (!project) fail('Project not found', 'NOT_FOUND');
      const now = Date.now(); const chat = { id: randomUUID(), projectId, title, archived: false, workspaceRoot: workspaceRoot ?? project.roots[0], status: 'idle', pendingRequests: [], messages: [], createdAt: now, updatedAt: now };
      if (worktreePath !== undefined) chat.worktreePath = worktreePath;
      state.chats.push(chat); return chat;
    });
  }
  updateChat(id, patch) {
    keys(patch, CHAT_PATCH_KEYS, 'chat update');
    return this.#mutate(state => {
      const chat = state.chats.find(item => item.id === id); if (!chat) fail('Chat not found', 'NOT_FOUND');
      Object.assign(chat, structuredClone(patch), { updatedAt: Date.now() });
      for (const key of ['model', 'reasoning']) if (patch[key] === null) delete chat[key];
      return chat;
    });
  }
  appendMessage(chatId, message) {
    keys(message, MESSAGE_KEYS, 'message');
    return this.#mutate(state => {
      const chat = state.chats.find(item => item.id === chatId); if (!chat) fail('Chat not found', 'NOT_FOUND');
      const now = Date.now(); const entry = { ...structuredClone(message), id: message.id ?? randomUUID(), createdAt: message.createdAt ?? now, updatedAt: message.updatedAt ?? now };
      chat.messages.push(entry); chat.updatedAt = now; return entry;
    });
  }
  updateMessage(chatId, messageId, patch) {
    keys(patch, MESSAGE_PATCH_KEYS, 'message update');
    return this.#mutate(state => { const chat = state.chats.find(item => item.id === chatId); const message = chat?.messages.find(item => item.id === messageId); if (!message) fail('Message not found', 'NOT_FOUND'); Object.assign(message, structuredClone(patch), { updatedAt: Date.now() }); chat.updatedAt = message.updatedAt; return message; });
  }
  updateSettings(patch) {
    validateSettings(patch); return this.#mutate(state => { Object.assign(state.settings, structuredClone(patch)); return state.settings; });
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.queue; if (this.closed) return; this.closed = true;
      try { const lock = JSON.parse(await privateRead(this.lockFile, 4096)); if (lock.pid === process.pid && lock.nonce === this.lockNonce) await fs.unlink(this.lockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    })();
    return this.closePromise;
  }
}
