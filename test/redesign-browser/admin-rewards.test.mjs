import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { balanceOf } from "../../lib/rewards.mjs";

// Rewards admin (#530, canvas: AdminRewards) at #rewards, owners only: the
// figures, Points and Referrals with their switches, the bundles customers can
// redeem, Save rewards settings (audited; "Saved"), held referrals approved
// (points paid) or rejected (nothing paid), and recent activity. Operators
// never see it. Local servers only, synthetic data, every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/[\s ]+/g, " ").trim();

test("the owner sets rewards, decides held referrals and reads recent activity; operators never see it", { timeout: 240000 }, async (t) => {
  const secret = "redesign-admin-rewards", store = createStore({ persistent: false }), now = new Date();
  await store.transaction((s) => {
    seedCatalogue(s, now); s.catalogue.mode = "unlimited";
    const drawn = ["unlimited-24h-1", "unlimited-7d-1", "unlimited-7d-2", "unlimited-30d-1", "unlimited-30d-2", "home-wisp-30d"];
    for (const b of s.bundles) if (!drawn.includes(b.id)) b.status = "unpublished";
    s.rewardsSettings = { points: { enabled: true, enabledAt: "2026-01-01T00:00:00.000Z" }, referrals: { enabled: true, enabledAt: "2026-01-01T00:00:00.000Z" } };
    for (const [id, role] of [["owner", "owner"], ["operator", "operator"]]) {
      s.adminUsers.push({ id, username: id, role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: id, role, tokenHash: hashSecret(`${id}-token`, secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    s.customers.push({ id: "amina", name: "Amina Ndi", phone: "+237670001245", referralCode: "AMINA-7K2" }, { id: "kofi", name: "Kofi Mensah", phone: "+237670004444", referralCode: "KOFI-3QP" },
      { id: "f1", name: "Customer", phone: "+237690005108" }, { id: "f2", name: "Customer", phone: "+237690001277" });
    const at = new Date(+now - 3600000).toISOString();
    s.pointsLedger = [{ id: "e1", customerId: "amina", kind: "earned", points: 40, at, actor: "system", expiresAt: new Date(+now + 3e10).toISOString(),
      bundle: { id: "unlimited-7d-2", name: "Personal Unlimited", validityHours: 168, deviceSlots: 2, accessType: "personal_unlimited" } }];
    s.referrals = [
      { id: "h1", referrerId: "amina", friendId: "f1", code: "AMINA-7K2", status: "held", reasons: ["same_device"], at, decidedAt: at, paymentId: "p1" },
      { id: "h2", referrerId: "kofi", friendId: "f2", code: "KOFI-3QP", status: "held", reasons: ["same_payer"], at, decidedAt: new Date(+now - 7200000).toISOString(), paymentId: "p2" },
    ];
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    SESSION_COOKIE_SECURE: "false", ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(adminServer); });
  const open = async (who, lang = "en") => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: `${who}-token`, url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }, { name: "ndahi_ui", value: "v2", url: admin, sameSite: "Lax" }]);
    // French, as the other admin journeys set it: the page language follows <html lang>.
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${admin}/dashboard#rewards`);
    return { page, errors, context };
  };

  const { page, errors } = await open("owner");
  await page.locator(".admin-rewards__flag").first().waitFor({ timeout: 20000 });
  assert.equal(await page.locator("#adminEyebrow").textContent(), "People · owners only");
  assert.equal(await text(page.locator("#adminTitle")), "Rewards.");
  assert.equal(await text(page.locator("#adminLede")), "Points customers earn on bundles and referrals, and swap for bundles. Points are never cash.");
  assert.deepEqual(await page.locator(".admin-rewards__metric").evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim())), [
    "40 Points outstanding · about 200 XAF in bundles", "0 Points redeemed this month · 0 bundles", "0 Friends joined this month · 0 points to referrers", "2 Referrals flagged for review"]);
  assert.equal(await page.locator("#rewardsPointsOn").getAttribute("aria-checked"), "true");
  assert.deepEqual(await page.locator("tr[data-offer]").evaluateAll((rows) => rows.map((r) => [r.querySelector("strong").innerText, r.querySelector(".admin-rewards__terms").innerText,
    r.querySelector(".admin-rewards__pts").value, r.querySelector("[role=switch]").getAttribute("aria-checked")])), [
    ["Personal Unlimited", "24 hours · 1 device", "100", "true"], ["Personal Unlimited", "7 days · 1 device", "500", "true"], ["Personal Unlimited", "7 days · 2 devices", "800", "true"],
    ["Personal Unlimited", "30 days · 1 device", "1200", "true"], ["Personal Unlimited", "30 days · 2 devices", "2000", "true"], ["Home WISP Unlimited", "30 days", "10000", "false"]]);
  assert.deepEqual(await page.locator(".admin-rewards__flag").evaluateAll((els) => els.map((el) => el.querySelector("strong").innerText)), ["AMINA-7K2 → 6•• •• 51 08", "KOFI-3QP → 6•• •• 12 77"]);
  assert.equal(await text(page.locator(".admin-rewards__flag").nth(1).locator(".admin-rewards__flag-text span")), "Paid from the same Mobile Money number as another friend");
  assert.equal(await text(page.locator(".admin-rewards__ledger tr").first()), "Amina N. Earned · Personal Unlimited 7 days · 2 devices +40 " + await page.locator(".admin-rewards__ledger tr td:last-child span").first().innerText());

  // Save: 24 months, Home WISP redeemable at 9,000 points; audited, "Saved".
  await page.locator("#rewardsExpiry").selectOption("24");
  await page.locator('tr[data-offer="home-wisp-30d"] .admin-rewards__pts').fill("9000");
  await page.locator('tr[data-offer="home-wisp-30d"] [role=switch]').click();
  await page.locator("#rewardsSave").click();
  await page.locator("#rewardsSaved:not(:empty)").waitFor();
  assert.equal(await text(page.locator("#rewardsSaved")), "Saved · applies to new points from now. Logged in the audit trail.");
  let s = await store.snapshot();
  assert.equal(s.rewardsSettings.points.expiryMonths, 24);
  assert.deepEqual(s.rewardsSettings.offers.find((o) => o.bundleId === "home-wisp-30d"), { bundleId: "home-wisp-30d", points: 9000, redeemable: true });
  assert.ok(s.auditLogs.some((x) => x.action === "rewards.settings_updated" && x.actor === "owner"));
  // A change hides "Saved" until the next save.
  await page.locator("#rewardsReferralsOn").click();
  assert.equal(await page.locator("#rewardsSaved").innerText(), "");
  await page.locator("#rewardsReferralsOn").click();

  // Approve pays both; Reject pays nothing; each card stays with its result.
  await page.locator(".admin-rewards__flag").nth(0).getByRole("button", { name: "Approve" }).click();
  await page.locator(".admin-rewards__pill--ok").waitFor();
  await page.locator(".admin-rewards__flag").nth(1).getByRole("button", { name: "Reject" }).click();
  await page.locator(".admin-rewards__pill--no").waitFor();
  assert.deepEqual(await page.locator(".admin-rewards__flag").evaluateAll((els) => els.map((el) => el.querySelector(".admin-rewards__pill")?.innerText)), ["Approved · points paid", "Rejected · no points"]);
  s = await store.snapshot();
  assert.deepEqual([s.referrals.find((r) => r.id === "h1").status, s.referrals.find((r) => r.id === "h2").status], ["paid", "rejected"]);
  assert.deepEqual([balanceOf(s, "amina"), balanceOf(s, "f1"), balanceOf(s, "kofi")], [240, 100, 0]);
  assert.ok(s.auditLogs.some((x) => x.action === "rewards.referral_approved") && s.auditLogs.some((x) => x.action === "rewards.referral_rejected"));
  assert.equal(await page.locator(".admin-rewards__activity-head a").getAttribute("href"), "/dashboard#audit");
  assert.deepEqual(errors, []);

  // French.
  const fr = await open("owner", "fr");
  await fr.page.locator(".admin-rewards__panel").first().waitFor();
  assert.equal(await text(fr.page.locator("#adminTitle")), "Récompenses.");
  assert.equal(await text(fr.page.locator("#rewardsSave")), "Enregistrer les réglages");
  assert.deepEqual(fr.errors, []);

  // Operators: #rewards opens Home, and the API refuses.
  const operator = await open("operator");
  await operator.page.waitForFunction(() => document.body.dataset.adminView);
  assert.notEqual(await operator.page.evaluate(() => document.body.dataset.adminView), "rewards");
  assert.equal(await operator.page.locator("#rewardsHost").count(), 0);
});
