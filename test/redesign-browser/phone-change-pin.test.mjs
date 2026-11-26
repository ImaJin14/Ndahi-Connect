import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import argon2 from "argon2";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Change PIN (canvas: PhoneChangePin, #396; owner 26 Nov): Current PIN, New
// PIN, "Type the new PIN again", "4 to 6 digits. Other devices stay signed in
// unless you sign them out.", and Save new PIN at the foot. Saving shows "PIN
// updated…" with "Sign out other devices too →", and the customer's other
// devices stay signed in. Local servers only, synthetic data.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

test("Change PIN is drawn as the board and keeps the other devices signed in", { timeout: 120000 }, async (t) => {
  const secret = "redesign-change-pin", store = createStore({ persistent: false });
  await store.transaction(async (s) => {
    s.customers.push({ id: "amina", name: "Amina Nfor", phone: "670001245", email: "amina@example.test", pinHash: await argon2.hash("2468"), passkeys: [] });
    for (const id of ["amina", "laptop"]) s.dashboardSessions.push({ id, customerId: "amina", tokenHash: hashSecret(id, secret), csrfToken: "csrf-" + id, expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); });
  const screenshots = process.env.PHONE_CHANGE_PIN_SCREENSHOTS || "/tmp/ndahi-phone-change-pin";
  await mkdir(screenshots, { recursive: true });
  const open = async (lang = "en") => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "customer_session", value: "amina", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(portal + "/dashboard#pin");
    await page.locator("#changePin").waitFor();
    return { page, errors, context };
  };
  const field = (page, name) => page.locator(`#changePin [name="${name}"]`);
  const fill = async (page, current, next, again = next) => { await field(page, "currentPin").fill(current); await field(page, "newPin").fill(next); await field(page, "confirmPin").fill(again); };
  const save = (page) => page.getByRole("button", { name: "Save new PIN", exact: true });

  const { page, errors, context } = await open();
  assert.equal(await page.locator("#portalSubTitle").innerText(), "Change PIN");
  assert.deepEqual(await page.locator("#changePin label").evaluateAll((nodes) => nodes.map((n) => n.firstChild.textContent)), ["Current PIN", "New PIN", "Type the new PIN again"]);
  assert.equal(await page.locator(".change-pin__hint").innerText(), "4 to 6 digits. Other devices stay signed in unless you sign them out.");
  assert.equal(await page.getByRole("button", { name: /passkey/i }).count(), 0, "a PIN holder confirms with the current PIN only");
  assert.equal(await page.locator(".change-pin__done").isVisible(), false);
  // Save new PIN 22px in and 20px up.
  assert.deepEqual(await save(page).evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(innerWidth - r.right), Math.round(innerHeight - r.bottom), Math.round(r.height)]; }), [22, 22, 20, 52]);
  assert.deepEqual(await lowContrastText(page), []);
  await page.screenshot({ path: `${screenshots}/form.png` });

  // The two new PINs must match; a wrong current PIN changes nothing.
  await fill(page, "2468", "135790", "135791");
  await save(page).click();
  assert.equal(await field(page, "confirmPin").evaluate((el) => el.validationMessage), "The two new PINs don't match.");
  await fill(page, "1111", "135790");
  await save(page).click();
  await page.locator("#changePin [data-proof-message]:not(:empty)").waitFor();
  assert.equal(await argon2.verify((await store.snapshot()).customers[0].pinHash, "2468"), true);

  // Saved: the note and the way to sign the other devices out; they stay signed in.
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await fill(page, "2468", "135790");
  await save(page).click();
  await page.locator(".change-pin__done:not([hidden])").waitFor();
  assert.equal(await page.locator(".change-pin__done [role=status]").innerText(), "PIN updated. Use it next time you sign in.");
  const link = page.getByRole("link", { name: "Sign out other devices too →", exact: true });
  assert.equal(await link.getAttribute("href"), "/dashboard#sessions");
  assert.equal(await field(page, "newPin").inputValue(), "", "the PINs are not kept on screen");
  const state = await store.snapshot();
  assert.equal(await argon2.verify(state.customers[0].pinHash, "135790"), true);
  assert.deepEqual(state.dashboardSessions.map((x) => x.id).sort(), ["amina", "laptop"]);
  assert.deepEqual(await lowContrastText(page), []);
  await page.screenshot({ path: `${screenshots}/saved.png` });
  await link.click();
  await page.waitForURL(/#sessions$/);
  assert.deepEqual(errors, []);
  await context.close();

  // French.
  const fr = await open("fr");
  assert.deepEqual(await fr.page.locator("#changePin label").evaluateAll((nodes) => nodes.map((n) => n.firstChild.textContent)), ["Code PIN actuel", "Nouveau code PIN", "Retapez le nouveau code PIN"]);
  assert.equal(await fr.page.getByRole("button", { name: "Enregistrer le nouveau PIN", exact: true }).count(), 1);
  assert.deepEqual(fr.errors, []);
  await fr.context.close();
});
