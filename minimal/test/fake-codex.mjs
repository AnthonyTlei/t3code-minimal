#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

if (process.argv.length !== 3 || process.argv[2] !== 'app-server') process.exit(64);
const recordPath = path.join(process.cwd(), '.fake-codex-requests.jsonl');
writeFileSync(path.join(process.cwd(), '.fake-codex-startup.json'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), marker: process.env.T3_MINIMAL_SYNTHETIC_MARKER ?? null }));
const input = createInterface({ input: process.stdin });
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ id, result });
const notify = (method, params) => write({ method, params });
const serverRequests = new Map();
let threadId;
let turnNumber = 0;
let serverRequestId = 100;
let heldTurn;

function complete(turnId, value, status = 'completed') {
  const itemId = `message-${turnId}`;
  notify('item/started', { threadId, turnId, item: { id: itemId, type: 'agentMessage', text: '' } });
  const halves = [value.slice(0, Math.ceil(value.length / 2)), value.slice(Math.ceil(value.length / 2))];
  setImmediate(() => {
    notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: halves[0] });
    setImmediate(() => {
      notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: halves[1] });
      notify('item/completed', { threadId, turnId, item: { id: itemId, type: 'agentMessage', text: value } });
      notify('turn/completed', { threadId, turn: { id: turnId, status, error: null, items: [] } });
    });
  });
}

function ask(method, turnId, params, onResponse) {
  const id = serverRequestId++;
  serverRequests.set(id, onResponse);
  write({ id, method, params: { threadId, turnId, itemId: `request-${id}`, ...params } });
}

function runTurn(turnId, prompt) {
  notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
  if (prompt === 'hold') { heldTurn = turnId; return; }
  if (prompt === 'crash') { process.stderr.write('sk-synthetic-secret must not escape diagnostic stderr\n'); process.exit(7); }
  if (prompt === 'malformed') { process.stdout.write('not-json\n'); return; }
  if (prompt === 'oversized') { process.stdout.write(`${'x'.repeat(4 * 1024 * 1024 + 1)}\n`); return; }
  if (prompt === 'approval' || prompt === 'restricted-approval' || prompt === 'file-approval' || prompt === 'root-grant') {
    const method = ['approval', 'restricted-approval'].includes(prompt) ? 'item/commandExecution/requestApproval' : 'item/fileChange/requestApproval';
    ask(method, turnId, { command: 'printf synthetic', cwd: process.cwd(), reason: 'Synthetic one-time check', ...(prompt === 'root-grant' ? { grantRoot: '/outside-synthetic-root' } : {}), ...(prompt === 'restricted-approval' ? { availableDecisions: ['decline', 'cancel'] } : {}) }, (response) => complete(turnId, `Approval decision: ${response.result?.decision ?? 'error'}`));
    return;
  }
  if (prompt === 'question' || prompt === 'secret-question') {
    ask('item/tool/requestUserInput', turnId, { isBlocking: true, questions: [{ id: 'choice', header: 'Choice', question: 'Choose a synthetic option', isSecret: prompt === 'secret-question', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }] }, (response) => complete(turnId, response.error ? 'Question declined by client' : `Answer: ${response.result.answers.choice.answers.join(', ')}`));
    return;
  }
  if (prompt === 'unknown-request') {
    ask('account/chatgptAuthTokens/refresh', turnId, { reason: 'synthetic unsupported auth request' }, (response) => complete(turnId, response.error ? 'Unsupported request denied' : 'Unexpectedly accepted'));
    return;
  }
  if (prompt === 'invalid-scope') {
    ask('item/commandExecution/requestApproval', turnId, { threadId: 'different-thread', command: 'printf synthetic' }, (response) => complete(turnId, response.error ? 'Scope denied' : 'Unexpectedly accepted'));
    return;
  }
  if (prompt === 'late-approval') {
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
    ask('item/commandExecution/requestApproval', turnId, { command: 'printf synthetic' }, () => notify('error', { threadId, turnId, error: { message: 'Synthetic late-response observed' }, willRetry: false }));
    return;
  }
  notify('item/reasoning/summaryTextDelta', { threadId, turnId, itemId: `reason-${turnId}`, delta: 'Checking the synthetic fixture.' });
  notify('item/started', { threadId, turnId, item: { id: `command-${turnId}`, type: 'commandExecution', command: 'printf synthetic', cwd: process.cwd(), status: 'inProgress' } });
  notify('item/commandExecution/outputDelta', { threadId, turnId, itemId: `command-${turnId}`, delta: 'synthetic output\n' });
  notify('item/completed', { threadId, turnId, item: { id: `command-${turnId}`, type: 'commandExecution', command: 'printf synthetic', status: 'completed', exitCode: 0 } });
  complete(turnId, `Synthetic response: ${prompt}`);
}

input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { process.exit(65); }
  appendFileSync(recordPath, `${JSON.stringify(message)}\n`);
  if (!message.method) { const callback = serverRequests.get(message.id); serverRequests.delete(message.id); callback?.(message); return; }
  if (!Object.hasOwn(message, 'id')) return;
  if (message.method === 'initialize') { reply(message.id, { userAgent: 'synthetic-codex', platformOs: 'synthetic' }); return; }
  if (message.method === 'model/list') {
    const first = { id: 'synthetic', model: 'synthetic-model', displayName: 'Synthetic model', description: 'Local deterministic fixture', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Less' }, { reasoningEffort: 'medium', description: 'Default' }] };
    const second = { ...first, id: 'secondary', model: 'synthetic-secondary', displayName: 'Secondary model', isDefault: false };
    reply(message.id, { data: message.params.cursor ? [second] : [first], nextCursor: message.params.cursor ? null : 'page-2' });
    return;
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    threadId = message.params.threadId ?? `synthetic-thread-${process.pid}`;
    reply(message.id, { thread: { id: threadId, cwd: process.cwd(), turns: [] }, approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false } });
    notify('thread/started', { thread: { id: threadId } });
    return;
  }
  if (message.method === 'turn/start') {
    const prompt = message.params.input[0].text;
    if (prompt === 'rpc-error') { write({ id: message.id, error: { code: -32000, message: 'sk-synthetic-secret in native error', data: { secret: 'synthetic-credential' } } }); return; }
    const turnId = `synthetic-turn-${++turnNumber}`;
    reply(message.id, { turn: { id: turnId, status: 'inProgress', items: [] } });
    setImmediate(() => runTurn(turnId, prompt));
    return;
  }
  if (message.method === 'turn/interrupt') {
    reply(message.id, {});
    if (heldTurn) { const turnId = heldTurn; heldTurn = null; notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', error: null, items: [] } }); }
    return;
  }
  write({ id: message.id, error: { code: -32601, message: 'Unsupported fake method' } });
});
