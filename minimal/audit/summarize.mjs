import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const directory = path.resolve(process.argv[2] || 'minimal/audit/output');
const exercise = JSON.parse(await fs.readFile(path.join(directory, 'exercise.json'), 'utf8'));
const image = JSON.parse(await fs.readFile(path.join(directory, 'image.json'), 'utf8'));
const tools = (await fs.readFile(path.join(directory, 'tools.txt'), 'utf8')).trim().split('\n');
assert.equal(exercise.result, 'pass');
const files = (await fs.readdir(directory)).filter(name => /^trace\.\d+$/.test(name));
assert.ok(files.length > 0, 'No syscall traces were collected');
const records = new Map(); const parents = new Map(); const roles = new Map(exercise.processes.map(item => [item.pid, item.role]));
const artifacts = [];
for (const filename of files) {
  const pid = Number(filename.split('.')[1]); const source = await fs.readFile(path.join(directory, filename), 'utf8');
  assert.doesNotMatch(source, /Bearer |#token=|sk-synthetic-secret/, 'Sensitive-looking payload escaped trace redaction');
  const lines = source.split('\n').filter(Boolean); records.set(pid, lines);
  artifacts.push({ file: filename, sha256: createHash('sha256').update(source).digest('hex'), bytes: Buffer.byteLength(source) });
  for (const line of lines) {
    const cloned = line.match(/(?:clone3?|fork|vfork)\(.*\)\s+=\s+(\d+)$/);
    if (cloned) parents.set(Number(cloned[1]), pid);
    const executed = line.match(/execve\("([^"]+)"/);
    if (executed?.[1] === '/app/minimal/test/fake-codex.mjs') roles.set(pid, 'fake-cli');
    if (executed?.[1] === '/usr/bin/chromium' || executed?.[1]?.startsWith('/usr/lib/chromium/')) roles.set(pid, 'browser');
  }
}
function role(pid, seen = new Set()) {
  if (roles.has(pid)) return roles.get(pid);
  if (seen.has(pid) || !parents.has(pid)) return 'unattributed';
  seen.add(pid); return role(parents.get(pid), seen);
}
const counts = {}; const connects = []; const internetSends = []; const binds = []; const unattributed = [];
const networkNames = new Set(['socket', 'socketpair', 'bind', 'listen', 'accept', 'accept4', 'connect', 'getsockname', 'getpeername', 'setsockopt', 'getsockopt', 'shutdown', 'sendto', 'sendmsg', 'sendmmsg', 'recvfrom', 'recvmsg', 'recvmmsg']);
for (const [pid, lines] of records) {
  const actor = role(pid); const operations = counts[actor] ??= { tasks: 0, networkSyscalls: 0, connectAttempts: 0, loopbackConnectAttempts: 0, externalConnectAttempts: 0, sendCalls: 0, bindCalls: 0 };
  operations.tasks++;
  if (actor === 'unattributed') unattributed.push(pid);
  for (const line of lines) {
    const syscall = line.match(/^([\d.]+) (\w+)\(/);
    if (!syscall || !networkNames.has(syscall[2])) continue;
    operations.networkSyscalls++;
    const name = syscall[2]; const unixTimeMs = Number(syscall[1]) * 1000;
    if (['sendto', 'sendmsg', 'sendmmsg'].includes(name)) {
      operations.sendCalls++;
      internetSends.push({ pid, actor, syscall: name, unixTimeMs, outcome: line.slice(line.lastIndexOf(' = ') + 3) });
    }
    if (name === 'bind') {
      operations.bindCalls++;
      const address = line.match(/inet_addr\("([^"]+)"\)/)?.[1];
      const port = Number(line.match(/sin_port=htons\((\d+)\)/)?.[1]);
      binds.push({ pid, actor, ...(address ? { address, port } : { family: line.match(/sa_family=(\w+)/)?.[1] || 'unknown' }) });
    }
    if (name !== 'connect') continue;
    const family = line.match(/sa_family=(\w+)/)?.[1] || 'unknown';
    const address = line.match(/inet_addr\("([^"]+)"\)/)?.[1];
    const port = Number(line.match(/sin_port=htons\((\d+)\)/)?.[1]);
    const outcome = line.slice(line.lastIndexOf(' = ') + 3);
    const entry = { pid, actor, family, ...(address ? { address, port } : {}), unixTimeMs, outcome };
    if (family === 'AF_INET' || family === 'AF_INET6') {
      operations.connectAttempts++;
      if (address?.startsWith('127.')) operations.loopbackConnectAttempts++;
      else operations.externalConnectAttempts++;
    }
    connects.push(entry);
  }
}
const external = connects.filter(entry => ['AF_INET', 'AF_INET6'].includes(entry.family) && !entry.address?.startsWith('127.'));
assert.ok(external.some(entry => entry.actor === 'positive-control-descendant' && entry.address === '198.51.100.53' && entry.port === 53 && /ENETUNREACH/.test(entry.outcome)), 'Blocked DNS attempt was not observed at syscall level');
assert.ok(external.some(entry => entry.actor === 'positive-control-descendant' && entry.address === '198.51.100.42' && entry.port === 443 && /ENETUNREACH/.test(entry.outcome)), 'Blocked TCP attempt was not observed at syscall level');
assert.ok(external.some(entry => entry.actor === 'positive-control-descendant' && entry.address === '198.51.100.43' && entry.port === 8080 && /ENETUNREACH/.test(entry.outcome)), 'Blocked redirected HTTP attempt was not observed at syscall level');
assert.ok(external.some(entry => entry.actor === 'positive-control-descendant' && entry.address === '198.51.100.44' && entry.port === 8080 && /ENETUNREACH/.test(entry.outcome)), 'Blocked WebSocket attempt was not observed at syscall level');
assert.ok(connects.some(entry => entry.actor === 'positive-control-descendant' && entry.address === '127.0.0.1' && entry.outcome === '0'), 'Successful local DNS connect was not captured');
assert.equal(exercise.positiveControls.redirect.redirected, true); assert.equal(exercise.positiveControls.websocket, 'opened');
assert.deepEqual(exercise.positiveControls.httpPaths, ['/redirect', '/final', '/ws', '/redirect-blocked']);
assert.deepEqual(unattributed, [], 'Some traced tasks could not be attributed');
for (const actor of ['wrapper-backend', 'fake-cli']) {
  assert.ok(counts[actor], `No ${actor} process was traced`);
  assert.equal(counts[actor].connectAttempts, 0, `${actor} attempted an Internet-family connect`);
  assert.equal(counts[actor].sendCalls, 0, `${actor} attempted a send syscall with opaque destination`);
  assert.equal(external.filter(entry => entry.actor === actor).length, 0);
}
assert.ok(binds.some(entry => entry.actor === 'wrapper-backend' && entry.address === '127.0.0.1'));
assert.equal(binds.filter(entry => entry.actor === 'wrapper-backend' && entry.address && entry.address !== '127.0.0.1').length, 0);
const summary = {
  result: 'pass',
  scope: 'Kernel network/process syscalls for synthetic driver, actual wrapper backend, fake CLI and all traced threads/descendants in a local Docker Linux VM',
  platform: { container: 'Debian 12 ARM64', node: '24.18.0', network: 'none', nonRoot: true, droppedCapabilities: 'ALL', noNewPrivileges: true, rootFilesystem: 'read-only', additionalPtraceCapability: false },
  image, tools,
  counts, connects, binds,
  positiveControls: exercise.positiveControls,
  scenarios: exercise.appScenarios,
  browserAudit: exercise.browserAudit || { status: 'not-run' },
  capabilityLeakCheck: exercise.capabilityLeakCheck,
  sourceHashes: exercise.sourceHashes || null,
  phases: exercise.phases,
  traceArtifacts: artifacts.sort((a, b) => a.file.localeCompare(b.file)),
  limitations: [...exercise.limits, 'socket observation covers the bounded synthetic scenarios and stated idle interval only', 'a real Codex installation and its network/MCP/child behavior were not executed', 'raw send/receive arguments are kept opaque to avoid recording auth payloads; unexpected sends by app actors fail the audit', 'HTTP redirect and WebSocket success is corroborated by the controlled local server and probe result; syscall data alone does not identify HTTP application semantics', 'Browser syscall scope depends on browserAudit status; a blocked sandboxed launch does not verify browser page/global networking. Production browser policy remains separate from app source code.'],
};
await fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ result: summary.result, counts, externalPositiveControlAttempts: external.length, tracedTasks: records.size }, null, 2));
