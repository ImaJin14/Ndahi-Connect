import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
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
  // Native keyboard change must retain focus through the dashboard refresh.
  await page.waitForFunction(() => document.documentElement.lang === 'fr' && document.querySelector('[data-account-language] option[value=fr][selected]'));
  assert.equal(await page.locator('[data-account-language]').evaluate(n => n === document.activeElement), true, 'keyboard language change preserves focus');
  await page.waitForFunction(() => document.documentElement.lang === 'fr');
  await page.locator('[data-account-language] option[value="fr"][selected]').waitFor({ state: 'attached' });
  await page.locator('.account-setup-reminder strong').filter({ hasText: 'Terminez la configuration du compte' }).waitFor();
  assert.equal(await page.locator('#portalHeadAction').textContent(), 'Forfaits et tickets');
  assert.equal(await page.locator('#portalNav').getAttribute('aria-label'), 'Navigation principale');
  assert.equal(await page.locator('#shopPanel h2').textContent(), 'Meilleur signal à la maison');
  assert.equal(await page.locator('#differentCode summary').textContent(), 'Saisir un code de ticket');
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
  // Exercise the actual Home banner in each network state; all provider/router
  // evidence here is synthetic. The independent internet probe is mocked too.
  await page.setViewportSize({ width: 360, height: 844 });
  const captureDir = process.env.FRENCH_HOME_CAPTURE_DIR;
  if (captureDir) await mkdir(captureDir, { recursive: true });
  let evidence = {}, browserOnline = false;
  await context.route('https://www.cloudflare.com/cdn-cgi/trace?**', route => route.fulfill({ status: browserOnline ? 200 : 503, headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }, body: browserOnline ? 'h=www.cloudflare.com\ncolo=TST\n' : 'Mock unavailable' }));
  await context.route('**/api/account/connectivity', route => route.fulfill({ json: { version: 1, expiresAt: new Date(Date.now() + 45000).toISOString(), ...evidence } }));
  const networkStates = [
    ['connected', 'confirmed', 'authenticated', 'signed-in', 'active', true, 'Connexion au routeur confirmée', 'Cet appareil dispose d’un accès HotSpot. Le test Internet du navigateur a réussi.'],
    ['internet-unconfirmed', 'confirmed', 'authenticated', 'signed-in', 'active', false, 'Connexion au routeur confirmée', 'Cet appareil dispose d’un accès HotSpot. L’accès Internet n’est pas confirmé ; ne rachetez pas de forfait pour rétablir la connexion.'],
    ['signed-out', 'confirmed', 'unknown', 'signed-out', 'none', false, 'Réseau NDAHI détecté', 'Connectez-vous pour utiliser votre accès existant ou vérifier les forfaits disponibles. L’accès Internet n’est pas encore confirmé.'],
    ['bundle-ended', 'confirmed', 'unknown', 'signed-in', 'expired', false, 'Réseau NDAHI détecté', 'Consultez les forfaits disponibles pour vous connecter. La présence sur le réseau ne donne pas accès à Internet.'],
    ['authorizing', 'confirmed', 'unknown', 'signed-in', 'active', false, 'Réseau NDAHI détecté', 'Votre compte est accessible. L’autorisation HotSpot de cet appareil est encore en cours de vérification.'],
    ['wifi-unconfirmed', 'unknown', 'unknown', 'signed-in', 'active', false, 'Wi-Fi NDAHI non confirmé', 'Cette requête ne confirme pas le Wi-Fi NDAHI. Les données mobiles, un VPN ou le routage peuvent modifier ce résultat.'],
  ];
  const metrics = [];
  for (const [name, network, hotspot, account, subscription, online, badge, message] of networkStates) {
    evidence = { network: { state: network }, hotspot: { state: hotspot }, account: { state: account }, subscription: { state: subscription }, internet: { state: 'unavailable' } }; browserOnline = online;
    await page.reload(); await page.locator('.network-banner-message').filter({ hasText: message }).waitFor();
    assert.equal((await page.locator('.network-banner-badge').textContent()).trim(), badge);
    assert.equal(await page.locator('.network-state-banner').getAttribute('aria-label'), 'État du réseau');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name);
    const tabsFit = await page.locator('.nd-topnav__label').evaluateAll(nodes => nodes.every(n => n.scrollWidth <= n.clientWidth && n.clientHeight <= 20));
    assert.equal(tabsFit, true, name);
    metrics.push({ state: name, badge, message, tabsFit, overflow: false });
    if (captureDir) { await page.evaluate(() => document.fonts.ready); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `${captureDir}/network-${name}-360.png` }); }
  }
  if (captureDir) await writeFile(`${captureDir}/network-states.json`, JSON.stringify(metrics, null, 2) + '\n');
  await page.reload(); await page.locator('[data-remaining-data]').filter({ hasText: '3,2 Go' }).waitFor();
  // Seed a near expiry; the actual timer must change its text in French.
  await store.transaction(s => { s.vouchers[0].expiresAt = new Date(Date.now() + 123000).toISOString(); });
  await page.reload(); await page.locator('[data-expiry-countdown]').waitFor();
  const beforeTick = await page.locator('[data-expiry-countdown]').innerText();
  await page.waitForFunction(before => { const n = document.querySelector('[data-expiry-countdown]'); return n && n.textContent.trim() !== before && /Se termine/.test(n.textContent); }, beforeTick);
  // A pending payment must keep its French content and help across refresh.
  await store.transaction(s => { s.payments.push({ id: 'fr-pending', customerId: 'fr-customer', planId: 'weekly', amount: 1000, currency: 'XAF', provider: 'mock', status: 'pending', payerPhone: '670050001', createdAt: new Date().toISOString(), paymentExpiresAt: new Date(Date.now() + 240000).toISOString(), paymentClosesAt: new Date(Date.now() + 360000).toISOString() }); });
  await page.reload(); await page.locator('#pendingPaymentTitle').filter({ hasText: 'Paiement en attente.' }).waitFor();
  await page.waitForFunction(() => document.querySelector('#pendingPayment [data-payment-clock]')?.textContent.includes('Validez le paiement dans'));
  const refreshed = page.waitForResponse(response => response.url().endsWith('/api/account/dashboard'));
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); await refreshed;
  await page.locator('#pendingPaymentTitle').filter({ hasText: 'Paiement en attente.' }).waitFor();
  assert.equal(await page.locator('#pendingPayment summary').textContent(), 'Pas de demande sur votre téléphone ?');
  assert.match(await page.locator('#pendingPayment').innerText(), /Voir le paiement/);
  assert.equal(await page.locator('#pendingPayment .ussd-waiting-header strong').textContent(), 'Validez la demande sur votre téléphone');
  if (captureDir) await page.screenshot({ path: `${captureDir}/payment-pending-fr-360.png`, fullPage: true });
  await page.locator('[data-portal-tab="account"]').click();
  await page.locator('[data-account-language]').waitFor(); await page.waitForTimeout(100);
  await page.locator('[data-account-language]').focus(); assert.equal(await page.locator('[data-account-language]').evaluate(n => n === document.activeElement), true);
  assert.deepEqual((await lowContrastText(page)).filter(item => item.includes('SELECT') || item.includes('Language') || item.includes('Langue')), []);
  await page.locator('[data-account-language]').selectOption('en'); await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.reload(); await page.locator('[data-account-language] option[value="en"][selected]').waitFor({ state: 'attached' });
  await page.locator('[data-portal-tab="home"]').click(); assert.match(await page.locator('[data-remaining-data]').innerText(), /3\.20 GB/);
  await page.locator('[data-portal-tab="account"]').click();
  await page.locator('body[data-current-tab="account"]').waitFor();
  await context.route('**/api/account/dashboard', route => route.fulfill({ status: 500, json: { error: 'Synthetic refresh failure' } }));
  await page.locator('[data-account-language]').focus(); await page.locator('[data-account-language]').selectOption('fr');
  await page.locator('#dashboardMessage').filter({ hasText: 'Impossible d’actualiser' }).waitFor();
  assert.equal(await page.locator('[data-account-language]').evaluate(n => n === document.activeElement), true, await page.evaluate(() => document.activeElement.outerHTML));
  assert.deepEqual(errors, []); await context.close();
  const restricted = await browser.newContext({ locale: 'fr-CM', viewport: { width: 360, height: 844 } });
  await restricted.route('**/*', route => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort('blockedbyclient'));
  await restricted.addCookies([{ name: 'customer_session', value: 'fr-token', url: `${api}/api/account`, httpOnly: true, sameSite: 'Lax' }]);
  await restricted.addInitScript(() => { for (const method of ['getItem', 'setItem']) Storage.prototype[method] = () => { throw new DOMException('Blocked storage', 'SecurityError'); }; });
  const restrictedPage = await restricted.newPage(); restrictedPage.on('pageerror', error => errors.push(error.message));
  await restrictedPage.goto(`${portal}/dashboard#account`); await restrictedPage.locator('[data-account-language]').waitFor();
  assert.equal(await restrictedPage.locator('html').getAttribute('lang'), 'en', 'blocked storage with French browser defaults to English');
  await restrictedPage.locator('[data-account-language]').selectOption('fr');
  await restrictedPage.locator('[data-portal-tab="home"]').click(); await restrictedPage.locator('[data-remaining-data]').filter({ hasText: '3,2 Go' }).waitFor();
  assert.deepEqual(errors, [], 'unavailable storage must not prevent in-page French'); await restricted.close();
});
