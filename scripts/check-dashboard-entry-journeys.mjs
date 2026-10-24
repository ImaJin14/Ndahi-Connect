import assert from 'node:assert/strict';
import http from 'node:http';
import { createStaticServer } from '../static-server.mjs';
import { pairingFixture, mainMac } from '../test/helpers/wifi-pairing-fixture.mjs';
let browser, checks = 0;
const website = http.createServer();
await new Promise(r => website.listen(0, '127.0.0.1', r));
const portal = `http://localhost:${website.address().port}`;
const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true });
const api = f.api.replace('127.0.0.1', 'localhost');
const assets = createStaticServer('customer', { apiUrl: api, hotspotLoginUrl: 'https://connect.entry.test/login' });
website.on('request', (req, res) => assets.emit('request', req, res));
let inside = true;
const initial = await f.store.snapshot();
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  async function scenario(name, work, { pendingPin = false, approval = false } = {}) {
    inside = true;
    await f.store.transaction(s => {
      Object.assign(s, structuredClone(initial));
      if (!approval) delete s.networkSetup.deviceApproval;
      if (pendingPin) { delete s.customers[0].pinHash; delete s.customers[0].wifiMainDevice; }
    });
    const context = await browser.newContext({ viewport: { width: 320, height: 900 } });
    await context.route('**/*', route => [portal, api].includes(new URL(route.request().url()).origin)
      ? route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': inside ? '203.0.113.10' : '198.51.100.10' } }) : route.abort('blockedbyclient'));
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    try { await work(page, context); assert.deepEqual(errors, []); console.log('PASS ' + name); checks++; }
    finally { await context.close(); }
  }
  async function pin(page, path = '/login') {
    await page.goto(portal + path);
    await page.locator('#login [name="phone"]').fill('670050001'); await page.locator('#login [name="code"]').fill('NC-AAAA-1111');
    await page.locator('#loginSubmit').click(); await page.locator('#customerPin').fill('2468'); await page.locator('#loginSubmit').click();
  }
  await scenario('ordinary PIN sign-in defaults to Home and survives reload/app restart/history without claiming Wi-Fi', async page => {
    await pin(page); await page.waitForURL(portal + '/dashboard'); await page.locator('[data-portal-tab="home"][aria-current="page"]').waitFor();
    await page.locator('#currentWifi [data-current-state="unknown"]').waitFor();
    await page.reload(); await page.locator('[data-portal-tab="home"][aria-current="page"]').waitFor();
    await page.locator('[data-portal-tab="account"]').click(); await page.goBack(); await page.locator('[data-portal-tab="home"][aria-current="page"]').waitFor();
    await page.goto('about:blank'); await page.goto(portal + '/dashboard'); await page.locator('[data-portal-tab="home"][aria-current="page"]').waitFor();
  });
  for (const [destination, expected] of [['/dashboard#payments','#payments'],['https://evil.test/steal',''],['/hotspot?next=/login',''],['/%5cevil.test','']]) {
    await scenario('PIN return destination ' + destination + ' is safely resolved', async page => {
      await pin(page, '/login?next=' + encodeURIComponent(destination));
      await page.waitForURL(url => url.pathname === '/dashboard' && url.hash === expected);
    });
  }
  await scenario('explicit account-settings intent is retained without Wi-Fi activation', async page => {
    await pin(page, '/login?account=1'); await page.waitForURL(portal + '/dashboard#account');
    await page.getByRole('heading', { name: 'PIN & passkeys', exact: true }).waitFor();
  });
  await scenario('evidence failure after a committed PIN sign-in still opens Dashboard', async (page, context) => {
    await context.route('**/api/account/connectivity', route => route.fulfill({ status: 503, json: { error: 'Connection read unavailable' } }));
    await pin(page); await page.waitForURL(portal + '/dashboard'); await page.locator('[data-portal-tab="home"][aria-current="page"]').waitFor();
  });
  await scenario('lost PIN completion response recovers only the expected account and reaches Dashboard once', async (page, context) => {
    let completions = 0;
    await context.route('**/api/account/access/complete', async route => { completions++; const response = await route.fetch({ headers: { ...route.request().headers(), 'cf-connecting-ip': '203.0.113.10' } }); assert.equal(response.status(), 200); await route.abort('failed'); }, { times: 1 });
    await pin(page); await page.waitForURL(portal + '/dashboard'); assert.equal(completions, 1);
  });
  await scenario('mobile data account sign-in reaches Dashboard without buying or connecting Wi-Fi', async page => {
    inside = false; const before = f.calls.length; await pin(page); await page.waitForURL(portal + '/dashboard'); assert.equal(f.calls.length, before);
    await page.locator('#currentWifi [data-current-state="unknown"]').waitFor();
  });
  await scenario('a real passkey sign-in defaults to Dashboard', async (page, context) => {
    assert.equal((await context.request.post(api + '/api/account/login/pin', { headers: { origin: portal, 'cf-connecting-ip': '203.0.113.10' }, data: { phone: '670050001', pin: '2468' } })).status(), 200);
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(portal + '/dashboard#account'); await page.locator('#securityManager>summary').click(); await page.locator('[data-security-panel="passkeys"]').click(); await page.locator('#addCustomerPasskey').click();
    await page.locator('[data-passkey-owner-proof] [name="pin"]').fill('2468'); await page.locator('[data-passkey-owner-proof]').getByRole('button', { name: 'Confirm with PIN', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#accountSecurity').textContent.includes('Rename'));
    await page.goto('about:blank'); await context.clearCookies({ name: 'customer_session' });
    await page.goto(portal + '/login'); await page.locator('#login [name="phone"]').fill('670050001'); await page.locator('#customerPasskeyLogin').click(); await page.waitForURL(portal + '/dashboard');
  });
  await scenario('onboarding PIN setup remains required, then defaults to Dashboard', async (page, context) => {
    await context.addInitScript(() => sessionStorage.setItem('ndahi-login-challenge', JSON.stringify({ setupPin: true, phone: '670050001', code: 'NC-AAAA-1111' })));
    await page.goto(portal + '/verify.html'); await page.getByRole('heading', { name: 'Create your PIN.' }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/verify.html');
    await page.locator('#primary').fill('2468'); await page.locator('#confirm').fill('2468'); await page.locator('#submitLabel').click(); await page.waitForURL(portal + '/dashboard');
    assert.ok((await f.store.snapshot()).customers[0].pinHash);
  }, { pendingPin: true });
  await scenario('a connected captive return skips duplicate activation and rejects an external next', async (page, context) => {
    const login = await context.request.post(api + '/api/account/login/pin', { headers: { origin: portal, 'cf-connecting-ip': '203.0.113.10' }, data: { phone: '670050001', pin: '2468' } }); assert.equal(login.status(), 200);
    const account = await (await context.request.get(api + '/api/account/dashboard', { headers: { origin: portal, 'cf-connecting-ip': '203.0.113.10' } })).json();
    const identified = await context.request.post(api + '/api/account/device-management/current/identify', { headers: { origin: portal, 'cf-connecting-ip': '203.0.113.10', 'x-csrf-token': account.csrfToken }, data: { mac: mainMac, address: '10.20.0.1' } }); assert.equal(identified.status(), 200);
    const before = f.calls.length;
    await page.goto(portal + '/hotspot?mac=' + encodeURIComponent(mainMac) + '&address=10.20.0.1&next=https%3A%2F%2Fevil.test'); await page.waitForURL(portal + '/dashboard');
    await page.locator('#currentWifi [data-current-state="connected"]').waitFor(); assert.equal(f.calls.length, before);
  });
  await scenario('secondary voucher entry cannot skip main-device approval or create an account session', async (page, context) => {
    await page.goto(portal + '/login?next=%2Fdashboard&mac=' + encodeURIComponent('AA:BB:CC:DD:EE:03') + '&address=10.20.0.30');
    await page.locator('#login [name="phone"]').fill('670050001'); await page.locator('#login [name="code"]').fill('NC-AAAA-1111'); await page.locator('#loginSubmit').click();
    await page.getByRole('heading', { name: 'Request access from your main device', exact: true }).waitFor();
    assert.equal((await context.cookies()).some(c => c.name === 'customer_session'), false); assert.equal(await page.locator('#customerPin').isHidden(), true);
    const before = f.calls.length; await page.getByRole('button', { name: 'Request access', exact: true }).click(); await page.waitForURL(/\/pair\?.*#key=/); assert.equal(f.calls.length, before);
  }, { approval: true });
  await scenario('a new app browser does not inherit captive authentication or its remembered connection', async (page, context) => {
    const signed = await context.request.post(api + '/api/account/login/pin', { headers: { origin: portal, 'cf-connecting-ip': '203.0.113.10' }, data: { phone: '670050001', pin: '2468' } }); assert.equal(signed.status(), 200);
    const separate = await browser.newContext();
    try {
      await separate.route('**/*', route => [portal, api].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
      const fresh = await separate.newPage(); await fresh.goto(portal + '/dashboard');
      await fresh.waitForURL(portal + '/onboarding.html');
      assert.equal((await separate.cookies()).some(c => c.name === 'customer_session'), false);
    } finally { await separate.close(); }
  });
  await scenario('an authenticated app restores Dashboard with blocked optional browser storage', async (page, context) => {
    assert.equal((await context.request.post(api + '/api/account/login/pin', { headers: { origin: portal, 'cf-connecting-ip': '203.0.113.10' }, data: { phone: '670050001', pin: '2468' } })).status(), 200);
    await context.addInitScript(() => { for (const store of ['localStorage', 'sessionStorage']) Object.defineProperty(window, store, { get() { throw new DOMException('denied', 'SecurityError'); } }); });
    await page.goto(portal + '/dashboard#vouchers'); await page.locator('[data-portal-tab="vouchers"][aria-current="page"]').waitFor();
    await page.reload(); await page.locator('[data-portal-tab="vouchers"][aria-current="page"]').waitFor();
  });
  console.log(`PASS ${checks} dashboard entry browser journeys`);
} finally { if (browser) await browser.close(); await f.close(); await new Promise(r => { website.close(r); website.closeAllConnections(); }); }

await import('./check-pwa-journeys.mjs');
