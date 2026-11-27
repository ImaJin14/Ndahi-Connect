// Codes made in Admin can be used for 90 days (owner, 26 Nov 2026, on #344 and
// #368): batches and single vouchers made from now on carry a use-by date and
// stop working after it; codes made before keep working with no date; a code
// reserved for a number keeps its own claim window. The voucher page shows
// "Valid until … if not used" from it.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { USE_BY_DAYS, expireUnusedCodes, pastUseBy } from "../lib/voucher-use-by.mjs";
import { startWaitingBundle } from "../lib/device-slots.mjs";

const secret = "voucher-use-by-secret";
const env = { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
  CUSTOMER_APP_URL: "https://portal.example.test", ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock",
  MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" };
const DAY = 864e5;

async function start(t, now) {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "staff-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "staff-owner", role: "owner", tokenHash: hashSecret("token-owner", secret), csrfToken: "csrf-owner", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.customers.push({ id: "c-amina", name: "Amina", phone: "670001245" });
  });
  const server = createServer({ store, validateConfig: false, env, now: () => now.value });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let ip = 0;
  const post = async (path, input, admin) => {
    const headers = { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${++ip % 250}`,
      ...(admin ? { cookie: "admin_session=token-owner", origin: "http://admin.test", "x-csrf-token": "csrf-owner" } : { origin: "https://portal.example.test" }) };
    const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(input) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return { store, post };
}

test("a batch, a single voucher and an account's voucher get a 90-day use-by date; a reserved one keeps its claim window", async (t) => {
  const now = { value: new Date("2026-11-27T09:00:00.000Z") }, f = await start(t, now);
  const batch = await f.post("/api/admin/vouchers/generate", { planId: "weekly", quantity: 2, purpose: "resale", saleType: "sold" }, true);
  const single = await f.post("/api/admin/vouchers/generate", { planId: "weekly", purpose: "assigned", saleType: "gift", customerId: "c-amina" }, true);
  const reserved = await f.post("/api/admin/vouchers/generate", { planId: "weekly", purpose: "assigned", saleType: "gift", reservedPhone: "670009910" }, true);
  assert.deepEqual([batch.status, single.status, reserved.status], [201, 201, 201]);
  const s = await f.store.snapshot(), byId = (id) => s.vouchers.find((v) => v.id === id);
  for (const made of [...batch.body.vouchers, single.body.voucher]) {
    const v = byId(made.id);
    assert.equal(Date.parse(v.useBy) - Date.parse(v.createdAt), USE_BY_DAYS * DAY);
  }
  assert.equal(byId(reserved.body.voucher.id).useBy, undefined, "a reserved code keeps its own claim window");
});

test("an unused code past its use-by date stops working; one made before the rule keeps working", async (t) => {
  const now = { value: new Date("2026-11-27T09:00:00.000Z") }, f = await start(t, now);
  const made = await f.post("/api/admin/vouchers/generate", { planId: "weekly", quantity: 2, purpose: "resale", saleType: "sold" }, true);
  const [late, onTime] = made.body.vouchers;
  // A code made before the rule: no date.
  await f.store.transaction((s) => s.vouchers.push({ id: "old", code: "NC-R2DA-8AQN", planId: "weekly", status: "available", quotaBytes: 5e9, usedBytes: 0, deviceLimit: 1, generatedByAdmin: true, resale: true, createdAt: "2025-01-01T00:00:00.000Z" }));
  now.value = new Date(+now.value + (USE_BY_DAYS + 1) * DAY);
  const refused = await f.post("/api/vouchers/redeem", { phone: "670002222", code: late.code, deviceId: "d1" });
  assert.equal(refused.status, 401, "the same answer as any unknown code");
  assert.equal((await f.store.snapshot()).vouchers.find((v) => v.id === late.id).status, "expired");
  assert.equal(typeof (await f.store.snapshot()).vouchers.find((v) => v.id === late.id).expiredUnusedAt, "string");
  const old = await f.post("/api/vouchers/redeem", { phone: "670003333", code: "NC-R2DA-8AQN", deviceId: "d2" });
  assert.equal(old.status, 200, "a code made before the rule keeps working: " + JSON.stringify(old.body));
  // Housekeeping (run with each request here) has expired the other one too.
  const s = await f.store.snapshot();
  assert.equal(s.vouchers.find((v) => v.id === onTime.id).status, "expired");
  assert.deepEqual(expireUnusedCodes(s, now.value), [], "nothing left to expire");
});

test("the rule in isolation: pastUseBy, housekeeping, and a waiting bundle can't start after its date", () => {
  const now = new Date("2026-11-27T09:00:00.000Z"), v = { id: "w", status: "available", startsOnFirstConnection: true, accessType: "personal_unlimited", validityHours: 168, useBy: "2026-11-26T09:00:00.000Z" };
  assert.equal(pastUseBy(v, now), true);
  assert.equal(pastUseBy({ ...v, useBy: undefined }, now), false, "no date, no expiry");
  assert.equal(pastUseBy({ ...v, status: "active" }, now), false, "only unused codes");
  const s = { vouchers: [v], auditLogs: [], routerCommands: [] };
  assert.equal(startWaitingBundle(s, v, now, "device_request"), false);
  assert.equal(v.status, "expired");
  assert.equal(v.activatedAt, undefined, "it never started");
});
