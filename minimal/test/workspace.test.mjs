import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { authorizeRoots, resolvePath, listFiles, readFile, gitStatus, gitDiff, createWorktree } from '../server/workspace.mjs';
const execute = promisify(execFile);
async function fixture(t) { const base = await fs.mkdtemp(path.join(os.tmpdir(), 't3-minimal-workspace-')); const root = path.join(base, 'allowed'); const outside = path.join(base, 'outside'); await fs.mkdir(root); await fs.mkdir(outside); t.after(() => fs.rm(base, { recursive: true, force: true })); return { base, root: await fs.realpath(root), outside: await fs.realpath(outside), roots: await authorizeRoots([root]) }; }
async function git(root, ...args) { return execute('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Synthetic Test', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic Test', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' } }); }
async function repository(t) { const value = await fixture(t); await git(value.root, 'init', '-q'); await fs.writeFile(path.join(value.root, 'hello.txt'), 'before\n'); await git(value.root, 'add', 'hello.txt'); await git(value.root, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic baseline'); return value; }

test('confines relative, absolute and symlink paths to explicit canonical roots', async t => {
  const { root, outside, roots } = await fixture(t); await fs.writeFile(path.join(root, 'hello.txt'), 'synthetic'); await fs.writeFile(path.join(outside, 'secret.txt'), 'outside'); await fs.symlink(outside, path.join(root, 'escape')); await fs.symlink(path.join(root, 'hello.txt'), path.join(root, 'inside'));
  assert.equal(await resolvePath(roots, 'hello.txt'), path.join(root, 'hello.txt')); assert.equal((await readFile(roots, 'inside')).content, 'synthetic');
  for (const requested of ['../outside/secret.txt', path.join(outside, 'secret.txt'), 'escape/secret.txt', '~/.codex/auth.json', '.git/config']) await assert.rejects(resolvePath(roots, requested));
  const listing = await listFiles(roots); assert.equal(listing.entries.some(entry => entry.name === 'escape'), false); assert.equal(listing.entries.some(entry => entry.name === 'hello.txt'), true);
});

test('an authorized root cannot be silently retargeted or replaced after startup', async t => {
  const { base, root, outside, roots } = await fixture(t); await fs.rename(root, path.join(base, 'original')); await fs.symlink(outside, root); await assert.rejects(resolvePath(roots, root), { code: 'ROOT_CHANGED' }); await fs.unlink(root); await fs.mkdir(root); await assert.rejects(resolvePath(roots, root), { code: 'ROOT_CHANGED' }); await assert.rejects(authorizeRoots([root]), { code: 'ROOT_CHANGED' });
});

test('bounded code viewing rejects oversized, binary and malformed UTF-8 data, and limits listings', async t => {
  const { root, roots } = await fixture(t); await fs.writeFile(path.join(root, 'big'), Buffer.alloc(1024 * 1024 + 1, 65)); await fs.writeFile(path.join(root, 'binary'), Buffer.from([65, 0, 66])); await fs.writeFile(path.join(root, 'invalid'), Buffer.from([0xff]));
  await assert.rejects(readFile(roots, 'big'), { code: 'FILE_LIMIT' }); await assert.rejects(readFile(roots, 'binary'), { code: 'BINARY_FILE' }); await assert.rejects(readFile(roots, 'invalid'));
  await Promise.all(Array.from({ length: 501 }, (_, index) => fs.writeFile(path.join(root, `entry-${index}`), 'test'))); const listing = await listFiles(roots); assert.equal(listing.entries.length, 500); assert.equal(listing.truncated, true);
});

test('Git views remain local and do not execute fsmonitor, pager, diff or textconv helpers', async t => {
  const { root, roots } = await repository(t); const sentinel = path.join(root, 'must-not-run'); await fs.writeFile(path.join(root, 'hello.txt'), 'after\n');
  await git(root, 'config', 'core.fsmonitor', `touch ${sentinel}`); await git(root, 'config', 'core.pager', `touch ${sentinel}`); await git(root, 'config', 'diff.external', `touch ${sentinel}`);
  const previous = process.env.GIT_EXTERNAL_DIFF; process.env.GIT_EXTERNAL_DIFF = `touch ${sentinel}`;
  try { const status = await gitStatus(roots, root); assert.equal(status.entries[0].path, 'hello.txt'); const diff = await gitDiff(roots, { root }); assert.match(diff.diff, /-before\n\+after/); } finally { if (previous === undefined) delete process.env.GIT_EXTERNAL_DIFF; else process.env.GIT_EXTERNAL_DIFF = previous; }
  await assert.rejects(fs.stat(sentinel), { code: 'ENOENT' });
  await git(root, 'config', 'diff.synthetic.textconv', `touch ${sentinel}`); await fs.writeFile(path.join(root, '.gitattributes'), '*.txt diff=synthetic\n'); await assert.rejects(gitDiff(roots, { root }), { code: 'UNSAFE_GIT' }); await assert.rejects(fs.stat(sentinel), { code: 'ENOENT' });
});

test('refuses local includes, filters, lazy-fetch repositories and external Git metadata before reading their targets', async t => {
  const { root, outside, roots } = await repository(t); const config = path.join(root, '.git', 'config'); const baseline = await fs.readFile(config, 'utf8');
  for (const addition of ['\n[include]\n path = /not-authorized/config\n', '\n[filter "synthetic"]\n clean = curl https://unapproved.invalid\n', '\n[remote "origin"]\n promisor = true\n url = https://unapproved.invalid/repo\n']) { await fs.writeFile(config, baseline + addition); await assert.rejects(gitStatus(roots, root), { code: 'UNSAFE_GIT' }); }
  await fs.writeFile(config, baseline); await fs.symlink(outside, path.join(root, '.git', 'outside')); await assert.rejects(gitStatus(roots, root), { code: 'UNSAFE_GIT' }); await fs.unlink(path.join(root, '.git', 'outside'));
  const alternate = path.join(root, '.git', 'objects', 'info', 'alternates'); await fs.writeFile(alternate, outside + '\n'); await assert.rejects(gitDiff(roots, { root }), { code: 'UNSAFE_GIT' });
});

test('explicit worktree creation keeps local changes isolated only for that repository and refuses outside destinations', async t => {
  const { root, outside, roots } = await repository(t); const destination = path.join(root, 'synthetic-worktree'); await assert.rejects(createWorktree(roots, { root, destination: path.join(outside, 'escape') }), { code: 'FORBIDDEN_PATH' });
  const created = await createWorktree(roots, { root, destination, branch: 'synthetic-isolation' }); assert.equal(created.path, destination); assert.deepEqual(created.isolatedRoots, [root]); assert.equal(await fs.readFile(path.join(destination, 'hello.txt'), 'utf8'), 'before\n'); await fs.writeFile(path.join(destination, 'hello.txt'), 'worktree edit\n'); assert.equal(await fs.readFile(path.join(root, 'hello.txt'), 'utf8'), 'before\n'); assert.equal((await gitStatus(roots, destination)).entries[0].path, 'hello.txt');
  await assert.rejects(createWorktree(roots, { root, destination }), { code: 'WORKTREE_EXISTS' });
});
