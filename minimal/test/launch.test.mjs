import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createBrowserLaunchFile } from '../server/launch.mjs';
import { createApplication } from '../server/server.mjs';

const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const token = 'A'.repeat(43);
const url = `http://127.0.0.1:3777/#token=${token}`;
async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 't3-launch-'));
  await fs.chmod(temporary, 0o700);
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  return temporary;
}

test('browser launch keeps the capability in a private static file and returns only a token-free file URI', async t => {
  const directory = await fixture(t);
  const launch = await createBrowserLaunchFile(directory, url);
  assert.equal(launch.uri.startsWith('file://'), true); assert.equal(launch.uri.includes(token), false);
  assert.equal(fileURLToPath(launch.uri), launch.path);
  assert.equal((await fs.stat(launch.path)).mode & 0o777, 0o600);
  const html = await fs.readFile(launch.path, 'utf8');
  assert.ok(html.includes(`content="0;url=${url}"`)); assert.ok(html.includes('no-referrer'));
  assert.ok(html.includes("default-src 'none'")); assert.equal(/<script|<iframe|<img|<link|<form/i.test(html), false);
  const rotated = url.replace(token, 'B'.repeat(43));
  await createBrowserLaunchFile(directory, rotated);
  assert.equal((await fs.readFile(launch.path, 'utf8')).includes(token), false);
});

test('browser handoff rejects external destinations and unsafe private paths without overwriting their targets', async t => {
  const directory = await fixture(t);
  for (const destination of [url.replace('127.0.0.1', 'unapproved.invalid'), url.replace('http:', 'https:'), url + '\n', url.replace('/#', '/?secret=yes#'), url.replace(token, '<script>')]) await assert.rejects(createBrowserLaunchFile(directory, destination));
  const target = path.join(directory, 'preserve.txt'); await fs.writeFile(target, 'preserve');
  const launch = path.join(directory, 'launch.html'); await fs.symlink(target, launch);
  await assert.rejects(createBrowserLaunchFile(directory, url)); assert.equal(await fs.readFile(target, 'utf8'), 'preserve');
  await fs.unlink(launch); await fs.chmod(directory, 0o755);
  await assert.rejects(createBrowserLaunchFile(directory, url)); await fs.chmod(directory, 0o700);
});

test('application rotates private browser handoff on restart and removes it on clean shutdown', async t => {
  const root = await fixture(t); const options = { roots: [root], executable: fake, port: 0, dataDir: path.join(root, 'state') };
  const app = await createApplication(options); t.after(() => app.close());
  assert.ok((await fs.readFile(app.launchFile, 'utf8')).includes(app.token));
  await app.close(); await assert.rejects(fs.stat(app.launchFile), { code: 'ENOENT' });
  const next = await createApplication(options); t.after(() => next.close());
  assert.notEqual(next.token, app.token); assert.ok((await fs.readFile(next.launchFile, 'utf8')).includes(next.token));
});

test('native --open passes only a private file URI to the opener process', async t => {
  const root = await fixture(t); const bin = path.join(root, 'bin'); await fs.mkdir(bin);
  const capture = path.join(root, 'opener-argv.json'); const state = path.join(root, 'state');
  const opener = path.join(bin, process.platform === 'darwin' ? 'open' : 'xdg-open');
  await fs.writeFile(opener, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)), {mode:384});\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/main.mjs', import.meta.url)), '--root', root, '--data-dir', state, '--codex', fake, '--port', '0', '--open'], { env: { ...process.env, PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter) }, stdio: ['ignore', 'ignore', 'ignore'] });
  const exited = once(child, 'close');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; });
  let args;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { args = JSON.parse(await fs.readFile(capture, 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (child.exitCode !== null) assert.fail('Synthetic native launcher exited before opening');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(args?.length, 1); assert.equal(args[0].startsWith('file://'), true);
  const secret = new URLSearchParams(new URL(JSON.parse(await fs.readFile(path.join(state, 'connection.json'), 'utf8')).url).hash.slice(1)).get('token');
  assert.equal(args[0].includes(secret), false); assert.equal(args[0].includes('#'), false);
  assert.equal((await fs.stat(fileURLToPath(args[0]))).mode & 0o777, 0o600);
});
