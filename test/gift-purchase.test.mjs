// Buying a bundle for someone else's number (#255, canvas: PhoneBuyForOther):
// the buyer learns only which case applies to the number; the paid bundle is
// saved for the recipient (a reservation for a number with no account, or in
// their account), never started, and never blocked by the buyer's own bundle.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { notificationItems } from "../lib/notifications.mjs";

const secret = "gift-purchase-secret", later = (hours) => new Date(Date.now() + hours * 36e5).toISOString();

async function start(t) {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.customers.push({ id: "c-buyer", name: "Amina Nfor", phone: "670001245" },
      { id: "c-account", name: "Mama Ngum", phone: "670008821" },
      { id: "c-busy", name: "Papa Ngum", phone: "670008822" },
      { id: "c-off", name: "Off", phone: "670008823", status: "suspended" });
    s.dashboardSessions.push({ id: "sess", customerId: "c-buyer", role: "customer", tokenHash: hashSecret("buyer", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    // The buyer's own bundle is running: buying for someone else is still allowed.
    s.vouchers.push({ id: "v-buyer", customerId: "c-buyer", planId: "weekly", code: "NC-BUYR-0001", status: "active", activatedAt: later(-24), expiresAt: later(100), quotaBytes: 5e9, usedBytes: 1e9, deviceLimit: 1 },
      { id: "v-busy", customerId: "c-busy", planId: "weekly", code: "NC-BUSY-0001", status: "active", activatedAt: later(-24), expiresAt: later(72), quotaBytes: 5e9, usedBytes: 1e9, deviceLimit: 1 });
  });
  const server = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: "https://portal.example.test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "not-configured", BILLING_WORKER_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, data, { buyer = true } = {}) => {
    const r = await fetch(base + path, { method: data === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(buyer ? { cookie: "customer_session=buyer", "x-csrf-token": "csrf" } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const buy = async (recipientPhone, extra = {}) => {
    const made = await call("/api/account/plan/purchase", { action: "gift", planId: "weekly", recipientPhone, recipientName: "Mama Ngum", note: "For your calls with the family ❤",
      payerPhone: "670001245", network: "mtn", requestKey: randomUUID().replaceAll("-", ""), ...extra });
    if (made.status !== 201) return made;
    assert.equal((await call(`/api/payments/${made.body.payment.id}/confirm`, {}, { buyer: false })).status, 200);
    return call(`/api/account/payments/${made.body.payment.id}/status`);
  };
  return { store, call, buy };
}

test("the buyer learns only which case applies to a number", async (t) => {
  const { call } = await start(t);
  const lookup = async (phone) => (await call("/api/account/gift/recipient", { phone })).body;
  assert.deepEqual(await lookup("670008899"), { case: "noAccount" });
  assert.deepEqual(await lookup("670008821"), { case: "hasAccount" }, "no name or other details");
  const busy = await lookup("+237 670 00 88 22");
  assert.equal(busy.case, "activeBundle");
  assert.ok(Date.parse(busy.endsAt) > Date.now());
  assert.deepEqual(await lookup("670008823"), { case: "unavailable" });
  assert.deepEqual(await lookup("670001245"), { case: "self" });
  assert.equal((await call("/api/account/gift/recipient", { phone: "12" })).status, 400);
  assert.equal((await call("/api/account/gift/recipient", { phone: "670008899" }, { buyer: false })).status, 401);
  for (let i = 0; i < 15; i++) await lookup("670008899");
  assert.equal((await call("/api/account/gift/recipient", { phone: "670008899" })).status, 429, "20 lookups an hour");
});

test("a gift for a number with no account is a reservation its owner claims", async (t) => {
  const { store, call, buy } = await start(t);
  const paid = await buy("670008899");
  assert.equal(paid.status, 200);
  const { qr, ...gift } = paid.body.gift;
  assert.deepEqual(gift, { recipientPhone: "670008899", recipientName: "Mama Ngum", note: "For your calls with the family ❤", outcome: "reserved", recipientBundleEndsAt: null });
  assert.match(qr, /^data:image\/png;base64,/, "a QR the recipient scans to claim it");
  const code = paid.body.access.code, s = await store.snapshot(), v = s.vouchers.find((x) => x.code === code);
  assert.deepEqual([v.status, v.customerId, v.reservation.status, v.reservation.phone, v.reservation.by, v.giftedBy], ["available", null, "waiting", "670008899", { type: "customer", id: "c-buyer" }, "c-buyer"]);
  assert.equal(s.vouchers.find((x) => x.id === "v-buyer").status, "active", "the buyer's own bundle is untouched");
  // The recipient claims it with their number and the code (#254).
  const check = await call("/api/account/claim/check", { phone: "670008899", code }, { buyer: false });
  assert.deepEqual([check.body.gift.from, check.body.gift.note], [{ type: "friend", name: "Amina N." }, "For your calls with the family ❤"]);
});

test("a gift for an account is saved in it, even while their bundle runs", async (t) => {
  const { store, buy } = await start(t);
  const saved = await buy("670008821");
  assert.equal(saved.body.gift.outcome, "saved");
  const busy = await buy("670008822");
  assert.equal(busy.body.gift.outcome, "savedUntilEnd");
  assert.ok(Date.parse(busy.body.gift.recipientBundleEndsAt) > Date.now());
  const s = await store.snapshot();
  const forAccount = s.vouchers.find((x) => x.code === saved.body.access.code), forBusy = s.vouchers.find((x) => x.code === busy.body.access.code);
  assert.deepEqual([forAccount.customerId, forAccount.status, Boolean(forAccount.startBy), forAccount.reservation], ["c-account", "available", true, undefined]);
  assert.deepEqual([forBusy.customerId, forBusy.status], ["c-busy", "available"]);
  assert.equal(s.vouchers.find((x) => x.id === "v-busy").status, "active", "their running bundle is untouched; there is no queue");
  const note = notificationItems(s, { type: "customer", id: "c-account" }, new Date()).find((n) => n.id === "gift-from:" + forAccount.id);
  assert.deepEqual([note.title, note.body], ["Amina bought you a bundle", '"For your calls with the family ❤" It\'s saved in your account. Start it from Vouchers when you\'re ready.']);
});

test("a gift needs another, reachable number", async (t) => {
  const { buy } = await start(t);
  assert.equal((await buy("670001245")).body.code, "GIFT_TO_SELF");
  assert.equal((await buy("670008823")).body.code, "RECIPIENT_UNAVAILABLE");
  assert.equal((await buy("12")).status, 400);
});
