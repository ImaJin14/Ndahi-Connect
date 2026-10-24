import assert from 'node:assert/strict';
import { createStaticServer } from '../static-server.mjs';
const server = createStaticServer('customer', { apiUrl: 'https://api.pwa.test', env: {} });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const portal = `http://localhost:${server.address().port}`;
let browser, checks = 0;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  async function scenario(name, work, options = {}) {
    const context = await browser.newContext({ viewport: { width: 320, height: 900 }, ...options });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    try {
      await context.route('https://api.pwa.test/**', route => route.abort());
      await page.goto(portal + '/wifi-connected.html');
      await page.evaluate(async () => {
        const target = document.createElement('section'); target.id = 'installFixture'; document.body.append(target);
        const { mountInstallCard } = await import('/install.js'); mountInstallCard(target);
      });
      await work(page, context); checks++; console.log('PASS ' + name);
    } finally { await context.close(); }
  }
  await scenario('optional native install is one user gesture and does not navigate or grant network access', async page => {
    await page.evaluate(() => {
      window.prompts = 0;
      const event = new Event('beforeinstallprompt', { cancelable: true });
      event.prompt = async () => { window.prompts++; }; event.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(event);
    });
    await page.getByRole('button', { name: 'Install app', exact: true }).click();
    assert.equal(await page.evaluate(() => window.prompts), 1);
    assert.equal(await page.locator('#installFixture').isHidden(), true);
    assert.equal(new URL(page.url()).pathname, '/wifi-connected.html');
  });
  await scenario('a rejected install prompt and denied optional storage preserve web access', async page => {
    await page.evaluate(() => {
      for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, { get() { throw Error('denied'); } });
      const event = new Event('beforeinstallprompt', { cancelable: true });
      event.prompt = async () => { throw Error('unsupported'); }; window.dispatchEvent(event);
    });
    await page.getByRole('button', { name: 'Install app', exact: true }).click();
    await page.locator('#installFixture').getByText(/Installation is optional/).waitFor();
    assert.equal(new URL(page.url()).pathname, '/wifi-connected.html');
  });
  await scenario('iPhone guidance remains optional and explains separate sign-in', async page => {
    await page.locator('#installFixture').getByText(/Add to Home Screen/, { exact: false }).first().waitFor();
    assert.match(await page.locator('#installFixture').innerText(), /may need to sign in again/);
    assert.equal(await page.getByRole('button', { name: 'Install app', exact: true }).count(), 0);
  }, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
  await scenario('offline launch exposes no prior private URL or cached account page', async (page, context) => {
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    });
    await context.setOffline(true);
    await page.goto(portal + '/dashboard?checkoutKey=do-not-retain#payments');
    await page.getByRole('heading', { name: "You're offline", exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Try Dashboard again' }).getAttribute('href'), '/dashboard');
    assert.equal(await page.evaluate(async () => (await caches.keys()).length), 0);
    assert.doesNotMatch(await page.locator('body').innerText(), /do-not-retain/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await context.setOffline(false);
    await page.getByRole('link', { name: 'Browse packages when online' }).click();
    await page.getByRole('heading', { name: 'Choose the plan that fits you' }).waitFor();
  });
  await scenario('a worker update never reloads a page during payment and the release UI waits', async page => {
    await page.route('**/version.json', route => route.fulfill({ json: { revision: 'new-pwa-release' } }));
    await page.evaluate(async () => {
      window.paymentPending = true; window.reloads = 0;
      const { startUpdates } = await import('/updates.js');
      startUpdates({ intervalMs: 50, isBusy: () => window.paymentPending, reload: () => { window.reloads++; } });
      await (await navigator.serviceWorker.ready).update();
    });
    await page.locator('.update-notice').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.update-notice button').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.reloads), 0);
    await page.evaluate(() => { window.paymentPending = false; });
    await page.waitForFunction(() => window.reloads === 1);
  });
  console.log(`PASS ${checks} PWA browser journeys (Chromium fixtures; native installation and OS captive acceptance remain separate)`);
} finally { await browser?.close(); await new Promise(r => { server.close(r); server.closeAllConnections(); }); }
