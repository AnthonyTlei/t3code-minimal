import { test as base, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApplication } from '../server/server.mjs';
import { CodexSession } from '../server/codex.mjs';

const execute = promisify(execFile);
const fake = fileURLToPath(new URL('../test/fake-codex.mjs', import.meta.url));
type Harness = { app: Awaited<ReturnType<typeof createApplication>>, roots: string[], dataDir: string, requests: { method: string; url: string; failed?: string }[], restart: () => Promise<void>, api: (route: string, method?: string, data?: unknown) => Promise<any>, seed: (name?: string) => Promise<any> };
const test = base.extend<{ harness: Harness }>({
  harness: async ({ page }, use) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 't3-local-browser-'));
    const roots: string[] = [];
    for (const name of ['synthetic-app', 'synthetic-library']) {
      const directory = path.join(temporary, name); await fs.mkdir(directory); const root = await fs.realpath(directory); roots.push(root);
      await execute('git', ['init', '-q'], { cwd: root });
      await fs.writeFile(path.join(root, 'example.ts'), 'export const message = "before";\n');
      await execute('git', ['-c', 'core.hooksPath=/dev/null', 'add', 'example.ts'], { cwd: root });
      await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Synthetic baseline'], { cwd: root });
      await fs.writeFile(path.join(root, 'example.ts'), 'export const message = "after";\n');
    }
    const dataDir = path.join(temporary, 'state'); await fs.chmod(fake, 0o755);
    const options = { roots, dataDir, executable: fake, port: 0, sessionFactory: (args: any) => new CodexSession(args) };
    let app = await createApplication(options);
    const requests: Harness['requests'] = [];
    page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
    page.on('requestfailed', request => { const recorded = requests.findLast(item => item.url === request.url()); if (recorded) recorded.failed = request.failure()?.errorText; });
    const api = async (route: string, method = 'GET', data?: unknown) => {
      const response = await fetch(app.url + route, { method, headers: { Authorization: `Bearer ${app.token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error?.message || 'Synthetic request failed'); return value;
    };
    const harness = { get app() { return app; }, roots, dataDir, requests, api,
      restart: async () => { await page.goto('about:blank'); await app.close(); app = await createApplication(options); },
      seed: async (name = 'Browser chat') => { const project = await api('/api/projects', 'POST', { name: 'Synthetic project', roots }); return api('/api/chats', 'POST', { projectId: project.id, title: name }); },
    };
    await use(harness);
    await page.goto('about:blank'); await app.close(); await fs.rm(temporary, { recursive: true, force: true });
  },
});

async function open(page: Page, harness: Harness) {
  await page.goto(harness.app.url + '/#token=' + harness.app.token);
  await expect(page.getByText('Connected locally', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
}
async function send(page: Page, value: string) { await page.getByRole('textbox', { name: 'Message Codex' }).fill(value); await page.getByRole('button', { name: 'Send message', exact: true }).click(); }
const assistant = (page: Page, value: string) => page.getByRole('article', { name: 'assistant message' }).filter({ hasText: value });

test('private local browser handoff authenticates without a secret-bearing process argument', async ({ page, harness }) => {
  expect(harness.app.launchUri).not.toContain(harness.app.token);
  expect((await fs.stat(harness.app.launchFile)).mode & 0o777).toBe(0o600);
  await page.goto(harness.app.launchUri);
  await expect(page.getByText('Connected locally', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  expect(harness.requests.every(request => request.url === harness.app.launchUri || request.url.startsWith(harness.app.url))).toBe(true);
  expect((await fs.readdir(harness.roots[0])).some(name => name.startsWith('.fake-codex'))).toBe(false);
});

test('cold start, explicit multi-root project, chat, streaming, code/diff, rename/archive and theme', async ({ page, harness }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page, harness);
  await expect(page.getByRole('heading', { name: 'Make room for good work.' })).toBeVisible();
  expect((await fs.readdir(harness.roots[0])).some(name => name.startsWith('.fake-codex'))).toBe(false);
  await page.getByRole('button', { name: 'Add your first project' }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('Name', { exact: true }).fill('Synthetic project');
  await dialog.getByRole('checkbox').nth(0).check(); await dialog.getByRole('checkbox').nth(1).check();
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByRole('button', { name: 'Start a chat', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Chat name (optional)').fill('Feature work');
  await page.getByRole('button', { name: 'Create chat', exact: true }).click();
  await send(page, 'hello browser'); await expect(assistant(page, 'Synthetic response: hello browser')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle local files and changes' }).click();
  await page.getByRole('button', { name: 'example.ts', exact: true }).click();
  await expect(page.getByLabel('Local files and changes').getByText('export const message = "after";', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Changes' }).click();
  await expect(page.getByLabel('Local files and changes').getByText(/\+export const message = "after"/)).toBeVisible();
  await page.getByRole('button', { name: 'Close files panel' }).click();
  await page.getByRole('button', { name: 'Rename chat', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Release check'); await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('button', { name: 'Release check', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Archive chat', exact: true }).click();
  await expect(page.getByText('This chat is archived.')).toBeVisible();
  await page.getByRole('button', { name: 'Unarchive', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/); await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.screenshot({ path: 'output/playwright/local-workspace-light.png', fullPage: true });
  expect(errors).toEqual([]);
  expect(harness.requests.filter(request => !request.url.startsWith(harness.app.url))).toEqual([]);
});

test('native approval, questions, concurrent chats and cancellation remain independent', async ({ page, harness }) => {
  const first = await harness.seed('First chat'); const second = await harness.api('/api/chats', 'POST', { projectId: first.projectId, title: 'Second chat' });
  await open(page, harness); await page.getByRole('button', { name: 'First chat', exact: true }).first().click();
  await send(page, 'approval'); await expect(page.getByRole('region', { name: 'Approval requested' })).toBeVisible();
  await page.getByRole('button', { name: 'Second chat', exact: true }).first().click();
  await send(page, 'second'); await expect(assistant(page, 'Synthetic response: second')).toBeVisible();
  await page.getByRole('button', { name: /First chat/ }).first().click(); await page.getByRole('button', { name: 'Approve once', exact: true }).click();
  await expect(assistant(page, 'Approval decision: accept')).toBeVisible();
  await send(page, 'question'); await page.getByRole('radio', { name: /B\s+Second/ }).check(); await page.getByRole('button', { name: 'Send answers' }).click();
  await expect(assistant(page, 'Answer: B')).toBeVisible();
  await send(page, 'hold'); await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop response' }).click(); await expect(page.locator('.composer-footnote')).toContainText('Interrupted');
  const snapshot = await harness.api('/api/bootstrap'); expect(snapshot.chats.find((chat: any) => chat.id === second.id).messages.some((message: any) => message.text === 'Synthetic response: second')).toBe(true);
});

test('restart/resume, CLI-derived model controls and clear defaults preserve native history', async ({ page, harness }) => {
  const chat = await harness.seed('Persistent chat'); await open(page, harness); await page.getByRole('button', { name: 'Persistent chat', exact: true }).first().click();
  await page.getByRole('button', { name: 'CLI default', exact: true }).click();
  await page.getByLabel('Model', { exact: true }).selectOption('synthetic-model'); await page.getByLabel('Reasoning', { exact: true }).selectOption('low');
  await send(page, 'before restart'); await expect(assistant(page, 'Synthetic response: before restart')).toBeVisible();
  const nativeId = (await harness.api('/api/bootstrap')).chats[0].nativeThreadId;
  await harness.restart(); await open(page, harness); await page.getByRole('button', { name: 'Persistent chat', exact: true }).first().click();
  await expect(assistant(page, 'Synthetic response: before restart')).toBeVisible();
  await page.locator('.model-trigger').click(); await page.getByLabel('Model', { exact: true }).selectOption('');
  await send(page, 'after restart'); await expect(assistant(page, 'Synthetic response: after restart')).toBeVisible();
  const current = (await harness.api('/api/bootstrap')).chats.find((item: any) => item.id === chat.id);
  expect(current.nativeThreadId).toBe(nativeId); expect(current.model).toBeUndefined(); expect(current.reasoning).toBeUndefined();
  const wire = (await fs.readFile(path.join(harness.roots[0], '.fake-codex-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  expect(wire.some(item => item.method === 'thread/resume' && item.params.threadId === nativeId)).toBe(true);
  expect(wire.filter(item => item.method === 'turn/start').at(-1).params).not.toHaveProperty('model');
});

test('hostile transcript content stays inert and makes no remote browser resource requests', async ({ page, harness }) => {
  await harness.seed('Hostile content'); await open(page, harness); await page.getByRole('button', { name: 'Hostile content', exact: true }).first().click();
  const hostile = '<img src="https://unapproved.invalid/image.png" onerror="alert(1)"><svg><image href="https://unapproved.invalid/a"/></svg><style>@import "https://unapproved.invalid/x.css";</style><iframe src="https://unapproved.invalid/frame"></iframe><script>new WebSocket("wss://unapproved.invalid/ws")</script>\n![remote](https://unapproved.invalid/image)\n[click](javascript:alert(1))';
  const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await send(page, hostile); await expect(assistant(page, 'Synthetic response:')).toContainText(hostile);
  const timeline = page.getByLabel('Chat messages'); await expect(timeline.locator('img,iframe,style,script,video,a,object,embed')).toHaveCount(0);
  expect(dialogs).toEqual([]); expect(harness.requests.filter(request => !request.url.startsWith(harness.app.url))).toEqual([]);
});

test('errors remain visible, recoverable and private; narrow mobile layout keeps real controls usable', async ({ page, harness }) => {
  await harness.seed('Mobile check'); await page.setViewportSize({ width: 390, height: 844 }); await open(page, harness);
  await page.getByRole('button', { name: 'Open navigation' }).click(); await page.getByRole('button', { name: 'Mobile check', exact: true }).first().click();
  await send(page, 'rpc-error'); await expect(page.getByRole('alert').first()).toContainText('Codex rejected turn/start');
  expect(await page.locator('body').innerText()).not.toContain('sk-synthetic-secret');
  await page.getByRole('button', { name: 'Dismiss error' }).click(); await send(page, 'recovered'); await expect(assistant(page, 'Synthetic response: recovered')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'output/playwright/local-workspace-mobile.png', fullPage: true });
});

test('explicit worktree creates a separate project and local Git views keep authorized shared metadata', async ({ page, harness }) => {
  await harness.seed('Worktree source'); await open(page, harness); await page.getByRole('button', { name: 'Worktree source', exact: true }).first().click();
  await page.getByRole('button', { name: 'Create worktree', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Destination directory').fill(path.join(harness.roots[0], 'isolated-checkout'));
  await page.getByRole('dialog').getByLabel('New branch (optional)').fill('synthetic-isolation');
  await page.getByRole('dialog').getByRole('button', { name: 'Create worktree', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make room for good work.' })).toBeVisible();
  await page.getByRole('button', { name: 'Toggle local files and changes' }).click();
  await page.getByRole('tab', { name: 'Changes' }).click();
  await expect(page.getByLabel('Local files and changes').getByText('No local changes', { exact: true })).toBeVisible();
  const state = await harness.api('/api/bootstrap'); expect(state.projects).toHaveLength(2);
  expect(await fs.readFile(path.join(harness.roots[0], 'isolated-checkout', 'example.ts'), 'utf8')).toContain('"before"');
});
