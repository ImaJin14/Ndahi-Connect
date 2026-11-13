import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";

// Activity tab (#231): payments and shop orders in one chronological stream,
// All | Internet | Orders filters, and an orders-unavailable warning that is
// visible in All and Orders when the store context fails. Local servers only,
// synthetic customers, mock providers, every non-local request aborted.

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server));
});
const close = (server) => new Promise((resolve) => {
  server.close(resolve);
  server.closeAllConnections();
});
const reservePort = async () => {
  const server = await listen(http.createServer());
  const port = server.address().port;
  await close(server);
  return port;
};

const secret = "redesign-activity-secret";
const FAR = "2099-01-01T00:00:00.000Z";
const payment = (id, customerId, status, createdAt) => ({
  id,
  customerId,
  status,
  amount: 3000,
  currency: "XAF",
  provider: "mesomb",
  providerReference: `${id}-ref`,
  payerPhone: "670060001",
  createdAt,
  ...(status === "paid" ? { confirmedAt: createdAt } : {}),
  planId: "weekly",
  planSnapshot: { id: "weekly", name: "Weekly", price: 3000 },
});
const order = (id, customerId, status, createdAt, name) => ({
  id,
  reference: `REF-${id}`,
  customerId,
  productId: `product-${id}`,
  product: { name: { en: name, fr: name } },
  quantity: 1,
  status,
  stockState: "collected",
  createdAt,
  expiresAt: FAR,
  payment: { id: `${id}-payment`, provider: "mesomb", status: "paid", amount: 25000 },
  pickup: "Synthetic pickup desk",
  returns: "",
  hours: "",
});

// Known interleaving: newest first must alternate payment / order.
const EXPECTED_ORDER = [
  "payment:activity-pay-a",
  "order:activity-order-1",
  "payment:activity-pay-b",
  "order:activity-order-2",
  "payment:activity-pay-c",
];

test("activity tab interleaves payments and orders, filters rows and never hides an orders failure", async (t) => {
  let apiServer, staticServer, browser;
  t.after(async () => {
    await browser?.close();
    if (staticServer) await close(staticServer);
    if (apiServer) await close(apiServer);
  });
  const store = createStore({ persistent: false });
  await store.transaction((state) => {
    state.storeOrders ||= [];
    for (const [id, token] of [["customer-activity", "activity-token"], ["customer-no-orders", "no-orders-token"]]) {
      state.customers.push({
        id,
        name: "Activity Customer",
        phone: id === "customer-activity" ? "670060001" : "670060002",
        pinHash: "$argon2id$v=19$m=65536,t=3,p=4$fixture$fixture",
        passkeys: [],
      });
      state.dashboardSessions.push({
        id: `${id}-session`,
        customerId: id,
        tokenHash: hashSecret(token, secret),
        csrfToken: `${id}-csrf`,
        expiresAt: FAR,
      });
    }
    // Stored out of order on purpose so only the client sort can produce EXPECTED_ORDER.
    state.payments.push(
      payment("activity-pay-b", "customer-activity", "failed", "2026-11-04T09:00:00.000Z"),
      payment("activity-pay-c", "customer-activity", "paid", "2026-10-28T09:00:00.000Z"),
      payment("activity-pay-a", "customer-activity", "paid", "2026-11-10T09:00:00.000Z"),
      payment("no-orders-pay", "customer-no-orders", "paid", "2026-11-01T09:00:00.000Z"),
    );
    state.storeOrders.push(
      order("activity-order-2", "customer-activity", "collected", "2026-10-30T09:00:00.000Z", "Synthetic Antenna"),
      order("activity-order-1", "customer-activity", "ready", "2026-11-07T09:00:00.000Z", "Synthetic Router"),
    );
  });

  const apiPort = await reservePort();
  staticServer = createStaticServer("customer", {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    env: { NODE_ENV: "test", UI_V2_PERCENT: "0" },
  });
  await listen(staticServer);
  const portal = `http://127.0.0.1:${staticServer.address().port}`;
  apiServer = createServer({
    store,
    validateConfig: false,
    env: {
      NODE_ENV: "test",
      CUSTOMER_SESSION_SECRET: secret,
      SECRET_PEPPER: secret,
      SESSION_COOKIE_SECURE: "false",
      CUSTOMER_APP_URL: portal,
      PAYMENT_MODE: "mock",
      EMAIL_MODE: "mock",
      MIKROTIK_MODE: "mock",
      OMADA_MODE: "mock",
      BILLING_WORKER_ENABLED: "false",
      NETWORK_QUEUE_ENABLED: "false",
      SECURITY_ALERTS_ENABLED: "false",
    },
  });
  await new Promise((resolve, reject) => {
    apiServer.once("error", reject);
    apiServer.listen(apiPort, "127.0.0.1", resolve);
  });
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const storeContextUrl = `${apiUrl}/api/account/store/context`;
  const localOnly = (route) => [apiUrl, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient");
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}),
  });

  // Opens the Activity tab for one customer; `failContext` makes the store
  // context lookup answer 503 (as a store outage would).
  async function openActivity({ width, token, failContext = false }) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-GB" });
    await context.route("**/*", localOnly);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    const failures = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin !== apiUrl || response.status() < 500) return;
      if (failContext && url.href.startsWith(storeContextUrl)) return;
      failures.push(`${response.status()} ${url.pathname}`);
    });
    if (failContext) {
      // Answer CORS preflight normally so the page really sees the 503, not a CORS error.
      const cors = { "access-control-allow-origin": portal, "access-control-allow-credentials": "true" };
      await page.route(`${storeContextUrl}*`, (route) => route.request().method() === "OPTIONS"
        ? route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-methods": "GET", "access-control-allow-headers": "content-type, x-csrf-token" } })
        : route.fulfill({ status: 503, contentType: "application/json", headers: cors, body: JSON.stringify({ error: "Store temporarily unavailable." }) }));
    }
    await context.addCookies([{ name: "customer_session", value: token, url: `${apiUrl}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    await page.goto(`${portal}/dashboard?ui=new#activity`);
    await page.locator("#billing [data-payment-row]").first().waitFor({ state: "visible" });
    return { context, page, errors, failures };
  }

  const pick = async (page, filter) => {
    await page.locator(`button[data-activity-filter="${filter}"]`).click();
    assert.equal(await page.locator("body").getAttribute("data-activity-filter"), filter);
    assert.equal(await page.locator(`button[data-activity-filter="${filter}"]`).getAttribute("aria-pressed"), "true");
  };
  const visible = (page, selector) => page.locator(selector).evaluateAll((nodes) => nodes.map((node) => node.checkVisibility()));
  const noHorizontalOverflow = async (page, label) => {
    const result = await page.evaluate(() => {
      const root = document.documentElement;
      const wide = [...document.querySelectorAll("#billing, #billing *, .portal-activity__filters, .portal-activity__filters *")]
        .filter((node) => node.checkVisibility() && node.getBoundingClientRect().right > root.clientWidth + 0.5)
        .map((node) => `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}`);
      return { scroll: root.scrollWidth, client: root.clientWidth, wide };
    });
    assert.ok(result.scroll <= result.client, `${label}: page scrolls sideways (${result.scroll} > ${result.client})`);
    assert.deepEqual(result.wide, [], `${label}: activity elements overflow the viewport`);
  };
  // Existing payment detail nodes, hooks and actions survive the order merge/sort.
  const paymentRowsIntact = async (page, label) => {
    const rows = await page.locator("#billing details[data-payment-row]").evaluateAll((nodes) => nodes.map((row) => ({
      id: row.dataset.paymentRow,
      kind: row.dataset.activityKind,
      at: row.dataset.activityAt,
      toggleHook: typeof row.ontoggle === "function",
      summary: Boolean(row.querySelector(":scope > summary.portal-activity__summary")),
      copy: row.querySelector("[data-copy-payment]")?.dataset.copyPayment || null,
      help: Boolean(row.querySelector("a.payment-help[href='/help#payment']")),
      refund: Boolean(row.querySelector("form[data-refund-payment]")),
    })));
    assert.ok(rows.length >= 1, `${label}: payment rows rendered`);
    for (const row of rows) {
      assert.equal(row.kind, "internet", `${label}: ${row.id} kind`);
      assert.ok(row.at, `${label}: ${row.id} keeps its date`);
      assert.equal(row.toggleHook, true, `${label}: ${row.id} keeps its toggle hook`);
      assert.equal(row.summary, true, `${label}: ${row.id} keeps its summary`);
      assert.equal(row.copy, `${row.id}-ref`, `${label}: ${row.id} keeps Copy reference`);
      assert.equal(row.help, true, `${label}: ${row.id} keeps Payment help`);
    }
    return rows;
  };
  const openAndClose = async (page, id, label) => {
    const row = page.locator(`#billing details[data-payment-row="${id}"]`);
    await row.locator(":scope > summary").click();
    await page.waitForFunction((rowId) => document.querySelector(`#billing details[data-payment-row="${rowId}"]`).open, id);
    assert.equal(await row.locator("[data-copy-payment]").isVisible(), true, `${label}: ${id} actions show when opened`);
    await row.locator(":scope > summary").click();
    await page.waitForFunction((rowId) => !document.querySelector(`#billing details[data-payment-row="${rowId}"]`).open, id);
  };

  for (const width of [390, 1280]) {
    // 1. Store context succeeds: one interleaved, newest-first stream.
    {
      const label = `orders/${width}`;
      const { context, page, errors, failures } = await openActivity({ width, token: "activity-token" });
      try {
        await page.waitForFunction(() => document.querySelectorAll("#billing [data-order-row]").length === 2);
        const stream = await page.locator("#billing .portal-activity__list > [data-activity-at]").evaluateAll((nodes) => nodes.map((node) => (node.dataset.paymentRow ? `payment:${node.dataset.paymentRow}` : `order:${node.dataset.orderRow}`)));
        assert.deepEqual(stream, EXPECTED_ORDER, `${label}: stream is newest first`);
        const rows = await paymentRowsIntact(page, label);
        assert.deepEqual(rows.filter((row) => row.refund).map((row) => row.id).sort(), ["activity-pay-a", "activity-pay-c"], `${label}: paid rows keep the refund request form`);
        assert.equal(await page.locator('#billing details[data-payment-row="activity-pay-a"] .portal-activity__pill').innerText().then((text) => text.toLowerCase()), "paid");

        const orders = await page.locator("#billing a[data-order-row]").evaluateAll((nodes) => nodes.map((node) => ({ id: node.dataset.orderRow, kind: node.dataset.activityKind, href: node.getAttribute("href"), title: node.querySelector("strong")?.textContent })));
        assert.deepEqual(orders, [
          { id: "activity-order-1", kind: "orders", href: "/dashboard#order/activity-order-1", title: "Order · Synthetic Router" },
          { id: "activity-order-2", kind: "orders", href: "/dashboard#order/activity-order-2", title: "Order · Synthetic Antenna" },
        ], `${label}: order links intact`);
        assert.equal(await page.locator("#activityOrders [data-orders-note]").count(), 0, `${label}: no orders note when orders exist`);

        await pick(page, "all");
        assert.deepEqual(await visible(page, "#billing .portal-activity__list > [data-activity-at]"), [true, true, true, true, true], `${label}: All shows every row`);
        await openAndClose(page, "activity-pay-a", label);
        await noHorizontalOverflow(page, `${label}/all`);

        await pick(page, "internet");
        assert.deepEqual(await visible(page, "#billing details[data-payment-row]"), [true, true, true], `${label}: Internet shows payments`);
        assert.deepEqual(await visible(page, "#billing [data-order-row]"), [false, false], `${label}: Internet hides orders`);
        await openAndClose(page, "activity-pay-b", label);
        await noHorizontalOverflow(page, `${label}/internet`);

        await pick(page, "orders");
        assert.deepEqual(await visible(page, "#billing details[data-payment-row]"), [false, false, false], `${label}: Orders hides payments`);
        assert.deepEqual(await visible(page, "#billing [data-order-row]"), [true, true], `${label}: Orders shows orders`);
        await noHorizontalOverflow(page, `${label}/orders`);

        // The order link opens the order route inside the portal.
        await page.locator('#billing a[data-order-row="activity-order-1"]').click();
        await page.waitForFunction(() => location.hash === "#order/activity-order-1");
        assert.deepEqual(errors, [], `${label}: page errors`);
        assert.deepEqual(failures, [], `${label}: failed API responses`);
      } finally {
        await context.close();
      }
    }

    // 2. Store context fails: payments still work; the warning is visible in All and Orders, not Internet.
    {
      const label = `context-failure/${width}`;
      const { context, page, errors, failures } = await openActivity({ width, token: "activity-token", failContext: true });
      try {
        const warning = page.locator('#activityOrders [data-orders-note="unavailable"]');
        await warning.waitFor({ state: "attached" });
        assert.equal(await warning.innerText(), "Shop orders could not be loaded.");
        assert.equal(await page.locator("#billing [data-order-row]").count(), 0, `${label}: no order rows`);
        assert.equal(await page.locator('#activityOrders [data-orders-note="empty"]').count(), 0, `${label}: failure is not reported as "no orders"`);
        await paymentRowsIntact(page, label);
        const payments = await page.locator("#billing details[data-payment-row]").evaluateAll((nodes) => nodes.map((node) => node.dataset.paymentRow));
        assert.deepEqual([...payments].sort(), ["activity-pay-a", "activity-pay-b", "activity-pay-c"], `${label}: all three payments render`);

        await pick(page, "all");
        assert.equal(await warning.isVisible(), true, `${label}: warning visible in All`);
        assert.deepEqual(await visible(page, "#billing details[data-payment-row]"), [true, true, true], `${label}: payments visible in All`);
        await openAndClose(page, "activity-pay-a", label);
        await noHorizontalOverflow(page, `${label}/all`);

        await pick(page, "internet");
        assert.equal(await warning.isVisible(), false, `${label}: warning hidden in Internet`);
        assert.deepEqual(await visible(page, "#billing details[data-payment-row]"), [true, true, true], `${label}: payments visible in Internet`);
        await noHorizontalOverflow(page, `${label}/internet`);

        await pick(page, "orders");
        assert.equal(await warning.isVisible(), true, `${label}: warning visible in Orders`);
        await noHorizontalOverflow(page, `${label}/orders`);
        assert.deepEqual(errors, [], `${label}: page errors`);
        assert.deepEqual(failures, [], `${label}: failed API responses`);
      } finally {
        await context.close();
      }
    }

    // 3. No orders: "No shop orders yet." stays in the Orders view only.
    {
      const label = `no-orders/${width}`;
      const { context, page, errors, failures } = await openActivity({ width, token: "no-orders-token" });
      try {
        const note = page.locator('#activityOrders [data-orders-note="empty"]');
        await note.waitFor({ state: "attached" });
        assert.equal(await page.locator('#activityOrders [data-orders-note="unavailable"]').count(), 0);
        await paymentRowsIntact(page, label);
        await pick(page, "all");
        assert.equal(await note.isVisible(), false, `${label}: note hidden in All`);
        await pick(page, "internet");
        assert.equal(await note.isVisible(), false, `${label}: note hidden in Internet`);
        await pick(page, "orders");
        assert.equal(await note.isVisible(), true, `${label}: note visible in Orders`);
        assert.equal(await note.innerText(), "No shop orders yet.");
        await noHorizontalOverflow(page, `${label}/orders`);
        assert.deepEqual(errors, [], `${label}: page errors`);
        assert.deepEqual(failures, [], `${label}: failed API responses`);
      } finally {
        await context.close();
      }
    }
  }
});
