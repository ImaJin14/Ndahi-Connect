import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Insights (AdminInsights, #382; owner decisions 25 Nov), owners only: the four
// figures with their change, revenue per day (weekly bars for 90 days), the
// busiest hours, access-point load "Not measured yet" with Starlink at peak,
// and Wi-Fi page → paid with the computed note. Charts carry text
// alternatives; nothing breaks the page's CSP. 1280 and 390 px, French.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const DAY = 864e5, OFFSET = 36e5;

test("owners see Insights drawn from the API; other staff don't", { timeout: 300000 }, async (t) => {
  const secret = "redesign-insights", store = createStore({ persistent: false }), now = Date.now();
  const today = Math.floor((now + OFFSET) / DAY) * DAY - OFFSET, iso = (ms) => new Date(ms).toISOString();
  await store.transaction((s) => {
    for (const role of ["owner", "operator"]) {
      s.adminUsers.push({ id: `u-${role}`, username: role, displayName: role, role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: `u-${role}`, role, tokenHash: hashSecret(`${role}-token`, secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    let n = 0;
    for (let d = 0; d < 60; d++) for (let k = 0; k < (d % 7 === 2 ? 6 : 3); k++) {
      const at = iso(today - d * DAY + 10 * OFFSET);
      s.payments.push({ id: `p${n}`, provider: "mesomb", providerReference: `r${n++}`, currency: "XAF", status: "paid", amount: 1000, planId: "day", customerId: `c${(d * 3 + k) % (d < 30 ? 40 : 25)}`, createdAt: at, confirmedAt: at });
    }
    s.insightCounters = Array.from({ length: 24 }, (_, hour) => ({ id: `devices:t${hour}`, type: "devices_hourly", at: iso(today - DAY + hour * OFFSET), hour, samples: 2, total: (hour >= 19 && hour < 22 ? 60 : 10) * 2, peak: 60 }));
    for (const hour of [19, 20, 21]) s.insightCounters.push({ id: `uplink:t${hour}`, type: "uplink_hourly", at: iso(today - DAY + hour * OFFSET), hour, peakMbps: 46, pingMs: 30 });
    s.insightCounters.push({ id: "funnel:t:v1", type: "funnel_daily", at: iso(today - 2 * DAY), variant: "v1", steps: { wifi_page: 900, signed_in: 522, payment_started: 306, paid: 198 } },
      { id: "funnel:t:v2", type: "funnel_daily", at: iso(today - 2 * DAY), variant: "v2", steps: { wifi_page: 100, signed_in: 63, payment_started: 39, paid: 28 } });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "standalone",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(adminServer); });
  const screenshots = process.env.POLISH_SCREENSHOTS || "/tmp/ndahi-admin-insights";
  await mkdir(screenshots, { recursive: true });
  const open = async (role, width, lang = "en") => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1200 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: `${role}-token`, url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }, { name: "ndahi_ui", value: "v2", url: admin, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => {
      try { localStorage.setItem("ndahi-language", "fr"); } catch {}
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Console errors catch CSP refusals; requests this test blocks are not errors.
    page.on("console", (message) => { if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/.test(message.text())) errors.push(message.text()); });
    return { context, page, errors };
  };

  for (const width of [1280, 390]) {
    const { context, page, errors } = await open("owner", width);
    await page.goto(`${admin}/dashboard#home`);
    await page.getByRole("link", { name: "Insights", exact: true }).click();
    await page.getByRole("heading", { name: "Insights.", exact: true }).waitFor();
    const bars = page.locator(".admin-insights__bar");
    await bars.first().waitFor();
    assert.equal(await bars.count(), 30);
    assert.equal(await page.locator('#insightsPeriods [aria-pressed="true"]').innerText(), "30 days");
    const metrics = await page.locator(".admin-insights__metric").evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()));
    assert.match(metrics[0], /^[\d\s ,.]+FCFA Revenue · [▲▼] (up|down) \d+% vs previous$/);
    assert.match(metrics[1], /^\d+ Bundles sold · [▲▼] (up|down) \d+%$/);
    assert.match(metrics[2], /^\d+ Paying customers · [▲▼] (up|down) \d+%$/);
    assert.equal(metrics[3], "— Bought again within 2 days");
    // Text alternatives and the computed lines.
    assert.match(await page.locator(".admin-insights__bars").getAttribute("aria-label"), /^Bar chart of revenue, last 30 days: .+ in all; the tallest bar is .+$/);
    assert.equal(await page.locator(".admin-insights__heat").getAttribute("aria-label"), "Heat strip of devices online by hour; darkest from 19:00 to 22:00.");
    await page.getByText("Devices online, average by hour. Peak 19:00–22:00.", { exact: true }).waitFor();
    await page.getByText("Not measured yet: the access points run standalone, so their load isn't recorded.", { exact: true }).waitFor();
    await page.getByText("Starlink at peak: 46 Mbps in use.", { exact: true }).waitFor();
    assert.equal(await page.locator(".admin-insights__fnote").innerText(), "New design: +6 pts paid. Biggest gain is at payment started → paid. 10% of visitors are on the new design.");
    // Styles go through the DOM, never style attributes (CSP).
    assert.notEqual(await bars.first().evaluate((el) => el.style.height), "");
    if (width === 1280) {
      await page.screenshot({ path: `${screenshots}/insights-30-${width}.png`, fullPage: true });
      await page.getByRole("button", { name: "7 days", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".admin-insights__bar").length === 7);
      await page.getByRole("button", { name: "90 days", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".admin-insights__bar").length === 13);
      await page.getByText("Bundles and store, last 90 days (weekly bars).", { exact: false }).waitFor();
    }
    assert.deepEqual(await lowContrastText(page), [], `contrast ${width}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow ${width}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Operators have no Insights: no menu item, and the address lands on Home.
  {
    const { context, page, errors } = await open("operator", 1280);
    await page.goto(`${admin}/dashboard#insights`);
    await page.locator('[data-admin-nav="home"][aria-current="page"]').waitFor();
    assert.equal(await page.locator('[data-admin-nav="insights"]').count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    const { context, page, errors } = await open("owner", 1280, "fr");
    await page.goto(`${admin}/dashboard#insights`);
    await page.getByRole("heading", { name: "Statistiques.", exact: true }).waitFor();
    await page.locator(".admin-insights__bar").first().waitFor();
    assert.equal(await page.locator("#insightsRevenueTitle").innerText(), "Revenus par jour");
    await page.screenshot({ path: `${screenshots}/insights-fr.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  }
});
