// Custom bundles given by the owner (#421; decisions.md → "Custom bundles
// given by an admin"): Unlimited terms set by hand, always a gift, owner only,
// with a reason, never in the catalogue; the voucher carries its own terms.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { seedCatalogue } from "../lib/catalogue.mjs";

const secret = "custom-gift-tests", HOUR = 36e5;

async function fixture(t) {
  const store = createStore({ persistent: false });
  let now = new Date("2026-11-25T10:00:00Z");
  await store.transaction((s) => {
    for (const role of ["owner", "operator"]) {
      s.adminUsers.push({ id: role, role, username: role, active: true });
      s.adminSessions.push({ id: role, userId: role, role, tokenHash: hashSecret(role, secret), csrfToken: "csrf-" + role, expiresAt: "2031-01-01T00:00:00Z" });
    }
    s.customers.push({ id: "amina", name: "Amina", phone: "670000001", email: "" }, { id: "paul", name: "Paul", phone: "670000002", email: "" });
    // Paul has a fixed-data bundle running, bought before the Unlimited catalogue.
    s.vouchers.push({ id: "v-weekly", customerId: "paul", planId: "weekly", code: "NC-WEEK-0001", status: "active", activatedAt: "2026-11-24T10:00:00.000Z",
      expiresAt: "2026-12-01T10:00:00.000Z", quotaBytes: 5e9, usedBytes: 1e9, deviceLimit: 1 });
    seedCatalogue(s, now);
  });
  const server = createServer({ store, now: () => now, validateConfig: false, env: { NODE_ENV: "test", PAYMENT_MODE: "mock", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret,
    SECRET_PEPPER: secret, NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false", LOG_LEVEL: "silent" } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (path, input, role) => {
    const r = await fetch(base + path, { method: input ? "POST" : "GET",
      headers: { ...(input ? { "content-type": "application/json" } : {}), ...(role ? { cookie: "admin_session=" + role, "x-csrf-token": "csrf-" + role } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return { store, call, at: (time) => { now = new Date(time); }, now: () => now };
}
const custom = (extra = {}, terms = {}) => ({ purpose: "assigned", saleType: "gift", planMode: "customGift", customerId: "amina", reason: "Outage compensation, 23 Nov",
  customTerms: { accessType: "personal_unlimited", validityValue: 7, validityUnit: "days", deviceSlots: 2, ...terms }, ...extra });

test("the owner gives a custom Personal Unlimited gift: its own terms on the voucher, never in the catalogue", async (t) => {
  const f = await fixture(t);
  const given = await f.call("/api/admin/vouchers/generate", custom(), "owner");
  assert.equal(given.status, 201, JSON.stringify(given.body));
  const s = await f.store.snapshot(), v = s.vouchers.find((x) => x.id === given.body.voucher.id);
  assert.deepEqual([v.customTerms.name, v.accessType, v.deviceSlots, v.deviceLimit, v.sharing, v.quotaBytes, v.saleType, v.saleAmount, v.faceValue],
    ["Gift from NDAHI · 7 days · 2 devices", "personal_unlimited", 2, 2, false, null, "gift", 0, null]);
  assert.equal(v.customTerms.validityHours, 168);
  assert.equal(s.bundles.some((b) => b.id === v.planId), false, "not written to the catalogue");
  await f.call("/api/admin/catalogue/mode", { mode: "unlimited" }, "owner");
  assert.equal((await f.call("/api/plans")).body.plans.some((p) => p.id === v.planId || /Gift/.test(p.name)), false, "never offered for sale");
  assert.equal((await f.call("/api/purchase", { phone: "699000001", planId: v.planId, requestKey: "k".repeat(24) })).status, 400, "can't be bought");
  const audit = s.auditLogs.find((a) => a.action === "voucher.custom_gift_given");
  assert.deepEqual([audit.meta.customerId, audit.meta.reason, audit.meta.terms.deviceSlots], ["amina", "Outage compensation, 23 Nov", 2]);
});

test("a custom Home WISP gift is one router with household sharing, whatever is sent", async (t) => {
  const f = await fixture(t);
  const given = await f.call("/api/admin/vouchers/generate", custom({}, { accessType: "home_wisp_unlimited", validityValue: 30, deviceSlots: 6 }), "owner");
  assert.equal(given.status, 201, JSON.stringify(given.body));
  const v = (await f.store.snapshot()).vouchers.find((x) => x.id === given.body.voucher.id);
  assert.deepEqual([v.customTerms.name, v.accessType, v.deviceSlots, v.sharing], ["Gift from NDAHI · 30 days · household sharing", "home_wisp_unlimited", 1, true]);
});

test("owners only: an operator's custom request is refused even sent straight to the API; catalogue gifts still work for them", async (t) => {
  const f = await fixture(t);
  const refused = await f.call("/api/admin/vouchers/generate", custom(), "operator");
  assert.equal(refused.status, 403);
  assert.equal((await f.store.snapshot()).vouchers.length, 1, "nothing given");
  assert.equal((await f.call("/api/admin/vouchers/generate", { purpose: "assigned", saleType: "gift", customerId: "amina", planId: "weekly" }, "operator")).status, 201);
});

test("a tampered or incomplete request is refused: price, revenue, validity, slots, reason, resale", async (t) => {
  const f = await fixture(t);
  for (const [extra, terms, label] of [
    [{ price: 5000 }, {}, "a price"], [{ saleAmount: 5000 }, {}, "a sale amount"], [{ saleType: "sold" }, {}, "sold"],
    [{ reason: "" }, {}, "no reason"], [{ reason: "x".repeat(301) }, {}, "reason too long"], [{ purpose: "resale" }, {}, "resale stock"],
    [{}, { validityValue: 0 }, "no validity"], [{}, { validityValue: 366, validityUnit: "days" }, "over 365 days"], [{}, { validityUnit: "weeks" }, "a unit"],
    [{}, { deviceSlots: 0 }, "no slots"], [{}, { deviceSlots: 11 }, "11 slots"], [{}, { accessType: "fixed_data" }, "fixed data"],
  ]) {
    const r = await f.call("/api/admin/vouchers/generate", custom(extra, terms), "owner");
    assert.ok([400, 403].includes(r.status), `${label}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.equal((await f.store.snapshot()).vouchers.length, 1, "nothing given");
});

test("reserved for a number with no account: claimed with the code, then started with its own terms", async (t) => {
  const f = await fixture(t);
  const given = await f.call("/api/admin/vouchers/generate", custom({ customerId: undefined, reservedPhone: "699112233" }), "owner");
  assert.equal(given.status, 201, JSON.stringify(given.body));
  const code = (await f.store.snapshot()).vouchers.find((x) => x.id === given.body.voucher.id).code;
  const check = await f.call("/api/account/claim/check", { phone: "699112233", code });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual([check.body.gift.plan.name, check.body.gift.plan.validityHours], ["Gift from NDAHI · 7 days · 2 devices", 168]);
  assert.equal((await f.call("/api/account/claim/complete", { token: check.body.token, pin: "4829", confirmPin: "4829", name: "Guest" })).status, 200);
  const started = await f.call("/api/vouchers/redeem", { phone: "699112233", code, deviceId: "phone-1" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const v = (await f.store.snapshot()).vouchers.find((x) => x.id === given.body.voucher.id);
  assert.deepEqual([v.status, v.expiresAt], ["active", new Date(+f.now() + 168 * HOUR).toISOString()]);
});

test("a legacy bundle is unaffected: replacing it needs the usual confirmation, and without it nothing changes", async (t) => {
  const f = await fixture(t);
  const before = JSON.stringify((await f.store.snapshot()).vouchers);
  const blocked = await f.call("/api/admin/vouchers/generate", custom({ customerId: "paul" }), "owner");
  assert.deepEqual([blocked.status, blocked.body.code], [409, "ACTIVE_BUNDLE_EXISTS"]);
  assert.equal(JSON.stringify((await f.store.snapshot()).vouchers), before, "Paul's fixed-data bundle and everything else unchanged");
  const replaced = await f.call("/api/admin/vouchers/generate", custom({ customerId: "paul", replaceActive: true }), "owner");
  assert.equal(replaced.status, 201);
  assert.equal((await f.store.snapshot()).vouchers.find((v) => v.id === "v-weekly").status, "replaced", "only with the explicit confirmation");
});
