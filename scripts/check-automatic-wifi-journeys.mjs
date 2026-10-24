import assert from 'node:assert/strict';
import http from 'node:http';
import { createStaticServer } from '../static-server.mjs';
const assets = createStaticServer('customer', { apiUrl: 'http://localhost' });
const server = http.createServer((req, res) => {
  if (req.url === '/poll-harness') {
    res.setHeader('content-type', 'text/html');
    res.end(`<link rel="stylesheet" href="/styles.css"><section data-portal-view="home"><div id="card"></div></section><script>window.NDAHI_CONFIG={hotspotLoginUrl:'https://connect.ndahi.test/login'};</script><script type="module">
    import {mountCurrentWifi} from '/current-wifi.js'; import {requestJson} from '/compat.js';
    window.stopWifi=mountCurrentWifi({container:document.querySelector('#card'),call:async(path,options)=>{const r=await requestJson(path,options,6000);if(!r.response.ok)throw Error(r.body.error);return r.body;},onMainDisconnect:async()=>{}});</script>`);
  } else assets.emit('request', req, res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${server.address().port}`;
let browser;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
  await page.clock.install();
  let accountAuthenticated = true, hotspotAuthenticated = true;
  let state = 'connected', fail = false, rejectDisconnect = false, reads = 0, disconnects = [], releaseDisconnect;
  const device = { mac: 'AA:BB:CC:DD:EE:03', sessionId: '*guest', startedAt: new Date().toISOString(), main: false };
  await page.route('**/api/account/device-management/current', async route => {
    reads++;
    if (fail) return route.fulfill({ status: 503, json: { error: 'Router status unavailable' } });
    const stamp = await page.evaluate(() => new Date().toISOString());
    await route.fulfill({ json: { state, message: 'Router evidence: ' + state, checkedAt: ['connected','disconnected','stale'].includes(state) ? stamp : null,
      device: ['connected','disconnecting'].includes(state) ? device : undefined, candidate: { mac: device.mac, address: '10.20.0.30' },
      connectivity: { version: 1, network: { state: 'confirmed' }, account: { state: accountAuthenticated ? 'authenticated' : 'signed-out' }, hotspot: { state: state === 'connected' && hotspotAuthenticated ? 'authenticated' : 'unknown' }, expiresAt: new Date(Date.parse(stamp) + 45000).toISOString() } } });
  });
  await page.route('**/api/account/wifi-devices/disconnect', async route => {
    disconnects.push(route.request().postDataJSON());
    if (rejectDisconnect) return route.fulfill({ status: 409, json: { error: "The router session changed. Check the current device before retrying." } });
    await new Promise(r => { releaseDisconnect = r; });
    state = 'disconnecting'; await route.fulfill({ status: 202, json: {} });
  });
  const card = page.locator('#card'), expectState = s => card.locator(`[data-current-state="${s}"]`).waitFor();
  await page.goto(origin + '/poll-harness'); await expectState('connected');
  assert.equal(await card.getByRole('button', { name: 'Refresh connection status', exact: true }).count(), 0);
  assert.equal(await card.locator('.current-wifi-connected .current-wifi-indicator').count(), 1);
  assert.equal(await card.locator('[role="status"]').first().getAttribute('aria-live'), 'polite');
  const initial = reads; await page.clock.runFor(30000); assert.ok(reads - initial <= 3, 'stable state checks at most once per ten seconds');
  console.log('PASS stable router-confirmed state is accessible, green and automatically bounded without Refresh');
  accountAuthenticated = false; await page.clock.runFor(10001); await expectState('unknown');
  assert.equal(await card.getByRole('button', { name: 'Disconnect this device', exact: true }).count(), 0);
  accountAuthenticated = true; hotspotAuthenticated = false; await page.clock.runFor(10001); await expectState('unknown');
  hotspotAuthenticated = true; await page.clock.runFor(10001); await expectState('connected');
  console.log('PASS inconsistent account or HotSpot evidence cannot label a current device Connected');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hiddenReads = reads; await page.clock.runFor(60000); assert.equal(reads, hiddenReads);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pageshow')); });
  await page.clock.runFor(10); await expectState('connected'); assert.equal(reads, hiddenReads + 1);
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); });
  await expectState('unknown'); const offlineReads = reads; await page.clock.runFor(60000); assert.equal(reads, offlineReads);
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')); });
  await page.clock.runFor(10); await expectState('connected');
  console.log('PASS hidden/offline views stop requests; overlapping resume events share one read');
  await card.getByRole('button', { name: 'Disconnect this device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-current-message]').textContent.includes('Submitting'));
  assert.equal(await card.locator('[data-current-state="disconnecting"]').count(), 0, 'a local POST alone cannot claim a router transition');
  await page.waitForTimeout(10); releaseDisconnect(); await expectState('disconnecting');
  assert.equal(disconnects[0].sessionId, '*guest'); assert.equal(disconnects[0].startedAt, device.startedAt); assert.equal(disconnects[0].retainApproval, true);
  assert.equal(await card.locator('.current-wifi-pending .current-wifi-indicator').count(), 1);
  state = 'disconnected'; await page.clock.runFor(2001); await expectState('disconnected');
  assert.equal(await card.locator('.current-wifi-disconnected .current-wifi-indicator').count(), 1);
  state = 'connecting'; await page.clock.runFor(10001); await expectState('connecting');
  state = 'connected'; device.sessionId = '*replacement'; await page.clock.runFor(2001); await expectState('connected');
  console.log('PASS accepted transitions turn yellow, confirmed disconnect red, and replacement session Connected');
  fail = true; await page.clock.runFor(10001); await expectState('failed');
  assert.equal(await card.getByRole('button', { name: 'Disconnect this device', exact: true }).count(), 0);
  assert.match(await card.textContent(), /Last successful check/);
  const failedReads = reads; await page.clock.runFor(60000); assert.ok(reads - failedReads <= 3, 'failures back off rather than hammering the API');
  fail = false; state = 'stale'; await page.clock.runFor(60001); await expectState('stale');
  assert.equal(await card.locator('.current-wifi-pending, .current-wifi-connected, .current-wifi-disconnected').count(), 0);
  state = 'connected'; await page.clock.runFor(10001); await expectState('connected');
  rejectDisconnect = true;
  await card.getByRole('button', { name: 'Disconnect this device', exact: true }).click();
  await card.locator('[data-current-message]').filter({ hasText: 'The router session changed.' }).waitFor();
  await page.clock.runFor(10001);
  assert.match(await card.locator('[data-current-message]').textContent(), /The router session changed/);
  assert.equal(disconnects[1].sessionId, '*replacement');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Polling can replace an indicator between locator resolution and evaluation.
  // Check the current attached node, so an empty style on an old node is not
  // mistaken for a reduced-motion regression.
  await page.waitForFunction(() => {
    const indicator = document.querySelector('#card .current-wifi-indicator');
    return indicator && indicator.isConnected && getComputedStyle(indicator).animationName === 'none';
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => { document.querySelector('[data-portal-view]').hidden = true; window.dispatchEvent(new Event('hashchange')); });
  const irrelevantReads = reads; await page.clock.runFor(60000); assert.equal(reads, irrelevantReads);
  await page.evaluate(() => window.stopWifi()); await page.clock.runFor(60000); assert.equal(reads, irrelevantReads);
  console.log('PASS failures keep last-check evidence, back off and recover; stale/unknown stay neutral; reduced motion and unmount work');
} finally { if (browser) await browser.close(); await new Promise(r => { server.close(r); server.closeAllConnections(); }); }
