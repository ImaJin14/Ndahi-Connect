import assert from "node:assert/strict";
import { pairingFixture } from "../test/helpers/wifi-pairing-fixture.mjs";
import { createStaticServer } from "../static-server.mjs";
import { voucherQrUrl } from "../lib/voucher-qr.mjs";
const origin = "http://127.0.0.1:8962",
  f = await pairingFixture({
    origin,
    liveClock: true,
    now: new Date(),
    env: { COVERAGE_ALLOWED_IPS: "127.0.0.1" },
  });
const site = createStaticServer("customer", {
  apiUrl: f.api,
  production: false,
});
await new Promise((resolve) => site.listen(8962, "127.0.0.1", resolve));
let qr;
await f.store.transaction((s) => {
  qr = new URL(voucherQrUrl(s.vouchers[0], s.customers[0], origin)).hash;
});
const baseline = await f.store.snapshot();
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAN_CHROME_PATH
    ? { executablePath: process.env.PLAN_CHROME_PATH }
    : {}),
});
let count = 0;
async function scenario(name, run, { other = false } = {}) {
  await f.store.transaction((s) => Object.assign(s, structuredClone(baseline)));
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await context.route("**/*", (route) =>
    [origin, f.api].includes(new URL(route.request().url()).origin)
      ? route.continue()
      : route.abort(),
  );
  if (other)
    await context.addCookies([
      {
        name: "customer_session",
        value: "other",
        url: f.api,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await run(page, context);
    assert.deepEqual(errors, []);
    console.log(`PASS ${name}`);
    count++;
  } catch (error) {
    console.error(
      await page
        .locator("#qrMessage")
        .textContent()
        .catch(() => "QR page unavailable"),
    );
    await page.screenshot({
      path: "/tmp/ndahi-qr-journey-failure.png",
      fullPage: true,
    });
    throw error;
  } finally {
    await context.close();
  }
}
const path = "/voucher-connect.html?mac=AA:BB:CC:DD:EE:03&address=10.20.0.30";
try {
  await scenario(
    "active QR opens direct proof page and connects once after PIN, including reload recovery",
    async (page, context) => {
      await page.goto(origin + path + qr);
      await page.waitForFunction(
        () => !document.querySelector("#connectWithPin").disabled,
      );
      assert.equal(await page.locator('input[type="tel"]').count(), 0);
      assert.equal(
        (await f.store.snapshot()).dashboardSessions.length,
        baseline.dashboardSessions.length,
      );
      await page.locator("#accountPin").fill("2468");
      await page.locator("#connectWithPin").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#qrMessage")
          .textContent.includes("Waiting for the router"),
      );
      assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 1);
      assert.equal(
        (await f.store.snapshot()).customers[0].wifiMainDevice.controllerHash,
        baseline.customers[0].wifiMainDevice.controllerHash,
      );
      await page.reload();
      await page.waitForFunction(() =>
        document
          .querySelector("#qrMessage")
          .textContent.includes("Waiting for the router"),
      );
      assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 1);
      await f.process();
      await page.waitForURL((url) => url.pathname === "/dashboard", {
        timeout: 15000,
      });
      assert.ok(
        (await context.cookies(f.api + "/api/account")).some(
          (cookie) => cookie.name === "customer_session",
        ),
      );
      assert.equal(f.calls.length, 1);
    },
  );
  await scenario(
    "unknown WiFi disables proof until hotspot sign-in identifies the same browser",
    async (page) => {
      await page.goto(origin + "/voucher-connect.html" + qr);
      await page.locator("#wifiGuidance").waitFor();
      assert.equal(await page.locator("#connectWithPin").isDisabled(), true);
      await page.goto(
        origin + "/hotspot?mac=AA:BB:CC:DD:EE:03&address=10.20.0.30",
      );
      await page.waitForURL((url) => url.pathname === "/voucher-connect.html");
      await page.waitForFunction(
        () => !document.querySelector("#connectWithPin").disabled,
      );
      assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 0);
    },
  );
  await scenario(
    "legacy printed active voucher goes to proof, never packages or automatic account login",
    async (page) => {
      await page.goto(
        origin +
          "/onboarding.html?action=connect&code=NC-AAAA-1111&mac=AA:BB:CC:DD:EE:03&address=10.20.0.30",
      );
      await page.waitForURL((url) => url.pathname === "/voucher-connect.html");
      await page.waitForFunction(
        () => !document.querySelector("#connectWithPin").disabled,
      );
      assert.equal(
        (await f.store.snapshot()).dashboardSessions.length,
        baseline.dashboardSessions.length,
      );
    },
  );
  await scenario(
    "different signed-in account requires explicit logout before QR proof",
    async (page) => {
      await page.goto(origin + path + qr);
      await page.locator("#switchAccount").waitFor();
      assert.equal(await page.locator("#connectWithPin").isDisabled(), true);
      await page.locator("#switchAccount").click();
      await page.waitForFunction(
        () => !document.querySelector("#connectWithPin").disabled,
      );
    },
    { other: true },
  );
  await scenario(
    "expired QR explains the inactive bundle and never authorizes connection",
    async (page) => {
      await f.store.transaction((s) => {
        s.vouchers[0].status = "expired";
      });
      await page.goto(origin + path + qr);
      await page.waitForFunction(() =>
        document
          .querySelector("#qrMessage")
          .textContent.includes("active bundle"),
      );
      assert.equal(await page.locator("#connectWithPin").isDisabled(), true);
      assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 0);
    },
  );
  console.log(`${count} voucher QR browser journeys passed.`);
} finally {
  await browser.close();
  await f.close();
  await new Promise((resolve) => site.close(resolve));
}
