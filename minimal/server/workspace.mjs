import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { resolveExecutable } from './executable.mjs';

const startupGit = resolveExecutable('git').catch(() => null);

const FILE_LIMIT = 1024 * 1024;
const GIT_LIMIT = 2 * 1024 * 1024;
const ENTRY_LIMIT = 500;
const rootAnchors = new Map();

function fail(message, code = 'INVALID_PATH') { const error = new Error(message); error.code = code; throw error; }
function validPath(value) { if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || value.split(/[\\/]/).includes('..') || value.startsWith('~')) fail('A literal authorized path is required'); }
function contains(root, candidate) { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function owner(roots, candidate) { return [...roots].sort((a, b) => b.length - a.length).find(root => contains(root, candidate)); }
function metadataPath(candidate) { return candidate.split(path.sep).includes('.git'); }

export async function authorizeRoots(rootPaths) {
  if (!Array.isArray(rootPaths) || rootPaths.length === 0 || rootPaths.length > 32) fail('Between one and 32 explicit roots are required');
  const roots = [];
  for (const root of rootPaths) {
    validPath(root); if (!path.isAbsolute(root)) fail('Authorized roots must be absolute');
    const canonical = await fs.realpath(root); const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) fail('Authorized roots must be directories');
    const previous = rootAnchors.get(canonical);
    if (previous && (previous.ino !== stat.ino || previous.dev !== stat.dev)) fail('An authorized root was replaced', 'ROOT_CHANGED');
    rootAnchors.set(canonical, { ino: stat.ino, dev: stat.dev });
    if (!roots.includes(canonical)) roots.push(canonical);
  }
  return roots;
}

async function checkedRoots(roots) {
  if (!Array.isArray(roots) || !roots.length || roots.length > 32) fail('No authorized workspace roots');
  for (const root of roots) {
    validPath(root); const stat = await fs.lstat(root); const anchor = rootAnchors.get(root);
    if (!path.isAbsolute(root) || stat.isSymbolicLink() || await fs.realpath(root) !== root || !stat.isDirectory() || (anchor && (anchor.ino !== stat.ino || anchor.dev !== stat.dev))) fail('An authorized root changed; restart with explicit roots', 'ROOT_CHANGED');
  }
}
async function resolve(roots, requested, metadata = false) {
  await checkedRoots(roots); validPath(requested);
  const absolute = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(roots[0], requested);
  if (!owner(roots, absolute) || (!metadata && metadataPath(absolute))) fail('Path is outside the authorized workspace', 'FORBIDDEN_PATH');
  const canonical = await fs.realpath(absolute);
  if (!owner(roots, canonical) || (!metadata && metadataPath(canonical))) fail('Symlink leaves the authorized workspace', 'FORBIDDEN_PATH');
  return canonical;
}
export async function resolvePath(roots, requested) { return resolve(roots, requested); }

async function boundedRead(roots, canonical, limit, metadata = false) {
  const resolved = await resolve(roots, canonical, metadata); const before = await fs.lstat(resolved);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) fail('Only bounded regular files can be read', 'FILE_LIMIT');
  const handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await handle.stat(); const afterPath = await resolve(roots, resolved, metadata); const after = await fs.lstat(afterPath);
    if (!actual.isFile() || actual.size > limit || actual.ino !== before.ino || actual.dev !== before.dev || actual.ino !== after.ino || actual.dev !== after.dev || afterPath !== resolved) fail('File changed during authorization', 'PATH_CHANGED');
    const buffer = Buffer.alloc(Math.min(actual.size + 1, limit + 1)); let used = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null); used += bytesRead;
      if (!bytesRead) break;
      if (used === buffer.length) {
        const extra = Buffer.alloc(1); if ((await handle.read(extra, 0, 1, null)).bytesRead) fail('File grew beyond the read limit', 'FILE_LIMIT');
        break;
      }
    }
    if (used > limit) fail('File exceeds the read limit', 'FILE_LIMIT');
    return buffer.subarray(0, used);
  } finally { await handle.close(); }
}

export async function listFiles(roots, { root, path: requested } = {}) {
  const selected = requested ?? root ?? roots[0]; const directory = await resolvePath(roots, selected);
  if (!(await fs.stat(directory)).isDirectory()) fail('Requested path is not a directory');
  const entries = []; let truncated = false; let visited = 0; const handle = await fs.opendir(directory);
  try {
    for await (const entry of handle) {
      if (++visited > ENTRY_LIMIT) { truncated = true; break; }
      if (entry.name === '.git') continue;
      if (entries.length >= ENTRY_LIMIT) { truncated = true; break; }
      const full = path.join(directory, entry.name);
      let resolved; let stat;
      try { resolved = await resolvePath(roots, full); stat = await fs.stat(resolved); }
      catch (error) { if (['FORBIDDEN_PATH', 'ENOENT', 'ELOOP'].includes(error.code)) continue; throw error; }
      if (!stat.isDirectory() && !stat.isFile()) continue;
      entries.push({ name: entry.name, path: full, kind: stat.isDirectory() ? 'directory' : 'file', ...(stat.isFile() ? { size: stat.size } : {}) });
    }
  } finally { await handle.close().catch(error => { if (error.code !== 'ERR_DIR_CLOSED') throw error; }); }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
  return { root: owner(roots, directory), path: directory, entries, truncated };
}

export async function readFile(roots, requested) {
  const canonical = await resolvePath(roots, requested); const buffer = await boundedRead(roots, canonical, FILE_LIMIT);
  if (buffer.includes(0)) fail('Binary files are not rendered', 'BINARY_FILE');
  const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  return { root: owner(roots, canonical), path: canonical, content, size: buffer.length };
}

function gitEnvironment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false', GIT_PAGER: 'cat', PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '' };
}
async function executeGit(cwd, args, limit = GIT_LIMIT) {
  const executable = await startupGit;
  if (!executable) fail('Git was not available in an absolute startup PATH directory', 'GIT_UNAVAILABLE');
  return new Promise((resolvePromise, reject) => {
    execFile(executable, ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.untrackedCache=false', '-c', 'core.sshCommand=/usr/bin/false', '-c', 'diff.external=', '-c', 'submodule.recurse=false', ...args], { cwd, env: gitEnvironment(), shell: false, encoding: 'utf8', maxBuffer: limit, timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (error) { const failure = new Error(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Git output exceeds the local viewing limit' : 'Local Git operation failed'); failure.code = error.code === 'ENOENT' ? 'GIT_UNAVAILABLE' : 'GIT_FAILED'; reject(failure); } else resolvePromise(stdout);
    });
  });
}

async function scanMetadata(roots, directory) {
  const pending = [directory]; let seen = 0;
  while (pending.length) {
    const current = pending.pop(); const entries = await fs.opendir(current);
    for await (const entry of entries) {
      if (++seen > 10_000) fail('Git metadata exceeds the bounded safety scan', 'UNSAFE_GIT');
      const full = path.join(current, entry.name); const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) fail('Symlinked Git metadata is not supported', 'UNSAFE_GIT');
      if (!stat.isFile() && !stat.isDirectory()) fail('Special Git metadata is not supported', 'UNSAFE_GIT');
      if (stat.isDirectory()) pending.push(full);
    }
  }
  const alternates = path.join(directory, 'objects', 'info', 'alternates');
  try { if ((await boundedRead(roots, alternates, 64 * 1024, true)).toString().trim()) fail('Git object alternates require a separate approved boundary', 'UNSAFE_GIT'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const filename of ['config', 'config.worktree']) {
    const config = path.join(directory, filename);
    try { await boundedRead(roots, config, 256 * 1024, true); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const values = await executeGit(directory, ['config', '--null', '--no-includes', '--file', config, '--list']);
    for (const entry of values.split('\0').filter(Boolean)) {
      const key = entry.split('\n', 1)[0].toLowerCase();
      if (key === 'include.path' || /^includeif\./.test(key) || /^filter\./.test(key) || /^diff\..*\.(command|textconv)$/.test(key) || key === 'extensions.partialclone' || /^remote\..*\.promisor$/.test(key) || key === 'core.alternaterefscommand') fail('Repository configuration can invoke helpers or lazy network access; local Git view is disabled', 'UNSAFE_GIT');
    }
  }
}
async function repository(roots, requested) {
  const root = await resolvePath(roots, requested); if (!(await fs.stat(root)).isDirectory()) fail('Repository root is not a directory');
  const dotGit = path.join(root, '.git'); const stat = await fs.lstat(dotGit);
  if (stat.isSymbolicLink()) fail('Symlinked Git metadata is not supported', 'UNSAFE_GIT');
  let gitDir;
  if (stat.isDirectory()) gitDir = await resolve(roots, dotGit, true);
  else if (stat.isFile()) {
    const target = (await boundedRead(roots, dotGit, 8192, true)).toString('utf8').trim();
    if (!target.startsWith('gitdir: ')) fail('Malformed worktree metadata', 'UNSAFE_GIT');
    const requestedGit = path.resolve(root, target.slice(8)); gitDir = await resolve(roots, requestedGit, true);
  } else fail('Unsupported repository metadata', 'UNSAFE_GIT');
  const directories = [gitDir];
  try {
    const common = (await boundedRead(roots, path.join(gitDir, 'commondir'), 8192, true)).toString('utf8').trim();
    const resolved = await resolve(roots, path.resolve(gitDir, common), true); if (!directories.includes(resolved)) directories.push(resolved);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const directory of directories) await scanMetadata(roots, directory);
  return { root, gitDir, args: [`--git-dir=${gitDir}`, `--work-tree=${root}`] };
}

export async function gitStatus(roots, requested) {
  const repo = await repository(roots, requested);
  const source = await executeGit(repo.root, [...repo.args, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']);
  const parts = source.split('\0'); const entries = [];
  for (let index = 0; index < parts.length; index++) {
    const item = parts[index]; if (!item) continue;
    const entry = { status: item.slice(0, 2), path: item.slice(3) };
    if (/[RC]/.test(entry.status)) entry.originalPath = parts[++index];
    if (entries.length >= 2000) fail('Git status exceeds the local viewing limit', 'FILE_LIMIT');
    entries.push(entry);
  }
  return { root: repo.root, entries };
}

export async function gitDiff(roots, { root, path: requested } = {}) {
  const repo = await repository(roots, root ?? roots[0]); const paths = [];
  if (requested !== undefined) {
    validPath(requested); const absolute = path.isAbsolute(requested) ? requested : path.join(repo.root, requested);
    if (!contains(repo.root, path.resolve(absolute)) || metadataPath(absolute)) fail('Diff path leaves the repository', 'FORBIDDEN_PATH');
    try { const canonical = await resolvePath(roots, absolute); if (!contains(repo.root, canonical)) fail('Diff symlink leaves the repository', 'FORBIDDEN_PATH'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    paths.push(path.relative(repo.root, absolute));
  }
  const options = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--ignore-submodules=all'];
  let hasHead = true; try { await executeGit(repo.root, [...repo.args, 'rev-parse', '--verify', 'HEAD']); } catch (error) { if (error.code !== 'GIT_FAILED') throw error; hasHead = false; }
  const diff = await executeGit(repo.root, [...repo.args, 'diff', ...options, ...(hasHead ? ['HEAD'] : ['--cached']), '--', ...paths]);
  return { root: repo.root, diff, truncated: false };
}

export async function createWorktree(roots, { root, destination, branch } = {}) {
  validPath(destination); if (!path.isAbsolute(destination) || metadataPath(destination)) fail('Worktree destination must be an absolute authorized path');
  const parent = await resolvePath(roots, path.dirname(destination)); const canonical = path.join(parent, path.basename(destination));
  if (!owner(roots, canonical)) fail('Worktree destination leaves the authorized roots', 'FORBIDDEN_PATH');
  try { await fs.lstat(canonical); fail('Worktree destination already exists', 'WORKTREE_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const repo = await repository(roots, root ?? roots[0]);
  if (branch !== undefined) { if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('.lock')) fail('Worktree branch is invalid'); await executeGit(repo.root, [...repo.args, 'check-ref-format', '--branch', branch]); }
  await executeGit(repo.root, [...repo.args, 'worktree', 'add', ...(branch ? ['-b', branch] : ['--detach']), '--', canonical, 'HEAD']);
  return { root: repo.root, path: await resolvePath(roots, canonical), branch: branch ?? null, isolatedRoots: [repo.root] };
}
