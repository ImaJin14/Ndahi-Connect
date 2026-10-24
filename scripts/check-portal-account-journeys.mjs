import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer, createStore } from '../server.mjs';
import { createStaticServer } from '../static-server.mjs';
import { MockEmailAdapter } from '../lib/email.mjs';
import { totpSecret, totpCode } from '../lib/security.mjs';
import { setDefaultResultOrder } from 'node:dns';

// Isolated services and synthetic accounts only; no live provider or router.
const apiPort = Number(process.env.PORTAL_TOOLS_API_PORT || 8798), portalPort = Number(process.env.PORTAL_TOOLS_PORT || 8797);
// WebAuthn requires a domain RP ID; localhost is trusted for local testing.
setDefaultResultOrder('ipv4first');
const api = `http://localhost:${apiPort}`, portal = `http://localhost:${portalPort}`;
const store = createStore({ persistent: false });
let now = new Date();
const email = new MockEmailAdapter(), verificationCodes = new Map();
email.sendVerification = async ({ to, code }) => { verificationCodes.set(to, code); return { messageId: 'fixture-email-code' }; };
const server = createServer({ store, email, now: () => now, env: {
  NODE_ENV: 'test', PAYMENT_MODE: 'mock', EMAIL_MODE: 'mock', MIKROTIK_MODE: 'mock', OMADA_MODE: 'mock',
  CUSTOMER_APP_URL: portal, SESSION_COOKIE_SECURE: 'false', BILLING_WORKER_ENABLED: 'false',
  NETWORK_QUEUE_ENABLED: 'false', SECURITY_ALERTS_ENABLED: 'false',
} });
const website = createStaticServer('customer', { apiUrl: api, supportEmail: 'support@example.test', supportPhone: '+237 670000001' });
const listen = (app, port) => new Promise((resolve, reject) => { app.once('error', reject); app.listen(port, '127.0.0.1', resolve); });
const close = (app) => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); });
const post = async (path, input, cookie = '') => {
  const response = await fetch(api + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(input) });
  const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return { response, body };
};
const makePurchaseEligible = () => store.transaction((s) => {
  const active = s.vouchers.find((v) => v.status === "active");
  if (active) active.usedBytes = active.quotaBytes;
});
let browser, checks = 0;
const screenshots = '/tmp/ndahi-portal-account-checks';
try {
  await listen(server, apiPort); await listen(website, portalPort); await mkdir(screenshots, { recursive: true });
  const purchased = await post('/api/purchase', { phone: '670050101', name: 'Portal Customer', email: 'portal@example.test', planId: 'weekly' });
  await store.transaction((s) => { s.customers[0].emailVerifiedAt = now.toISOString(); });
  const paid = await post(`/api/payments/${purchased.body.payment.id}/confirm`, {});
  const setup = await post('/api/account/setup/pin', { phone: '670050101', code: paid.body.access.code, pin: '2468', confirmPin: '2468' });
  const cookie = setup.response.headers.get('set-cookie').split(';')[0];
  await store.transaction((s) => { s.vouchers.push({ ...structuredClone(s.vouchers[0]), id: 'historical', code: 'NC-HIST-0001', status: 'expired',
    paymentId: undefined, activatedAt: new Date(+now - 20 * 864e5).toISOString(), expiresAt: new Date(+now - 13 * 864e5).toISOString() }); });
  const baseline = await store.snapshot();
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  async function scenario(name, work, width = 390) {
    now = new Date();
    await store.transaction((s) => Object.assign(s, structuredClone(baseline)));
    const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
    await context.route('**/*', (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort('blockedbyclient'));
    await context.addCookies([{ name: 'customer_session', value: cookie.split('=')[1], domain: 'localhost', path: '/api/account', httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(20000);
    page.on('pageerror', (error) => errors.push(error.message));
    try { await work(page, context); assert.deepEqual(errors, []); console.log(`PASS ${name}`); checks++; }
    catch (error) { console.error(JSON.stringify({pageErrors:errors})); await page.screenshot({ path: `${screenshots}/failure-${checks}.png`, fullPage: true }).catch(() => {}); throw error; }
    finally { await context.close(); }
  }
  for (const width of [320, 390, 768, 1280]) {
    await scenario(`portal navigation supports dedicated views, Back and refresh at ${width}px`, async (page) => {
      await page.goto(`${portal}/dashboard#home`);
      await page.locator('[data-portal-tab="home"][aria-current="page"]').waitFor();
      assert.equal(await page.locator('#portalNav a').count(), 5);
      assert.equal(await page.locator('#billing').isVisible(), false);
      const layout = await page.evaluate(() => {
        const nav = document.querySelector('#portalNav').getBoundingClientRect(), main = document.querySelector('main').getBoundingClientRect();
        return { nav: { x: nav.x, y: nav.y, width: nav.width, height: nav.height }, mainX: main.x,
          overflow: document.documentElement.scrollWidth > innerWidth, height: innerHeight };
      });
      assert.equal(layout.overflow, false);
      if (width < 1000) assert.ok(Math.abs(layout.nav.y + layout.nav.height - layout.height) < 2);
      else assert.ok(layout.nav.x + layout.nav.width <= layout.mainX);
      await page.locator('[data-portal-tab="vouchers"]').click();
      await page.locator('[data-portal-view="vouchers"]').first().waitFor({ state: 'visible' });
      await page.reload();
      await page.locator('[data-portal-tab="vouchers"][aria-current="page"]').waitFor();
      await page.goBack();
      await page.locator('[data-portal-tab="home"][aria-current="page"]').waitFor();
      await page.locator('[data-portal-tab="account"]').click();
      await page.getByRole('heading', { name: 'Your account number', exact: true }).waitFor();
      await page.screenshot({ path: `${screenshots}/account-${width}.png`, fullPage: true });
    }, width);
  }
  await scenario('personal welcome, name editing and safe fallback work without changing receipts', async (page) => {
    await page.goto(`${portal}/dashboard#home`);
    await page.getByRole('heading', { name: 'Welcome back, Portal', exact: true }).waitFor();
    const before = (await store.snapshot()).payments;
    await page.locator('[data-portal-tab="account"]').click();
    await page.getByText('Edit display name', { exact: true }).click();
    await page.locator('#changeName [name="name"]').fill('Marie Ndongo');
    await page.locator('#changeName [type="submit"]').click();
    await page.getByText('Your display name was updated.', { exact: true }).waitFor();
    await page.locator('[data-portal-tab="home"]').click();
    await page.getByRole('heading', { name: 'Welcome back, Marie', exact: true }).waitFor();
    assert.deepEqual((await store.snapshot()).payments, before);
    await store.transaction((s) => { s.customers[0].name = '<img src=x onerror=alert(1)>'; });
    await page.reload(); await page.getByRole('heading', { name: 'Welcome back, <img', exact: true }).waitFor();
    assert.equal(await page.locator('#portalTitle img').count(), 0);
  });
  await scenario('public FAQs work without login and open the requested answer with configured support', async (page, context) => {
    await context.clearCookies(); await page.goto(`${portal}/help#payment`);
    await page.getByRole('heading', { name: 'Frequently asked questions', exact: true }).waitFor();
    assert.equal(await page.locator('details').count(), 13);
    assert.equal(await page.locator('#payment').getAttribute('open'), '');
    await page.getByRole('link', { name: 'Email support: support@example.test', exact: true }).waitFor();
    assert.equal(await page.locator('a[href="tel:+237670000001"]').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${screenshots}/help-mobile.png`, fullPage: true });
  }, 320);
  await scenario('pending history shows server deadlines and closes automatically after its window', async (page) => {
    await makePurchaseEligible();
    const created = await post('/api/account/plan/purchase', { action: 'renew', planId: 'weekly', requestKey: 'clock' }, cookie);
    await store.transaction((s) => {
      const p = s.payments.find((p) => p.id === created.body.payment.id);
      p.paymentExpiresAt = new Date(+now + 1000).toISOString(); p.paymentClosesAt = new Date(+now + 2500).toISOString();
    });
    await page.goto(`${portal}/dashboard#payments`);
    const row = page.locator(`[data-payment-row="${created.body.payment.id}"]`);
    await row.locator('[data-payment-clock]').waitFor();
    now = new Date(+now + 5000);
    await page.waitForFunction((id) => document.querySelector(`[data-payment-row="${id}"]`).textContent.includes('expired'), created.body.payment.id);
    assert.equal((await store.snapshot()).payments.find((p) => p.id === created.body.payment.id).status, 'expired');
    assert.equal(await row.getByRole('button', { name: 'Check payment status', exact: true }).count(), 0);
    await row.getByRole('button', { name: 'Copy reference', exact: true }).waitFor();
  });
  await scenario('customers copy and download current and historical voucher codes', async (page, context) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`${portal}/dashboard#vouchers`);
    const cards = page.locator('[data-portal-view="vouchers"] .voucher-card'); await cards.first().waitFor();
    assert.equal(await cards.count(), 1);
    await page.getByLabel('Voucher status', { exact: true }).selectOption('expired');
    assert.equal(await cards.count(), 1);
    assert.equal(await cards.last().locator('[data-voucher-code]').inputValue(), 'NC-HIST-0001');
    await cards.last().getByRole('button', { name: 'Copy code', exact: true }).click();
    await cards.last().getByText('Voucher code copied.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'NC-HIST-0001');
    const downloaded = page.waitForEvent('download');
    await cards.last().getByRole('button', { name: 'Download PDF', exact: true }).click();
    const file = await downloaded;
    assert.match(file.suggestedFilename(), /^ndahi-voucher-historical\.pdf$/);
    assert.equal((await readFile(await file.path())).subarray(0, 5).toString(), '%PDF-');
    assert.ok(!page.url().includes('NC-HIST'));
    await page.screenshot({ path: `${screenshots}/vouchers-mobile.png`, fullPage: true });
  });
  await scenario('voucher history pages, empty Active view and expiry preserve records at 320px', async (page) => {
    await store.transaction((s) => {
      s.vouchers[0].expiresAt = new Date(+now + 30000).toISOString();
      for (let n = 0; n < 14; n++) s.vouchers.push({ ...structuredClone(s.vouchers[0]), id: 'history-page-' + n, code: 'NC-PAGE-' + String(n).padStart(4, '0'), status: n % 2 ? 'expired' : 'exhausted', activatedAt: '2026-09-01T12:00:00Z', expiresAt: '2026-09-02T12:00:00Z' });
    });
    await page.clock.install({ time: now });
    await page.goto(`${portal}/dashboard#vouchers`);
    await page.locator('#voucherHistory .voucher-card').first().waitFor();
    assert.equal(await page.locator('#voucherHistory .voucher-card').count(), 1);
    await page.getByRole('button', { name: 'View voucher history', exact: true }).click();
    assert.equal(await page.locator('#voucherHistory .voucher-card').count(), 6);
    await page.getByRole('button', { name: 'Next vouchers', exact: true }).click();
    assert.match(await page.locator('[data-voucher-page]').textContent(), /Page 2/);
    await page.getByLabel('Voucher status', { exact: true }).selectOption('exhausted');
    assert.equal(await page.locator('#voucherHistory .voucher-card').count(), 6);
    await page.getByRole('button', { name: 'Next vouchers', exact: true }).click();
    assert.equal(await page.locator('#voucherHistory .voucher-card').count(), 1);
    await page.getByLabel('Voucher status', { exact: true }).selectOption('active');
    // Exercise the page lifecycle used by a browser-history cache restore.
    // Expiry must keep updating afterwards without another navigation.
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    now = new Date(+now + 31000);
    await page.clock.fastForward(31000);
    await page.getByText('No current active voucher. View your voucher history or choose a package.', { exact: true }).waitFor();
    assert.equal(await page.locator('#voucherHistory .voucher-card').count(), 0);
    await page.getByLabel('Voucher status', { exact: true }).selectOption('expired');
    assert.ok(await page.locator('#voucherHistory .voucher-card').count() > 0);
    assert.equal((await store.snapshot()).vouchers.length, 16);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }, 320);

  await scenario('alternate renewal payers stay with their transaction and new checkouts reset to the account number', async (page) => {
    await makePurchaseEligible();
    await page.goto(`${portal}/onboarding.html?action=renew`);
    await page.locator('[data-plan="weekly"]').click();
    const payer = page.locator('[name="payerPhone"]');
    assert.equal(await payer.inputValue(), '670050101');
    const modal = await page.locator('#checkout .card').boundingBox();
    assert.ok(modal.y >= 0 && modal.y + modal.height <= 900, 'the payment form stays within the viewport and scrolls internally');
    await payer.fill('670050199'); await page.locator('[name="network"]').selectOption('orange');
    await page.locator('[name="acknowledge"]').check(); await page.locator('#requestPayment').click();
    await page.locator('#confirm').waitFor();
    const transaction = (await store.snapshot()).payments.find((p) => p.id !== purchased.body.payment.id);
    assert.equal(transaction.payerPhone, '670050199');
    assert.equal(transaction.network, 'orange');
    assert.equal((await store.snapshot()).customers[0].phone, '670050101');
    await page.locator('#closeCheckout').click(); await page.locator('#viewPayment').click();
    assert.equal(await payer.inputValue(), '670050199');
    await page.reload(); await page.locator('#checkExisting').waitFor();
    assert.match(await page.locator('#planNotice').innerText(), /670050199/);
    await post(`/api/payments/${transaction.id}/confirm`, {});
    await makePurchaseEligible();
    await page.goto(`${portal}/onboarding.html?action=renew`); await page.locator('[data-plan="weekly"]').click();
    assert.equal(await page.locator('[name="payerPhone"]').inputValue(), '670050101');
    assert.equal((await store.snapshot()).payments.find((p) => p.id === transaction.id).receipt.payerPhone, '670050199');
    await page.screenshot({ path: `${screenshots}/renewal-payment-mobile.png`, fullPage: true });
  });
  await scenario('account-number changes verify the PIN, retain history and sign out other portal sessions', async (page) => {
    const other = await post('/api/account/login/pin', { phone: '670050101', pin: '2468' });
    const otherCookie = other.response.headers.get('set-cookie').split(';')[0];
    await page.goto(`${portal}/dashboard#account`);
    await page.getByText('Change account number', { exact: true }).click();
    const form = page.locator('#changePhone');
    await form.locator('[name="phone"]').fill('670050103'); await form.locator('[name="pin"]').fill('0000');
    await form.locator('[name="confirmChange"]').check(); await form.locator('[type="submit"]').click();
    await page.locator('#phoneChangeMessage .error-card').waitFor();
    assert.equal(new URL(page.url()).hash, '#account');
    now = new Date(+now + 2000);
    await form.locator('[name="pin"]').fill('2468'); await form.locator('[type="submit"]').click();
    await page.getByText('Account number updated. Your other portal sessions were signed out.', { exact: true }).waitFor();
    const s = await store.snapshot();
    assert.equal(s.customers[0].phone, '670050103');
    assert.equal(s.customers[0].id, baseline.customers[0].id);
    assert.deepEqual(s.vouchers, baseline.vouchers);
    assert.equal(s.payments[0].payerPhone, '670050101');
    assert.equal((await fetch(api + '/api/account/dashboard', { headers: { cookie: otherCookie } })).status, 401);
    await makePurchaseEligible();
    await page.goto(`${portal}/onboarding.html?action=renew`); await page.locator('[data-plan="weekly"]').click();
    assert.equal(await page.locator('[name="payerPhone"]').inputValue(), '670050103');
  });
  await scenario('an alternate-payer renewal survives a lost response without creating another charge', async (page) => {
    let submissions = 0;
    await page.route('**/api/account/plan/purchase', async (route) => {
      submissions++; await route.fetch(); await route.abort('failed');
    });
    await makePurchaseEligible();
    await page.goto(`${portal}/onboarding.html?action=renew`); await page.locator('[data-plan="weekly"]').click();
    await page.locator('[name="payerPhone"]').fill('670050199');
    await page.locator('[name="acknowledge"]').check(); await page.locator('#requestPayment').click();
    await page.getByRole('button', { name: 'Check payment again', exact: true }).waitFor();
    assert.equal(submissions, 1);
    assert.equal((await store.snapshot()).payments.length, baseline.payments.length + 1);
    assert.equal(await page.locator('[name="payerPhone"]').inputValue(), '670050199');
    assert.equal(await page.locator('[name="payerPhone"]').isDisabled(), true);
    await page.reload(); await page.locator('#checkExisting').waitFor();
    assert.match(await page.locator('#planNotice').innerText(), /670050199/);
  });
  await scenario('a real passkey authorizes an account-number change despite stale authenticator data', async (page, context) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(`${portal}/dashboard#account`);
    await page.locator("#securityManager>summary").click(); await page.locator('[data-security-panel="passkeys"]').click(); await page.locator('#addCustomerPasskey').click();
    await page.locator('[data-passkey-owner-proof] [name="pin"]').fill('2468');
    await page.locator('[data-passkey-owner-proof]').getByRole('button', { name: 'Confirm with PIN', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#accountSecurity').textContent.includes('Rename'));
    const key = totpSecret();
    await store.transaction((s) => { s.customers[0].totpSecret = key; });
    await page.reload(); await page.getByText('Change account number', { exact: true }).click();
    await page.locator('#changePhone [name="phone"]').fill('670050104');
    assert.equal(await page.locator('#changePhone [name="otp"]').count(), 0);
    await page.locator('#changePhone [name="confirmChange"]').check();
    await page.locator('#changePhonePasskey').click();
    await page.getByText('Account number updated. Your other portal sessions were signed out.', { exact: true }).waitFor();
    assert.equal((await store.snapshot()).customers[0].phone, '670050104');
    assert.equal((await store.snapshot()).customers[0].passkeys.length, 1);
  });
  await scenario('a real passkey sign-in creates one scoped security-history entry and opens active sessions', async (page, context) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(`${portal}/dashboard#account`);
    await page.locator("#securityManager>summary").click(); await page.locator('[data-security-panel="passkeys"]').click(); await page.locator('#addCustomerPasskey').click();
    await page.locator('[data-passkey-owner-proof] [name="pin"]').fill('2468');
    await page.locator('[data-passkey-owner-proof]').getByRole('button', { name: 'Confirm with PIN', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#accountSecurity').textContent.includes('Rename'));
    // Stop authenticated polling before clearing cookies; its 401 redirect can
    // otherwise race the explicit login navigation on slower CI runners.
    await page.goto('about:blank');
    await context.clearCookies();
    await page.goto(`${portal}/login?account=1`);
    await page.locator('#login [name="phone"]').fill('670050101');
    await page.locator('#customerPasskeyLogin').click();
    await page.waitForURL(/\/dashboard#account$/);
    await page.locator('#sessionActivity summary').click();
    await page.getByRole('button', { name: 'View security history', exact: true }).click();
    const centre = page.getByRole('dialog', { name: 'Notifications', exact: true });
    await centre.getByRole('heading', { name: /Passkey sign-in/ }).waitFor();
    assert.equal((await store.snapshot()).securityEvents.filter((e) => e.type === 'customer.passkey_login.succeeded').length, 1);
    await centre.locator('[data-notification-id]').filter({ has: page.getByRole('heading', { name: /Passkey sign-in/ }) }).getByRole('link', { name: 'Review sessions', exact: true }).click();
    await page.waitForURL(/#sessions$/);
    assert.equal(await page.locator('#sessionActivity').evaluate((el) => el.open), true);
  }, 320);
  await scenario('signup without email reaches the portal and the owner can link a confirmed email later', async (page, context) => {
    await context.clearCookies();
    await page.goto(`${portal}/onboarding.html`); await page.locator('[data-plan="weekly"]').click();
    await page.locator('[name="name"]').fill('No Email Customer');
    await page.locator('[name="phone"]').fill('670050188');
    assert.equal(await page.locator('[name="email"]').getAttribute('required'), null);
    await page.locator('#requestPayment').click(); await page.locator('#confirm').click();
    await page.waitForURL('**/verify.html?setup=checkout');
    await page.locator('#primary').fill('2468'); await page.locator('#confirm').fill('2468');
    await page.locator('#submitLabel').click(); await page.waitForURL(/\/voucher-ready\.html/);
    await page.getByRole('button', { name: 'Download Voucher', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Continue to Dashboard / Wi-Fi', exact: true }).click(); await page.waitForURL('**/dashboard');
    await page.locator('[data-portal-tab="account"]').click(); await page.getByText('Link email', {exact:true}).click(); await page.locator('#linkEmail').waitFor();
    const before = (await store.snapshot()).customers.find((c) => c.phone === '670050188');
    assert.equal(before.email, ''); assert.equal(before.emailVerificationRequired, true);
    await page.locator('#linkEmail [name="email"]').fill('linked@example.test');
    await page.locator('#linkEmail [name="pin"]').fill('2468');
    await page.locator('#linkEmail [type="submit"]').click(); await page.locator('#confirmEmail').waitFor();
    await page.reload(); await page.locator('#confirmEmail').waitFor();
    await page.screenshot({ path: `${screenshots}/email-confirm-mobile.png`, fullPage: true });
    await server.listeners("request")[0].transactionalEmails.run();
    await page.locator('#confirmEmail [name="code"]').fill(verificationCodes.get('linked@example.test'));
    await page.locator('#confirmEmail [type="submit"]').click();
    await page.getByText('Email linked. Email updates are enabled. Your other portal sessions were signed out.', { exact: true }).waitFor();
    const after = (await store.snapshot()).customers.find((c) => c.id === before.id);
    assert.equal(after.email, 'linked@example.test'); assert.ok(after.emailVerifiedAt);
    assert.equal(after.pendingEmail, undefined);
    await page.locator('[data-portal-tab="payments"]').click();
    await page.getByRole('button', { name: 'Email receipt', exact: true }).click();
    await page.getByText('Receipt sent to your account email.', { exact: true }).waitFor();
  }, 320);
  await scenario('a passkey can link an email and a lost confirmation response recovers the completed change', async (page, context) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(`${portal}/dashboard#account`); await page.locator("#securityManager>summary").click(); await page.locator('[data-security-panel="passkeys"]').click(); await page.locator('#addCustomerPasskey').click();
    await page.locator('[data-passkey-owner-proof] [name="pin"]').fill('2468');
    await page.locator('[data-passkey-owner-proof]').getByRole('button', { name: 'Confirm with PIN', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#accountSecurity').textContent.includes('Rename'));
    await page.locator('#emailAccount summary').click();
    await page.locator('#linkEmail [name="email"]').fill('passkey@example.test');
    await page.locator('#linkEmailPasskey').click(); await page.locator('#confirmEmail').waitFor();
    let submissions = 0;
    await page.route('**/api/account/profile/email/confirm', async (route) => {
      submissions++; await route.fetch(); await route.abort('failed');
    });
    await server.listeners("request")[0].transactionalEmails.run();
    await page.locator('#confirmEmail [name="code"]').fill(verificationCodes.get('passkey@example.test'));
    await page.locator('#confirmEmail [type="submit"]').click();
    await page.getByText('Email linked. Email updates are enabled. Your other portal sessions were signed out.', { exact: true }).waitFor();
    assert.equal(submissions, 1);
    assert.equal((await store.snapshot()).customers[0].email, 'passkey@example.test');
  });
  await scenario('Flutterwave checkout collects a transaction email without linking it to the account', async (page) => {
    await store.transaction((s) => { s.customers[0].email = ''; s.customers[0].emailVerificationRequired = true; delete s.customers[0].emailVerifiedAt; });
    await page.route('**/api/plans', async (route) => {
      const response = await route.fetch(), body = await response.json(); body.paymentProvider = 'flutterwave';
      await route.fulfill({ response, json: body });
    });
    await makePurchaseEligible();
    await page.goto(`${portal}/onboarding.html?action=renew`); await page.locator('[data-plan="weekly"]').click();
    const emailInput = page.locator('[name="email"]');
    assert.equal(await emailInput.isVisible(), true);
    assert.equal(await emailInput.getAttribute('required'), '');
    await emailInput.fill('payment-contact@example.test');
    await page.locator('[name="acknowledge"]').check(); await page.locator('#requestPayment').click();
    await page.locator('#confirm').waitFor();
    const s = await store.snapshot(), payment = s.payments.find((p) => p.id !== purchased.body.payment.id);
    assert.equal(payment.email, 'payment-contact@example.test');
    assert.equal(s.customers[0].email, ''); assert.equal(s.customers[0].pendingEmail, undefined);
  });
  await scenario('pending payments have a visible navigation badge', async (page) => {
    await makePurchaseEligible();
    await post('/api/account/plan/purchase', { action: 'renew', planId: 'weekly', payerPhone: '670050199', requestKey: 'badge' }, cookie);
    await page.goto(`${portal}/dashboard`);
    await page.locator('[data-portal-tab="payments"] .nav-badge').waitFor();
    assert.equal(await page.locator('[data-portal-tab="payments"] .nav-badge').innerText(), '1');
    await page.locator('[data-portal-tab="payments"]').click();
    await page.getByText('Payment number: 670050199', { exact: true }).waitFor();
  });
  for (const protection of ['payment', 'unsaved', 'offline']) {
    await scenario(`app updates wait safely for ${protection} recovery and apply when ready`, async (page) => {
      let newer = false, offline = protection === 'offline';
      const current = await (await fetch(portal + '/version.json')).json();
      await page.route('**/version.json', (route) => offline ? route.abort('internetdisconnected')
        : route.fulfill({ contentType: 'application/json', body: JSON.stringify({ revision: newer ? 'fixture-next-release' : current.revision }) }));
      await page.goto(`${portal}/billing-terms.html`);
      await page.evaluate(async (protection) => {
        window.releaseReloads = 0; window.releaseBusy = protection === 'payment';
        if (protection === 'unsaved') {
          const form = document.createElement('form'); form.id = 'draft';
          form.innerHTML = '<input name="phone" aria-label="Draft number">'; document.body.appendChild(form);
        }
        const { startUpdates } = await import('/updates.js');
        startUpdates({ intervalMs: 80, isBusy: () => window.releaseBusy, reload: () => { window.releaseReloads++; } });
      }, protection);
      if (protection === 'unsaved') await page.locator('#draft input').fill('670050199');
      newer = true;
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.releaseReloads), 0);
      if (protection === 'payment') {
        await page.locator('.update-notice').waitFor({ state: 'visible' });
        assert.equal(await page.locator('.update-notice button').isDisabled(), true);
        await page.evaluate(() => { window.releaseBusy = false; });
      } else if (protection === 'unsaved') await page.evaluate(() => document.querySelector('#draft').remove());
      else { offline = false; await page.evaluate(() => window.dispatchEvent(new Event('online'))); }
      await page.waitForFunction(() => window.releaseReloads === 1);
    });
  }
  console.log(`${checks} portal account browser journeys passed. Screenshots: ${screenshots}`);
} finally {
  await browser?.close(); await close(website); await close(server);
}
