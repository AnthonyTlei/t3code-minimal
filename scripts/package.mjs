import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const name = `t3code-local-${version}`;
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 't3-local-package-'));
const staged = path.join(temporary, name); await fs.mkdir(staged);
try {
  for (const relative of ['minimal/server', 'dist', 'LICENSE', 'NOTICE', 'CHANGELOG.md', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'AGENTS.md', 'docs', 'minimal/audit/README.md', 'minimal/audit/RESULTS.md', 'minimal/web/UPSTREAM.md', 'Dockerfile', 'compose.yaml', 'Makefile', '.dockerignore', 'scripts/manage.py', 'scripts/feasibility/host-check.sh']) {
    const target = path.join(staged, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.cp(path.join(root, relative), target, { recursive: true, dereference: false });
  }
  const hashes = [];
  async function inspect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); if (entry.isSymbolicLink()) throw new Error('Release files must not be symlinks');
      if (entry.isDirectory()) await inspect(file);
      else {
        const relative = path.relative(staged, file); if (/node_modules|fake-codex|connection\.json|launch\.html|state\.json|\.env|test-results|\.git(?:\/|$)/.test(relative)) throw new Error(`Forbidden release content: ${relative}`);
        hashes.push({ path: relative, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') });
      }
    }
  }
  await inspect(staged); hashes.sort((a, b) => a.path.localeCompare(b.path));
  const epochText = process.env.SOURCE_DATE_EPOCH ?? '0';
  if (!/^\d{1,10}$/.test(epochText) || Number(epochText) > 8_589_934_591) throw new Error('SOURCE_DATE_EPOCH must be a nonnegative USTAR timestamp');
  const sourceDateEpoch = Number(epochText);
  await fs.writeFile(path.join(staged, 'MANIFEST.json'), JSON.stringify({ format: 't3code-local-release', version, node: '24.x', sourceDateEpoch, files: hashes }, null, 2) + '\n');
  async function normalizeTimes(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await normalizeTimes(filename);
      else await fs.utimes(filename, sourceDateEpoch, sourceDateEpoch);
    }
    await fs.utimes(directory, sourceDateEpoch, sourceDateEpoch);
  }
  await normalizeTimes(staged);
  const release = path.join(root, 'release'); await fs.mkdir(release, { recursive: true }); const archive = path.join(release, `${name}.tar.gz`);
  const tarVersion = execFileSync('tar', ['--version'], { encoding: 'utf8' });
  const owners = tarVersion.includes('bsdtar') ? ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root'] : tarVersion.includes('GNU tar') ? ['--owner=0', '--group=0', '--numeric-owner'] : null;
  if (!owners) throw new Error('Release packaging requires GNU tar or bsdtar');
  execFileSync('tar', ['--format=ustar', '--no-xattrs', '--no-acls', ...owners, '-czf', archive, '-C', temporary, name], { stdio: 'pipe', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const digest = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  await fs.writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
  console.log(`${archive}\nSHA-256 ${digest}\n${hashes.length} allowlisted files; no npm install is needed to run the archive.`);
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
