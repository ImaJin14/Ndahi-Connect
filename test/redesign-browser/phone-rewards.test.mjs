import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
import { hashSecret } from "../../lib/security.mjs";

// Rewards (#528, canvas: PhoneRewards), opened from Account's Rewards row: the
// points card, Redeem (an out-of-reach bundle says how many points it needs),
// the confirm and "Bundle saved" sheets (a double tap redeems once; Start now
// waits while a bundle runs), Invite friends and History, in English and
// French. Local servers only, synthetic data, every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

function seed(s, now) {
  seedCatalogue(s, now); s.catalogue.mode = "unlimited";
  const drawn = new Set(["unlimited-24h-1", "unlimited-7d-1", "unlimited-7d-2", "unlimited-30d-1", "home-wisp-30d"]);
  s.rewardsSettings = { points: { enabled: true, enabledAt: "2025-09-01T00:00:00.000Z" }, referrals: { enabled: true, enabledAt: "2025-09-01T00:00:00.000Z" },
    offers: s.bundles.map((b) => ({ bundleId: b.id, points: Math.round(b.price / 5), redeemable: drawn.has(b.id) })) };
  s.customers.push({ id: "amina", name: "Amina Ndi", phone: "+237670001245", email: "amina@example.test", emailVerifiedAt: "2026-09-01T08:00:00.000Z", referralCode: "AMINA-7K2", createdAt: "2026-09-01T08:00:00.000Z" });
  s.dashboardSessions.push({ id: "amina-session", customerId: "amina", tokenHash: hashSecret("amina-token", "redesign-rewards"), csrfToken: "amina-csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  const bundle = (id) => { const b = s.bundles.find((x) => x.id === id); return { id, name: b.name, validityHours: b.validityHours, deviceSlots: b.deviceSlots, accessType: b.accessType }; };
  const year = (at) => new Date(new Date(at).setUTCFullYear(new Date(at).getUTCFullYear() + 1)).toISOString();
  const row = (id, at, kind, points, extra = {}) => ({ id, customerId: "amina", at, actor: "system", kind, points, ...(points > 0 ? { expiresAt: year(at) } : {}), ...extra });
  const soon = (days) => new Date(+now + days * 864e5).toISOString();
  // 180 + 720 + 100 + 200 + 40 = 1,240; nothing spent yet, so the oldest 180 expire next.
  s.pointsLedger = [
    row("old", soon(-300), "earned", 180, { bundle: bundle("unlimited-30d-6") }),
    row("b", soon(-200), "earned", 720, { bundle: bundle("unlimited-30d-6") }),
    row("w", soon(-90), "welcome", 100, { invitedBy: { name: "J. Fon", code: "JEAN-4PQ" } }),
    row("f", soon(-16), "referral", 200, { friend: "6•• •• 88 21" }),
    row("e", soon(-4), "earned", 40, { bundle: bundle("unlimited-7d-2") }),
  ];
  for (const [id, phone] of [["f1", "+237690008821"], ["f3", "+237690007731"]]) s.customers.push({ id, name: "Friend", phone, createdAt: soon(-30) });
  s.referrals = [
    { id: "r3", referrerId: "amina", friendId: "f3", code: "AMINA-7K2", status: "pending", at: soon(-3) },
    { id: "r1", referrerId: "amina", friendId: "f1", code: "AMINA-7K2", status: "paid", at: soon(-18), paidAt: soon(-16), points: { referrer: 200, welcome: 100 } },
  ];
  s.vouchers.push({ id: "running", customerId: "amina", planId: "unlimited-7d-2", code: "NC-RUN", status: "active", activatedAt: soon(-4), expiresAt: soon(3), quotaBytes: null, usedBytes: 0,
    deviceLimit: 2, accessType: "personal_unlimited", deviceSlots: 2, sharing: false, customTerms: s.bundles.find((x) => x.id === "unlimited-7d-2") });
}

test("Rewards from Account: the points, redeeming once with Start now waiting for the running bundle, Invite friends and History, in English and French", { timeout: 180000 }, async (t) => {
  const secret = "redesign-rewards", store = createStore({ persistent: false }), now = new Date();
  await store.transaction((s) => seed(s, now));
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); });
  const open = async (path, lang = "en") => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "customer_session", value: "amina-token", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: portal });
    if (lang === "fr") await context.addInitScript(() => { try { localStorage.setItem("ndahi-lang", "fr"); } catch {} });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Blocked outside requests (the web fonts) aren't the page's errors.
    page.on("console", (message) => { if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/.test(message.text())) errors.push(message.text()); });
    await page.goto(portal + path);
    return { page, errors, context };
  };

  // Account's Rewards row, with the balance, opens Rewards.
  const { page, errors } = await open("/dashboard#account");
  const row = page.locator("[data-account-rewards]:not([hidden]) .portal-account__item");
  await row.waitFor({ timeout: 20000 });
  assert.equal((await row.innerText()).replace(/\s+/g, " ").trim(), "Rewards 1,240 points");
  await row.click();
  await page.waitForURL(/\/rewards\.html$/);
  await page.locator(".rewards__offer").first().waitFor();
  assert.equal(await page.locator(".rewards__balance").innerText(), "1,240 points");
  assert.equal(await page.locator(".rewards__worth").innerText(), "Worth about 6,200 XAF in bundles");
  assert.match(await page.locator(".rewards__expiry").innerText(), /^180 points expire on \d{1,2} [A-Z][a-z]{2} \d{4} · points last 12 months$/);
  assert.deepEqual(await page.locator(".rewards__offer").evaluateAll((rows) => rows.map((r) => r.innerText.replace(/\s+/g, " ").trim())), [
    "Personal Unlimited 24 hours · 1 device 100 pts", "Personal Unlimited 7 days · 1 device 500 pts", "Personal Unlimited 7 days · 2 devices 800 pts",
    "Personal Unlimited 30 days · 1 device 1,200 pts", "Home WISP Unlimited 30 days · need 8,760 points more 10,000 pts"]);
  assert.equal(await page.locator(".rewards__pts").nth(4).isDisabled(), true);
  assert.match(await page.locator(".rewards__panel > p:last-child").innerText(), /^You earn 1 point for every 100 XAF you pay for a bundle \(not the Mobile Money fee\), and 200 points/);

  // Redeem: the sheet, then a double tap spends once; Start now waits for the running bundle.
  await page.locator(".rewards__pts").nth(1).click();
  const sheet = page.locator(".rewards__sheet");
  assert.equal((await sheet.locator(".rewards__chosen").innerText()).replace(/\s+/g, " ").trim(), "Personal Unlimited · 7 days · 1 device Unlimited data · 1 registered device");
  assert.equal((await sheet.locator(".rewards__sums").innerText()).replace(/\s+/g, " ").trim(), "Cost 500 points Balance after 740 points");
  assert.match(await sheet.locator(".rewards__note").innerText(), /within 60 days — you can start it once your current bundle has ended\.$/);
  await sheet.locator("[data-redeem]").dblclick();
  await page.locator(".rewards__sheet--done").waitFor();
  assert.equal((await store.snapshot()).vouchers.filter((v) => v.reward).length, 1, "one tap's worth");
  assert.match(await page.locator(".rewards__done-line").innerText(), /^Personal Unlimited · 7 days · 1 device is on your account\. Start it by \d{1,2} [A-Z][a-z]{2} \d{4}\.$/);
  assert.equal(await page.locator("[data-start]").isDisabled(), true);
  assert.match(await page.locator(".rewards__start-note").innerText(), /^Available when your current bundle ends \([A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}\)\.$/);
  assert.equal(await page.locator(".rewards__balance").innerText(), "740 points");

  // Invite friends: the code, Copy link, and the friends (joined first).
  await page.goto(portal + "/rewards.html");
  await page.locator('[data-tab="invite"]').click();
  assert.equal(await page.locator(".rewards__code").innerText(), "AMINA-7K2");
  await page.locator("[data-copy]").click();
  await page.locator("[data-copy]", { hasText: "Copied" }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${portal}/r/AMINA-7K2`);
  assert.deepEqual(await page.locator(".rewards__row").evaluateAll((rows) => rows.map((r) => r.innerText.replace(/\s+/g, " ").trim().replace(/Joined \d{1,2} [A-Z][a-z]{2}/, "Joined <day>"))), [
    "6•• •• 88 21 Joined <day> +200", "6•• •• 77 31 Invited · hasn’t bought a first bundle yet Pending"]);
  assert.match(await page.locator(".rewards__panel--invite > p:last-child").innerText(), /^One friend per new number, up to 10 a month\./);
  // History: the ledger, newest first.
  await page.locator('[data-tab="history"]').click();
  const history = await page.locator(".rewards__row").evaluateAll((rows) => rows.map((r) => [r.querySelector("strong").innerText, r.querySelector(".rewards__amount").innerText]));
  assert.deepEqual(history, [["Redeemed", "−500"], ["Bundle payment", "+40"], ["Friend joined", "+200"], ["Welcome bonus", "+100"], ["Bundle payment", "+720"], ["Bundle payment", "+180"]]);
  assert.deepEqual(errors, []);

  // Start now once nothing is running: the bundle starts and Home opens.
  await store.transaction((s) => { const v = s.vouchers.find((x) => x.id === "running"); v.status = "expired"; v.expiresAt = new Date(Date.now() - 1000).toISOString(); });
  await page.goto(portal + "/rewards.html");
  await page.locator(".rewards__pts").nth(0).click();
  await page.locator("[data-redeem]").click();
  await page.locator(".rewards__sheet--done").waitFor();
  assert.equal(await page.locator("[data-start]").isDisabled(), false);
  assert.equal(await page.locator(".rewards__start-note").count(), 0);
  await page.locator("[data-start]").click();
  await page.waitForURL(/\/dashboard$/);
  const started = (await store.snapshot()).vouchers.filter((v) => v.reward && v.status === "active");
  assert.equal(started.length, 1);
  assert.equal(started[0].planId, "unlimited-24h-1");

  // French.
  const fr = await open("/rewards.html", "fr");
  await fr.page.locator(".rewards__offer").first().waitFor();
  assert.equal(await fr.page.locator(".rewards__title").innerText(), "Récompenses");
  assert.equal(await fr.page.locator(".rewards__balance").innerText(), "640 points");
  assert.deepEqual(await fr.page.locator(".rewards__tabs button").allInnerTexts(), ["Échanger", "Inviter des amis", "Historique"]);
  assert.match(await fr.page.locator(".rewards__offer").nth(4).innerText(), /30 jours · encore 9 360 points/);
  assert.deepEqual(fr.errors, []);
});
