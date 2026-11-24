// Server-priced checkout with an immutable terms snapshot (#333, spec §2):
// the server prices every checkout from the catalogue and keeps the terms and
// the quote on the order; edits, unpublishing and retries never change what
// was bought.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { seedCatalogue } from "../lib/catalogue.mjs";

const secret = "unlimited-checkout-tests", MIN = 60000, HOUR = 36e5;

async function fixture(t, { mode = "unlimited" } = {}) {
  const store = createStore({ persistent: false });
  let now = new Date("2026-11-25T10:00:00Z");
  await store.transaction((s) => {
    s.adminUsers.push({ id: "owner", role: "owner", username: "owner", active: true });
    s.adminSessions.push({ id: "owner", userId: "owner", role: "owner", tokenHash: hashSecret("owner", secret), csrfToken: "csrf-owner", expiresAt: "2031-01-01T00:00:00Z" });
    seedCatalogue(s, now);
    s.catalogue.mode = mode;
  });
  const server = createServer({ store, now: () => now, validateConfig: false, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret,
    SECRET_PEPPER: secret, NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false", LOG_LEVEL: "silent" } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (path, input, admin) => {
    const r = await fetch(base + path, { method: input ? "POST" : "GET",
      headers: { ...(input ? { "content-type": "application/json" } : {}), ...(admin ? { cookie: "admin_session=owner", "x-csrf-token": "csrf-owner" } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return { store, call, at: (time) => { now = new Date(time); }, now: () => now };
}
const order = (planId, extra = {}) => ({ phone: "699112233", planId, network: "mtn", requestKey: randomUUID(), ...extra });

test("the server prices the checkout: amount, name, validity, slots and access type sent by the browser are ignored", async (t) => {
  const f = await fixture(t);
  const placed = await f.call("/api/purchase", order("unlimited-7d-2", { amount: 1, price: 1, name: "Free", validityHours: 9999, deviceSlots: 6, deviceLimit: 6,
    accessType: "home_wisp_unlimited", quotaGb: 1, fee: 0, total: 1 }));
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const p = (await f.store.snapshot()).payments[0];
  assert.deepEqual([p.planId, p.amount], ["unlimited-7d-2", 4000]);
  assert.ok(p.fee !== 0 && p.total !== 1, "the fee and total are the server's quote, not the request's");
  assert.deepEqual([p.planSnapshot.name, p.planSnapshot.validityHours, p.planSnapshot.deviceSlots, p.planSnapshot.accessType, p.planSnapshot.quotaGb],
    ["Personal Unlimited", 168, 2, "personal_unlimited", null]);
});

test("the terms and quote are fixed at checkout: an admin edit changes new checkouts only", async (t) => {
  const f = await fixture(t);
  const placed = await f.call("/api/purchase", order("unlimited-30d-2"));
  const before = structuredClone((await f.store.snapshot()).payments[0]);
  const bundle = (await f.call("/api/admin/catalogue", null, true)).body.bundles.find((b) => b.id === "unlimited-30d-2");
  assert.equal((await f.call("/api/admin/catalogue/update", { id: bundle.id, version: bundle.version, price: 12000, deviceSlots: 3 }, true)).status, 200);
  f.at(+f.now() + 2 * MIN);
  assert.equal((await f.call(`/api/payments/${placed.body.payment.id}/confirm`, {})).status, 200);
  const s = await f.store.snapshot(), p = s.payments.find((x) => x.id === placed.body.payment.id), v = s.vouchers.find((x) => x.paymentId === p.id);
  assert.deepEqual([p.amount, p.fee, p.total, p.planSnapshot], [before.amount, before.fee, before.total, before.planSnapshot], "the order keeps what was quoted");
  assert.deepEqual([v.deviceLimit, v.deviceSlots, v.accessType, v.sharing, v.quotaBytes], [2, 2, "personal_unlimited", false, null], "the voucher carries the terms bought");
  assert.equal(p.receipt.amount ?? p.amount, 10000);
  // A new checkout gets the edit.
  await f.call("/api/purchase", order("unlimited-30d-2", { phone: "699445566" }));
  const next = (await f.store.snapshot()).payments[0];
  assert.deepEqual([next.amount, next.planSnapshot.deviceSlots], [12000, 3]);
});

// Today the bundle starts when the payment is confirmed (never at checkout);
// starting Unlimited bundles at the first connection comes with the device
// binding at HotSpot sign-in (#334), where that connection is observed.
test("validity starts when the payment is confirmed, not at checkout; retries and duplicate confirmations never charge twice or restart it", async (t) => {
  const f = await fixture(t);
  const input = order("unlimited-24h-1");
  const first = await f.call("/api/purchase", input);
  // The connection drops; the browser retries with the same key.
  const retry = await f.call("/api/purchase", input);
  assert.equal(retry.body.payment.id, first.body.payment.id);
  assert.equal((await f.store.snapshot()).payments.length, 1, "one order, one charge");
  // Approved four minutes after checkout: the 24 hours start then, not at checkout.
  f.at(+f.now() + 4 * MIN);
  const activatedAt = f.now().toISOString();
  await f.call(`/api/payments/${first.body.payment.id}/confirm`, {});
  f.at(+f.now() + 10 * MIN);
  await f.call(`/api/payments/${first.body.payment.id}/confirm`, {});
  const s = await f.store.snapshot(), vouchers = s.vouchers.filter((v) => v.paymentId === first.body.payment.id);
  assert.equal(vouchers.length, 1, "a duplicate confirmation activates nothing more");
  assert.deepEqual([vouchers[0].activatedAt, vouchers[0].expiresAt], [activatedAt, new Date(Date.parse(activatedAt) + 24 * HOUR).toISOString()]);
});

test("a bundle taken off sale: a quote still on screen gets a clear error, a pending order keeps its terms", async (t) => {
  const f = await fixture(t);
  const pending = await f.call("/api/purchase", order("unlimited-7d-1"));
  await f.call("/api/admin/catalogue/unpublish", { id: "unlimited-7d-1" }, true);
  const stale = await f.call("/api/purchase", order("unlimited-7d-1", { phone: "699778899" }));
  assert.deepEqual([stale.status, stale.body.code, stale.body.error], [409, "BUNDLE_NOT_ON_SALE", "This bundle is no longer on sale. Choose another bundle."]);
  assert.equal((await f.call("/api/purchase", order("unlimited-9d-9", { phone: "699778800" }))).status, 400, "an id that never existed");
  // Paid before checkout expiry: activated at the price and terms recorded.
  assert.equal((await f.call(`/api/payments/${pending.body.payment.id}/confirm`, {})).status, 200);
  const v = (await f.store.snapshot()).vouchers.find((x) => x.paymentId === pending.body.payment.id);
  assert.deepEqual([v.status, v.deviceSlots, v.planId], ["active", 1, "unlimited-7d-1"]);
});

test("Revoke subscription ends one customer's access, at the router, audited", async (t) => {
  const f = await fixture(t);
  const placed = await f.call("/api/purchase", order("home-wisp-30d"));
  await f.call(`/api/payments/${placed.body.payment.id}/confirm`, {});
  const v = (await f.store.snapshot()).vouchers.find((x) => x.paymentId === placed.body.payment.id);
  assert.deepEqual([v.accessType, v.sharing, v.deviceSlots], ["home_wisp_unlimited", true, 1]);
  const revoked = await f.call("/api/admin/vouchers/revoke", { voucherId: v.id }, true);
  assert.equal(revoked.status, 200);
  const s = await f.store.snapshot();
  assert.equal(s.vouchers.find((x) => x.id === v.id).status, "revoked");
  assert.ok(s.routerCommands.some((c) => c.action === "disconnect_voucher" && c.targetId === v.id));
  assert.ok(s.auditLogs.some((a) => a.action === "voucher.revoked" && a.meta.voucherId === v.id));
});

test("a legacy bundle is unaffected: a fixed-data purchase under the legacy catalogue is exactly as before", async (t) => {
  const f = await fixture(t, { mode: "legacy" });
  const placed = await f.call("/api/purchase", order("weekly"));
  assert.equal(placed.status, 201);
  await f.call(`/api/payments/${placed.body.payment.id}/confirm`, {});
  const v = (await f.store.snapshot()).vouchers.find((x) => x.paymentId === placed.body.payment.id);
  assert.deepEqual([v.quotaBytes, v.deviceLimit], [5e9, 1]);
  for (const key of ["accessType", "deviceSlots", "sharing"]) assert.equal(key in v, false, `no ${key} on a fixed-data voucher`);
});
