import assert from "node:assert/strict";
import test from "node:test";
import { createStaticServer } from "../../static-server.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Help as drawn (#361, canvas PhoneHelp; owner 27 Nov): five questions, the
// connection check answering in three rows, Call and WhatsApp. Answers other
// pages link to stay hidden until the address points at them. The API is
// answered here; connectivityState's private-address answer is unit-tested.

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
const API = "https://api.help.test";
const text = async (locator) => (await locator.evaluate((el) => el.innerText)).replace(/\s+/g, " ").trim();

test("Help reads as drawn: five questions, the three-row check, Call and WhatsApp; linked answers open on demand", { timeout: 180000 }, async (t) => {
  const site = await listen(createStaticServer("customer", { apiUrl: API, supportPhone: "+237 670 123 456", env: { NODE_ENV: "test", CUSTOMER_UI_DEFAULT: "v2" } }));
  const portal = `http://127.0.0.1:${site.address().port}`;
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await new Promise((r) => { site.close(r); site.closeAllConnections(); }); });
  let answers = {};
  const open = async ({ path = "/help", lang = "en" } = {}) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url()), cors = { "access-control-allow-origin": portal, "access-control-allow-credentials": "true" };
      if (u.origin === API) return answers[u.pathname] ? route.fulfill({ headers: cors, json: answers[u.pathname] }) : route.fulfill({ status: 401, headers: cors, json: { error: "Sign in." } });
      return u.origin === portal ? route.continue() : route.abort("blockedbyclient");
    });
    if (lang === "fr") await context.addInitScript(() => { try { localStorage.setItem("ndahi-lang", "fr"); } catch {} });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(portal + path);
    await page.locator("#runCheck").waitFor();
    return { page, errors };
  };

  // Signed in on NDAHI Wi-Fi, a running Personal Unlimited bundle, a private address.
  const ends = new Date(Date.now() + 62 * 36e5 + 180e3).toISOString();
  answers = {
    "/api/account/connectivity": { version: 1, account: { state: "authenticated" }, network: { state: "confirmed" }, subscription: { state: "active" }, device: { privateAddress: true } },
    "/api/account/bundle-status": { version: 1, bundle: { status: "active", accessType: "personal_unlimited", expiresAt: ends } },
    "/api/store/catalogue": { settings: { pickup: "NDAHI Akwa, rue Joss." } },
  };
  let { page, errors } = await open();
  assert.equal(await page.locator("h1").textContent(), "Answers for your connection.");
  assert.deepEqual(await page.locator("details:visible summary").allInnerTexts(), ["My payment went through but I'm not online", "Can I use my bundle on my laptop too?",
    "Can I buy a new bundle before mine ends?", "Can I share my bundle through my phone's hotspot?", "How do I collect a shop order?"]);
  assert.equal(await page.locator("#checkResults").isVisible(), false, "no rows before the check runs");
  assert.equal(await page.locator(".portal-faq__contact").first().getAttribute("href"), "tel:+237670123456");
  assert.equal(await text(page.locator(".portal-faq__contact").first()), "Call +237 670 123 456");
  assert.match(await page.getByRole("link", { name: "WhatsApp", exact: true }).getAttribute("href"), /^https:\/\/wa\.me\/237670123456\?text=/);
  await page.getByText("How do I collect a shop order?").click();
  await page.locator("#orderAnswer", { hasText: "NDAHI Akwa, rue Joss" }).waitFor();
  assert.equal(await page.locator("#orderAnswer").textContent(), "Bring your order code to NDAHI Akwa, rue Joss. Staff check it before handing over the device.");
  await page.getByRole("button", { name: "Run check" }).click();
  await page.locator("#checkResults:not([hidden])").waitFor();
  assert.deepEqual(await page.locator("#checkResults li").allInnerTexts(), ["Joined NDAHI Wi-Fi", "Bundle active — 2 days 14 h left", "Private Wi-Fi address is on — turn it off for NDAHI"]);
  assert.deepEqual(await page.locator("#checkResults li span").evaluateAll((dots) => dots.map((d) => getComputedStyle(d).backgroundColor)), ["rgb(111, 149, 0)", "rgb(111, 149, 0)", "rgb(214, 150, 15)"]);
  assert.equal(await page.locator("#runCheck").textContent(), "Run again");
  assert.deepEqual(await lowContrastText(page), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);

  // Signed out, off NDAHI Wi-Fi: the rows say so, and nothing about the device.
  answers = { "/api/account/connectivity": { version: 1, account: { state: "signed-out" }, network: { state: "unconfirmed" }, subscription: { state: "unknown" }, device: { privateAddress: null } } };
  ({ page } = await open());
  await page.getByRole("button", { name: "Run check" }).click();
  await page.locator("#checkResults:not([hidden])").waitFor();
  assert.deepEqual(await page.locator("#checkResults li").allInnerTexts(), ["Not on NDAHI Wi-Fi — join it to use your bundle", "Sign in to check your bundle"]);
  assert.equal(await page.locator("#orderAnswer").textContent(), "Bring your order code to the pickup point shown on your order. Staff check it before handing over the device.");

  // Answers other pages link to open on demand, and only then.
  for (const [id, question] of [["recovery", "I forgot my PIN or no longer have my old number."], ["scan-qr", "How do I connect by scanning a voucher QR?"], ["connect", "How do I connect to NDAHI Wi-Fi?"]]) {
    ({ page } = await open({ path: "/help#" + id }));
    const answer = page.locator(`details#${id}`);
    await answer.waitFor();
    assert.equal(await answer.evaluate((el) => el.open), true, id);
    assert.equal(await text(answer.locator("summary")), question);
    assert.equal(await page.locator("details:visible").count(), 6, id + ": the drawn five and the linked one");
  }
  ({ page } = await open({ path: "/help#payment" }));
  assert.equal(await page.locator("details#payment").evaluate((el) => el.open), true);

  // French.
  ({ page, errors } = await open({ lang: "fr" }));
  await page.locator("html[lang=fr]").waitFor();
  assert.equal(await page.locator("h1").textContent(), "Des réponses pour votre connexion.");
  assert.equal(await page.locator("#runCheck").textContent(), "Lancer la vérification");
  assert.equal(await page.locator("#supportTitle").textContent(), "Toujours besoin d’aide ?");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});
