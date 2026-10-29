import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { resolveExecutable } from './executable.mjs';

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const APPROVAL_METHODS = new Map([
  ['item/commandExecution/requestApproval', 'command'],
  ['item/fileChange/requestApproval', 'file'],
  ['item/tool/requestUserInput', 'question'],
]);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => (typeof value === 'string' && value.length > 0 && value.length <= 200) || (Number.isSafeInteger(value) && value >= 0);
const requestKey = (id) => JSON.stringify(id);
const inside = (root, target) => target === root || (!path.relative(root, target).startsWith(`..${path.sep}`) && path.relative(root, target) !== '..' && !path.isAbsolute(path.relative(root, target)));
const text = (value, limit = MAX_TEXT_BYTES) => typeof value === 'string' ? value.slice(0, limit) : '';

function requireKeys(value, allowed, label) {
  if (!isObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`Invalid ${label}`);
}

function rpcError(method, code) {
  const error = new Error(`Codex rejected ${method}${Number.isInteger(code) ? ` (code ${code})` : ''}`);
  error.code = Number.isInteger(code) ? code : 'CODEX_REQUEST_FAILED';
  error.method = method;
  return error;
}

function visibleItem(item) {
  if (!isObject(item)) return { type: 'unknown' };
  const result = { id: text(item.id, 200), type: text(item.type, 100) || 'unknown' };
  for (const key of ['text', 'command', 'cwd', 'status', 'aggregatedOutput', 'tool', 'server', 'title']) {
    if (typeof item[key] === 'string') result[key] = text(item[key]);
  }
  if (Number.isInteger(item.exitCode)) result.exitCode = item.exitCode;
  if (Array.isArray(item.changes)) result.changes = item.changes.slice(0, 200).filter(isObject).map((change) => ({ path: text(change.path, 4096), kind: typeof change.kind === 'string' ? change.kind : text(change.kind?.type, 100), diff: text(change.diff) }));
  return result;
}

/** A deliberately narrow stdio client; enterprise policy remains owned by Codex. */
export class CodexSession extends EventEmitter {
  constructor({ executable = 'codex', cwd, roots = [cwd], logger, spawnProcess } = {}) {
    super();
    if (typeof executable !== 'string' || !executable || executable.includes('\0')) throw new Error('A Codex executable is required');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('An absolute working directory is required');
    if (!Array.isArray(roots) || roots.length === 0 || roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) throw new Error('Explicit absolute workspace roots are required');
    this.executable = executable;
    this.cwd = cwd;
    this.roots = [...roots];
    this.logger = typeof logger === 'function' ? logger : () => {};
    this.spawnProcess = spawnProcess;
    this.threadId = null;
    this.turnId = null;
    this.status = 'stopped';
    this.child = null;
    this.pendingRequests = new Map();
    this.pendingApprovals = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.closed = false;
    this.closing = false;
    this.ready = false;
    this.startPromise = null;
    this.threadPromise = null;
    this.capabilitiesPromise = null;
    this.models = null;
    this.startingTurn = false;
    this.awaitingTurnStart = false;
    this.closedPromise = null;
  }

  async start() {
    if (this.closed || this.closing) throw new Error('Codex session is closed');
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start();
    return this.startPromise;
  }

  async _start() {
    if (!this.spawnProcess) {
      try { this.executable = await resolveExecutable(this.executable); }
      catch { throw new Error('Could not launch the configured Codex executable from an absolute PATH directory'); }
    }
    const [canonicalCwd, canonicalRoots] = await Promise.all([realpath(this.cwd), Promise.all(this.roots.map((root) => realpath(root)))]);
    if (!canonicalRoots.some((root) => inside(root, canonicalCwd))) throw new Error('Codex working directory is outside authorized roots');
    this.cwd = canonicalCwd;
    this.roots = canonicalRoots;
    this._status('starting');
    // No command-line config, environment rewrite, provider, auth or policy override.
    this.child = this.spawnProcess ? await this.spawnProcess({ cwd: this.cwd }) : spawn(this.executable, ['app-server'], { cwd: this.cwd, env: process.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._data(chunk));
    // Native diagnostics can contain credentials; consume without retaining or logging.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this._fail(new Error('Codex input pipe failed')));
    this.child.on('error', () => this._fail(new Error('Could not launch the configured Codex executable')));
    this.child.once('exit', (code, signal) => this._exited(code, signal));
    this.child.once('close', (code, signal) => { if (!this.closed) this._exited(code, signal); });
    try {
      await this._request('initialize', { clientInfo: { name: 't3-code-minimal', title: 'T3 Code Minimal', version: '0.1.1' }, capabilities: { experimentalApi: true } });
      this._write({ method: 'initialized' });
      this.ready = true;
      this._status('idle');
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async capabilities() {
    await this.start();
    if (!this.capabilitiesPromise) this.capabilitiesPromise = this._capabilities().catch((error) => { this.capabilitiesPromise = null; throw error; });
    return this.capabilitiesPromise;
  }

  async _capabilities() {
    const models = [];
    const seenCursors = new Set();
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const response = await this._request('model/list', { ...(cursor ? { cursor } : {}), includeHidden: false, limit: 100 });
      if (!isObject(response) || !Array.isArray(response.data)) throw new Error('Codex returned an unsupported model catalog');
      for (const model of response.data) {
        if (!isObject(model) || model.hidden === true || typeof model.model !== 'string' || !model.model || !Array.isArray(model.supportedReasoningEfforts)) continue;
        models.push({ id: model.model, name: text(model.displayName, 200) || model.model, description: text(model.description, 2000), reasoning: model.supportedReasoningEfforts.filter((option) => isObject(option) && typeof option.reasoningEffort === 'string').map((option) => ({ effort: option.reasoningEffort, description: text(option.description, 1000) })), defaultReasoning: typeof model.defaultReasoningEffort === 'string' ? model.defaultReasoningEffort : null, isDefault: model.isDefault === true });
      }
      if (!response.nextCursor) { this.models = models; return { models, additionalRoots: false, policyControls: false }; }
      if (typeof response.nextCursor !== 'string' || seenCursors.has(response.nextCursor)) throw new Error('Codex returned an invalid model cursor');
      cursor = response.nextCursor;
      seenCursors.add(cursor);
    }
    throw new Error('Codex model catalog exceeded the supported page limit');
  }

  async startThread(options = {}) {
    requireKeys(options, ['resumeId'], 'thread options');
    if (options.resumeId !== undefined && (typeof options.resumeId !== 'string' || !options.resumeId || options.resumeId.length > 200)) throw new Error('Invalid native thread identifier');
    await this.start();
    if (this.threadId) {
      if (options.resumeId && options.resumeId !== this.threadId) throw new Error('This session already owns a different native thread');
      return { threadId: this.threadId, policy: this.policy };
    }
    if (!this.threadPromise) this.threadPromise = this._startThread(options);
    return this.threadPromise;
  }

  async _startThread({ resumeId }) {
    try {
      const response = await this._request(resumeId ? 'thread/resume' : 'thread/start', { ...(resumeId ? { threadId: resumeId } : {}), cwd: this.cwd });
      if (!isObject(response?.thread) || typeof response.thread.id !== 'string' || !response.thread.id) throw new Error('Codex returned an unsupported thread response');
      if (resumeId && response.thread.id !== resumeId) throw new Error('Codex resumed a different native thread');
      if (this.threadId && response.thread.id !== this.threadId) throw new Error('Codex thread identifier changed during creation');
      this.threadId = response.thread.id;
      this.policy = { approvalPolicy: response.approvalPolicy ?? null, sandbox: response.sandbox ?? null };
      this._event('thread', { threadId: this.threadId, policy: this.policy });
      return { threadId: this.threadId, policy: this.policy };
    } catch (error) {
      this.threadPromise = null;
      throw error;
    }
  }

  async prompt(options) {
    requireKeys(options, ['text', 'model', 'reasoning'], 'turn options');
    if (typeof options.text !== 'string' || !options.text.trim() || Buffer.byteLength(options.text) > MAX_TEXT_BYTES) throw new Error('A non-empty prompt up to 1 MiB is required');
    if (this.startingTurn || this.turnId) throw new Error('This chat already has an active turn');
    this.startingTurn = true;
    try {
      await this.startThread();
      const params = { threadId: this.threadId, input: [{ type: 'text', text: options.text }] };
      if (options.model !== undefined || options.reasoning !== undefined) {
        const capabilities = await this.capabilities();
        const model = options.model === undefined ? capabilities.models.find((entry) => entry.isDefault) : capabilities.models.find((entry) => entry.id === options.model);
        if (!model) throw new Error('The selected model is not advertised by the installed Codex');
        if (options.model !== undefined) params.model = model.id;
        if (options.reasoning !== undefined) {
          if (typeof options.reasoning !== 'string' || !model.reasoning.some((entry) => entry.effort === options.reasoning)) throw new Error('The selected reasoning effort is not advertised by the installed Codex');
          params.effort = options.reasoning;
        }
      }
      this._status('running');
      this.awaitingTurnStart = true;
      let response;
      try { response = await this._request('turn/start', params); }
      finally { this.awaitingTurnStart = false; }
      if (!isObject(response?.turn) || typeof response.turn.id !== 'string') throw new Error('Codex returned an unsupported turn response');
      // A very short turn can complete before its turn/start response arrives.
      if (this.status !== 'idle') this.turnId = response.turn.id;
      return { threadId: this.threadId, turnId: response.turn.id };
    } catch (error) {
      if (!this.turnId && !this.closed) this._status('idle');
      throw error;
    } finally { this.startingTurn = false; }
  }

  async interrupt() {
    if (!this.turnId) return { interrupted: false };
    const turnId = this.turnId;
    await this._request('turn/interrupt', { threadId: this.threadId, turnId });
    return { interrupted: true, turnId };
  }

  async respond(options) {
    requireKeys(options, ['requestId', 'result'], 'approval response');
    if (!isId(options.requestId)) throw new Error('Invalid approval request identifier');
    const key = requestKey(options.requestId);
    const request = this.pendingApprovals.get(key);
    if (!request) throw new Error('Approval request is no longer pending');
    const result = options.result;
    if (request.kind === 'question') {
      requireKeys(result, ['answers'], 'question response');
      if (!isObject(result.answers)) throw new Error('Question answers are required');
      const questionIds = new Set(request.params.questions.map((question) => question.id));
      if (Object.keys(result.answers).length !== questionIds.size || Object.keys(result.answers).some((id) => !questionIds.has(id))) throw new Error('Answers must match the pending questions');
      for (const answer of Object.values(result.answers)) {
        requireKeys(answer, ['answers'], 'question answer');
        if (!Array.isArray(answer.answers) || answer.answers.length === 0 || answer.answers.length > 16 || answer.answers.some((value) => typeof value !== 'string' || Buffer.byteLength(value) > 64 * 1024)) throw new Error('Invalid question answer');
      }
    } else {
      requireKeys(result, ['decision'], 'approval decision');
      if (!request.allowedDecisions.includes(result.decision)) throw new Error('Only the displayed one-time approval decisions are permitted');
    }
    this._write({ id: options.requestId, result });
    this.pendingApprovals.delete(key);
    this._event('request_resolved', { requestId: options.requestId, reason: 'answered' });
    this._status(this.pendingApprovals.size ? 'waiting' : (this.turnId ? 'running' : 'idle'));
    return { answered: true };
  }

  async close() {
    if (!this.child) { this.closed = true; this._status('stopped'); return; }
    if (this.closed || this.closing) return this.closedPromise;
    for (const request of this.pendingApprovals.values()) {
      try { this._write({ id: request.id, error: { code: -32000, message: 'Client closed before approval' } }); } catch { /* Owned process is already closing. */ }
    }
    this.pendingApprovals.clear();
    this.closing = true;
    this.ready = false;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const force = setTimeout(() => { if (!this.closed) this.child.kill('SIGKILL'); }, 2000);
    force.unref();
    await this.closedPromise;
    clearTimeout(force);
  }

  _status(status) { this.status = status; this._event('status', { status }); }
  _event(type, data = {}) { this.emit('event', { type, threadId: this.threadId, turnId: this.turnId, ...data }); }

  _write(message) {
    if (this.closed || !this.child?.stdin?.writable) throw new Error('Codex input is unavailable');
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) throw new Error('Codex request exceeded the frame limit');
    this.child.stdin.write(`${encoded}\n`);
  }

  _request(method, params) {
    if (this.pendingRequests.size >= 64) return Promise.reject(new Error('Too many pending Codex requests'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingRequests.delete(id); const error = new Error(`Codex did not answer ${method}`); reject(error); this._fail(error); }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pendingRequests.set(id, { method, resolve, reject, timer });
      try { this._write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pendingRequests.delete(id); reject(error); }
    });
  }

  _data(chunk) {
    if (this.closed || this.closing) return;
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const frame = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!frame.trim()) continue;
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) { this._fail(new Error('Codex output frame exceeded the limit')); return; }
      let message;
      try { message = JSON.parse(frame); } catch { this._fail(new Error('Codex sent malformed protocol output')); return; }
      if (!isObject(message)) { this._fail(new Error('Codex sent an invalid protocol message')); return; }
      this._message(message);
    }
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) this._fail(new Error('Codex output frame exceeded the limit'));
  }

  _message(message) {
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) { this._serverRequest(message); return; }
      this._notification(message.method, message.params);
      return;
    }
    if (!isId(message.id)) { this._fail(new Error('Codex sent an invalid response identifier')); return; }
    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;
    this.pendingRequests.delete(message.id);
    clearTimeout(pending.timer);
    if (Object.hasOwn(message, 'error')) pending.reject(rpcError(pending.method, message.error?.code));
    else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
    else pending.reject(new Error(`Codex returned an invalid ${pending.method} response`));
  }

  _serverRequest(message) {
    if (!isId(message.id)) { this._fail(new Error('Codex sent an invalid server request identifier')); return; }
    const params = message.params;
    const kind = APPROVAL_METHODS.get(message.method);
    const validScope = isObject(params) && params.threadId === this.threadId && typeof params.turnId === 'string' && (this.turnId ? params.turnId === this.turnId : this.awaitingTurnStart);
    const validQuestions = kind !== 'question' || (Array.isArray(params?.questions) && params.questions.length > 0 && params.questions.length <= 16 && params.questions.every((question) => isObject(question) && typeof question.id === 'string' && question.id.length > 0 && question.id.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(question.id) && typeof question.question === 'string' && question.isSecret !== true) && new Set(params.questions.map((question) => question.id)).size === params.questions.length);
    if (!kind || !validScope || !validQuestions || this.pendingApprovals.size >= 32 || this.pendingApprovals.has(requestKey(message.id))) {
      this._write({ id: message.id, error: { code: -32601, message: 'This client does not support this request' } });
      this._event('error', { message: 'Codex requested an unsupported operation; it was not approved', nativeMethod: message.method });
      return;
    }
    let allowedDecisions = kind === 'question' ? undefined : (kind === 'file' && params.grantRoot ? ['decline', 'cancel'] : ['accept', 'decline', 'cancel']);
    if (kind === 'command' && params.availableDecisions !== undefined && params.availableDecisions !== null) {
      if (!Array.isArray(params.availableDecisions)) {
        this._write({ id: message.id, error: { code: -32602, message: 'Invalid approval decisions' } });
        this._event('error', { message: 'Codex advertised unsupported approval decisions; nothing was approved', nativeMethod: message.method });
        return;
      }
      allowedDecisions = params.availableDecisions.filter((decision) => allowedDecisions.includes(decision));
      if (allowedDecisions.length === 0) {
        this._write({ id: message.id, error: { code: -32601, message: 'No supported one-time approval decisions' } });
        this._event('error', { message: 'Codex advertised no supported one-time approval decision; nothing was approved', nativeMethod: message.method });
        return;
      }
    }
    const request = { id: message.id, method: message.method, params, kind, ...(allowedDecisions ? { allowedDecisions } : {}) };
    this.turnId ??= params.turnId;
    this.pendingApprovals.set(requestKey(message.id), request);
    this._status('waiting');
    this.emit('request', request);
  }

  _notification(method, params) {
    if (!isObject(params)) return;
    const nativeThreadId = params.threadId ?? params.thread?.id;
    if (this.threadId && nativeThreadId && nativeThreadId !== this.threadId) return;
    const base = { nativeMethod: method, ...(typeof params.itemId === 'string' ? { itemId: params.itemId } : {}) };
    if (method === 'thread/started') return;
    if (method === 'turn/started') {
      if (typeof params.turn?.id !== 'string') return this._fail(new Error('Codex sent an invalid turn notification'));
      this.turnId = params.turn.id;
      this._status('running');
      this._event('turn_started', { ...base, turnId: this.turnId });
    } else if (method === 'turn/completed') {
      if (this.turnId && params.turn?.id && params.turn.id !== this.turnId) return;
      const turnId = params.turn?.id ?? this.turnId;
      this.turnId = null;
      for (const request of this.pendingApprovals.values()) this._event('request_resolved', { requestId: request.id, reason: 'turn-completed' });
      this.pendingApprovals.clear();
      this._status('idle');
      this._event('turn_completed', { ...base, turnId, status: text(params.turn?.status, 100) || 'completed', ...(params.turn?.error ? { message: 'Codex reported a turn error' } : {}) });
    } else if (method === 'item/agentMessage/delta') {
      this._event('message_delta', { ...base, delta: text(params.delta) });
    } else if (method === 'item/reasoning/summaryTextDelta') {
      this._event('reasoning_delta', { ...base, delta: text(params.delta) });
    } else if (method === 'item/started' || method === 'item/completed') {
      this._event('activity', { ...base, stage: method === 'item/started' ? 'started' : 'completed', item: visibleItem(params.item) });
    } else if (method === 'item/commandExecution/outputDelta') {
      this._event('activity_delta', { ...base, delta: text(params.delta) });
    } else if (method === 'turn/plan/updated') {
      this._event('activity', { ...base, item: { type: 'plan', explanation: text(params.explanation, 10_000), plan: Array.isArray(params.plan) ? params.plan.slice(0, 100).map((step) => ({ step: text(step?.step, 10_000), status: text(step?.status, 100) })) : [] } });
    } else if (method === 'error') {
      this._event('error', { ...base, message: 'Codex reported an error', willRetry: params.willRetry === true });
    }
  }

  _fail(error) {
    if (this.closed) return;
    this._event('error', { message: error.message });
    for (const pending of this.pendingRequests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pendingRequests.clear();
    if (this.child?.pid) this.child.kill('SIGTERM');
    else this._exited(null, null);
  }

  _exited(code, signal) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.turnId = null;
    const error = new Error('Codex process exited; no user work was retried');
    for (const pending of this.pendingRequests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pendingRequests.clear();
    for (const request of this.pendingApprovals.values()) this._event('request_resolved', { requestId: request.id, reason: 'process-exited' });
    this.pendingApprovals.clear();
    this.child?.stdout?.destroy();
    this.child?.stderr?.destroy();
    this.child?.stdin?.destroy();
    this._status('stopped');
    this.emit('exit', { code, signal });
    this.resolveClosed?.();
  }
}
