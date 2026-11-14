import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import { createServer, createStore } from '../../server.mjs';
import { createStaticServer } from '../../static-server.mjs';
import { hashSecret } from '../../lib/security.mjs';
import { lowContrastText } from '../../scripts/ui-checks.mjs';
const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
const close = s => new Promise(resolve => { s.close(resolve); s.closeAllConnections(); });

test('give a voucher: explicit replacement, Sold/Gift accounting, role isolation, changed bundles and lost replies', async t => {
  let browser, website, server;
  t.after(async () => { await browser?.close(); if (website) await close(website); if (server) await close(server); });
  const reservation = http.createServer(); await listen(reservation); const port = reservation.address().port; await close(reservation);
  const api = `http://127.0.0.1:${port}`, store = createStore({ persistent: false }), secret = 'customer-voucher-test-only';
  const now = new Date('2030-01-01T08:00:00.000Z');
  await store.transaction(s => {
    s.customers.push({ id: 'c1', name: 'Amina N.', phone: '670001245', status: 'active' }, { id: 'c2', name: 'Grace T.', phone: '670000366', status: 'active' }, { id: 'c3', name: 'Suspended customer', phone: '670009999', status: 'suspended', suspended: true });
    s.bundles.push({ id: 'resale-only', name: 'Resale only', resale: true, price: 1000, quotaGb: 5, validityHours: 168, deviceLimit: 1 }, { id: 'retired-plan', name: 'Retired plan', discontinued: true, price: 1000, quotaGb: 5, validityHours: 168, deviceLimit: 1 });
    s.vouchers.push({ id: 'v1', code: 'NC-OLD-0001', customerId: 'c1', planId: 'weekly', status: 'active', quotaBytes: 5e9, usedBytes: 1.8e9, deviceLimit: 3, activatedAt: now.toISOString(), expiresAt: new Date(+now + 2 * 864e5).toISOString() });
    for (const role of ['owner', 'operator', 'auditor', 'reseller']) {
      s.adminUsers.push({ id: role, username: `fixture-${role}`, displayName: role, role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: role, role, tokenHash: hashSecret(role, secret), csrfToken: `csrf-${role}`, expiresAt: '2099-01-01T00:00:00.000Z' });
    }
  });
  const baseline = await store.snapshot();
  website = createStaticServer('admin', { apiUrl: api, env: { NODE_ENV: 'test', ADMIN_UI_DEFAULT: 'v2' } }); await listen(website);
  const admin = `http://127.0.0.1:${website.address().port}`;
  server = createServer({ store, now: () => now, validateConfig: false, env: { NODE_ENV: 'test', ADMIN_SESSION_SECRET: secret, SESSION_COOKIE_SECURE: 'false', ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: 'mock', EMAIL_MODE: 'mock', MIKROTIK_MODE: 'mock', OMADA_MODE: 'mock', BILLING_WORKER_ENABLED: 'false', NETWORK_QUEUE_ENABLED: 'false', SECURITY_ALERTS_ENABLED: 'false' } });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'); browser = await chromium.launch({ headless: true });
  const captureDir = process.env.ISSUE253_CAPTURE_DIR;
  if (captureDir) await mkdir(captureDir, { recursive: true });
  async function capture(page, name) { if (captureDir) { await page.evaluate(() => document.fonts.ready); await page.locator("#adminTitle").click(); await page.screenshot({ path: `${captureDir}/${name}.png`, fullPage: true }); } }
  async function scenario(name, work, { role = 'owner', width = 1280, french = false } = {}) {
    await store.transaction(s => Object.assign(s, structuredClone(baseline)));
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route('**/*', route => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort('blockedbyclient'));
    // Component-language check only: production admin's language policy is unchanged.
    if (french) await context.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.lang = 'fr'; }));
    await context.addCookies([{ name: 'admin_session', value: role, url: api, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage(), errors = [], posts = []; page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text()); });
    page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/api/admin/vouchers/generate')) posts.push(req.postDataJSON()); });
    try { await work({ page, context, posts }); assert.deepEqual(errors, []); console.info(`PASS ${name}`); }
    catch (e) { await capture(page, `failure-${name.replace(/\W/g, '-')}`); throw e; }
    finally { await context.close(); }
  }
  const open = async page => { await page.goto(`${admin}/dashboard#vouchers`); await page.locator('[data-give-pick]').first().waitFor(); };
  const pick = async (page, name) => { await page.locator('[data-give-pick]').filter({ hasText: name }).click(); await page.locator('#customerVoucherForm [name="planId"]').selectOption('weekly'); };
  const submit = page => page.locator('[data-give-submit]');
  const confirm = page => page.locator('#customerVoucherForm [name="replaceActive"]');

  for (const width of [390, 1280]) await scenario(`gift starts once and reuses thermal print at ${width}px`, async ({ page, posts }) => {
    await open(page); assert.equal(await page.locator('[data-give-pick]').filter({ hasText: 'Suspended customer' }).count(), 0);
    await capture(page, `initial-${width}`); await pick(page, 'Grace');
    assert.equal(await page.locator('#customerVoucherForm option[value="resale-only"], #customerVoucherForm option[value="retired-plan"]').count(), 0);
    await capture(page, `inactive-sold-${width}`); await page.getByRole('radio', { name: /Gift/ }).check();
    await capture(page, `inactive-gift-${width}`);
    assert.deepEqual(await lowContrastText(page), [], 'new panel rendered contrast');
    await page.locator('#customerVoucherForm').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await page.locator('.customer-voucher__code').waitFor(); assert.equal(posts.length, 1);
    const s = await store.snapshot(), v = s.vouchers.find(v => v.customerId === 'c2');
    assert.equal(v.status, 'active'); assert.equal(v.saleType, 'gift'); assert.equal(v.saleAmount, 0);
    assert.equal(v.customerId, 'c2'); assert.equal(posts[0].replaceActive, false);
    const recent = page.locator(`[data-voucher-record="${v.id}"]`);
    await recent.getByRole('link', { name: 'Grace T.', exact: true }).waitFor();
    assert.match(await recent.innerText(), /Gift/);
    await page.getByText('Active now on Grace T.’s account. It shows in their Internet tab.', { exact: true }).waitFor();
    await capture(page, `gift-success-${width}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('link', { name: 'Print slip', exact: true }).click();
    await page.locator('.thermal-slip').waitFor(); assert.equal(await page.locator('#voucherPrintLayout').inputValue(), 'thermal-58');
    assert.equal(await page.getByText('A4', { exact: true }).count(), 0);
    await page.evaluate(() => { location.hash = 'voucher-create'; });
    await page.locator('#generate').waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('tab', { name: 'Batch to print or sell', exact: true }).getAttribute('aria-selected'), 'true', 'legacy links still select batch on the current document');
    assert.equal(posts.length, 1);
  }, { width });

  for (const width of [390, 1280]) await scenario(`customer detail requires fresh consent and sold replaces once at ${width}px`, async ({ page, posts }) => {
    await page.goto(`${admin}/dashboard#customer/c1`); await page.getByRole('button', { name: 'Give a voucher (sold or gift)', exact: true }).waitFor();
    await capture(page, `customer-detail-${width}`); await page.getByRole('button', { name: 'Give a voucher (sold or gift)', exact: true }).click();
    await confirm(page).waitFor(); assert.equal(await confirm(page).isChecked(), false); assert.equal(await submit(page).isDisabled(), true);
    await page.locator('#customerVoucherForm').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(posts.length, 0); await capture(page, `active-unconfirmed-${width}`);
    await confirm(page).check(); await page.locator('#customerVoucherForm [name="planId"]').selectOption('weekly'); assert.equal(await confirm(page).isChecked(), false);
    await confirm(page).check(); await page.getByRole('radio', { name: /Gift/ }).check(); assert.equal(await confirm(page).isChecked(), false);
    await capture(page, `active-gift-unconfirmed-${width}`); await confirm(page).check(); await capture(page, `active-gift-confirmed-${width}`);
    await page.getByRole('radio', { name: /Sold/ }).check();
    await confirm(page).focus(); await page.keyboard.press('Space'); assert.equal(await confirm(page).isChecked(), true);
    assert.deepEqual(await lowContrastText(page), [], 'active replacement panel contrast');
    await capture(page, `active-confirmed-${width}`); await submit(page).click(); await page.locator('.customer-voucher__code').waitFor();
    assert.equal(posts.length, 1); assert.equal(posts[0].replaceActive, true);
    const s = await store.snapshot(), v = s.vouchers.find(v => v.customerId === 'c1' && v.id !== 'v1');
    assert.equal(s.vouchers.find(v => v.id === 'v1').status, 'replaced'); assert.equal(v.saleType, 'sold'); assert.equal(v.saleAmount, 1000);
    assert.ok(s.auditLogs.some(a => a.action === 'voucher.admin_replaced')); assert.ok(s.routerCommands.some(c => c.action === 'disconnect_voucher' && c.targetId === 'v1'));
    await page.getByText('The old bundle has ended. Its device disconnection request is queued; check Devices for confirmation.', { exact: true }).waitFor();
    await capture(page, `sold-replacement-success-${width}`);
    await page.getByRole('button', { name: 'Give another', exact: true }).click(); await page.locator('[data-give-pick]').first().waitFor();
    const batchTab = page.getByRole('tab', { name: 'For one customer', exact: true }); await batchTab.focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Batch to print or sell', exact: true }).getAttribute('aria-selected'), 'true');
    await page.locator('#generate [name="planId"]').selectOption('weekly');
    await page.locator('#generate [name="quantity"]').fill('20'); await capture(page, `batch-${width}`);
    await page.locator('#generate [type="submit"]').click(); await page.getByText('20 vouchers generated', { exact: true }).waitFor(); await capture(page, `batch-success-${width}`);
    assert.equal(posts.at(-1).purpose, 'resale'); assert.equal((await store.snapshot()).vouchers.filter(v => v.status === 'available').length, 20);
  }, { width });

  await scenario('new active bundle between lookup and submit requires confirmation before any POST', async ({ page, posts }) => {
    await open(page); await pick(page, 'Grace');
    await store.transaction(s => s.vouchers.push({ ...s.vouchers[0], id: 'new-active', customerId: 'c2', code: 'NC-NEW-0001' }));
    await submit(page).click(); await confirm(page).waitFor(); assert.equal(posts.length, 0); assert.equal(await confirm(page).isChecked(), false);
    await page.getByText('Their active bundle changed. Review it and confirm again before giving this voucher.', { exact: true }).waitFor();
  });
  await scenario('409 race restores current active bundle and clears consent without auto retry', async ({ page, context, posts }) => {
    await open(page); await pick(page, 'Grace');
    await context.route('**/api/admin/vouchers/generate', async route => { await store.transaction(s => s.vouchers.push({ ...s.vouchers[0], id: 'raced', customerId: 'c2', code: 'NC-RACED-1' })); await route.fulfill({ status: 409, json: { error: 'Bundle changed', code: 'ACTIVE_BUNDLE_EXISTS', activeBundle: { id: 'raced', name: 'Weekly' } } }); }, { times: 1 });
    await submit(page).click(); await confirm(page).waitFor(); assert.equal(posts.length, 1); assert.equal(await confirm(page).isChecked(), false); assert.equal(await submit(page).isDisabled(), true);
    await confirm(page).check(); await submit(page).click(); await page.locator('.customer-voucher__code').waitFor(); assert.equal(posts.length, 2); assert.equal(posts[1].replaceActive, true);
  });
  await scenario('lost committed response shows unknown outcome and never blindly retries', async ({ page, context, posts }) => {
    await open(page); await pick(page, 'Grace');
    await context.route('**/api/admin/vouchers/generate', async route => { const response = await route.fetch(); assert.equal(response.status(), 201); await route.abort('failed'); });
    await submit(page).click(); await page.getByText(/The result could not be confirmed/).waitFor();
    assert.equal((await store.snapshot()).vouchers.filter(v => v.customerId === 'c2').length, 1);
    await page.locator('#customerVoucherForm').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(posts.length, 1); assert.equal(await submit(page).isDisabled(), true); await page.getByText(/A newer active bundle is now recorded/).waitFor();
    await page.getByRole('button', { name: 'Review Recent vouchers', exact: true }).waitFor(); await capture(page, 'unknown-outcome-1280');
  });
  await scenario('consent for bundle A is cleared when the final read finds B', async ({ page, posts }) => {
    await open(page); await pick(page, 'Amina'); await confirm(page).check();
    await store.transaction(s => { s.vouchers[0].status = 'replaced'; s.vouchers.push({ ...s.vouchers[0], id: 'bundle-b', status: 'active', code: 'NC-B-1' }); });
    await submit(page).click(); await page.getByText('Their active bundle changed. Review it and confirm again before giving this voucher.', { exact: true }).waitFor();
    assert.equal(posts.length, 0); assert.equal(await confirm(page).isChecked(), false); assert.equal(await submit(page).isDisabled(), true);
  });
  await scenario('replacement race after the final read is detected from the receipt', async ({ page, context, posts }) => {
    await open(page); await pick(page, 'Amina'); await confirm(page).check();
    await context.route('**/api/admin/vouchers/generate', async route => {
      await store.transaction(s => { s.vouchers[0].status = 'replaced'; s.vouchers.push({ ...s.vouchers[0], id: 'unexpected-b', status: 'active', code: 'NC-B-2' }); });
      const response = await route.fetch(); await route.fulfill({ response });
    }, { times: 1 });
    await submit(page).click(); await page.locator('.customer-voucher__anomaly').filter({ hasText: 'unexpected-b' }).waitFor();
    assert.equal(posts.length, 1); assert.equal(await page.getByRole('button', { name: 'Give another', exact: true }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Print slip', exact: true }).count(), 0); await capture(page, 'unexpected-replacement-1280');
    await page.evaluate(() => { location.hash = 'voucher-print'; }); await page.waitForFunction(() => location.hash === '#vouchers'); assert.equal(await page.locator('.thermal-slip').count(), 0);
  });
  for (const [field, value] of [['customerId', 'c1'], ['status', 'available'], ['saleType', 'gift'], ['planId', 'daily']]) await scenario(`unexpected returned ${field} never claims success`, async ({ page, context }) => {
    await open(page); await pick(page, 'Grace');
    await context.route('**/api/admin/vouchers/generate', async route => { const response = await route.fetch(), body = await response.json(); body.voucher[field] = value; await route.fulfill({ response, json: body }); }, { times: 1 });
    await submit(page).click(); await page.getByText('The returned account, status, plan or payment type differs from this request. Review Recent vouchers before giving another voucher.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Print slip', exact: true }).count(), 0); assert.equal(await page.getByText('Active now on Grace T.’s account. It shows in their Internet tab.', { exact: true }).count(), 0);
  });
  await scenario('503 preflight preserves the form and sends no mutation', async ({ page, context, posts }) => {
    await open(page); await pick(page, 'Grace');
    await context.route('**/api/admin/records?**', route => new URL(route.request().url()).searchParams.get('q') === 'c2' ? route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }) : route.continue());
    await submit(page).click(); await page.getByText('Unable to verify the current customer and bundle. Search again before giving a voucher.', { exact: true }).waitFor();
    assert.equal(posts.length, 0); assert.equal(await submit(page).isEnabled(), true); assert.equal(new URL(page.url()).pathname, '/dashboard');
  });
  await scenario('4xx mutation rejection restores the form without retrying', async ({ page, context, posts }) => {
    await open(page); await pick(page, 'Grace');
    await context.route('**/api/admin/vouchers/generate', route => route.fulfill({ status: 400, json: { error: 'Invalid bundle' } }));
    await submit(page).click(); await page.getByText('The voucher request was rejected. Check the customer and bundle, then try again.', { exact: true }).waitFor();
    assert.equal(posts.length, 1); assert.equal(await submit(page).isEnabled(), true);
  });
  await scenario('a customer suspended after detail load cannot be preselected', async ({ page, posts }) => {
    await page.goto(`${admin}/dashboard#customer/c2`); const give = page.getByRole('button', { name: 'Give a voucher (sold or gift)', exact: true }); await give.waitFor();
    await store.transaction(s => { const c = s.customers.find(c => c.id === 'c2'); c.status = 'suspended'; c.suspended = true; });
    await give.click(); await page.getByText('Customer unavailable. Search again.', { exact: true }).waitFor(); assert.equal(posts.length, 0); assert.equal(await submit(page).count(), 0);
  });
  for (const failingCollection of ['vouchers', 'customers']) await scenario(`503 refreshing ${failingCollection} after success never hides the receipt`, async ({ page, context }) => {
    await open(page); await pick(page, 'Grace'); let created = false;
    await context.route('**/api/admin/vouchers/generate', async route => { const response = await route.fetch(); created = true; await route.fulfill({ response }); });
    let failedReads = 0;
    await context.route('**/api/admin/records?**', route => {
      if (created && new URL(route.request().url()).searchParams.get('collection') === failingCollection) { failedReads++; return route.fulfill({ status: 503, json: { error: 'Temporary read outage' } }); }
      return route.continue();
    });
    const readFailure = page.waitForResponse(response => response.status() === 503 && response.url().includes('/api/admin/records?') && new URL(response.url()).searchParams.get('collection') === failingCollection);
    await submit(page).click(); await page.locator('.customer-voucher__code').waitFor(); await readFailure;
    assert.ok(failedReads > 0); assert.equal(new URL(page.url()).pathname, '/dashboard');
    await page.getByText('Active now on Grace T.’s account. It shows in their Internet tab.', { exact: true }).waitFor();
    await page.getByRole('link', { name: 'Print slip', exact: true }).click(); await page.locator('.thermal-slip').waitFor();
  });
  await scenario('stale search responses cannot select a different customer', async ({ page, context, posts }) => {
    await open(page);
    let release; const gate = new Promise(resolve => { release = resolve; });
    await context.route('**/api/admin/records?**', async route => { const url = new URL(route.request().url()); if (url.searchParams.get('q') === 'Amina') { await gate; } await route.continue(); });
    const input = page.getByRole('searchbox', { name: 'Customer name or phone number', exact: true });
    await input.fill('Amina'); await page.waitForTimeout(350); await input.fill('Grace');
    await page.locator('[data-give-pick]').filter({ hasText: 'Grace' }).waitFor(); release(); await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-give-pick]').filter({ hasText: 'Amina' }).count(), 0); assert.equal(posts.length, 0);
    await input.fill('999000777'); await page.getByText(/No matching account/).waitFor(); assert.equal(await submit(page).count(), 0); await capture(page, 'no-account-1280');
  });
  await scenario('operator can issue sold and French component strings wrap safely', async ({ page, posts }) => {
    await open(page); await pick(page, 'Grace'); await capture(page, 'french-inactive-390');
    assert.match(await page.locator('#customerVoucherForm').innerText(), /Aucune recette|aucune recette/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await submit(page).click(); await page.locator('.customer-voucher__code').waitFor(); assert.equal(posts[0].saleType, 'sold');
  }, { role: 'operator', width: 390, french: true });
  for (const role of ['auditor', 'reseller']) await scenario(`${role} never mounts individual UI or reads customer contacts`, async ({ page }) => {
    const customerReads = []; page.on('request', req => { const url = new URL(req.url()); if (url.pathname === '/api/admin/records' && url.searchParams.get('collection') === 'customers') customerReads.push(req.url()); });
    await page.goto(`${admin}/dashboard#vouchers`); await page.locator('#voucherRecords').waitFor();
    assert.equal(await page.locator('#customerVoucherForm').count(), 0); assert.equal(await page.getByRole('tab', { name: 'For one customer', exact: true }).count(), 0); assert.deepEqual(customerReads, []);
  }, { role });
});
