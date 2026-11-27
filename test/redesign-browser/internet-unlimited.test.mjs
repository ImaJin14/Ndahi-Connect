import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createStaticServer } from "../../static-server.mjs";
import { pairingFixture } from "../helpers/wifi-pairing-fixture.mjs";
import { routerRevision } from "../../lib/device-identities.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Internet with a running Unlimited bundle (#355 PhoneInternet, #356
// DesktopInternet; owner 27 Nov): the time left, never data left; no Buy for
// someone else; on desktop the card beside Got a voucher?, Bundle history beside
// Saved vouchers (drawn as a list whose codes open their voucher page).

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();
const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });

test("Internet shows a running Unlimited bundle as drawn on phones and desktop, with Saved vouchers as a list", { timeout: 240000 }, async (t) => {
  const website = await listen(http.createServer()), portal = `http://127.0.0.1:${website.address().port}`;
  const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, env: { NETWORK_QUEUE_ENABLED: "false" } });
  await f.store.transaction((s) => {
    const v = s.vouchers.find((x) => x.id === "v1"), terms = { name: "Personal Unlimited", validityHours: 168, accessType: "personal_unlimited", deviceLimit: 2 };
    Object.assign(v, { accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaBytes: null, usedBytes: 3.2e9, activatedAt: new Date(Date.now() - 106 * 36e5).toISOString(),
      expiresAt: new Date(Date.now() + 62 * 36e5 + 180e3).toISOString(), customTerms: terms });
    s.vouchers.push({ ...structuredClone(v), id: "old", code: "NC-K7PM-42XQ", status: "expired", usedBytes: 5e9, activatedAt: new Date(Date.now() - 29 * 864e5).toISOString(), expiresAt: new Date(Date.now() - 22 * 864e5).toISOString() },
      { ...structuredClone(v), id: "new", code: "NC-QF83-ZK4M", status: "available", usedBytes: 0, activatedAt: null, expiresAt: null, createdAt: new Date(Date.now() - 36e5).toISOString() });
    s.wifiDeviceGrants ??= [];
    for (const n of [1, 2]) s.wifiDeviceGrants.push({ id: "g" + n, customerId: "c1", voucherId: "v1", mac: `AA:BB:CC:DD:EE:0${n}`, status: "approved", routerRevision: routerRevision(s), approvedAt: new Date().toISOString() });
  });
  const assets = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: "https://connect.home.test/login", env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } });
  website.on("request", (req, res) => assets.emit("request", req, res));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await f.close(); await new Promise((r) => { website.close(r); website.closeAllConnections(); }); });
  const open = async ({ width, height = 900, lang = "en", path = "/dashboard#internet", ready = ".portal-bundle__time" }) => {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (![portal, f.api].includes(u.origin)) return route.abort("blockedbyclient");
      return route.continue(u.origin === f.api ? { headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } } : {});
    });
    await context.addCookies([{ name: "customer_session", value: "main", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => { try { localStorage.setItem("ndahi-lang", "fr"); } catch {} });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(portal + path);
    await page.locator(ready).waitFor();
    return { page, errors };
  };

  // Phone (PhoneInternet): the time at the figure's size, "left · unlimited data", the bar and its end.
  let { page, errors } = await open({ width: 390, height: 844 });
  const time = page.locator(".portal-bundle [data-time-left]");
  assert.equal(await text(time), "2 days 14 h");
  assert.deepEqual(await time.evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).color]), ["30px", "rgb(255, 255, 255)"]);
  assert.equal(await text(page.locator(".portal-bundle__unit")), "left · unlimited data");
  assert.match(await text(page.locator(".portal-bundle__ends")), /^Ends [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/);
  const gone = Number(await page.locator(".portal-bundle__time").getAttribute("value"));
  assert.ok(gone > 60 && gone < 65, "the bar shows the time gone: " + gone);
  assert.match(await text(page.locator(".portal-internet__note")), /^You can buy your next bundle once this one ends\./);
  assert.equal(await page.getByText("Buy for someone else").count(), 0, "no Buy for someone else (owner)");
  assert.match(await text(page.locator(".portal-internet__history")), /29 Oct|5 GB used/);
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);

  // Desktop (DesktopInternet): each row's panels level; slots in the unit; Saved vouchers as drawn.
  ({ page, errors } = await open({ width: 1280 }));
  await page.locator(".portal-saved__row").first().waitFor();
  assert.equal(await text(page.locator(".portal-bundle__unit")), "left · unlimited data · 2 of 2 device slots");
  assert.equal(await page.locator(".portal-bundle [data-time-left]").evaluate((el) => getComputedStyle(el).fontSize), "42px");
  const [card, got, history, saved] = await Promise.all([".portal-bundle", ".portal-vouchers__got", ".portal-internet__table", "#voucherHistory .portal-vouchers__saved"].map((s) => box(page.locator(s))));
  assert.deepEqual([got.y, got.h], [card.y, card.h], "the voucher panel sits beside the card, as tall");
  assert.deepEqual([saved.y, saved.h], [history.y, history.h], "Saved vouchers sits beside Bundle history, as tall");
  assert.equal(card.x + card.w + 22, got.x);
  assert.deepEqual(await page.locator(".portal-saved__code").allInnerTexts(), ["QF83-ZK4M", "AAAA-1111", "K7PM-42XQ"]);
  assert.deepEqual(await page.locator(".portal-saved__meta").allInnerTexts().then((all) => all.map((m) => m.replace(/\d{1,2} [A-Z][a-z]{2}/, "D"))), ["Personal Unlimited · not used", "Redeemed D", "Redeemed D"]);
  assert.equal(await page.locator("a.portal-saved__row").count(), 2, "codes that can still be used open");
  assert.equal(await text(page.locator("div.portal-saved__row .portal-saved__used")), "Used");
  for (const hidden of ["[data-voucher-filter]", "[data-voucher-history]", ".voucher-card"]) assert.equal(await page.locator(`#voucherHistory ${hidden}`).first().isVisible().catch(() => false), false, hidden + " leaves desktop");
  assert.deepEqual(await lowContrastText(page), []);
  assert.deepEqual(errors, []);
  // Open goes to that code's voucher page.
  await page.locator('a.portal-saved__row[href="/voucher-ready.html?voucher=new"]').click();
  await page.getByRole("link", { name: "Print slip", exact: true }).waitFor();
  assert.equal(await page.locator("[data-voucher-code]").textContent(), "QF83-ZK4M");
  assert.match(await text(page.locator("[data-voucher-usage]")), /^Not used yet/);
  assert.equal(await page.getByRole("link", { name: "Print slip", exact: true }).getAttribute("href"), "/voucher-print.html#ids=new&width=58");
  ({ page } = await open({ width: 1280, path: "/voucher-ready.html?voucher=someone-else", ready: "#retryVoucher:not([hidden])" }));
  assert.equal(await text(page.locator("#voucherStatus")), "This voucher isn't in this account. Open it from your saved vouchers.");

  // Below 1024px the board's rows wrap: card, voucher, history, saved.
  ({ page } = await open({ width: 900, height: 1400 }));
  await page.locator(".portal-saved__row").first().waitFor();
  const stacked = await Promise.all([".portal-bundle", ".portal-vouchers__got", ".portal-internet__table", "#voucherHistory .portal-vouchers__saved"].map((s) => box(page.locator(s))));
  assert.ok(stacked.every((b, n) => b.x === stacked[0].x && b.w === stacked[0].w && (n === 0 || b.y > stacked[n - 1].y + stacked[n - 1].h)), JSON.stringify(stacked));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  // French.
  ({ page, errors } = await open({ width: 1280, lang: "fr" }));
  await page.locator(".portal-saved__row").first().waitFor();
  assert.equal(await text(page.locator(".portal-bundle__unit")), "restants · données illimitées · 2 appareils sur 2");
  assert.equal(await text(page.locator(".portal-saved__meta").first()), "Personal Unlimited · pas encore utilisé");
  assert.deepEqual([await text(page.locator(".portal-saved__open").first()), await text(page.locator(".portal-saved__used"))], ["Ouvrir", "Utilisé"]);
  assert.deepEqual(errors, []);

  // A fixed-data bundle keeps its data card: no time bar.
  await f.store.transaction((s) => { const v = s.vouchers.find((x) => x.id === "v1"); Object.assign(v, { accessType: null, quotaBytes: 5e9, usedBytes: 1.8e9 }); delete v.customTerms; });
  ({ page } = await open({ width: 390, height: 844, ready: ".portal-bundle__amount" }));
  assert.equal(await page.locator(".portal-bundle__time").count(), 0);
  assert.match(await text(page.locator(".portal-bundle__amount")), /GB/);
});
