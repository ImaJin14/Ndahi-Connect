import assert from 'node:assert/strict';
import { createStaticServer } from '../static-server.mjs';
import { pairingFixture } from '../test/helpers/wifi-pairing-fixture.mjs';
import { deliverActivityPush } from '../lib/notifications.mjs';
const website = createStaticServer('customer', { apiUrl: 'http://api.background.test' });
await new Promise(r => website.listen(0, '127.0.0.1', r));
const portal = `http://127.0.0.1:${website.address().port}`;
const f = await pairingFixture({ origin: portal, env: { WEB_PUSH_PUBLIC_KEY: 'B'.repeat(87), WEB_PUSH_PRIVATE_KEY: 'fixture', WEB_PUSH_SUBJECT: 'mailto:fixture@example.test' } });
let browser;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  for (const width of [320, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([{ name: 'customer_session', value: 'main', domain: '127.0.0.1', path: '/api/account', httpOnly: true, sameSite: 'Lax' }]);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'http://api.background.test') {
        const response = await route.fetch({ url: f.api + url.pathname + url.search, headers: { ...route.request().headers(), origin: portal } }); return route.fulfill({ response });
      }
      return url.origin === portal ? route.continue() : route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    await page.goto(portal + '/dashboard#account'); await page.getByRole('button', { name: 'Manage notification settings', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Notifications', exact: true });
    await panel.getByLabel('Email data and expiry alerts when browser push is unavailable', { exact: true }).check();
    await panel.getByRole('button', { name: 'Save notification settings', exact: true }).click();
    await panel.getByText('Notification settings saved.', { exact: true }).waitFor();
    assert.equal((await f.call('/api/account/notifications', undefined, { session: 'secondary' })).body.preferences.emailFallback, true);
    const mockBrowserSubscription = async () => {
      await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
      window.permissionCalls = 0;
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
      Notification.requestPermission = async () => { permissionCalls++; return 'granted'; };
      const sub = { endpoint: 'https://fcm.googleapis.com/send/background', keys: { auth: 'a'.repeat(22), p256dh: 'B'.repeat(87) } };
      navigator.serviceWorker.register = async () => ({ pushManager: { getSubscription: async () => ({ toJSON: () => sub, endpoint: sub.endpoint, unsubscribe: async () => true }) } });
    };
    await page.evaluate(mockBrowserSubscription);
    await panel.getByRole('button', { name: 'Enable on this device', exact: true }).click();
    await panel.getByText('Browser notifications enabled on this device.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => permissionCalls), 0, 'already granted permission is not requested again');
    await page.close();
    await f.store.transaction(s => { s.securityAlerts.push({ id: 'closed-' + width, customerId: 'c1', subject: 'Synthetic security event', lines: [], at: f.now().toISOString() }); });
    const sent = []; await deliverActivityPush({ store: f.store, now: f.now, config: { enabled: true, publicKey: 'fixture', privateKey: 'fixture', subject: 'mailto:fixture@example.test' }, send: async (_s, text) => sent.push(JSON.parse(text)) });
    assert.ok(sent.some(n => n.url === '/dashboard#account'), 'server delivery works with no dashboard page');
    const reopened = await context.newPage(); await reopened.goto(portal + '/dashboard#account'); await reopened.evaluate(mockBrowserSubscription); await reopened.getByRole('button', { name: 'Manage notification settings', exact: true }).click();
    await reopened.getByRole('dialog', { name: 'Notifications', exact: true }).getByRole('button', { name: 'Disable on this device', exact: true }).click();
    await reopened.getByText('Browser notifications disabled on this device.', { exact: true }).waitFor();
    assert.equal((await f.store.snapshot()).customers.find(c => c.id === 'c1').pushSubscriptions.length, 0);
    assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await context.close(); console.log(`PASS ${width}px fallback consent, persistent settings, explicit push opt-in, closed-dashboard server delivery and unsubscribe (synthetic transport)`);
  }
} finally { await browser?.close(); await f.close(); await new Promise(r => { website.close(r); website.closeAllConnections(); }); }
