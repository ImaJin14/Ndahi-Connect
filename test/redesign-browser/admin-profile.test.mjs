import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Profile and security (canvas: AdminProfile, #389; owner 26 Nov): You (Name,
// Email, Save, Change PIN), Passkeys ("added 19 Aug · used today", Remove, the
// one-left warning, Add), and Staff for owners ("Name · role", Remove opening
// "Remove their passkeys (lost device)" or "Remove from staff", Invite an
// operator opening today's add form). No install card. 1280 px.

const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };

test("Profile and security is drawn as the board, with the staff choices in dialogs", { timeout: 150000 }, async (t) => {
  const secret = "redesign-admin-profile", store = createStore({ persistent: false }), now = new Date();
  await store.transaction((s) => {
    s.adminUsers.push(
      { id: "u-owner", username: "owner", displayName: "Imani O.", email: "owner@ndahiconnect.net", role: "owner", active: true,
        passkeys: [{ id: "k1", publicKey: "pk", counter: 0, label: "Office laptop", createdAt: "2026-08-19T09:00:00.000Z", lastUsedAt: now.toISOString() },
          { id: "k2", publicKey: "pk2", counter: 0, label: "Android phone", createdAt: "2026-08-20T09:00:00.000Z" }] },
      { id: "u-brenda", username: "brenda", displayName: "Brenda", role: "operator", active: true, passkeys: [{ id: "kb", publicKey: "pk3", counter: 0, createdAt: "2026-09-01T09:00:00.000Z" }] },
      { id: "u-eric", username: "eric", displayName: "Eric", role: "operator", active: true, passkeys: [] },
      { id: "u-gone", username: "gone", displayName: "Gone", role: "operator", active: false, passkeys: [] },
      { id: "u-op", username: "operator", displayName: "Oscar", role: "operator", active: true, passkeys: [{ id: "ko", publicKey: "pk4", counter: 0, createdAt: "2026-09-01T09:00:00.000Z" }] });
    for (const [user, token, role] of [["u-owner", "owner-token", "owner"], ["u-op", "operator-token", "operator"]])
      s.adminSessions.push({ userId: user, role, tokenHash: hashSecret(token, secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
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
  const screenshots = process.env.ADMIN_PROFILE_SCREENSHOTS || "/tmp/ndahi-admin-profile";
  await mkdir(screenshots, { recursive: true });
  const open = async (token, lang = "en") => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1020 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: token, url: `${api}/api/admin`, httpOnly: true, sameSite: "Strict" }]);
    if (lang === "fr") await context.addInitScript(() => {
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(admin + "/dashboard#profile");
    await page.locator("#panel-profile .admin-passkeys").waitFor();
    return { page, errors, context };
  };
  const text = (locator) => locator.evaluate((el) => el.innerText.replace(/\s+/g, " ").trim());

  const { page, errors, context } = await open("owner-token");
  const you = page.getByRole("region", { name: "You", exact: true });
  assert.equal(await you.getByLabel("Name", { exact: true }).inputValue(), "Imani O.");
  assert.equal(await you.getByLabel("Email", { exact: true }).inputValue(), "owner@ndahiconnect.net");
  assert.deepEqual(await you.getByRole("button").allInnerTexts(), ["Save", "Change PIN"]);
  assert.deepEqual(await page.locator(".admin-passkeys__list li span").allInnerTexts(), ["Office laptop · added 19 Aug · used today", "Android phone · added 20 Aug"]);
  assert.equal(await page.locator("#adminPasskeysTitle").innerText(), "Passkeys");
  const staff = page.getByRole("region", { name: "Staff (owner only)", exact: true });
  assert.deepEqual(await staff.locator(".admin-row").evaluateAll((rows) => rows.map((row) => row.innerText.replace(/\s+/g, " ").trim())),
    ["Imani O. · owner You", "Brenda · operator Remove", "Eric · operator Remove", "Oscar · operator Remove"], "active staff only, as drawn");
  assert.equal(await page.locator("#adminInstall").count(), 0, "no install card");
  assert.deepEqual(await lowContrastText(page), []);
  await page.screenshot({ path: `${screenshots}/profile.png`, fullPage: true });

  // Save: a new name needs no verification.
  await you.getByLabel("Name", { exact: true }).fill("Imani Owner");
  await you.getByRole("button", { name: "Save", exact: true }).click();
  await you.getByText("Saved", { exact: true }).waitFor();
  assert.equal((await store.snapshot()).adminUsers.find((u) => u.id === "u-owner").displayName, "Imani Owner");
  assert.equal(await page.getByRole("dialog", { name: "Verify administrator action" }).count(), 0);

  // Remove opens the choice; "their passkeys" only when they have some.
  await staff.getByRole("button", { name: "Remove Brenda", exact: true }).click();
  let choice = page.getByRole("dialog", { name: "Remove Brenda", exact: true });
  assert.equal(await choice.getByRole("button", { name: /Remove their passkeys \(lost device\)/ }).isVisible(), true);
  assert.equal(await choice.getByRole("button", { name: /Remove from staff/ }).isVisible(), true);
  assert.deepEqual(await lowContrastText(page), []);
  await page.screenshot({ path: `${screenshots}/remove-choice.png` });
  await choice.getByRole("button", { name: "Cancel", exact: true }).click();
  await staff.getByRole("button", { name: "Remove Eric", exact: true }).click();
  choice = page.getByRole("dialog", { name: "Remove Eric", exact: true });
  assert.equal(await choice.getByRole("button", { name: /Remove their passkeys/ }).isVisible(), false, "Eric has no passkeys");
  await choice.getByRole("button", { name: "Cancel", exact: true }).click();

  // Invite an operator opens today's add form, set to Operator.
  await staff.getByRole("button", { name: "Invite an operator", exact: true }).click();
  const invite = page.getByRole("dialog", { name: "Invite an operator", exact: true });
  assert.equal(await invite.locator('[name="role"]').inputValue(), "operator");
  await invite.getByLabel("Temporary PIN", { exact: true }).waitFor();
  await invite.getByRole("button", { name: "Cancel", exact: true }).click();

  // Change PIN opens its dialog; the two PINs must match.
  await you.getByRole("button", { name: "Change PIN", exact: true }).click();
  const pin = page.getByRole("dialog", { name: "Change PIN", exact: true });
  await pin.getByLabel("New PIN", { exact: true }).fill("123456");
  await pin.getByLabel("Confirm new PIN", { exact: true }).fill("654321");
  await pin.getByRole("button", { name: "Change PIN", exact: true }).click();
  await pin.getByText("The two PINs don't match.", { exact: true }).waitFor();
  await pin.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(errors, []);
  await context.close();

  // An operator: one passkey left, no Staff.
  const op = await open("operator-token");
  assert.equal(await op.page.getByText("Only one passkey left. Add another before you lose this device.", { exact: true }).isVisible(), true);
  assert.equal(await op.page.getByRole("region", { name: "Staff (owner only)" }).count(), 0);
  assert.deepEqual(op.errors, []);
  await op.context.close();

  // French.
  const fr = await open("owner-token", "fr");
  assert.equal(await fr.page.locator("#adminPasskeysTitle").innerText(), "Clés d'accès");
  assert.equal(await fr.page.getByRole("button", { name: "Inviter un opérateur", exact: true }).count(), 1);
  assert.deepEqual(fr.errors, []);
  await fr.context.close();
});
