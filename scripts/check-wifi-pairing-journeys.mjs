import assert from "node:assert/strict";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createStaticServer } from "../static-server.mjs";
import { pairingFixture, publicRoot, ownerRoot, guestMac } from "../test/helpers/wifi-pairing-fixture.mjs";

const website = http.createServer();
await new Promise((r) => website.listen(0, "127.0.0.1", r));
const portal = `http://127.0.0.1:${website.address().port}`;
const hostileName = '<img src=x onerror="alert(1)">';
const f = await pairingFixture({ origin: portal, now: new Date(), liveClock: true, router: {
  async readGuestDevice({ mac, address }) { return { mac, address, loginAddress: address, hostId: "*guest-" + mac.slice(-2), server: "ndahi-hotspot", name: mac === guestMac ? "Galaxy Note 8" : hostileName }; },
} });
const staticServer = createStaticServer("customer", { apiUrl: f.api, hotspotLoginUrl: "https://connect.hotspot.test/login" });
website.on("request", (req, res) => staticServer.emit("request", req, res));
const screenshots = "/tmp/ndahi-pairing-checks", errors = [];
let browser;
try {
  await mkdir(screenshots, { recursive: true });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  const contexts = [];
  async function context({ owner = false, blockedStorage = false } = {}) {
    const c = await browser.newContext({ viewport: { width: 320, height: 900 } }); contexts.push(c);
    await c.route("**/*", (route) => {
      if (![f.api, portal].includes(new URL(route.request().url()).origin)) return route.abort("blockedbyclient");
      return route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } });
    });
    if (owner) await c.addCookies([
      { name: "customer_session", value: "main", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" },
      { name: "ndahi_main_device", value: "controller", domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" },
    ]);
    if (blockedStorage) await c.addInitScript(() => {
      for (const key of ["localStorage", "sessionStorage"]) Object.defineProperty(window, key, { get() { throw new DOMException("Storage denied", "SecurityError"); } });
      Object.defineProperty(AbortSignal, "timeout", { value: undefined });
    });
    const page = await c.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", (e) => errors.push(e.message));
    return { c, page };
  }
  const { page: owner } = await context({ owner: true }), { c: guestContext, page: guest } = await context({ blockedStorage: true });
  await owner.goto(portal + "/dashboard");
  await owner.getByText("This browser controls connection approvals.", { exact: false }).waitFor();
  const pairUrl = portal + "/pair?mac=" + encodeURIComponent(guestMac) + "&address=10.20.0.30";
  await guest.goto(pairUrl.replace("/pair?", "/onboarding.html?"));
  await guest.getByRole("link", { name: "Connect using your main device", exact: true }).click();
  await guest.getByLabel("Account phone number", { exact: true }).fill("670050001");
  await guest.getByLabel("Active voucher code", { exact: true }).fill("NC-AAAA-1111");
  // The API commits, then the reply is lost. Retrying must keep the same request.
  await guest.route("**/api/wifi/pairing/request", async (route) => { await route.fetch({ headers: { ...route.request().headers(), "cf-connecting-ip": "203.0.113.10" } }); await route.abort("failed"); }, { times: 1 });
  await guest.getByRole("button", { name: "Request access", exact: true }).click();
  await guest.locator("#pairingMessage").filter({ hasText: /network|reach|fetch|connection/i }).waitFor();
  await guest.reload();
  await guest.getByLabel("Account phone number", { exact: true }).fill("670050001");
  await guest.getByLabel("Active voucher code", { exact: true }).fill("NC-AAAA-1111");
  await guest.getByRole("button", { name: "Request access", exact: true }).click();
  await guest.locator("#pairingStatus").filter({ hasText: "waiting for the main device" }).waitFor().catch(async (e) => {
    console.error(await guest.locator("#pairingMessage").textContent()); throw e;
  });
  assert.equal(await guest.locator("#pairingCode").count(), 0);
  assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 1);
  await guest.reload();
  await guest.locator("#pairingStatus").filter({ hasText: "waiting for the main device" }).waitFor();
  assert.equal(new URL(guest.url()).search, ""); assert.doesNotMatch(guest.url(), /670050001|NC-AAAA/);
  assert.equal((await guestContext.cookies()).some((c) => c.name === "customer_session"), false);
  console.log("PASS lost-response retry and reload preserve one request with storage and AbortSignal.timeout unavailable");
  await owner.getByRole("button", { name: "Refresh requests", exact: true }).click();
  const row = owner.locator("[data-request]").first();
  await row.getByText("Galaxy Note 8 · ending EE:03", { exact: true }).waitFor();
  await row.getByRole("button", { name: "Approve & show code", exact: true }).click();
  const displayed = await row.getByLabel("Approval code", { exact: true }).textContent();
  assert.match(displayed, /^\d{6}$/);
  assert.equal(f.calls.length, 0, "main approval alone must not connect the guest");
  await guest.getByLabel("Approval code from your main device").fill(displayed);
  await guest.getByRole("button", { name: "Enter code and connect", exact: true }).click();
  await row.getByText("Connecting — waiting for the router", { exact: true }).waitFor();
  assert.equal(f.calls.length, 0);
  await f.process();
  await guest.locator("#pairingStatus").filter({ hasText: "Connected — internet access was confirmed" }).waitFor();
  await row.getByText("Connected — confirmed by the router", { exact: true }).waitFor();
  assert.equal(f.calls.length, 1); assert.equal(new URL(guest.url()).hash, "");
  const denied = await guest.request.get(f.api + "/api/account/dashboard", { headers: { origin: portal } }); assert.equal(denied.status(), 401);
  for (const page of [owner, guest]) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await guest.screenshot({ path: screenshots + "/guest-connected-320.png", fullPage: true });
  await owner.screenshot({ path: screenshots + "/main-approval-320.png", fullPage: true });
  console.log("PASS two independent browsers approve Wi-Fi access without granting the guest an account session");

  await f.store.transaction((s) => { s.vouchers[0].deviceLimit = 5; });
  const { page: expired } = await context();
  await expired.goto(portal + "/pair?mac=AA%3ABB%3ACC%3ADD%3AEE%3A04&address=10.20.0.40");
  await expired.getByLabel("Account phone number", { exact: true }).fill("670050001");
  await expired.getByLabel("Active voucher code", { exact: true }).fill("NC-AAAA-1111");
  await expired.getByRole("button", { name: "Request access", exact: true }).click();
  await expired.locator("#pairingStatus").filter({ hasText: "waiting for the main device" }).waitFor();
  f.advance(301);
  await expired.locator("#pairingStatus").filter({ hasText: "expired" }).waitFor();
  assert.equal(await expired.locator("#pairingRedeem").isHidden(), true);
  await expired.getByRole("button", { name: "Request access again", exact: true }).waitFor();
  await owner.getByRole("button", { name: "Refresh requests", exact: true }).click();
  await owner.locator("[data-request]").filter({ hasText: "ending EE:04" }).getByText("Expired", { exact: true }).waitFor();
  assert.equal(await owner.locator("[data-request] img").count(), 0);
  await owner.getByRole("heading", { name: hostileName + " · ending EE:04", exact: true }).waitFor();
  await expired.getByRole("button", { name: "Request access again", exact: true }).click();
  await expired.getByLabel("Account phone number", { exact: true }).fill("670050001");
  await expired.getByLabel("Active voucher code", { exact: true }).fill("NC-AAAA-1111");
  await expired.getByRole("button", { name: "Request access", exact: true }).click();
  await expired.locator("#pairingStatus").filter({ hasText: "waiting for the main device" }).waitFor();
  await owner.getByRole("button", { name: "Refresh requests", exact: true }).click();
  await owner.locator("[data-request]").filter({ has: owner.locator("[data-pairing-approval]") }).getByRole("button", { name: "Decline", exact: true }).click();
  await expired.locator("#pairingStatus").filter({ hasText: "declined" }).waitFor();
  assert.equal(f.calls.length, 1); assert.deepEqual(errors, []);
  console.log("PASS expiry and decline cannot connect; announced names render safely and both screens fit at 320px");
  for (const c of contexts) await c.close();
} finally {
  await browser?.close(); await f.close();
  await new Promise((r) => { website.close(r); website.closeAllConnections(); });
}
