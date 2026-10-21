import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";

const at = "2030-01-01T12:00:00.000Z", origin = "http://admin.test";
async function fixture(t) {
  const store = createStore({ persistent: false }), secret = randomUUID(), roles = ["owner", "operator", "auditor", "reseller"], tokens = Object.fromEntries(roles.map((r) => [r, randomUUID()]));
  await store.transaction((s) => {
    for (const role of roles) {
      s.adminUsers.push({ id: `staff-${role}`, username: role, active: true, role, passwordHash: "PRIVATE_PASSWORD", passkeys: [{ id: "PRIVATE_PASSKEY" }] });
      s.adminSessions.push({ userId: `staff-${role}`, tokenHash: hashSecret(tokens[role], secret), role: "owner", csrfToken: "csrf", expiresAt: "2030-01-02T00:00:00Z" });
    }
    s.zone.authenticationMigrationReview = { evidenceReference: "PRIVATE_MIGRATION_REVIEW" };
    s.zone.authenticatorRetirement = { digest: "PRIVATE_RETIREMENT" };
    s.customers.push({ id: "c1", name: "Account owner", phone: "670000001", pinHash: "PRIVATE_PIN", totpSecret: "PRIVATE_TOTP", recoveryCodes: ["PRIVATE_RECOVERY"], authMigration: { intent: "PRIVATE_MIGRATION" } },
      { id: "c2", name: "Resale customer", phone: "670000002" });
    s.payments.push({ id: "p1", customerId: "c1", status: "paid", amount: 500, currency: "XAF", provider: "mock", providerReference: "REFERENCE-1", payerPhone: "699999999", requestKey: "PRIVATE_REQUEST", guestSetup: { code: "PRIVATE_SETUP" } },
      { id: "p2", customerId: "c2", status: "paid", amount: 500, payerPhone: "699999998", providerReference: "REFERENCE-2" });
    const voucher = (id, fields) => ({ id, code: `NC-${id}`, planId: "weekly", status: "active", quotaBytes: 1000000, usedBytes: 250000, deviceLimit: 2, activatedAt: at, expiresAt: "2030-01-03T00:00:00Z", privateFutureField: "PRIVATE_VOUCHER", ...fields });
    s.vouchers.push(voucher("linked", { customerId: "c1", paymentId: "p1" }),
      voucher("stock", { customerId: null, status: "available", activatedAt: null, createdAt: at, generatedByAdmin: true, generatedByAdminId: "staff-reseller", assignedResellerId: "staff-reseller" }),
      voucher("resale", { customerId: "c2", paymentId: "p2", status: "exhausted", usedBytes: 1000000, generatedByAdmin: true, generatedByAdminId: "staff-reseller" }),
      voucher("assigned-away", { status: "expired", expiresAt: "2029-01-01T00:00:00Z", generatedByAdminId: "staff-reseller", assignedResellerId: "another-reseller" }),
      voucher("legacy", { customerId: "c1", generatedByAdmin: true }));
  });
  const server = createServer({ store, now: () => new Date(at), validateConfig: false, env: {
    NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", PAYMENT_WEBHOOK_WORKER_ENABLED: "false", SESSION_COOKIE_SECURE: "false", ADMIN_SESSION_SECRET: secret, ADMIN_APP_URL: origin, ALLOWED_ADMIN_ORIGINS: origin,
  } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const call = async (role, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}` + path, { method: body ? "POST" : "GET", headers: { cookie: `admin_session=${tokens[role]}`, origin, "content-type": "application/json", "x-csrf-token": "csrf" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text.startsWith("{") ? JSON.parse(text) : null };
  };
  return { store, call };
}
const details = (id) => `/api/admin/vouchers/${id}/details`;
const records = (query = "") => "/api/admin/records?collection=vouchers" + query;

test("voucher ownership is current, whitelisted, read-only and distinct from an alternate payer", async (t) => {
  const f = await fixture(t);
  await f.call("owner", records()); // Normalize legacy fixture data before the no-mutation assertion.
  const before = await f.store.snapshot();
  for (const role of ["owner", "operator"]) {
    const result = await f.call(role, details("linked"));
    assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "no-store");
    assert.deepEqual(result.body.ownership, { state: "linked", customerId: "c1", name: "Account owner", accountPhone: "670000001" });
    assert.equal(result.body.payment.payerPhone, "699999999"); assert.equal(result.body.payment.providerReference, "REFERENCE-1");
    assert.equal(result.body.remainingBytes, 750000); assert.equal(result.body.plan.id, "weekly");
    assert.doesNotMatch(result.text, /PRIVATE_/); assert.equal(result.body.voucher.code, undefined);
  }
  const after = await f.store.snapshot();
  for (const collection of ["vouchers", "customers", "payments", "routerCommands", "auditLogs"]) assert.deepEqual(after[collection], before[collection], collection);
  await f.store.transaction((s) => { Object.assign(s.customers.find((c) => c.id === "c1"), { name: "Updated customer", phone: "670000003" }); });
  const refreshed = await f.call("owner", details("linked"));
  assert.equal(refreshed.body.ownership.name, "Updated customer"); assert.equal(refreshed.body.ownership.accountPhone, "670000003");
  assert.equal(refreshed.body.payment.payerPhone, "699999999");
  const stock = await f.call("owner", details("stock")); assert.deepEqual(stock.body.ownership, { state: "unlinked" });
  await f.store.transaction((s) => { s.customers = s.customers.filter((c) => c.id !== "c1"); });
  assert.deepEqual((await f.call("owner", details("linked"))).body.ownership, { state: "unavailable" }, "never infer account ownership from payment");
});

test("every staff role shares one voucher scope across lists, counts, filters, export and direct IDs", async (t) => {
  const f = await fixture(t);
  for (const role of ["owner", "operator", "auditor", "reseller"]) {
    const restricted = ["auditor", "reseller"].includes(role), ids = role === "reseller" ? ["stock", "resale"] : ["linked", "stock", "resale", "assigned-away", "legacy"];
    const result = await f.call(role, records());
    assert.equal(result.status, 200); assert.equal(result.body.total, ids.length); assert.deepEqual(result.body.items.map((v) => v.id), ids);
    assert.doesNotMatch(result.text, /PRIVATE_/);
    assert.ok(result.body.items.every((v) => role === "auditor" ? v.code === undefined : v.code));
    assert.ok(result.body.items.every((v) => restricted ? v.customerId === undefined && v.paymentId === undefined : true));
    const phoneSearch = await f.call(role, records("&q=670000002"));
    assert.equal(phoneSearch.body.total, restricted ? 0 : 1, `${role} contact search`);
    assert.equal((await f.call(role, records("&q=p2"))).body.total, restricted ? 0 : 1, `${role} payment search`);
    assert.equal((await f.call(role, records("&q=NC-resale"))).body.total, role === "auditor" ? 0 : 1, `${role} code search`);
    const filtered = await f.call(role, records("&status=active&from=2030-01-01&to=2030-01-01&pageSize=1&page=2"));
    assert.equal(filtered.body.total, role === "reseller" ? 0 : 2); assert.ok(filtered.body.items.every((v) => ids.includes(v.id)));
    const csv = await f.call(role, "/api/admin/export"); assert.equal(csv.status, 200); assert.equal(csv.headers.get("cache-control"), "no-store");
    for (const id of ["linked", "stock", "resale", "assigned-away", "legacy"]) assert.equal(csv.text.includes(`"voucher","${id}"`), ids.includes(id), `${role} export ${id}`);
    if (restricted) { assert.doesNotMatch(csv.text, /"payment"|670000|699999|REFERENCE/); }
    if (role === "auditor") assert.doesNotMatch(csv.text, /NC-/);
    const searchedExport = await f.call(role, "/api/admin/export?q=670000002");
    assert.equal(searchedExport.text.split("\n").length, restricted ? 1 : 2);
    const dashboard = await f.call(role, "/api/admin/dashboard"); assert.equal(dashboard.body.recordTotals.vouchers, ids.length);
    assert.doesNotMatch(dashboard.text, /PRIVATE_/);
    if (restricted) assert.doesNotMatch(dashboard.text, /670000|699999|REFERENCE-|NC-linked/);
    for (const id of ids) {
      const detail = await f.call(role, details(id)); assert.equal(detail.status, 200);
      assert.equal(detail.body.scopeKey, result.body.scopeKey);
      if (restricted) { assert.equal(detail.body.payment, undefined); assert.equal(detail.body.ownership.accountPhone, undefined); assert.equal(detail.body.ownership.name, undefined); }
    }
    for (const collection of ["customers", "payments", "sessions", "events", "audit", "security"]) {
      const response = await f.call(role, `/api/admin/records?collection=${collection}&q=670000001`);
      assert.equal(response.status, restricted ? 403 : 200, `${role} ${collection}`);
      assert.doesNotMatch(response.text, /PRIVATE_MIGRATION/);
    }
  }
  const denied = await f.call("reseller", details("linked")), missing = await f.call("reseller", details("missing"));
  assert.equal(denied.status, 404); assert.deepEqual(denied.body, missing.body);
  assert.equal((await f.call("reseller", details("assigned-away"))).status, 404, "explicit reassignment overrides generator");
  assert.equal((await f.call("reseller", details("legacy"))).status, 404, "legacy boolean is not attribution");
});

test("disabled, deleted, demoted and reassigned staff lose access without reusing session claims", async (t) => {
  const f = await fixture(t), owner = await f.call("owner", details("linked"));
  await f.store.transaction((s) => { s.adminUsers.find((u) => u.id === "staff-owner").role = "auditor"; });
  const demoted = await f.call("owner", details("linked")); assert.equal(demoted.status, 200);
  assert.notEqual(demoted.body.scopeKey, owner.body.scopeKey); assert.equal(demoted.body.ownership.name, undefined); assert.equal(demoted.body.payment, undefined);
  await f.store.transaction((s) => { s.adminUsers.find((u) => u.id === "staff-reseller").active = false; });
  for (const path of [records(), details("stock"), "/api/admin/export", "/api/admin/dashboard"]) assert.equal((await f.call("reseller", path)).status, 401);
  await f.store.transaction((s) => { s.adminUsers = s.adminUsers.filter((u) => u.id !== "staff-operator"); });
  assert.equal((await f.call("operator", details("linked"))).status, 401, "missing user must not fall back to session owner role");
  await f.store.transaction((s) => { s.adminUsers.find((u) => u.id === "staff-auditor").role = "unknown-role"; });
  assert.equal((await f.call("auditor", records())).status, 403);
  await f.store.transaction((s) => { s.adminUsers.find((u) => u.id === "staff-reseller").active = true; s.vouchers.find((v) => v.id === "stock").assignedResellerId = "another-reseller"; });
  assert.equal((await f.call("reseller", details("stock"))).status, 404);
  assert.deepEqual((await f.call("reseller", records())).body.items.map((v) => v.id), ["resale"]);
});

test("details cannot mutate vouchers and restricted staff cannot expand their mutation rights", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("owner", "/api/admin/vouchers/revoke?voucherId=linked")).status, 404, "GET is read only");
  for (const role of ["auditor", "reseller"]) {
    for (const action of ["revoke", "resend-email", "classify"]) assert.equal((await f.call(role, `/api/admin/vouchers/${action}`, { voucherId: "stock", saleType: "gift" })).status, 403);
  }
  const forbidden = await f.call("reseller", "/api/admin/vouchers/generate", { purpose: "assigned", customerId: "c1", planId: "weekly", saleType: "sold" });
  assert.equal(forbidden.status, 403);
  const generated = await f.call("reseller", "/api/admin/vouchers/generate", { purpose: "resale", planId: "weekly", quantity: 2 });
  assert.equal(generated.status, 201); assert.equal(generated.body.vouchers.length, 2);
  const state = await f.store.snapshot();
  for (const v of generated.body.vouchers) {
    const stored = state.vouchers.find((x) => x.id === v.id); assert.equal(stored.generatedByAdminId, "staff-reseller"); assert.equal(stored.assignedResellerId, "staff-reseller");
    assert.equal((await f.call("reseller", details(v.id))).status, 200);
  }
  assert.equal(state.vouchers.find((v) => v.id === "linked").status, "active");
  assert.equal((await f.call("reseller", "/api/admin/vouchers/revoke")).status, 403);
});


test("a failed read transaction never releases buffered voucher contact data", async (t) => {
  const f = await fixture(t), transaction = f.store.transaction.bind(f.store);
  let fail = true;
  f.store.transaction = (fn, options) => transaction(async (s) => {
    const result = await fn(s);
    if (fail) { fail = false; throw Error("Synthetic voucher detail commit rollback"); }
    return result;
  }, options);
  const response = await f.call("owner", details("linked"));
  assert.ok(response.status >= 400); assert.doesNotMatch(response.text, /Account owner|670000001|699999999|ownership/);
  assert.equal((await f.call("owner", details("linked"))).status, 200);
});


test("exports page through exactly the authorized filtered stock and escape spreadsheet cells", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    for (let n = 0; n < 115; n++) s.vouchers.push({ id: `bulk-${n}`, code: n === 0 ? '=FORMULA("unsafe")' : `NC-BULK-${n}`, planId: "weekly", status: "available", generatedByAdminId: n % 3 ? "staff-reseller" : "another-reseller", quotaBytes: null, usedBytes: 0, deviceLimit: 1 });
  });
  const listed = await f.call("reseller", records("&status=available&pageSize=1"));
  const exported = await f.call("reseller", "/api/admin/export?status=available&page=999999&pageSize=1");
  assert.equal(exported.text.split("\n").length - 1, listed.body.total);
  assert.doesNotMatch(exported.text, /bulk-0"|bulk-3"|NC-linked/);
  const owner = await f.call("owner", "/api/admin/export?status=available");
  assert.equal(owner.text.split("\n").length - 1, 116);
  assert.ok(owner.text.includes(`"'=FORMULA(""unsafe"")"`));
});
