import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import argon2 from "argon2";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { emailConfirmationLinkToken } from "../../lib/transactional-email.mjs";

// Edit profile (canvas: PhoneEditProfile, #398; owner 26 Nov): name and email,
// the sign-in number read-only and masked with "contact support", and "Save
// changes" at the bottom. A name change saves at once; an email change asks
// for the PIN in a dialog after Save, then shows "Saved. Check … to confirm
// it." The link opens a page that confirms on a tap, once. Local servers
// only, synthetic customer, every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

test("Edit profile keeps the number read-only and asks for the PIN only for a new email, confirmed by its link", { timeout: 120000 }, async (t) => {
  const secret = "redesign-edit-profile", store = createStore({ persistent: false });
  const pinHash = await argon2.hash("2468");
  await store.transaction((s) => {
    s.customers.push({ id: "amina", name: "Amina Nfor", phone: "670001245", email: "amina@example.test", pinHash });
    s.dashboardSessions.push({ id: "sess", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
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
  const screenshots = process.env.PHONE_EDIT_PROFILE_SCREENSHOTS || "/tmp/ndahi-phone-edit-profile";
  await mkdir(screenshots, { recursive: true });

  const open = async (path, { width = 390, lang = "en", signedIn = true } = {}) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, locale: lang === "fr" ? "fr-FR" : "en-GB" });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    if (signedIn) await context.addCookies([{ name: "customer_session", value: "amina", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(portal + path);
    return { page, errors, context };
  };
  const customer = async () => (await store.snapshot()).customers.find((c) => c.id === "amina");

  // The drawn screen: no number field to edit and no PIN field in the form.
  const { page, errors, context } = await open("/dashboard#editProfile");
  const form = page.locator("#profileEdit");
  await form.locator('input[name="name"]').waitFor({ state: "visible" });
  assert.equal(await form.locator('input[name="name"]').inputValue(), "Amina Nfor");
  assert.equal(await form.locator('input[name="email"]').inputValue(), "amina@example.test");
  const phone = page.locator("#profilePhone");
  assert.equal(await phone.inputValue(), "+237 6•• •• 12 45");
  assert.equal(await phone.getAttribute("readonly"), "");
  assert.equal(await form.locator('input[name="phone"], input[name="pin"]').count(), 0, "no number to edit and no PIN in the form");
  assert.equal(await page.locator("#profilePhoneHint").innerText(), "This is how you sign in. To change it, contact support.");
  assert.equal(await page.locator("#profilePhoneHint a").getAttribute("href"), "/help#support");
  assert.equal(await page.locator("#profileEmailHint").innerText(), "Needed to reset your PIN and receive receipts. We send a link to confirm a new address.");
  const save = form.locator('button[type="submit"]');
  assert.equal(await save.innerText(), "Save changes");
  // Sticky at the bottom, 22px in and 20px up (canvas).
  assert.deepEqual(await save.evaluate((node) => { const box = node.getBoundingClientRect(); return [box.left, innerWidth - box.right, innerHeight - box.bottom, box.height]; }), [22, 22, 20, 52]);
  await page.screenshot({ path: `${screenshots}/edit-profile.png` });

  // A name change saves at once.
  await form.locator('input[name="name"]').fill("Amina Ndi");
  await save.click();
  await page.locator("#profileEditMessage", { hasText: "Saved." }).waitFor();
  assert.equal(await page.locator("#profilePinDialog").evaluate((node) => node.open), false);
  assert.equal((await customer()).name, "Amina Ndi");

  // An email change asks for the PIN after Save; Cancel changes nothing.
  const dialog = page.locator("#profilePinDialog");
  await form.locator('input[name="email"]').fill("amina.new@example.test");
  await save.click();
  await dialog.waitFor({ state: "visible" });
  assert.match(await page.locator("#profilePinLede").innerText(), /amina\.new@example\.test/);
  await page.screenshot({ path: `${screenshots}/edit-profile-pin.png` });
  await page.locator("#profilePinCancel").click();
  assert.equal(await dialog.evaluate((node) => node.open), false);
  assert.equal((await customer()).pendingEmail, undefined);
  // A wrong PIN keeps the dialog open with the reason; the right one saves.
  await save.click();
  await dialog.locator('input[name="pin"]').fill("1111");
  await dialog.locator('button[type="submit"]').click();
  await page.locator("#profilePinMessage:not(:empty)").waitFor();
  assert.equal(await dialog.evaluate((node) => node.open), true);
  assert.equal(await dialog.locator('input[name="pin"]').inputValue(), "", "the PIN is cleared after each try");
  // The server's back-off after a wrong PIN (covered by its own tests) is skipped here.
  await store.transaction((s) => { const c = s.customers.find((x) => x.id === "amina"); delete c.pinNextAttemptAt; });
  await dialog.locator('input[name="pin"]').fill("2468");
  await dialog.locator('button[type="submit"]').click();
  const saved = page.locator("#profileEditSaved");
  await saved.waitFor();
  assert.equal(await saved.innerText(), "Saved. Check amina.new@example.test to confirm it.");
  const pending = (await customer()).pendingEmail;
  assert.equal(pending.method, "link");
  assert.equal(await page.locator("#confirmEmail").count(), 0, "no code form for a link");
  await page.screenshot({ path: `${screenshots}/edit-profile-saved.png` });
  assert.deepEqual(errors, []);
  await context.close();

  // The link: confirmed on a tap, then the customer signs in again; once only.
  const token = emailConfirmationLinkToken("amina", pending, secret);
  const link = await open(`/confirm-email#${encodeURIComponent(token)}`, { signedIn: false });
  assert.equal(new URL(link.page.url()).hash, "", "the token leaves the address bar");
  assert.equal(await link.page.locator("h1").innerText(), "Confirm your email");
  assert.equal((await customer()).email, "amina@example.test", "opening the link alone confirms nothing");
  await link.page.locator("#confirmEmailButton").click();
  await link.page.locator("h1", { hasText: "Email confirmed" }).waitFor();
  assert.match(await link.page.locator("#confirmEmailText").innerText(), /amina\.new@example\.test is now your account email/);
  assert.equal(await link.page.locator("#confirmEmailSignIn").getAttribute("href"), "/login");
  const after = await store.snapshot();
  assert.equal(after.customers.find((c) => c.id === "amina").email, "amina.new@example.test");
  assert.equal(after.dashboardSessions.some((s) => s.customerId === "amina"), false, "every portal session ends");
  await link.page.screenshot({ path: `${screenshots}/confirm-email-done.png` });
  assert.deepEqual(link.errors, []);
  await link.context.close();
  const again = await open(`/confirm-email#${encodeURIComponent(token)}`, { signedIn: false });
  await again.page.locator("#confirmEmailButton").click();
  await again.page.locator("h1", { hasText: "This link has expired" }).waitFor();
  await again.context.close();
  const broken = await open("/confirm-email#nonsense", { signedIn: false });
  assert.equal(await broken.page.locator("h1").innerText(), "This link has expired");
  assert.equal(await broken.page.locator("#confirmEmailButton").isHidden(), true);
  await broken.context.close();

  // French.
  await store.transaction((s) => { s.dashboardSessions.push({ id: "sess2", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" }); });
  const fr = await open("/dashboard#editProfile", { lang: "fr" });
  await fr.page.locator("#profileEdit").waitFor({ state: "visible" });
  assert.equal(await fr.page.locator("#profileEdit > label.portal-profile__field").evaluate((node) => node.firstChild.textContent), "Nom complet");
  assert.equal(await fr.page.locator('#profileEdit button[type="submit"]').innerText(), "Enregistrer les modifications");
  assert.equal(await fr.page.locator("#profilePhoneHint").innerText(), "C'est votre numéro de connexion. Pour le changer, contactez l'assistance.");
  await fr.page.screenshot({ path: `${screenshots}/edit-profile-fr.png` });
  await fr.context.close();
});
