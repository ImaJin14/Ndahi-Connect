import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createServer, createStore } from '../../server.mjs';
import { createStaticServer } from '../../static-server.mjs';
import { hashSecret } from '../../lib/security.mjs';
import { lowContrastText } from '../../scripts/ui-checks.mjs';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

test('optional French: English default, Account preference, persistent translated Home and five unclipped tabs at 360px', async t => {
  let browser, apiServer, website;
  t.after(async () => { await browser?.close(); if (website) await close(website); if (apiServer) await close(apiServer); });
  const reservation = http.createServer(); await listen(reservation); const port = reservation.address().port; await close(reservation);
  const api = `http://127.0.0.1:${port}`, secret = 'french-home-test-only', store = createStore({ persistent: false });
  const now = new Date();
  await store.transaction(s => {
    s.customers.push({ id: 'fr-customer', name: 'Amina', phone: '670050001', passkeys: [] });
    s.dashboardSessions.push({ id: 'fr-session', customerId: 'fr-customer', tokenHash: hashSecret('fr-token', secret), csrfToken: 'fr-csrf', expiresAt: '2099-01-01T00:00:00.000Z' });
    s.vouchers.push({ id: 'fr-voucher', customerId: 'fr-customer', code: 'NC-FRTEST-001', planId: 'weekly', status: 'active', quotaBytes: 5e9, usedBytes: 1.8e9, deviceLimit: 3, activatedAt: now.toISOString(), expiresAt: new Date(+now + 2.5 * 864e5).toISOString() });
  });
  website = createStaticServer('customer', { apiUrl: api, env: { NODE_ENV: 'test', CUSTOMER_UI_DEFAULT: 'v2' } }); await listen(website);
  const portal = `http://127.0.0.1:${website.address().port}`;
  apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: 'test', CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: 'false', CUSTOMER_APP_URL: portal, PAYMENT_MODE: 'mock', EMAIL_MODE: 'mock', MIKROTIK_MODE: 'mock', OMADA_MODE: 'mock', BILLING_WORKER_ENABLED: 'false', NETWORK_QUEUE_ENABLED: 'false', SECURITY_ALERTS_ENABLED: 'false' } });
  await new Promise(resolve => apiServer.listen(port, '127.0.0.1', resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'); browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'fr-CM', viewport: { width: 360, height: 844 } });
  await context.route('**/*', route => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort('blockedbyclient'));
  await context.addCookies([{ name: 'customer_session', value: 'fr-token', url: `${api}/api/account`, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${portal}/dashboard#home`); await page.locator('[data-remaining-data]').waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en', 'French browser alone must not change the default');
  assert.match(await page.locator('[data-remaining-data]').innerText(), /3\.20 GB/);
  await page.locator('[data-portal-tab="account"]').click();
  const language = page.getByRole('combobox', { name: 'Language' }); await language.focus();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  // Browser keyboard selection differs by platform; selectOption uses the same change handler.
  if (await page.locator('[data-account-language]').inputValue() !== 'fr') await page.locator('[data-account-language]').selectOption('fr');
  await page.waitForFunction(() => document.documentElement.lang === 'fr');
  await page.locator('[data-account-language] option[value="fr"][selected]').waitFor({ state: 'attached' });
  await page.locator('[data-portal-tab="home"]').click(); await page.locator('[data-remaining-data]').filter({ hasText: '3,2 Go' }).waitFor();
  for (const tab of ['internet', 'shop', 'activity', 'account', 'home']) {
    await page.locator(`[data-portal-tab="${tab}"]`).click();
    await page.locator(`body[data-current-tab="${tab}"]`).waitFor();
    assert.equal(await page.locator('.nd-topnav__label').evaluateAll(nodes => nodes.every(n => n.scrollWidth <= n.clientWidth && n.clientHeight <= 20)), true, `${tab}: French nav fits`);
  }
  for (const width of [360, 390, 1280]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: page overflow`);
    const labels = await page.locator('.nd-topnav__label').evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, clipped: n.scrollWidth > n.clientWidth, lines: n.clientHeight > 20, nowrap: getComputedStyle(n).whiteSpace === 'nowrap' })));
    assert.deepEqual(labels.map(n => n.text), ['Accueil', 'Internet', 'Boutique', 'Activité', 'Compte']);
    assert.equal(labels.some(n => n.clipped || n.lines || !n.nowrap), false, `${width}: ${JSON.stringify(labels)}`);
    if (width < 768) assert.equal(await page.locator('#portalTitle').innerText(), 'Bon retour parmi nous.');
    assert.match(await page.locator('[data-expiry-countdown]').innerText(), /Se termine dans 2 jours/);
    console.info(`PASS French Home / five tabs at ${width}px: zero clipped or wrapped labels`);
  }
  await page.reload(); await page.locator('[data-remaining-data]').filter({ hasText: '3,2 Go' }).waitFor();
  await page.waitForTimeout(1100); assert.match(await page.locator('[data-expiry-countdown]').innerText(), /Se termine/,'countdown tick remains translated');
  await page.locator('[data-portal-tab="account"]').click();
  await page.locator('[data-account-language]').waitFor(); await page.waitForTimeout(100);
  await page.locator('[data-account-language]').focus(); assert.equal(await page.locator('[data-account-language]').evaluate(n => n === document.activeElement), true);
  assert.deepEqual((await lowContrastText(page)).filter(item => item.includes('SELECT') || item.includes('Language') || item.includes('Langue')), []);
  await page.locator('[data-account-language]').selectOption('en'); await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.reload(); await page.locator('[data-account-language] option[value="en"][selected]').waitFor({ state: 'attached' });
  await page.locator('[data-portal-tab="home"]').click(); assert.match(await page.locator('[data-remaining-data]').innerText(), /3\.20 GB/);
  assert.deepEqual(errors, []); await context.close();
  const restricted = await browser.newContext({ viewport: { width: 360, height: 844 } });
  await restricted.route('**/*', route => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort('blockedbyclient'));
  await restricted.addCookies([{ name: 'customer_session', value: 'fr-token', url: `${api}/api/account`, httpOnly: true, sameSite: 'Lax' }]);
  await restricted.addInitScript(() => { for (const method of ['getItem', 'setItem']) Storage.prototype[method] = () => { throw new DOMException('Blocked storage', 'SecurityError'); }; });
  const restrictedPage = await restricted.newPage(); restrictedPage.on('pageerror', error => errors.push(error.message));
  await restrictedPage.goto(`${portal}/dashboard#account`); await restrictedPage.locator('[data-account-language]').selectOption('fr');
  await restrictedPage.locator('[data-portal-tab="home"]').click(); await restrictedPage.locator('[data-remaining-data]').filter({ hasText: '3,2 Go' }).waitFor();
  assert.deepEqual(errors, [], 'unavailable storage must not prevent in-page French'); await restricted.close();
});
