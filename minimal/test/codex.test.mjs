import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, chmod, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexSession } from '../server/codex.mjs';

const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
await chmod(fake, 0o755);

async function fixture(t, extra = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 't3-codex-adapter-'));
  const session = new CodexSession({ executable: fake, cwd, roots: [cwd], ...extra });
  const events = [];
  session.on('event', (event) => events.push(event));
  t.after(async () => { await session.close(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, session, events, async requests() { return (await readFile(path.join(cwd, '.fake-codex-requests.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)); } };
}

function until(session, predicate) {
  return new Promise((resolve) => {
    const listener = (event) => { if (predicate(event)) { session.off('event', listener); resolve(event); } };
    session.on('event', listener);
  });
}

test('launch inherits environment and uses only app-server; cold start has no helper or capability calls', async (t) => {
  const previous = process.env.T3_MINIMAL_SYNTHETIC_MARKER;
  process.env.T3_MINIMAL_SYNTHETIC_MARKER = 'preserved-synthetic-value';
  const f = await fixture(t);
  try { await f.session.start(); } finally { if (previous === undefined) delete process.env.T3_MINIMAL_SYNTHETIC_MARKER; else process.env.T3_MINIMAL_SYNTHETIC_MARKER = previous; }
  const startup = JSON.parse(await readFile(path.join(f.cwd, '.fake-codex-startup.json'), 'utf8'));
  assert.deepEqual(startup.args, ['app-server']);
  assert.equal(startup.marker, 'preserved-synthetic-value');
  assert.equal(startup.cwd, await import('node:fs/promises').then((fs) => fs.realpath(f.cwd)));
  await f.session.close();
  assert.deepEqual((await f.requests()).map((request) => request.method), ['initialize', 'initialized']);
});

test('streaming and local activity translate without policy, auth, summary or MCP overrides', async (t) => {
  const f = await fixture(t);
  const completed = until(f.session, (event) => event.type === 'turn_completed');
  const result = await f.session.prompt({ text: 'hello' });
  await completed;
  assert.ok(result.threadId.startsWith('synthetic-thread-'));
  assert.equal(f.session.status, 'idle');
  assert.equal(f.events.filter((event) => event.type === 'message_delta').map((event) => event.delta).join(''), 'Synthetic response: hello');
  assert.ok(f.events.some((event) => event.type === 'activity' && event.item.type === 'commandExecution'));
  assert.ok(f.events.some((event) => event.type === 'activity_delta'));
  assert.ok(f.events.some((event) => event.type === 'reasoning_delta'));
  const requests = await f.requests();
  assert.deepEqual(requests.filter((request) => request.method).map((request) => request.method), ['initialize', 'initialized', 'thread/start', 'turn/start']);
  assert.deepEqual(requests.find((request) => request.method === 'thread/start').params, { cwd: f.session.cwd });
  assert.deepEqual(requests.find((request) => request.method === 'turn/start').params, { threadId: result.threadId, input: [{ type: 'text', text: 'hello' }] });
});

test('fast completion and early approvals bind to the acknowledged turn without reviving finished work', async (t) => {
  const f = await fixture(t);
  const completed = until(f.session, event => event.type === 'turn_completed');
  const result = await f.session.prompt({ text: 'fast-turn' }); await completed;
  assert.equal(f.session.turnId, null); assert.equal(f.session.status, 'idle');
  assert.equal(result.turnId, 'synthetic-turn-1');
  assert.equal(f.events.find(event => event.type === 'message_delta').delta, 'Synthetic fast response');
  const approval = once(f.session, 'request');
  await f.session.prompt({ text: 'early-approval' });
  const [request] = await approval;
  assert.equal(request.params.turnId, 'synthetic-turn-2');
  const approved = until(f.session, event => event.type === 'turn_completed');
  await f.session.respond({ requestId: request.id, result: { decision: 'accept' } }); await approved;
  await f.session.prompt({ text: 'early-resolved' });
  assert.equal(f.session.pendingApprovals.size, 0);
  assert.equal(f.session.status, 'running');
  const resolved = f.events.findLast(event => event.type === 'request_resolved');
  await assert.rejects(f.session.respond({ requestId: resolved.requestId, result: { decision: 'accept' } }), /no longer pending/);
});

test('stale native turns cannot replace active work, expose old output or solicit approvals', async (t) => {
  const f = await fixture(t); const shown = []; f.session.on('request', request => shown.push(request));
  const completed = until(f.session, event => event.type === 'turn_completed');
  await f.session.prompt({ text: 'early-stale' }); await completed;
  assert.equal(shown.length, 0);
  assert.doesNotMatch(JSON.stringify(f.events), /STALE_NATIVE_OUTPUT|stale command/);
  await f.session.prompt({ text: 'hold' });
  const currentTurn = f.session.turnId; const before = f.events.length;
  for (const scope of [
    { threadId: f.session.threadId, turnId: 'synthetic-turn-1' },
    { threadId: 'other-thread', turnId: currentTurn },
    { turnId: currentTurn },
  ]) {
    f.session._notification('turn/started', { ...scope, turn: { id: scope.turnId } });
    f.session._notification('item/agentMessage/delta', { ...scope, delta: 'stale text' });
    f.session._notification('item/commandExecution/outputDelta', { ...scope, delta: 'stale text' });
    f.session._notification('turn/completed', { ...scope, turn: { id: scope.turnId, status: 'completed' } });
  }
  assert.equal(f.session.turnId, currentTurn); assert.equal(f.events.length, before);
  const interrupted = until(f.session, event => event.type === 'turn_completed');
  await f.session.interrupt(); await interrupted;
  const exited = once(f.session, 'exit');
  await assert.rejects(f.session.prompt({ text: 'reused-turn' }), /reused turn/); await exited;
});

test('notifications buffered before turn acknowledgement have a strict memory bound', () => {
  for (const mode of ['count', 'bytes']) {
    const session = new CodexSession({ cwd: process.cwd() });
    session.awaitingTurnStart = true;
    if (mode === 'bytes') session._message({ method: 'item/agentMessage/delta', params: { delta: 'x'.repeat(4 * 1024 * 1024) } });
    else for (let index = 0; index < 1025; index++) session._message({ method: 'item/started', params: {} });
    assert.equal(session.closed, true);
    assert.ok(session.startNotifications.length <= 1024);
  }
});

test('invalid acknowledgements and fatal replay close the owned session without exposing later approvals', async (t) => {
  for (const text of ['invalid-ack', 'invalid-replay']) {
    const f = await fixture(t); const approvals = []; f.session.on('request', request => approvals.push(request));
    const exited = once(f.session, 'exit');
    await assert.rejects(f.session.prompt({ text }), /invalid|closed/); await exited;
    assert.equal(approvals.length, 0); assert.equal(f.session.closed, true);
    assert.doesNotMatch(JSON.stringify(f.events), /MUST_NOT_EXPOSE_APPROVAL/);
    await assert.rejects(f.session.prompt({ text: 'no automatic retry' }), /closed/);
  }
  const session = new CodexSession({ cwd: process.cwd() });
  session.seenTurnIds = new Set(Array.from({ length: 10_000 }, (_, i) => String(i)));
  await assert.rejects(session.prompt({ text: 'capacity cannot start native work' }), /session turn limit/);
  assert.equal(session.child, null);
});

test('capabilities are CLI-derived, paginated and validate model/reasoning selection', async (t) => {
  const f = await fixture(t);
  const capabilities = await f.session.capabilities();
  assert.deepEqual(capabilities.models.map((model) => model.id), ['synthetic-model', 'synthetic-secondary']);
  assert.equal(capabilities.additionalRoots, false);
  assert.equal(capabilities.policyControls, false);
  await assert.rejects(f.session.prompt({ text: 'hello', model: 'unadvertised' }), /not advertised/);
  await assert.rejects(f.session.prompt({ text: 'hello', model: 'synthetic-model', reasoning: 'unadvertised' }), /not advertised/);
  const completed = until(f.session, (event) => event.type === 'turn_completed');
  await f.session.prompt({ text: 'hello', model: 'synthetic-model', reasoning: 'low' });
  await completed;
  const requests = await f.requests();
  assert.equal(requests.filter((request) => request.method === 'model/list').length, 2);
  assert.equal(requests.filter((request) => request.method === 'turn/start').length, 1);
  assert.equal(requests.find((request) => request.method === 'turn/start').params.effort, 'low');
});

test('approval forwarding is one-time and rejects session/policy amendments and stale answers', async (t) => {
  const f = await fixture(t);
  const requestPromise = once(f.session, 'request');
  const completed = until(f.session, (event) => event.type === 'turn_completed');
  await f.session.prompt({ text: 'approval' });
  const [request] = await requestPromise;
  assert.equal(request.kind, 'command');
  assert.equal(f.session.status, 'waiting');
  assert.deepEqual(request.allowedDecisions, ['accept', 'decline', 'cancel']);
  await assert.rejects(f.session.respond({ requestId: request.id, result: { decision: 'acceptForSession' } }), /one-time/);
  await assert.rejects(f.session.respond({ requestId: request.id, result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['all'] } } } }), /one-time/);
  await f.session.respond({ requestId: request.id, result: { decision: 'accept' } });
  await completed;
  await assert.rejects(f.session.respond({ requestId: request.id, result: { decision: 'accept' } }), /no longer pending/);
  assert.deepEqual((await f.requests()).find((message) => message.id === request.id && !message.method).result, { decision: 'accept' });
});

test('file approvals preserve native context and refuse hidden root-wide grants', async (t) => {
  const f = await fixture(t);
  for (const prompt of ['file-approval', 'root-grant']) {
    const requestPromise = once(f.session, 'request');
    const completed = until(f.session, (event) => event.type === 'turn_completed');
    await f.session.prompt({ text: prompt });
    const [request] = await requestPromise;
    assert.equal(request.kind, 'file');
    if (prompt === 'root-grant') {
      assert.equal(request.params.grantRoot, '/outside-synthetic-root');
      assert.deepEqual(request.allowedDecisions, ['decline', 'cancel']);
      await assert.rejects(f.session.respond({ requestId: request.id, result: { decision: 'accept' } }), /one-time/);
    }
    await f.session.respond({ requestId: request.id, result: { decision: 'decline' } });
    await completed;
  }
});

test('native availableDecisions narrows one-time approval choices', async (t) => {
  const f = await fixture(t);
  const requestPromise = once(f.session, 'request');
  const completed = until(f.session, (event) => event.type === 'turn_completed');
  await f.session.prompt({ text: 'restricted-approval' });
  const [request] = await requestPromise;
  assert.deepEqual(request.allowedDecisions, ['decline', 'cancel']);
  await assert.rejects(f.session.respond({ requestId: request.id, result: { decision: 'accept' } }), /one-time/);
  await f.session.respond({ requestId: request.id, result: { decision: 'decline' } });
  await completed;
});

test('native request resolution is scoped, type-sensitive and releases stale approval slots', async (t) => {
  const f = await fixture(t);
  await f.session.prompt({ text: 'hold' });
  const params = { threadId: f.session.threadId, turnId: f.session.turnId, command: 'printf synthetic' };
  for (const id of [42, '42']) f.session._serverRequest({ id, method: 'item/commandExecution/requestApproval', params });
  for (const resolution of [{ requestId: 42 }, { threadId: 'other-thread', requestId: 42 }, { threadId: params.threadId, requestId: {} }]) {
    f.session._notification('serverRequest/resolved', resolution);
  }
  assert.equal(f.session.pendingApprovals.size, 2);
  f.session._notification('serverRequest/resolved', { threadId: params.threadId, requestId: 42 });
  assert.equal(f.session.pendingApprovals.size, 1);
  assert.equal(f.session.status, 'waiting');
  await assert.rejects(f.session.respond({ requestId: 42, result: { decision: 'accept' } }), /no longer pending/);
  f.session._notification('serverRequest/resolved', { threadId: params.threadId, requestId: '42' });
  assert.equal(f.session.status, 'running');
  for (let id = 1000; id < 1040; id++) {
    f.session._serverRequest({ id, method: 'item/commandExecution/requestApproval', params });
    assert.equal(f.session.pendingApprovals.size, 1);
    f.session._notification('serverRequest/resolved', { threadId: params.threadId, requestId: id });
  }
  assert.equal(f.session.pendingApprovals.size, 0);
  assert.equal(f.events.filter(event => event.type === 'request_resolved' && event.reason === 'native-resolved').length, 42);
});

test('questions require the exact pending ids and valid answer payloads', async (t) => {
  const f = await fixture(t);
  const requestPromise = once(f.session, 'request');
  const completed = until(f.session, (event) => event.type === 'turn_completed');
  await f.session.prompt({ text: 'question' });
  const [request] = await requestPromise;
  assert.equal(request.kind, 'question');
  await assert.rejects(f.session.respond({ requestId: request.id, result: { answers: { unknown: { answers: ['A'] } } } }), /match/);
  await assert.rejects(f.session.respond({ requestId: request.id, result: { answers: { choice: { answers: ['A'], injected: true } } } }), /Invalid/);
  await f.session.respond({ requestId: request.id, result: { answers: { choice: { answers: ['B'] } } } });
  await completed;
  assert.equal(f.events.filter((event) => event.type === 'message_delta').map((event) => event.delta).join(''), 'Answer: B');
});

test('auth, secret-input and wrong-thread requests fail closed without collecting user input', async (t) => {
  const f = await fixture(t);
  const requests = [];
  f.session.on('request', (request) => requests.push(request));
  for (const prompt of ['unknown-request', 'secret-question', 'invalid-scope']) {
    const completed = until(f.session, (event) => event.type === 'turn_completed');
    await f.session.prompt({ text: prompt });
    await completed;
  }
  assert.equal(requests.length, 0);
  const responses = (await f.requests()).filter((message) => !message.method && message.error);
  assert.equal(responses.length, 3);
  assert.ok(responses.every((message) => message.error.code === -32601));
});

test('approval arriving after a completed turn cannot revive that turn or grant stale work', async (t) => {
  const f = await fixture(t);
  const forwarded = [];
  f.session.on('request', (request) => forwarded.push(request));
  const acknowledged = until(f.session, (event) => event.type === 'error' && event.nativeMethod === 'error');
  await f.session.prompt({ text: 'late-approval' });
  await acknowledged;
  assert.equal(f.session.turnId, null);
  assert.equal(forwarded.length, 0);
  assert.ok((await f.requests()).some((message) => !message.method && message.error?.code === -32601));
});

test('concurrent chats remain independent and one chat cannot overlap its active turn', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const firstStarted = until(first.session, (event) => event.type === 'turn_started');
  await first.session.prompt({ text: 'hold' });
  await firstStarted;
  await assert.rejects(first.session.prompt({ text: 'overlap' }), /active turn/);
  const secondCompleted = until(second.session, (event) => event.type === 'turn_completed');
  await second.session.prompt({ text: 'independent' });
  await secondCompleted;
  assert.equal(first.session.status, 'running');
  assert.equal(second.session.status, 'idle');
  assert.notEqual(first.session.threadId, second.session.threadId);
  const interrupted = until(first.session, (event) => event.type === 'turn_completed');
  assert.equal((await first.session.interrupt()).interrupted, true);
  assert.equal((await interrupted).status, 'interrupted');
  assert.deepEqual((await first.requests()).find((request) => request.method === 'turn/interrupt').params, { threadId: first.session.threadId, turnId: 'synthetic-turn-1' });
});

test('resume uses native id and selected cwd without restoring wrapper policy/config overrides', async (t) => {
  const f = await fixture(t);
  const thread = await f.session.startThread({ resumeId: 'saved-native-thread' });
  assert.equal(thread.threadId, 'saved-native-thread');
  assert.equal(thread.policy.approvalPolicy, 'on-request');
  assert.deepEqual((await f.requests()).find((request) => request.method === 'thread/resume').params, { threadId: 'saved-native-thread', cwd: f.session.cwd });
  await assert.rejects(f.session.startThread({ resumeId: 'different-thread' }), /different/);
});

test('native errors and stderr do not expose raw credential-like content', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.session.prompt({ text: 'rpc-error' }), (error) => error.message === 'Codex rejected turn/start (code -32000)');
  const exited = once(f.session, 'exit');
  await f.session.prompt({ text: 'crash' });
  assert.equal((await exited)[0].code, 7);
  assert.equal(f.session.status, 'stopped');
  assert.doesNotMatch(JSON.stringify(f.events), /sk-synthetic-secret|synthetic-credential/);
  await assert.rejects(f.session.prompt({ text: 'must not retry' }), /closed/);
  assert.equal((await f.requests()).filter((request) => request.method === 'turn/start').length, 2);
});

test('malformed and oversized protocol output terminate the owned process', async (t) => {
  for (const prompt of ['malformed', 'oversized']) {
    const f = await fixture(t);
    const exited = once(f.session, 'exit');
    await f.session.prompt({ text: prompt });
    await exited;
    assert.equal(f.session.status, 'stopped');
    assert.ok(f.events.some((event) => event.type === 'error' && /protocol output|frame/.test(event.message)));
  }
});

test('canonical cwd confinement rejects an escaping symlink before any child starts', async (t) => {
  const f = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 't3-codex-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(f.cwd, 'allowed'));
  await symlink(outside, path.join(f.cwd, 'allowed', 'escape'));
  const session = new CodexSession({ executable: fake, cwd: path.join(f.cwd, 'allowed', 'escape'), roots: [path.join(f.cwd, 'allowed')] });
  await assert.rejects(session.start(), /outside authorized/);
  assert.equal(session.child, null);
  await session.close();
});

test('missing executable fails cleanly and explicit extra roots never become sandbox overrides', async (t) => {
  const f = await fixture(t);
  const missing = new CodexSession({ executable: path.join(f.cwd, 'missing-codex'), cwd: f.cwd, roots: [f.cwd] });
  await assert.rejects(missing.start(), /launch|exited/);
  await missing.close();
  const extra = await mkdtemp(path.join(os.tmpdir(), 't3-extra-root-'));
  t.after(() => rm(extra, { recursive: true, force: true }));
  const session = new CodexSession({ executable: fake, cwd: f.cwd, roots: [f.cwd, extra] });
  t.after(() => session.close());
  await session.startThread();
  assert.deepEqual((await f.requests()).find((request) => request.method === 'thread/start').params, { cwd: session.cwd });
});

test('invalid and unsolicited options cannot become a generic native RPC or policy escape', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.session.prompt({ text: 'hello', sandboxPolicy: { type: 'dangerFullAccess' } }), /Invalid turn/);
  await assert.rejects(f.session.startThread({ config: { approval_policy: 'never' } }), /Invalid thread/);
  await assert.rejects(f.session.respond({ requestId: 100, result: { decision: 'accept' } }), /no longer pending/);
  assert.equal(f.session.child, null);
});
