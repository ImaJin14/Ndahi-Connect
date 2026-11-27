import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createStaticServer } from "../../static-server.mjs";
import { pairingFixture } from "../helpers/wifi-pairing-fixture.mjs";
import { ensureHome, reserveHomeLink } from "../../lib/home.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Home WISP router (#351, canvas PhoneHomeRouter; owner 27 Nov). The router's
// own answers (the local sign-in, what it reports) are proved on-site
// (docs/operations/home-wisp-test-plan.md), so the test answers enroll, detect
// and confirm; the page's states come from the real Home API.

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();
const LOGIN = "https://connect.home.test/login";

test("the Home WISP router page: register, Router found, sharing, paused, replacing; earlier NDAHI Home keeps its page", { timeout: 240000 }, async (t) => {
  const website = await listen(http.createServer()), portal = `http://127.0.0.1:${website.address().port}`;
  const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, env: { NETWORK_QUEUE_ENABLED: "false", NDAHI_HOME_ENABLED: "true" } });
  const seed = (state) => f.store.transaction((s) => {
    ensureHome(s);
    s.vouchers = s.vouchers.filter((v) => v.customerId !== "c1");
    s.homeConnections = []; s.homeOperations = []; s.homeChallenges = []; delete s.customers.find((c) => c.id === "c1").homeConnectionId;
    const v = { id: "hw", customerId: "c1", planId: "home-wisp-30d", code: "NC-HOME-0001", status: "available", quotaBytes: null, usedBytes: 0, deviceLimit: 1, accessType: "home_wisp_unlimited",
      deviceSlots: 1, startsOnFirstConnection: true, validityHours: 720, createdAt: new Date().toISOString(), routerSyncStatus: "synchronized" };
    if (state === "legacy") { s.vouchers.push({ id: "old", customerId: "c1", status: "active", accessMode: "home", quotaBytes: 5e10, usedBytes: 0, activatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 864e5).toISOString() }); return; }
    s.vouchers.unshift(v);
    if (state !== "waiting") {
      s.homeChallenges.push({ id: "ch", customerId: "c1", sessionId: "main", status: "ready", expiresAt: new Date(Date.now() + 120000).toISOString(), routerRevision: s.networkSetup.connections.router.revision });
      reserveHomeLink(s, "c1", { challengeId: "ch", mac: "AA:BB:CC:9C:31:E4", address: "10.20.0.9", hostId: "*h", sessionId: "*s" }, "ch", "Home router", new Date());
      Object.assign(v, { status: "active", activatedAt: new Date().toISOString(), expiresAt: "2026-12-22T17:03:00.000Z", accessMode: "home", homeStatus: state === "paused" ? "activation_pending" : "connected" });
      if (state === "paused") s.homeOperations.push({ id: "op1", customerId: "c1", kind: "refresh", status: "retry", attempts: 2, lastAttemptAt: new Date(Date.now() - 120000).toISOString(), nextAttemptAt: new Date(Date.now() + 8000).toISOString() });
    }
  });
  const assets = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: LOGIN, env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } });
  website.on("request", (req, res) => assets.emit("request", req, res));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await f.close(); await new Promise((r) => { website.close(r); website.closeAllConnections(); }); });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const cors = { "access-control-allow-origin": portal, "access-control-allow-credentials": "true" }, asked = [];
  await context.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.href.startsWith(LOGIN)) { const form = new URLSearchParams(route.request().postData()); asked.push("login"); return route.fulfill({ status: 302, headers: { location: form.get("dst") } }); }
    if (u.pathname.endsWith("/api/account/home/enroll")) { asked.push("enroll"); return route.fulfill({ status: 201, headers: cors, json: { enrollmentId: "e1", login: { url: LOGIN, username: "he_x", password: "secret" } } }); }
    if (u.pathname.endsWith("/api/account/home/detect")) { asked.push("detect:" + route.request().postDataJSON().enrollmentId); return route.fulfill({ headers: cors, json: { router: { identifierTail: "9C:31:E4", seenAt: new Date().toISOString(), place: "AP-Market" } } }); }
    if (u.pathname.endsWith("/api/account/home/confirm")) { const body = route.request().postDataJSON(); asked.push("confirm:" + [body.enrollmentId, body.confirm, body.pin].join("/")); await seed("sharing"); return route.fulfill({ status: 202, headers: cors, json: { link: { status: "linked" } } }); }
    if (![portal, f.api].includes(u.origin)) return route.abort("blockedbyclient");
    return route.continue(u.origin === f.api ? { headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } } : {});
  });
  await context.addCookies([{ name: "customer_session", value: "main", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // Waiting for its router: the three steps; no end date yet (owner).
  await seed("waiting");
  await page.goto(portal + "/home-router.html");
  await page.locator(".home-wisp__steps").waitFor();
  assert.equal(await text(page.getByRole("heading", { level: 1 })), "Register your home router");
  assert.deepEqual(await page.locator(".home-wisp__steps li").allInnerTexts(), ["1\nSet your router to connect to NDAHI Wi-Fi (WISP or client mode). How?", "2\nConnect this phone to your router's Wi-Fi.", "3\nOpen portal.ndahiconnect.net and sign in. NDAHI Wi-Fi sees your router and we show it here."]);
  assert.equal(await page.locator(".home-wisp__ends").count(), 0);
  assert.doesNotMatch(await page.locator("body").innerText(), /60|household devices/i, "no device or router count");
  assert.deepEqual(await lowContrastText(page), []);

  // Find my router: the local sign-in through it, then Router found and Register with the PIN.
  await page.getByRole("button", { name: "I've done this — find my router" }).click();
  await page.locator(".home-wisp__found").waitFor();
  assert.deepEqual(asked.slice(0, 3), ["enroll", "login", "detect:e1"]);
  assert.equal(await text(page.locator(".home-wisp__found")), "Router reaching NDAHI Wi-Fi Upstream address ••:••:••:9C:31:E4 Seen just now · AP-Market");
  await page.getByLabel("Confirm with your PIN").fill("2468");
  await page.getByRole("button", { name: "Register this router" }).click();
  await page.locator(".home-wisp__status").waitFor();
  assert.ok(asked.includes("confirm:e1/true/2468"));
  assert.equal(new URL(page.url()).searchParams.has("enrollment"), false);

  // Sharing: the status card; Replace opens the explanation and the find step (owner).
  assert.equal(await text(page.locator(".home-wisp__status")), "REGISTERED ROUTER Online Sharing with your household Router ••:9C:31:E4 Subscription " + await page.locator(".home-wisp__row:last-child span:last-child").innerText());
  assert.match(await page.locator(".home-wisp__ends").innerText(), /^Ends \d{1,2} [A-Z][a-z]{2}$/);
  await page.getByRole("button", { name: "Replace this router" }).click();
  assert.match(await text(page.locator(".home-wisp__tip")), /^To use a new router: set it up the same way and sign in through it\./);
  assert.equal(await page.getByRole("button", { name: "I've done this — find my router" }).isVisible(), true);
  await page.getByRole("button", { name: "Keep this router" }).click();
  assert.equal(await page.locator(".home-wisp__tip").count(), 0);

  // Paused: the entitlement can't be confirmed; retrying, don't pay again.
  await seed("paused");
  await page.reload();
  await page.locator(".home-wisp__alert").waitFor();
  assert.equal(await text(page.locator(".home-wisp__pill")), "Checking");
  assert.equal(await text(page.locator(".home-wisp__alert")), "Sharing is paused. We couldn't confirm your subscription with NDAHI Wi-Fi, so devices behind your router can't get online right now. We keep retrying automatically — last try 2 min ago. You don't need to pay again.");
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  // An earlier NDAHI Home bundle keeps today's page.
  await seed("legacy");
  await page.reload();
  await page.locator("#homeStatus").waitFor();
  assert.equal(await page.locator(".home-wisp").count(), 0);
  assert.deepEqual(errors, []);
});
