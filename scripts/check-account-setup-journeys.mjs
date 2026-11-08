import assert from "node:assert/strict";
import http from "node:http";
import { createStaticServer } from "../static-server.mjs";
import { pairingFixture } from "../test/helpers/wifi-pairing-fixture.mjs";
import { emailConfirmationCode } from "../lib/transactional-email.mjs";
const server = http.createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const f = await pairingFixture({
  origin,
  now: new Date(),
  liveClock: true,
  env: { NODE_ENV: "test", EMAIL_MODE: "mock", PAYMENT_MODE: "mock" },
});
const assets = createStaticServer("customer", { apiUrl: f.api });
server.on("request", (req, res) => assets.emit("request", req, res));
const baseline = await f.store.snapshot();
let browser,
  checks = 0;
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true });
  for (const width of [320, 1280]) {
    await f.store.transaction((s) => {
      Object.assign(s, structuredClone(baseline));
      Object.assign(s.customers[0], {
        email: "signup@example.test",
        emailVerificationRequired: true,
      });
    });
    const context = await browser.newContext({
      viewport: { width, height: 950 },
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
    await context.addInitScript(() => {
      if (!sessionStorage.getItem("setup-fixture-seeded")) {
        sessionStorage.setItem("ndahi-email-setup-prompt", "1");
        sessionStorage.setItem("setup-fixture-seeded", "1");
      }
    });
    await context.route("**/*", (route) =>
      [origin, f.api].includes(new URL(route.request().url()).origin)
        ? route.continue({
            headers: {
              ...route.request().headers(),
              "cf-connecting-ip": "203.0.113.10",
            },
          })
        : route.abort(),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/dashboard");
    const popup = page.locator("#accountSetupDialog");
    await popup.waitFor({ state: "visible" });
    assert.equal(
      await popup.getByLabel("Email address", { exact: true }).inputValue(),
      "signup@example.test",
    );
    assert.equal(
      (await f.store.snapshot()).customers[0].emailVerifiedAt,
      undefined,
    );
    await popup.getByRole("button", { name: "Not now", exact: true }).click();
    await page
      .getByRole("button", { name: "Complete account setup", exact: true })
      .click();
    await popup.getByLabel("Email address", { exact: true }).waitFor();
    await popup.getByLabel("Current account PIN", { exact: true }).fill("0000");
    await popup
      .getByRole("button", { name: "Send verification code", exact: true })
      .click();
    await popup
      .getByText(
        "Could not verify this email change. Use your current PIN or passkey.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      (await f.store.snapshot()).customers[0].pendingEmail,
      undefined,
    );
    f.advance(2);
    await popup.getByLabel("Current account PIN", { exact: true }).fill("2468");
    await popup
      .getByRole("button", { name: "Send verification code", exact: true })
      .click();
    await popup.getByLabel("Verification code", { exact: true }).waitFor();
    let customer = (await f.store.snapshot()).customers[0];
    assert.equal(customer.emailVerifiedAt, undefined);
    assert.equal(customer.name, "Imajin");
    assert.equal(customer.phone, "670050001");
    const code = emailConfirmationCode(
      customer.id,
      customer.pendingEmail,
      "pairing-tests",
    );
    await popup
      .getByLabel("Verification code", { exact: true })
      .fill(code === "000000" ? "111111" : "000000");
    await popup
      .getByRole("button", { name: "Verify and link email", exact: true })
      .click();
    await popup
      .getByText("The email confirmation code is invalid.", { exact: true })
      .waitFor();
    assert.equal(
      (await f.store.snapshot()).customers[0].emailVerifiedAt,
      undefined,
    );
    await popup.getByLabel("Verification code", { exact: true }).fill(code);
    await popup
      .getByRole("button", { name: "Verify and link email", exact: true })
      .click();
    await popup
      .getByRole("heading", { name: "Email linked", exact: true })
      .waitFor();
    customer = (await f.store.snapshot()).customers[0];
    assert.ok(customer.emailVerifiedAt);
    assert.equal(customer.email, "signup@example.test");
    assert.equal(customer.name, "Imajin");
    assert.equal(customer.phone, "670050001");
    assert.equal(customer.pendingEmail, undefined);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: `/tmp/ndahi-account-setup-${width}.png`,
      fullPage: true,
    });
    await popup
      .getByRole("button", { name: "Continue to my account", exact: true })
      .click();
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("#accountSetupDialog").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
    checks++;
    console.log(
      `PASS signup email popup, dismiss/reopen, PIN proof, invalid/valid mailbox code, unchanged identity and verified-email suppression at ${width}px`,
    );
  }
  console.log(
    `${checks} account setup browser journeys passed; email delivery mocked.`,
  );
} finally {
  await browser?.close();
  await f.close();
  await new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
}
