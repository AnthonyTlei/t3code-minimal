import assert from 'node:assert/strict';
import { chromium } from 'playwright';

export async function browserCheck(app) {
  let browser;
  const requests = []; const failures = []; const sockets = []; const policyViolations = [];
  try {
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, chromiumSandbox: true, args: ['--disable-background-networking'] });
  } catch (error) {
    const diagnostic = error.message.replaceAll(/#token=[^\s]+/g, '#token=[redacted]').slice(-3500);
    return { status: 'blocked', code: 'SANDBOXED_BROWSER_LAUNCH_FAILED', diagnostic, limitation: 'No --no-sandbox flag, security-profile relaxation or added capability was used. Browser process launch was traced, but page/global-network behavior cannot be verified without a working sandboxed browser.' };
  }
  try {
    const context = await browser.newContext(); const page = await context.newPage();
    await page.exposeFunction('recordAuditCsp', value => policyViolations.push(value));
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => globalThis.recordAuditCsp({ directive: event.violatedDirective, blockedURI: event.blockedURI })));
    const sanitize = value => { const url = new URL(value); return url.origin + url.pathname; };
    page.on('request', request => requests.push({ method: request.method(), url: sanitize(request.url()), resource: request.resourceType() }));
    page.on('requestfailed', request => failures.push({ url: sanitize(request.url()), error: request.failure()?.errorText }));
    page.on('websocket', socket => sockets.push(sanitize(socket.url())));
    await page.goto(app.url + '/#token=' + app.token);
    const composer = page.getByRole('textbox', { name: 'Message Codex', exact: true });
    await composer.fill('browser observation');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Synthetic response: browser observation', { exact: true }).waitFor();
    const hostile = 'remote-content audit: ![image](https://remote.t3-audit.invalid/pixel) <img src="https://remote.t3-audit.invalid/pixel"><svg><image href="https://remote.t3-audit.invalid/svg"></image></svg> <style>@import "https://remote.t3-audit.invalid/style";</style>';
    await composer.fill(hostile); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('remote-content audit:', { exact: false }).last().waitFor();
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor({ state: 'visible' });
    await page.waitForTimeout(20_000);
    assert.ok(requests.length > 0);
    assert.deepEqual(requests.filter(request => new URL(request.url).origin !== app.url), []);
    assert.equal(await page.locator('img, iframe, video, audio, object, embed').count(), 0);
    assert.equal(new URL(page.url()).hash, '');
    await context.close();
    return { status: 'pass', requests, failures, sockets, policyViolations, idleMs: 20_000, hostileMarkupRenderedAsText: true, sandboxEnabled: true };
  } finally { await browser.close(); }
}
