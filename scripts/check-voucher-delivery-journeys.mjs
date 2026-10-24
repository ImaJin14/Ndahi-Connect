import assert from 'node:assert/strict';
import http from 'node:http';
import { createStaticServer } from '../static-server.mjs';
import { pairingFixture, mainMac } from '../test/helpers/wifi-pairing-fixture.mjs';
const website = http.createServer(); await new Promise(r => website.listen(0, '127.0.0.1', r));
const portal = `http://127.0.0.1:${website.address().port}`;
const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, env: { NODE_ENV: 'test', PAYMENT_MODE: 'mock', EMAIL_MODE: 'mock' } });
const assets = createStaticServer('customer', { apiUrl: f.api, hotspotLoginUrl: 'https://connect.voucher.test/login' }); website.on('request', (req, res) => assets.emit('request', req, res));
let browser, checks = 0;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  async function scenario(name, work, { width = 320, standalone = false, storage = true, signedIn = true } = {}) {
    await f.store.transaction(s => {
      s.payments = [{ id: 'p1', customerId: 'c1', status: 'paid', confirmedAt: f.now().toISOString(), amount: 500, currency: 'XAF', planId: 'family' }];
      s.vouchers[0].paymentId = 'p1';
    });
    const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
    if (signedIn) await context.addCookies([{ name: 'customer_session', value: 'main', domain: '127.0.0.1', path: '/api/account', httpOnly: true, sameSite: 'Lax' }]);
    await context.addInitScript(({ standalone, storage }) => {
      if (standalone) Object.defineProperty(navigator, 'standalone', { value: true });
      if (!storage) for (const key of ['sessionStorage', 'localStorage']) Object.defineProperty(window, key, { get() { throw Error('storage denied'); } });
      window.closeCalls = 0; window.close = () => { closeCalls++; };
    }, { standalone, storage });
    await context.route('**/*', route => [portal, f.api].includes(new URL(route.request().url()).origin) ? route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': '203.0.113.10' } }) : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(12000); const errors = []; page.on('pageerror', e => errors.push(e.message));
    try { await work(page, context); assert.deepEqual(errors, []); checks++; console.log('PASS ' + name); }
    finally { await context.close(); }
  }
  for (const width of [320, 1280]) await scenario(`blocked PDF, retry, reload and history retain confirmed voucher at ${width}px`, async (page, context) => {
    await page.goto(portal + '/voucher-ready.html?payment=p1'); await page.getByRole('button', { name: 'Download Voucher', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Voucher code', { exact: true }).inputValue(), 'NC-AAAA-1111');
    assert.equal(await page.evaluate(() => window.closeCalls), 0);
    await page.route('**/api/account/vouchers/v1/download', route => route.fulfill({ status: 503, json: { error: 'Synthetic PDF unavailable' } }), { times: 1 });
    await page.getByRole('button', { name: 'Download Voucher', exact: true }).click();
    await page.locator('#downloadStatus').filter({ hasText: 'Your payment and saved voucher are unchanged' }).waitFor();
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download Voucher', exact: true }).click(); assert.match((await download).suggestedFilename(), /^ndahi-voucher-v1\.pdf$/);
    await page.reload(); await page.getByRole('button', { name: 'Download Voucher', exact: true }).waitFor();
    await page.getByRole('link', { name: 'View all saved vouchers', exact: true }).click();
    await page.locator('[data-voucher-id="v1"]').waitFor(); const again = page.waitForEvent('download'); await page.locator('[data-voucher-id="v1"] [data-download-voucher]').click(); await again;
    assert.equal((await f.store.snapshot()).payments[0].status, 'paid'); assert.equal((await f.store.snapshot()).vouchers.length, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }, { width });
  await scenario('supported standalone context offers one PDF without closing or redirecting the window', async page => {
    let offers = 0; page.on('download', () => offers++);
    const download = page.waitForEvent('download'); await page.goto(portal + '/voucher-ready.html?payment=p1'); await download;
    await page.locator('#downloadStatus').filter({ hasText: 'offered to your browser' }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/voucher-ready.html'); assert.equal(await page.evaluate(() => window.closeCalls), 0);
    await page.reload(); await page.getByRole('button', { name: 'Download Voucher', exact: true }).waitFor(); assert.equal(offers, 1, 'reload does not repeatedly offer automatic downloads');
  }, { standalone: true });
  await scenario('captive identity and denied storage use explicit download and preserve continuation', async page => {
    let automatic = 0; page.on('download', () => automatic++);
    const path = '/voucher-ready.html?payment=p1&mac=' + encodeURIComponent(mainMac) + '&address=10.20.0.1';
    await page.goto(portal + path); await page.getByRole('button', { name: 'Download Voucher', exact: true }).waitFor();
    assert.equal(automatic, 0); assert.equal(await page.evaluate(() => closeCalls), 0);
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download Voucher', exact: true }).click(); await download;
    assert.equal(new URL(page.url()).searchParams.get('mac'), mainMac);
  }, { standalone: true, storage: false });
  await scenario('a separate app session must sign in before any PDF or voucher code is available', async page => {
    await page.goto(portal + '/voucher-ready.html?payment=p1'); await page.waitForURL(url => url.pathname === '/login');
    assert.equal(await page.locator('body').innerText().then(t => t.includes('NC-AAAA-1111')), false);
    assert.equal(new URL(page.url()).searchParams.get('next'), '/voucher-ready.html?payment=p1');
  }, { signedIn: false });
  await scenario('an unrelated purchase ID is not replaced by another account voucher', async page => {
    await page.goto(portal + '/voucher-ready.html?payment=not-owned'); await page.locator('#voucherStatus').filter({ hasText: 'No confirmed voucher' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Download Voucher', exact: true }).isHidden(), true);
    assert.equal(await page.locator('body').innerText().then(t => t.includes('NC-AAAA-1111')), false);
  });
  await scenario('a paid saved checkout for an established account returns through owner sign-in to the exact voucher', async (page, context) => {
    await f.store.transaction(s => { s.vouchers[0].status = 'exhausted'; s.vouchers[0].usedBytes = s.vouchers[0].quotaBytes; });
    const requestKey = 'a1'.repeat(16);
    const created = await f.call('/api/purchase', { phone: '670050001', name: 'Existing owner', planId: 'weekly', requestKey });
    assert.equal(created.status, 201); const id = created.body.payment.id;
    assert.equal((await f.call('/api/payments/' + id + '/confirm', {})).status, 200);
    await context.addCookies([{ name: 'ndahi-checkout', value: encodeURIComponent(JSON.stringify({ value: JSON.stringify({ paymentId: id, requestKey, planId: 'weekly' }), expiresAt: Date.now() + 60000 })), domain: '127.0.0.1', path: '/' }]);
    await page.route('**/api/purchase/recover', route => route.fulfill({ status: 404, json: { error: 'Synthetic lost recovery response' } }), { times: 1 });
    await page.goto(portal + '/onboarding.html'); await page.waitForURL(url => url.pathname === '/login');
    const next = '/voucher-ready.html?payment=' + id;
    assert.equal(new URL(page.url()).searchParams.get('next'), next); assert.equal(new URL(page.url()).searchParams.get('account'), '1');
    const stored = await f.store.snapshot(), voucher = stored.vouchers.find(v => v.paymentId === id);
    await page.locator('#login [name="phone"]').fill('670050001'); await page.locator('#login [name="code"]').fill(voucher.code); await page.locator('#loginSubmit').click();
    await page.locator('#customerPin').fill('2468'); await page.locator('#loginSubmit').click(); await page.waitForURL(portal + next);
    await page.getByRole('button', { name: 'Download Voucher', exact: true }).waitFor(); assert.equal(await page.getByLabel('Voucher code', { exact: true }).inputValue(), voucher.code);
  }, { signedIn: false });
  console.log(`PASS ${checks} retained voucher browser journeys; physical captive/download and real email delivery remain separate`);
} finally { await browser?.close(); await f.close(); await new Promise(r => { website.close(r); website.closeAllConnections(); }); }
