import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { createTransactionalEmailService } from "../lib/transactional-email.mjs";

// Vouchers staff give (AdminVouchers, #343; owner 26 Nov): the customer gets a
// notification and the usual voucher email; a voucher reserved for a number
// with no account gets neither until it is claimed. Recent vouchers finds a
// voucher by its customer's name or the number it is reserved for.
const secret = "admin-gift-notice";
async function fixture(t) {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.bundles.push({ id: "p2", name: "Weekly Unlimited", price: 3500, validityHours: 168, accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaGb: null, status: "published", catalogue: "unlimited" },
      { id: "legacy", name: "Legacy 5 GB", price: 1000, validityHours: 168, deviceLimit: 1, quotaGb: 5 });
    s.customers.push({ id: "c-amina", name: "Amina Nfor", phone: "670001245", email: "amina@example.test", emailVerifiedAt: "2026-11-01T00:00:00.000Z", status: "active" });
    s.adminUsers.push({ id: "owner", username: "owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "owner", role: "owner", tokenHash: hashSecret("owner", secret), csrfToken: "csrf-owner", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.dashboardSessions.push({ id: "amina", customerId: "c-amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf-amina", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const server = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, PAYMENT_MODE: "mock",
    EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false", LOG_LEVEL: "silent" } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = async (path, input) => {
    const r = await fetch(base + path, { method: input ? "POST" : "GET", headers: { cookie: "admin_session=owner", "x-csrf-token": "csrf-owner", ...(input ? { "content-type": "application/json" } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const notices = async () => (await (await fetch(`${base}/api/account/notifications?view=all`, { headers: { cookie: "customer_session=amina" } })).json());
  return { store, admin, notices };
}

test("a voucher given to an account brings a notification and the voucher email", async (t) => {
  const f = await fixture(t);
  const given = await f.admin("/api/admin/vouchers/generate", { customerId: "c-amina", planId: "legacy", purpose: "assigned", saleType: "gift" });
  assert.equal(given.status, 201);
  const v = (await f.store.snapshot()).vouchers.find((x) => x.id === given.body.voucher.id);
  assert.equal(typeof v.givenAt, "string");
  assert.equal(v.emailDelivery.status, "pending");
  const inbox = await f.notices();
  const notice = (inbox.items || inbox.notifications || []).find((n) => n.id === `given:${v.id}`);
  assert.ok(notice, "the customer sees it in their notifications");
  assert.equal(notice.title, "A bundle was added to your account");
  assert.equal(notice.url, "/dashboard#internet");

  // The email worker sends it although there was no payment.
  const sent = [];
  const service = createTransactionalEmailService({ store: f.store, now: () => new Date(), pepper: secret, planFor: (s, id) => s.bundles.find((p) => p.id === id),
    email: { configured: () => true, sendVoucher: async (message) => { sent.push(message); return { messageId: "m1" }; } } });
  await service.voucher(v.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].voucher.code, v.code);
  assert.deepEqual(sent[0].payment, { amount: 0, currency: "XAF", given: true });
  assert.equal(sent[0].customer.email, "amina@example.test");
});

test("a voucher reserved for a number brings no notice or email until claimed; custom gifts read as drawn", async (t) => {
  const f = await fixture(t);
  const reserved = await f.admin("/api/admin/vouchers/generate", { reservedPhone: "670009910", planId: "p2", purpose: "assigned", saleType: "gift" });
  assert.equal(reserved.status, 201);
  const v = (await f.store.snapshot()).vouchers.find((x) => x.id === reserved.body.voucher.id);
  assert.equal(v.givenAt, undefined);
  assert.equal(v.emailDelivery, undefined);
  // A custom gift for the account (owner).
  const custom = await f.admin("/api/admin/vouchers/generate", { customerId: "c-amina", planMode: "customGift", saleType: "gift", purpose: "assigned", reason: "Outage at AP-Market",
    customTerms: { accessType: "personal_unlimited", validityValue: 10, validityUnit: "days", deviceSlots: 3 } });
  assert.equal(custom.status, 201);
  assert.equal(custom.body.plan.name, "Gift from NDAHI · Unlimited · 10 days · 3 devices");
  // Recent vouchers: "Code, name or number".
  const byName = await f.admin("/api/admin/records?collection=vouchers&q=Amina");
  assert.deepEqual(byName.body.items.map((x) => x.id), [custom.body.voucher.id]);
  const byNumber = await f.admin("/api/admin/records?collection=vouchers&q=670009910");
  assert.deepEqual(byNumber.body.items.map((x) => x.id), [v.id]);
});
