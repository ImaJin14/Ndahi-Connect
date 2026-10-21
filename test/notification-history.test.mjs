import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { hashSecret } from "../lib/security.mjs";

const endpoint = "/api/account/notifications";
async function fixture(t) {
  const f = await pairingFixture({ env: { ADMIN_APP_URL: "http://customer.test" } }); t.after(f.close);
  await f.store.transaction((s) => {
    for (let n = 0; n < 135; n++) s.securityAlerts.push({ id: "history-" + String(n).padStart(3, "0"), customerId: "c1", subject: "Security event " + n, lines: ["Review account"], at: n < 130 ? "2029-12-30T12:00:00Z" : "2029-11-01T00:00:00Z" });
    s.payments.push({ id: "old-payment", customerId: "c1", status: "confirmed", createdAt: "2029-10-01T00:00:00Z" });
    s.securityAlerts.push({ id: "other-account", customerId: "c2", subject: "Private other customer", at: "2029-12-30T12:00:00Z" });
  });
  return f;
}

test("history pagination reaches every matching item with deterministic timestamp ties", async (t) => {
  const f = await fixture(t), ids = []; let cursor = "";
  do {
    const page = await f.call(endpoint + "?view=all&limit=17&cursor=" + encodeURIComponent(cursor));
    assert.equal(page.status, 200); assert.ok(page.body.items.length <= 17); assert.equal(page.body.page.total, 136);
    ids.push(...page.body.items.map((n) => n.id)); cursor = page.body.page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 136); assert.equal(new Set(ids).size, 136);
  assert.equal(ids.at(-1), "payment:old-payment"); assert.equal(ids.some((id) => id.includes("other-account")), false);
});

test("category and inclusive UTC date filters apply before pagination beyond the previous cap", async (t) => {
  const f = await fixture(t);
  const payment = await f.call(endpoint + "?view=all&category=payments&from=2029-10-01&to=2029-10-01");
  assert.equal(payment.status, 200); assert.deepEqual(payment.body.items.map((n) => n.id), ["payment:old-payment"]);
  const older = await f.call(endpoint + "?view=all&category=security&from=2029-11-01&to=2029-11-01");
  assert.equal(older.body.items.length, 5); assert.equal(older.body.categories.security, "Security / sign-ins");
  const empty = await f.call(endpoint + "?view=all&from=2029-10-02&to=2029-10-03");
  assert.equal(empty.body.page.total, 0); assert.equal(empty.body.page.nextCursor, null);
});

test("read-all covers the selected history across pages without changing other categories or actions", async (t) => {
  const f = await fixture(t), request = await f.request();
  const read = await f.call(endpoint + "?view=unread&category=security&limit=5", { action: "read-all" });
  assert.equal(read.status, 200); assert.equal(read.body.page.total, 0);
  const all = await f.call(endpoint + "?view=all&category=security&limit=100");
  assert.equal(all.body.items.every((n) => n.read), true);
  const payments = await f.call(endpoint + "?view=unread&category=payments"); assert.equal(payments.body.page.total, 1);
  const actions = await f.call(endpoint + "?view=action"); assert.ok(actions.body.items.some((n) => n.requestId === request.body.request.id));
  assert.equal((await f.store.snapshot()).wifiPairingRequests[0].status, "pending");
  const another = await f.call(endpoint + "?view=unread&category=security", undefined, { session: "secondary" });
  assert.equal(another.body.page.total, 0);
});

test("archive and restore remain available across filtered pages and browser sessions", async (t) => {
  const f = await fixture(t), id = "security:history-134";
  await f.call(endpoint + "?view=all&category=security", { action: "archive", id });
  const archived = await f.call(endpoint + "?view=archived&category=security", undefined, { session: "secondary" });
  assert.deepEqual(archived.body.items.map((n) => n.id), [id]);
  await f.call(endpoint + "?view=archived&category=security", { action: "restore", id });
  assert.equal((await f.call(endpoint + "?view=archived")).body.items.length, 0);
});

test("cursors cannot cross recipients or filters and malformed date/limit/cursor inputs are rejected", async (t) => {
  const f = await fixture(t), first = await f.call(endpoint + "?view=all&category=security&limit=3"), cursor = encodeURIComponent(first.body.page.nextCursor);
  assert.equal((await f.call(endpoint + "?view=all&category=security&limit=3&cursor=" + cursor, undefined, { session: "other" })).status, 400);
  assert.equal((await f.call(endpoint + "?view=all&category=payments&limit=3&cursor=" + cursor)).status, 400);
  for (const query of ["view=invalid", "category=network", "from=2029-02-30", "from=garbage", "from=2030-01-02&to=2030-01-01", "limit=0", "limit=101", "cursor=not-a-cursor"]) {
    assert.equal((await f.call(endpoint + "?" + query)).status, 400, query);
  }
});

test("newer inserted events do not repeat items while paging stable history", async (t) => {
  const f = await fixture(t), first = await f.call(endpoint + "?view=all&limit=5");
  await f.store.transaction((s) => s.securityAlerts.push({ id: "new-insert", customerId: "c1", subject: "New", at: f.now().toISOString() }));
  const next = await f.call(endpoint + "?view=all&limit=5&cursor=" + encodeURIComponent(first.body.page.nextCursor));
  const initial = new Set(first.body.items.map((n) => n.id)); assert.equal(next.body.items.some((n) => initial.has(n.id)), false);
});

test("administrator category labels, filters and read state respect current staff permissions", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    for (const [id, role] of [["owner", "owner"], ["operator", "operator"], ["auditor", "auditor"], ["reseller", "reseller"]]) {
      s.adminUsers.push({ id, username: id, role, active: true });
      s.adminSessions.push({ id, userId: id, role, tokenHash: hashSecret(id, "pairing-tests"), csrfToken: "csrf", expiresAt: "2030-01-02T00:00:00Z" });
    }
    s.securityEvents.push({ id: "admin-security", type: "admin.authorization.denied", at: f.now().toISOString() });
  });
  async function get(user, query = "view=all") {
    const r = await fetch(f.api + "/api/admin/notifications?" + query, { headers: { origin: "http://customer.test", cookie: "admin_session=" + user } });
    return { status: r.status, body: await r.json() };
  }
  assert.equal((await get("owner")).body.categories.security, "Staff / security");
  assert.equal((await get("operator")).body.categories.security, undefined);
  assert.deepEqual(Object.keys((await get("auditor")).body.categories), ["service"]);
  assert.deepEqual(Object.keys((await get("reseller")).body.categories), ["service"]);
  assert.equal((await get("operator", "view=all&category=security")).status, 400);
  await f.store.transaction((s) => { s.adminUsers[0].role = "auditor"; });
  assert.equal((await get("owner")).body.items.some((n) => n.id === "admin-security:admin-security"), false);
});
