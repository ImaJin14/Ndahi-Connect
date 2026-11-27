import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Home WISP routers (canvas: AdminHomeRouters, #340; owner 26 Nov): Reconcile
// now with its result, the counts, each router (masked MAC, Online / Offline /
// Disconnected, Sharing / Sharing (idle) / Withheld / Removed), Revoke with a
// reason, recent changes and the rule; no pilot tools. 1280 px. Home stays off here, so the
// worker doesn't act on the mock router; the pass itself is in test/home-reconcile.test.mjs.
const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

test("Home WISP routers is drawn as the board, with Reconcile now and Revoke", { timeout: 200000 }, async (t) => {
  const secret = "redesign-home-routers", store = createStore({ persistent: false }), now = Date.now();
  const at = (ms) => new Date(now + ms).toISOString();
  await store.transaction((s) => {
    s.adminUsers.push({ id: "owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "owner", role: "owner", tokenHash: hashSecret("owner", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.homeConnections = []; s.homeOperations = []; s.homeUsageObservations = []; s.homeChallenges = [];
    const add = (id, name, mac, opts) => {
      s.customers.push({ id, name, phone: "67000" + String(s.customers.length).padStart(4, "0"), homeConnectionId: "h-" + id, status: "active" });
      s.homeConnections.push({ id: "h-" + id, customerId: id, mac, status: "linked", generation: 1, verifiedAt: at(-20 * 864e5) });
      s.vouchers.push({ id: "v-" + id, customerId: id, planId: "wisp", code: "NC-AAAA-AAA" + s.customers.length, accessType: "home_wisp_unlimited", accessMode: "home", status: "active",
        activatedAt: at(-5 * 864e5), expiresAt: at(20 * 864e5), homeStatus: "authorized", homeGeneration: 1, quotaBytes: null, usedBytes: 0, deviceLimit: 1, ...(opts.online ? { homeOnlineSince: at(-36e5) } : {}) });
      if (opts.failed) s.homeOperations.push({ id: "op-" + id, customerId: id, kind: "activate", status: "retry", attempts: 2, errorCode: "HOME_ROUTER_UNAVAILABLE", createdAt: at(-36e5), nextAttemptAt: at(36e5) });
    };
    add("c-fon", "J. Fon", "AA:BB:CC:7E:10:2B", { online: true });
    add("c-mbah", "P. Mbah", "AA:BB:CC:12:6C:D8", { online: true, failed: true });
    add("c-tabe", "S. Tabe", "AA:BB:CC:B3:51:07", {});
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test", ADMIN_UI_DEFAULT: "v2" } }));
  const admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await listen(apiServer, apiPort);
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(adminServer); });
  const text = (locator) => locator.evaluate((el) => el.innerText.replace(/\s+/g, " ").trim());
  const open = async (lang = "en") => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, timezoneId: "Africa/Douala", locale: lang === "fr" ? "fr-FR" : "en-US" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: "owner", url: `${api}/api/admin`, httpOnly: true, sameSite: "Strict" }]);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${admin}/home-routers.html`);
    await page.locator("#wispRouters tbody tr").first().waitFor();
    return { page, errors, context };
  };

  const { page, errors, context } = await open();
  assert.equal(await text(page.locator("#adminTitle")), "Home WISP routers.");
  assert.equal(await text(page.locator("#wispLast")), "Not reconciled yet (runs every 5 minutes and after any router restart or failed change).");
  assert.deepEqual(await page.locator(".admin-wisp__metric").evaluateAll((cards) => cards.map((c) => c.innerText.replace(/\s+/g, " ").trim())),
    ["3 registered routers", "2 sharing now", "1 sharing withheld", "0 stale exceptions found"]);
  const rows = await page.locator("#wispRouters tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.cells].slice(0, 5).map((td) => td.innerText.replace(/\s+/g, " ").trim())));
  assert.deepEqual(rows.map((r) => [r[0], r[2], r[3], r[4].split(" ")[0]]), [
    ["J. Fon", "••:••:••:7E:10:2B", "Online", "Sharing"],
    ["P. Mbah", "••:••:••:12:6C:D8", "Online", "Withheld"],
    ["S. Tabe", "••:••:••:B3:51:07", "Offline", "Sharing"],
  ]);
  assert.match(rows[1][4], /Couldn't verify — retrying/);
  assert.match(rows[2][4], /^Sharing \(idle\) Applies when the router reconnects$/);
  assert.equal(await page.locator("#homePilotImport, #checkHomeReadiness").count(), 0, "no pilot tools (owner)");
  assert.match(await text(page.locator("#wispRule")), /^Sharing is allowed only when a signed-in session matches an active Home WISP subscription and its registered router\./);
  assert.deepEqual(await lowContrastText(page), []);

  // Reconcile now with Home off says so (with Home on it runs: test/home-reconcile.test.mjs).
  await page.getByRole("button", { name: "Reconcile now", exact: true }).click();
  await page.locator("#wispLast").getByText("Home WISP is off, so there's nothing to reconcile yet.", { exact: true }).waitFor();

  // Revoke: a reason, then the router's removal is queued and audited.
  await page.locator('[data-wisp-revoke="c-fon"]').click();
  const dialog = page.getByRole("dialog", { name: "Revoke J. Fon's router?" });
  await dialog.getByLabel("Reason (kept in the audit log)").fill("Customer asked to stop sharing");
  await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.locator("#wispMessage").getByText("J. Fon's router is being disconnected; sharing is removed once the router confirms.", { exact: true }).waitFor();
  const s = await store.snapshot();
  assert.ok(s.homeOperations.some((o) => o.customerId === "c-fon" && o.kind === "revoke"));
  assert.ok(s.auditLogs.some((a) => a.action === "home.admin.operation" && a.meta.customerId === "c-fon" && a.meta.operation === "revoke"));
  assert.deepEqual(errors, []);
  await context.close();

  // French.
  const fr = await open("fr");
  assert.equal(await text(fr.page.locator("#adminTitle")), "Routeurs Home WISP.");
  assert.equal(await text(fr.page.locator("#reconcileNow")), "Réconcilier maintenant");
  assert.deepEqual(fr.errors, []);
  await fr.context.close();
});
