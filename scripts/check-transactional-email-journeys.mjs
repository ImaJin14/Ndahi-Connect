import assert from "node:assert/strict";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createHandler, plans } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { pairingFixture } from "../test/helpers/wifi-pairing-fixture.mjs";
import { MockEmailAdapter } from "../lib/email.mjs";
import { queueVoucherEmail } from "../lib/transactional-email.mjs";
const portalServer = http.createServer();
await new Promise((r) => portalServer.listen(0, "127.0.0.1", r));
const portal = `http://127.0.0.1:${portalServer.address().port}`;
const f = await pairingFixture({
  origin: portal,
  now: new Date(),
  liveClock: true,
});
await f.close();
const initial = await f.store.snapshot(),
  messages = [];
let voucherOutage = false;
const email = new MockEmailAdapter();
for (const kind of [
  "Verification",
  "Welcome",
  "Activation",
  "Receipt",
  "Voucher",
])
  email["send" + kind] = async (m) => {
    messages.push({ kind, ...m });
    if (kind === "Voucher" && voucherOutage)
      throw Error("fixture provider unavailable");
    return { messageId: "fixture-" + messages.length };
  };
const handler = createHandler({
  store: f.store,
  email,
  now: f.now,
  validateConfig: false,
  env: {
    NODE_ENV: "test",
    PAYMENT_MODE: "mock",
    CUSTOMER_SESSION_SECRET: "pairing-tests",
    SECRET_PEPPER: "pairing-tests",
    SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal,
    LOG_LEVEL: "warn",
    BILLING_WORKER_ENABLED: "false",
    SECURITY_ALERTS_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false",
  },
});
const apiServer = http.createServer(handler);
await new Promise((r) => apiServer.listen(0, "127.0.0.1", r));
const api = `http://127.0.0.1:${apiServer.address().port}`;
const assets = createStaticServer("customer", { apiUrl: api });
portalServer.on("request", (req, res) => assets.emit("request", req, res));
let browser;
try {
  const { chromium } = await import(
    process.env.PLAYWRIGHT_MODULE || "playwright"
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAN_CHROME_PATH
      ? { executablePath: process.env.PLAN_CHROME_PATH }
      : {}),
  });
  await mkdir("/tmp/ndahi-email-checks", { recursive: true });
  for (const width of [320, 1280]) {
    messages.length = 0;
    voucherOutage = false;
    await f.store.transaction((s) => {
      Object.assign(s, structuredClone(initial));
      Object.assign(s.customers[0], {
        email: "owner@example.test",
        emailVerificationRequired: true,
        emailVerifiedAt: f.now().toISOString(),
      });
      s.vouchers[0].paymentId = "p";
      s.vouchers[0].planId = "weekly";
      s.vouchers[0].activationEmail = { status: "pending", attempts: 0 };
      s.payments.push({
        id: "p",
        customerId: "c1",
        planId: "weekly",
        status: "paid",
        amount: 500,
        currency: "XAF",
        confirmedAt: f.now().toISOString(),
        createdAt: f.now().toISOString(),
        planSnapshot: plans.find((p) => p.id === "weekly"),
        email: "payer@example.test",
      });
      queueVoucherEmail(s, s.vouchers[0]);
    });
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    await context.addCookies([
      {
        name: "customer_session",
        value: "main",
        domain: "127.0.0.1",
        path: "/api/account",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await context.route("**/*", (route) =>
      [portal, api].includes(new URL(route.request().url()).origin)
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(portal + "/dashboard#account");
    await page
      .getByRole("button", {
        name: "Manage notification settings",
        exact: true,
      })
      .click();
    const panel = page.getByRole("dialog", {
      name: "Notifications",
      exact: true,
    });
    await panel
      .getByLabel("Email welcome, receipts, vouchers and activation notices", {
        exact: true,
      })
      .uncheck();
    await panel
      .getByRole("button", { name: "Save notification settings", exact: true })
      .click();
    await panel
      .getByText("Notification settings saved.", { exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#emailAccount summary").click();
    await page
      .locator('#profileEdit [name="email"]')
      .fill("replacement@example.test");
    await page.locator('#profileEdit [name="pin"]').fill("2468");
    await page.locator('#profileEdit [type="submit"]').click();
    await page.locator("#confirmEmail").waitFor();
    assert.equal(messages.length, 0);
    await page
      .getByText(
        "Your confirmation email is queued. Delivery may take a moment.",
        { exact: false },
      )
      .waitFor();
    await handler.transactionalEmails.run();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, "Verification");
    assert.equal(messages[0].to, "replacement@example.test");
    assert.equal(
      (await f.store.snapshot()).customers[0].email,
      "owner@example.test",
    );
    await page.reload();
    await page.locator("#confirmEmail").waitFor();
    await page.locator('#confirmEmail [name="code"]').fill("invalid");
    await page
      .locator("#confirmEmail")
      .evaluate((form) => (form.noValidate = true));
    await page.locator('#confirmEmail [type="submit"]').click();
    await page
      .locator("#emailConfirmMessage")
      .filter({ hasText: "invalid" })
      .waitFor();
    assert.equal(
      await page.locator('#confirmEmail [type="submit"]').isEnabled(),
      true,
    );
    // Simulate a lost successful confirmation reply. Session recovery must observe
    // the new verified association without asking the user to submit another code.
    await page.route(
      "**/api/account/profile/email/confirm",
      async (route) => {
        await route.fetch();
        await route.abort("failed");
      },
      { times: 1 },
    );
    await page.locator('#confirmEmail [name="code"]').fill(messages[0].code);
    await page.locator('#confirmEmail [type="submit"]').click();
    await page.locator("#confirmEmail").waitFor({ state: "detached" });
    await page
      .locator("#emailAccount")
      .getByText("replacement@example.test (confirmed)", { exact: true })
      .waitFor();
    await handler.transactionalEmails.run();
    assert.equal(
      messages.length,
      1,
      "opted-out account receives no transactional messages",
    );
    const s = await f.store.snapshot();
    assert.equal(s.customers[0].email, "replacement@example.test");
    assert.equal(
      s.dashboardSessions.some((a) => a.id === "secondary"),
      false,
    );
    assert.equal(s.payments[0].email, "payer@example.test");
    await page
      .getByRole("button", {
        name: "Manage notification settings",
        exact: true,
      })
      .click();
    await panel
      .getByLabel("Email welcome, receipts, vouchers and activation notices", {
        exact: true,
      })
      .check();
    await panel
      .getByRole("button", { name: "Save notification settings", exact: true })
      .click();
    await panel
      .getByText("Notification settings saved.", { exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    voucherOutage = true;
    await handler.transactionalEmails.run();
    assert.equal((await f.store.snapshot()).vouchers[0].status, "active");
    assert.equal((await f.store.snapshot()).vouchers[0].emailStatus, "failed");
    f.advance(121);
    voucherOutage = false;
    await handler.transactionalEmails.run();
    await handler.billing.run();
    const vouchers = messages.filter((m) => m.kind === "Voucher");
    assert.equal(vouchers.length, 2);
    assert.deepEqual(vouchers[0], vouchers[1]);
    assert.equal((await f.store.snapshot()).vouchers[0].emailStatus, "sent");
    assert.ok(
      messages.every(
        (m) => (m.to || m.customer?.email) === "replacement@example.test",
      ),
    );
    await page.reload();
    await page
      .getByRole("button", {
        name: "Manage notification settings",
        exact: true,
      })
      .click();
    assert.equal(
      await panel
        .getByLabel(
          "Email welcome, receipts, vouchers and activation notices",
          { exact: true },
        )
        .isChecked(),
      true,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: `/tmp/ndahi-email-checks/settings-${width}.png`,
      fullPage: true,
    });
    await context.close();
    console.log(
      `PASS verified replacement, queued delivery, invalid/lost reply recovery, separate payer identity, preferences, outage retry and reload at ${width}px`,
    );
  }
} finally {
  await browser?.close();
  await new Promise((r) => {
    apiServer.close(r);
    apiServer.closeAllConnections();
  });
  await new Promise((r) => {
    portalServer.close(r);
    portalServer.closeAllConnections();
  });
}
