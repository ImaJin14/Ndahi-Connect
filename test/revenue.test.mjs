import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore, blank } from "../server.mjs";
import { dashboardTotals } from "../lib/admin-records.mjs";
import { createAdminVouchersRoutes } from "../lib/api/admin-vouchers.mjs";

const at = "2030-01-01T00:00:00Z";

test("revenue counts settled payments and activated voucher sales, never gifts", () => {
  const s = blank();
  s.payments.push(
    { id: "p1", status: "paid", amount: 1000 },
    { id: "p2", status: "pending", amount: 5000 },
    { id: "p3", status: "refunded", amount: 700 },
  );
  s.vouchers.push(
    { id: "online", paymentId: "p1", status: "active", activatedAt: at },
    { id: "assigned-sold", generatedByAdmin: true, saleType: "sold", saleAmount: 500, faceValue: 500, status: "active", activatedAt: at },
    { id: "resale-unclaimed", generatedByAdmin: true, saleType: "sold", saleAmount: 300, faceValue: 300, status: "available", activatedAt: null },
    { id: "resale-claimed", generatedByAdmin: true, saleType: "sold", saleAmount: 300, faceValue: 300, status: "expired", activatedAt: at },
    { id: "revoked-sale", generatedByAdmin: true, saleType: "sold", saleAmount: 900, faceValue: 900, status: "revoked", activatedAt: at },
    { id: "gift", generatedByAdmin: true, saleType: "gift", saleAmount: 0, faceValue: 2500, status: "active", activatedAt: at },
    { id: "legacy", generatedByAdmin: true, status: "active", activatedAt: at },
  );
  const { revenue, sales } = dashboardTotals(s);
  assert.equal(revenue, 1800);
  assert.deepEqual(sales, {
    online: { bundles: 1, amount: 1000 }, vouchers: { bundles: 2, amount: 800 },
    gifts: { bundles: 1, faceValue: 2500 }, unclassified: { bundles: 1 },
  });
});

function adminRoutes() {
  const s = blank(), route = createAdminVouchersRoutes({ deliverVoucherEmail: async () => false, clock: () => new Date(at) });
  s.customers.push({ id: "c1", phone: "670000001" });
  return {
    s,
    async call(path, i, role = "owner") {
      const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
      await route({ method: "POST", headers: {}, socket: {}, adminActor: role }, res, new URL(`http://api.test${path}`), { s, i, role, effects: {} });
      return res;
    },
  };
}

test("generated vouchers record whether they were sold or gifted", async () => {
  const f = adminRoutes();
  const unspecified = await f.call("/api/admin/vouchers/generate", { purpose: "assigned", customerId: "c1", planId: "weekly" });
  assert.equal(unspecified.status, 400);
  assert.equal(f.s.vouchers.length, 0);
  const resellerGift = await f.call("/api/admin/vouchers/generate", { purpose: "resale", planId: "weekly", saleType: "gift" }, "reseller");
  assert.equal(resellerGift.status, 403);
  const resale = await f.call("/api/admin/vouchers/generate", { purpose: "resale", planId: "weekly", quantity: 2 }, "reseller");
  assert.equal(resale.status, 201);
  assert.ok(resale.body.vouchers.every((v) => v.saleType === "sold" && v.saleAmount === v.faceValue && v.faceValue > 0));
  const gift = await f.call("/api/admin/vouchers/generate", { purpose: "assigned", customerId: "c1", planId: "weekly", saleType: "gift" });
  assert.equal(gift.status, 201);
  assert.equal(gift.body.voucher.saleType, "gift");
  assert.equal(gift.body.voucher.saleAmount, 0);
  assert.equal(f.s.auditLogs[0].meta.saleType, "gift");
});

test("administrators reclassify generated vouchers but never online purchases", async () => {
  const f = adminRoutes();
  f.s.vouchers.push(
    { id: "legacy", planId: "weekly", generatedByAdmin: true, status: "active", activatedAt: at },
    { id: "online", planId: "weekly", paymentId: "p1", status: "active", activatedAt: at },
  );
  assert.equal((await f.call("/api/admin/vouchers/classify", { voucherId: "online", saleType: "gift" })).status, 404);
  assert.equal((await f.call("/api/admin/vouchers/classify", { voucherId: "legacy", saleType: "free" })).status, 400);
  const sold = await f.call("/api/admin/vouchers/classify", { voucherId: "legacy", saleType: "sold" });
  assert.equal(sold.status, 200);
  assert.ok(sold.body.voucher.saleAmount > 0);
  assert.equal(sold.body.voucher.saleAmount, sold.body.voucher.faceValue);
  const gift = await f.call("/api/admin/vouchers/classify", { voucherId: "legacy", saleType: "gift" });
  assert.equal(gift.body.voucher.saleAmount, 0);
  assert.deepEqual(f.s.auditLogs.map((a) => [a.action, a.meta.previous, a.meta.saleType]),
    [["voucher.sale_classified", "sold", "gift"], ["voucher.sale_classified", null, "sold"]]);
  assert.equal(f.s.vouchers.find((v) => v.id === "online").saleType, undefined);
});

test("the admin dashboard reports bundles sold, gifts and the revenue breakdown", async (t) => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.payments.push({ id: "p1", status: "paid", amount: 1000 });
    s.vouchers.push({ id: "g", generatedByAdmin: true, saleType: "gift", saleAmount: 0, faceValue: 400, status: "active", activatedAt: at, planId: "weekly" });
  });
  const server = createServer({ store, env: {
    PAYMENT_MODE: "mock", SESSION_COOKIE_SECURE: "false", ADMIN_SESSION_SECRET: "admin-secret", ADMIN_PIN: "9999",
    ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`,
    login = await fetch(base + "/api/admin/login", { method: "POST", headers: { "content-type": "application/json", origin: "http://admin.test" }, body: JSON.stringify({ pin: "9999" }) }),
    body = await (await fetch(base + "/api/admin/dashboard", { headers: { cookie: login.headers.get("set-cookie").split(";")[0] } })).json();
  assert.equal(body.metrics.revenue, 1000);
  assert.equal(body.metrics.bundlesSold, 1);
  assert.equal(body.metrics.giftedBundles, 1);
  assert.deepEqual(body.sales.gifts, { bundles: 1, faceValue: 400 });
});
