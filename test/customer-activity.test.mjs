// Server task 1 for the redesign's AdminCustomers filters (#256): each customer's
// activity derived from voucher history, the Active / Stale / Suspended filter
// with a count per chip, and the filtered list as CSV for owners and operators.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore, blank } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { customerActivity, parseRecordQuery, queryRecords, RecordQueryError } from "../lib/admin-records.mjs";

const now = new Date("2026-11-13T12:00:00Z"), daysAgo = (n) => new Date(+now - n * 864e5).toISOString();

function state() {
  const s = blank();
  const customer = (id, name, joined, extra = {}) => s.customers.push({ id, name, phone: `67000${id.padStart(4, "0")}`, createdAt: daysAgo(joined), ...extra });
  customer("a", "Amina", 90); customer("b", "Fon", 60); customer("c", "Ekane", 80); customer("d", "Grace", 41);
  customer("e", "Nji", 70, { status: "suspended" }); customer("f", "New", 0); customer("g", "Unused", 20); customer("h", "Revoked", 50);
  const voucher = (id, customerId, status, extra = {}) => s.vouchers.push({ id, customerId, status, planId: "weekly", quotaBytes: null, usedBytes: 0, deviceLimit: 1, ...extra });
  voucher("va", "a", "active", { activatedAt: daysAgo(2), expiresAt: daysAgo(-5) });
  voucher("vb", "b", "expired", { activatedAt: daysAgo(16), expiresAt: daysAgo(9) });
  voucher("vb-old", "b", "expired", { activatedAt: daysAgo(40), expiresAt: daysAgo(33) });
  voucher("vc", "c", "exhausted", { activatedAt: daysAgo(45), exhaustedAt: daysAgo(42), expiresAt: daysAgo(38) });
  voucher("ve", "e", "active", { activatedAt: daysAgo(1), expiresAt: daysAgo(-6) });
  voucher("vg", "g", "available", { createdAt: daysAgo(3) });
  voucher("vh", "h", "revoked", { activatedAt: daysAgo(20), expiresAt: daysAgo(13) });
  s.sessions.push({ id: "s1", customerId: "a", voucherId: "va", status: "online" });
  return s;
}

test("activity is derived from voucher history", () => {
  const activity = customerActivity(state(), { now, staleDays: 30 }), get = (id) => activity.get(id);
  assert.deepEqual(get("a"), { state: "active", online: true, hasBundle: true, neverBought: false, idleDays: null, lastEndedAt: null, joinedAt: daysAgo(90) });
  assert.deepEqual([get("b").state, get("b").idleDays, get("b").lastEndedAt], ["active", 9, daysAgo(9)], "the latest ended bundle counts");
  assert.deepEqual([get("c").state, get("c").idleDays], ["stale", 42], "a quota cut-off ends a bundle when it happened");
  assert.deepEqual([get("d").state, get("d").neverBought, get("d").idleDays], ["stale", true, 41]);
  assert.equal(get("e").state, "suspended", "suspension wins over an active bundle");
  assert.deepEqual([get("f").state, get("f").neverBought], ["stale", true], "signed up and never bought is stale at once");
  assert.equal(get("g").neverBought, true, "an unused voucher is not a bought bundle");
  assert.deepEqual([get("h").state, get("h").idleDays], ["active", 13], "a revoked bundle without a stop time uses its expiry");
  const week = customerActivity(state(), { now, staleDays: 7 });
  assert.deepEqual([week.get("b").state, week.get("h").state], ["stale", "stale"]);
});

test("the filter keeps a count per chip, applied after search", () => {
  const query = (params) => queryRecords(state(), parseRecordQuery(new URLSearchParams({ collection: "customers", ...params })), { now });
  const all = query({});
  assert.deepEqual(all.counts, { all: 8, active: 3, stale: 4, suspended: 1 });
  assert.equal(all.staleDays, 30);
  const stale = query({ activity: "stale" });
  assert.deepEqual(stale.items.map((c) => c.id).sort(), ["c", "d", "f", "g"]);
  assert.equal(stale.total, 4);
  assert.deepEqual(stale.counts, all.counts, "counts describe every chip, not just the chosen one");
  assert.equal(stale.items.find((c) => c.id === "c").activity.idleDays, 42);
  assert.equal(query({ activity: "stale", staleDays: "7" }).total, 6);
  assert.deepEqual(query({ q: "fon" }).counts, { all: 1, active: 1, stale: 0, suspended: 0 });
  const parse = (params) => parseRecordQuery(new URLSearchParams(params));
  for (const bad of ["collection=vouchers&activity=stale", "collection=customers&activity=dormant", "collection=customers&staleDays=10", "collection=customers&staleDays=x"])
    assert.throws(() => parse(bad), RecordQueryError, bad);
  assert.equal(parse("collection=vouchers").activity, undefined, "only customers take the filter");
});

test("owners and operators read the filtered list and export it; other roles cannot", async (t) => {
  const store = createStore({ persistent: false }), secret = "customer-activity-secret", seed = state();
  await store.transaction((s) => {
    s.customers.push(...seed.customers); s.vouchers.push(...seed.vouchers); s.sessions.push(...seed.sessions);
    for (const role of ["owner", "operator", "auditor", "reseller"]) {
      s.adminUsers.push({ id: `staff-${role}`, username: role, role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: `staff-${role}`, role, tokenHash: hashSecret(`token-${role}`, secret), csrfToken: `csrf-${role}`, expiresAt: "2099-01-01T00:00:00.000Z" });
    }
  });
  const server = createServer({ store, validateConfig: false, now: () => now, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (role, path) => fetch(base + path, { headers: { cookie: `admin_session=token-${role}`, origin: "http://admin.test" } });
  const list = await get("owner", "/api/admin/records?collection=customers&activity=stale&staleDays=30");
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.deepEqual(body.counts, { all: 8, active: 3, stale: 4, suspended: 1 });
  assert.deepEqual(body.items.map((c) => [c.id, c.activity?.state, "pinHash" in c]).sort(), [["c", "stale", false], ["d", "stale", false], ["f", "stale", false], ["g", "stale", false]]);
  for (const role of ["owner", "operator"]) {
    const csv = await get(role, "/api/admin/export?collection=customers&activity=stale&staleDays=30");
    assert.equal(csv.status, 200, role);
    assert.match(csv.headers.get("content-disposition"), /ndahi-customers-stale\.csv/);
    const lines = (await csv.text()).split("\n");
    assert.equal(lines[0], "name,phone,state,idleDays,lastBundleEnded,joined");
    assert.equal(lines.length, 5);
    assert.ok(lines.some((line) => line.startsWith('"Ekane","67000000c","stale","42"')), lines.join("\n"));
  }
  for (const role of ["auditor", "reseller"]) assert.equal((await get(role, "/api/admin/export?collection=customers")).status, 403, role);
});
