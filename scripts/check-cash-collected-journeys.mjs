import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { chromium } from "playwright";
const store = createStore({ persistent: false }),
  secret = randomUUID();
const now = new Date("2026-11-08T16:00:00Z"),
  api = "http://127.0.0.1:8982",
  admin = "http://127.0.0.1:8981";
const tokens = { owner: randomUUID(), reseller: randomUUID() };
const payment = (id, amount, extra = {}) => ({
  id,
  provider: "mesomb",
  providerReference: `gateway-${id}`,
  currency: "XAF",
  status: "paid",
  amount,
  confirmedAt: "2026-11-02T10:00:00Z",
  ...extra,
});
await store.transaction((s) => {
  for (const [role, token] of Object.entries(tokens)) {
    s.adminUsers.push({
      id: role,
      username: role,
      role,
      active: true,
      passkeys: [],
    });
    s.adminSessions.push({
      userId: role,
      role,
      tokenHash: hashSecret(token, secret),
      csrfToken: randomUUID(),
      expiresAt: "2027-01-01T00:00:00Z",
    });
  }
  s.payments.push(
    payment("current", 2000),
    payment("old", 99999, { confirmedAt: "2026-10-31T22:59:59Z" }),
    payment("mock", 88888, { provider: "mock" }),
    payment("pending", 77777, { status: "pending", confirmedAt: null }),
    payment("refunded", 1000, {
      status: "refunded",
      refund: { status: "completed" },
    }),
  );
  s.storeOrders = [
    {
      id: "store-fixture",
      status: "collected",
      stockState: "consumed",
      contact: {},
      payment: payment("store", 5000),
      product: { name: { en: "Fixture router" } },
    },
  ];
});
const server = createServer({
  store,
  now: () => now,
  validateConfig: false,
  env: {
    NODE_ENV: "test",
    PAYMENT_MODE: "mock",
    EMAIL_MODE: "mock",
    BILLING_WORKER_ENABLED: "false",
    SECURITY_ALERTS_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false",
    ADMIN_SESSION_SECRET: secret,
    SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin,
    ALLOWED_ADMIN_ORIGINS: admin,
  },
});
const website = createStaticServer("admin", { apiUrl: api });
const listen = (s, port) => new Promise((r) => s.listen(port, "127.0.0.1", r));
const close = (s) => {
  s.closeAllConnections();
  return new Promise((r) => s.close(r));
};
let browser;
try {
  await listen(server, 8982);
  await listen(website, 8981);
  browser = await chromium.launch({ headless: true });
  for (const width of [320, 1280]) {
    for (const role of ["owner", "reseller"]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
      });
      await context.addCookies([
        { name: "admin_session", value: tokens[role], url: api },
      ]);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(admin + "/dashboard");
      await page.locator("#admin-nav-payments").click();
      if (role === "owner") {
        await page.waitForFunction(() =>
          document
            .getElementById("cashCollectedMetric")
            ?.textContent.includes("7,000"),
        );
        assert.match(
          await page.locator("#cashCollectedReport").innerText(),
          /1 November 2026 onward/,
        );
        assert.equal(
          await page.locator("#cashCollectedReport tbody tr").count(),
          2,
        );
        assert.equal(await page.locator("#settlementReport").count(), 0);
        assert.doesNotMatch(
          await page.locator("#panel-payments").innerText(),
          /Recorded offline voucher sales|99,999|88,888|77,777/,
        );
        await page.reload();
        await page.waitForFunction(() =>
          document
            .getElementById("cashCollectedMetric")
            ?.textContent.includes("7,000"),
        );
      } else {
        assert.equal(await page.locator("#cashCollectedReport").count(), 0);
        assert.equal(
          await page.locator("#cashCollectedMetric").innerText(),
          "Unavailable",
        );
      }
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        true,
      );
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS cash dashboard ${role} ${width}px`);
    }
  }
} finally {
  await browser?.close();
  await Promise.all([close(server), close(website)]);
}
console.log(
  "4 cash dashboard browser journeys passed; no real payment or provider request.",
);
