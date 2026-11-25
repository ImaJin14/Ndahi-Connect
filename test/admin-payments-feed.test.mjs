import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore, blank } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { queryRecords } from "../lib/admin-records.mjs";
import { bundlesSoldToday, doualaDayStart, paymentCounts, paymentFeed } from "../lib/admin-payments-feed.mjs";
import { cashCollected } from "../lib/cash-collected.mjs";

// One payments list for Admin home and Payments (#377, #386): bundle payments,
// store-order payments and reseller cash handoffs, newest first.
const now = new Date("2026-11-25T17:30:00+01:00"); // 16:30 UTC; the Douala day began at 2026-11-24T23:00Z.
const ago = (minutes) => new Date(+now - minutes * 60000).toISOString();
function state() {
  const s = blank();
  s.payments.push(
    { id: "p-wait-old", status: "pending", amount: 1000, currency: "XAF", provider: "mesomb", network: "mtn", payerPhone: "670001245", createdAt: ago(12), requestKey: "secret-key", guestSetup: { token: "x" } },
    { id: "p-wait-new", status: "processing", amount: 250, currency: "XAF", provider: "mesomb", network: "orange", payerPhone: "670007731", createdAt: ago(5) },
    { id: "p-paid", status: "paid", amount: 3000, currency: "XAF", provider: "mesomb", network: "mtn", payerPhone: "670004019", providerReference: "MTN-REF-77", createdAt: ago(50), confirmedAt: ago(49) },
    { id: "p-failed", status: "failed", amount: 1000, currency: "XAF", provider: "mesomb", network: "orange", payerPhone: "670000366", createdAt: ago(130) },
    { id: "p-expired-yesterday", status: "expired", amount: 1000, currency: "XAF", provider: "mesomb", network: "mtn", payerPhone: "670000366", createdAt: "2026-11-24T22:30:00Z" },
    { id: "p-refunded", status: "refunded", amount: 1000, currency: "XAF", provider: "mesomb", network: "mtn", payerPhone: "670000366", createdAt: ago(300), confirmedAt: ago(299) },
  );
  s.storeOrders = [
    { id: "o-guest", reference: "NS-3F2A91BC", customerId: null, product: { name: { en: "TP-Link CPE210", fr: "TP-Link CPE210" } }, quantity: 1, createdAt: ago(36), contact: { phone: "670008802" },
      payment: { id: "store-o-guest", status: "paid", amount: 30000, currency: "XAF", provider: "mesomb", network: "orange", payerPhone: "670008802", providerReference: "OM-REF-9", createdAt: ago(36), confirmedAt: ago(35), refund: { status: "requested", reason: "x" } } },
    { id: "o-no-payment", reference: "NS-00000000", createdAt: ago(1) },
  ];
  s.adminUsers.push({ id: "r-kiosk", username: "brenda", displayName: "Market kiosk", role: "reseller", active: true, passkeys: [],
    remittances: [{ id: "remit-1", amount: 20000, note: "Cash drop", recordedBy: "owner", createdAt: ago(180), resellerName: "Old name" }, { id: "remit-bad", amount: "x", createdAt: ago(1) }] });
  return s;
}

test("the payments list joins bundle payments, store orders and reseller cash, newest first", () => {
  const rows = paymentFeed(state());
  assert.deepEqual(rows.map((r) => r.id), ["p-wait-new", "p-wait-old", "store-o-guest", "p-paid", "p-failed", "remit-1", "p-refunded", "p-expired-yesterday"]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId["p-wait-old"].kind, "bundle");
  assert.ok(!("requestKey" in byId["p-wait-old"]) && !("guestSetup" in byId["p-wait-old"]), "a payment's private keys never leave the server");
  assert.deepEqual([byId["p-wait-old"].group, byId["p-wait-new"].group, byId["p-paid"].group, byId["p-failed"].group, byId["p-expired-yesterday"].group, byId["p-refunded"].group],
    ["waiting", "waiting", "paid", "failed", "failed", "other"]);
  assert.deepEqual(byId["store-o-guest"], { kind: "order", id: "store-o-guest", orderId: "o-guest", orderReference: "NS-3F2A91BC", product: { en: "TP-Link CPE210", fr: "TP-Link CPE210" },
    quantity: 1, guest: true, payerPhone: "670008802", network: "orange", provider: "mesomb", amount: 30000, currency: "XAF", status: "paid", group: "paid",
    providerReference: "OM-REF-9", confirmedAt: ago(35), createdAt: ago(36), refund: { status: "requested" } });
  assert.deepEqual(byId["remit-1"], { kind: "cash", id: "remit-1", resellerId: "r-kiosk", resellerName: "Market kiosk", amount: 20000, currency: "XAF",
    status: "recorded", group: "paid", createdAt: ago(180), recordedBy: "owner" }, "the reseller's current name, recorded as drawn");
  assert.ok(!byId["remit-bad"], "a handoff without a valid amount is left out");
});

test("the records API filters the list by chip, searches phone, order or reference, and pages it", () => {
  const s = state(), list = (query) => queryRecords(s, { collection: "allPayments", ...query });
  assert.deepEqual(list({ status: "waiting" }).items.map((r) => r.id), ["p-wait-new", "p-wait-old"]);
  assert.deepEqual(list({ status: "paid" }).items.map((r) => r.id), ["store-o-guest", "p-paid", "remit-1"], "Paid includes recorded cash, as drawn");
  assert.deepEqual(list({ status: "failed" }).items.map((r) => r.id), ["p-failed", "p-expired-yesterday"]);
  assert.deepEqual(list({}).statuses, ["waiting", "paid", "failed"]);
  assert.deepEqual(list({ q: "1245" }).items.map((r) => r.id), ["p-wait-old"], "by phone digits");
  assert.deepEqual(list({ q: "ns-3f2a" }).items.map((r) => r.id), ["store-o-guest"], "by order reference");
  assert.deepEqual(list({ q: "mtn-ref-77" }).items.map((r) => r.id), ["p-paid"], "by provider reference");
  assert.deepEqual(list({ q: "market" }).items.map((r) => r.id), ["remit-1"], "by reseller name");
  const page = list({ page: 2, pageSize: 3 });
  assert.deepEqual([page.total, page.pages, page.items.map((r) => r.id)], [8, 3, ["p-paid", "p-failed", "remit-1"]]);
});

test("waiting over ten minutes and failed today follow the Douala day", () => {
  assert.deepEqual(paymentCounts(paymentFeed(state()), now), { waitingOverTen: 1, failedToday: 1 }, "the payment that expired at 23:30 yesterday in Douala is not today's");
  assert.equal(doualaDayStart(now).toISOString(), "2026-11-24T23:00:00.000Z");
  assert.equal(doualaDayStart(new Date("2026-11-25T23:00:00Z")).toISOString(), "2026-11-25T23:00:00.000Z");
});

test("bundles sold today count confirmed bundle payments and sold codes started today, not tests or gifts", () => {
  const s = state();
  s.payments.push(
    { id: "p-test", status: "paid", amount: 1000, provider: "mock", createdAt: ago(20), confirmedAt: ago(20) },
    { id: "p-yesterday", status: "paid", amount: 1000, provider: "mesomb", createdAt: "2026-11-24T22:00:00Z", confirmedAt: "2026-11-24T22:59:00Z" },
    { id: "p-late-confirm", status: "paid", amount: 1000, provider: "mesomb", createdAt: "2026-11-24T22:58:00Z", confirmedAt: "2026-11-24T23:01:00Z" },
  );
  s.vouchers.push(
    { id: "v-sold", generatedByAdmin: true, saleType: "sold", status: "active", activatedAt: ago(90) },
    { id: "v-gift", generatedByAdmin: true, saleType: "gift", status: "active", activatedAt: ago(90) },
    { id: "v-revoked", generatedByAdmin: true, saleType: "sold", status: "revoked", activatedAt: ago(90) },
    { id: "v-unused", generatedByAdmin: true, saleType: "sold", status: "available", activatedAt: null },
    { id: "v-online", generatedByAdmin: true, saleType: "sold", status: "active", activatedAt: ago(30), paymentId: "p-paid" },
  );
  assert.equal(bundlesSoldToday(s, now), 3, "p-paid, p-late-confirm and v-sold");
});

test("revenue today is the cash report from Douala midnight, never before the November baseline", () => {
  const s = { payments: [
    { id: "a", provider: "mesomb", providerReference: "ref-a", amount: 1000, currency: "XAF", status: "paid", confirmedAt: "2026-11-24T22:59:59Z" },
    { id: "b", provider: "mesomb", providerReference: "ref-b", amount: 2500, currency: "XAF", status: "paid", confirmedAt: "2026-11-24T23:00:00Z" },
    { id: "c", provider: "mesomb", providerReference: "ref-c", amount: 500, currency: "XAF", status: "refunded", refund: { status: "completed" }, confirmedAt: ago(10) },
  ], storeOrders: [{ payment: { id: "store-1", provider: "mesomb", providerReference: "ref-s", amount: 30000, currency: "XAF", status: "paid", confirmedAt: ago(5) } }] };
  const today = cashCollected(s, now, { since: doualaDayStart(now) });
  assert.deepEqual([today.amount, today.collected, today.refunded, today.from], [32500, 33000, 500, "2026-11-24T23:00:00.000Z"]);
  assert.equal(cashCollected(s, now, { since: "2026-10-01T00:00:00Z" }).from, "2026-10-31T23:00:00.000Z", "clamped to the baseline");
  assert.equal(cashCollected(s, now).from, "2026-11-01T00:00:00+01:00", "the default report is unchanged");
  assert.throws(() => cashCollected(s, now, { since: "not a date" }), /Invalid cash report start/);
});

test("only owners and operators read the payments list; the dashboard carries Home's figures", async (t) => {
  const secret = "feed-secret", store = createStore({ persistent: false });
  await store.transaction((s) => {
    Object.assign(s, state());
    for (const [id, role] of [["u-owner", "owner"], ["u-operator", "operator"], ["u-auditor", "auditor"], ["u-reseller2", "reseller"]]) {
      if (!s.adminUsers.some((u) => u.id === id)) s.adminUsers.push({ id, username: id, role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: id, role, tokenHash: hashSecret(`${id}-token`, secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    s.insightCounters = [{ id: "router:x", type: "router_hourly", at: new Date(Date.now() - 3600000).toISOString(), checks: 8, reached: 7 }];
  });
  const server = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", SESSION_COOKIE_SECURE: "false", ADMIN_SESSION_SECRET: secret,
    CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (user, path) => fetch(base + path, { headers: { cookie: `admin_session=${user}-token` } });
  for (const user of ["u-owner", "u-operator"]) {
    const list = await get(user, "/api/admin/records?collection=allPayments&pageSize=4");
    assert.equal(list.status, 200, user);
    assert.deepEqual((await list.json()).items.map((r) => r.id), ["p-wait-new", "p-wait-old", "store-o-guest", "p-paid"]);
  }
  for (const user of ["u-auditor", "u-reseller2"]) assert.equal((await get(user, "/api/admin/records?collection=allPayments")).status, 403, user);
  const owner = await (await get("u-owner", "/api/admin/dashboard")).json();
  assert.equal(owner.metrics.routerUptime.percent, 87.5);
  assert.equal(typeof owner.metrics.bundlesSoldToday, "number");
  assert.ok("revenueToday" in owner.metrics);
  assert.equal(typeof owner.payments.waitingOverTen, "number");
  const auditor = await (await get("u-auditor", "/api/admin/dashboard")).json();
  assert.deepEqual([auditor.metrics.revenueToday, auditor.metrics.bundlesSoldToday, auditor.payments], [null, null, undefined], "no takings for roles without payments");
  assert.equal(auditor.metrics.routerUptime.percent, 87.5);
});
