import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { createPostgresStore, StoreConflictError } from "../lib/postgres-store.mjs";
import { blank } from "../lib/api/state.mjs";

// Runs against a disposable schema when TEST_DATABASE_URL is set (CI provides one).
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL is not set";
const schema = `ndahi_store_test_${process.pid}`;
let admin, pool, store;

function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { open, opened };
}
const settled = (promise) => Promise.race([
  promise.then(() => true, () => true),
  new Promise((resolve) => setTimeout(() => resolve(false), 150)),
]);
const rows = async (sql, params) => (await pool.query(sql, params)).rows;

test.before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 12 });
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) {
    await pool.query(await readFile(new URL(file, directory), "utf8"));
  }
});
test.beforeEach(async () => {
  if (skip) return;
  await pool.query(`TRUNCATE customers, admin_users, bundles, payments, vouchers, network_sessions,
    dashboard_sessions, admin_sessions, challenges, events, audit_logs, app_settings CASCADE`);
  store = createPostgresStore({ pool, initialState: blank });
});
test.after(async () => {
  if (skip) return;
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test("writes only changed rows and keeps prepend/append order without renumbering", { skip }, async () => {
  await store.transaction((s) => {
    for (let i = 0; i < 5; i++) s.events.push({ id: `e${i}`, type: "seed" });
    s.customers.push({ id: "c1", phone: "670000001" }, { id: "c2", phone: "670000002" });
  });
  const before = await rows("SELECT id, ordinal, xmin::text AS version FROM events ORDER BY ordinal");
  await store.transaction((s) => {
    s.events.unshift({ id: "new-first", type: "log" });
    s.events.push({ id: "new-last", type: "log" });
    s.events = s.events.slice(0, 6);
    s.customers[1].name = "Changed";
  });
  const after = await rows("SELECT id, ordinal, xmin::text AS version FROM events ORDER BY ordinal, id");
  assert.deepEqual(after.map(({ id }) => id), ["new-first", "e0", "e1", "e2", "e3", "e4"]);
  assert.equal(after[0].ordinal, -1, "prepended rows take an ordinal below the first row");
  for (const row of after.slice(1)) {
    assert.equal(row.version, before.find(({ id }) => id === row.id).version, `${row.id} was not rewritten`);
  }
  const customers = await rows("SELECT id, xmin::text AS version, payload FROM customers ORDER BY ordinal");
  assert.equal(customers[1].payload.name, "Changed");
  assert.deepEqual((await store.snapshot()).events.map(({ id }) => id), after.map(({ id }) => id));
});

test("insertions between rows and reordering fall back to renumbering", { skip }, async () => {
  await store.transaction((s) => { s.bundles.push({ id: "a" }, { id: "b" }); });
  await store.transaction((s) => { s.bundles.splice(1, 0, { id: "between" }); });
  assert.deepEqual((await store.snapshot()).bundles.map(({ id }) => id), ["a", "between", "b"]);
  await store.transaction((s) => { s.bundles.reverse(); });
  assert.deepEqual((await store.snapshot()).bundles.map(({ id }) => id), ["b", "between", "a"]);
});

test("unrelated scoped transactions run concurrently", { skip }, async () => {
  const hold = gate();
  const first = store.transaction(async (s) => {
    s.customers.push({ id: "a", phone: "670000011" });
    await hold.opened;
  }, { scope: ["customer:670000011"] });
  const second = store.transaction((s) => {
    s.customers.push({ id: "b", phone: "670000012" });
  }, { scope: ["customer:670000012"] });
  assert.equal(await settled(second), true, "a different customer is not blocked");
  assert.equal(await settled(first), false);
  hold.open();
  await Promise.all([first, second]);
  assert.deepEqual((await store.snapshot()).customers.map(({ id }) => id).sort(), ["a", "b"]);
});

test("scoped transactions on the same key are serialized and see committed data", { skip }, async () => {
  const hold = gate();
  const first = store.transaction(async (s) => {
    s.customers.push({ id: "a", phone: "670000021", balance: 1 });
    await hold.opened;
  }, { scope: ["customer:670000021"] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = store.transaction((s) => {
    const customer = s.customers.find(({ phone }) => phone === "670000021");
    customer.balance += 1;
  }, { scope: ["customer:670000021"] });
  assert.equal(await settled(second), false, "the same customer waits");
  hold.open();
  await Promise.all([first, second]);
  assert.equal((await store.snapshot()).customers[0].balance, 2);
});

test("unscoped transactions exclude scoped ones", { skip }, async () => {
  const hold = gate();
  const scoped = store.transaction(async () => { await hold.opened; }, { scope: ["x"] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const exclusive = store.transaction((s) => { s.zone = { status: "maintenance" }; });
  assert.equal(await settled(exclusive), false);
  hold.open();
  await Promise.all([scoped, exclusive]);
});

test("scope keys can be derived from a partial read", { skip }, async () => {
  await store.transaction((s) => {
    s.customers.push({ id: "c", phone: "670000031" });
    s.dashboardSessions.push({ id: "session", customerId: "c", tokenHash: "hash" });
  });
  let seen;
  await store.transaction((s) => { s.customers[0].touched = true; }, {
    scopeFrom: ["dashboardSessions", "customers"],
    scope: (s) => {
      seen = Object.keys(s).filter((key) => Array.isArray(s[key]) && s[key].length);
      const session = s.dashboardSessions.find(({ tokenHash }) => tokenHash === "hash");
      return [`customer:${s.customers.find(({ id }) => id === session.customerId).phone}`];
    },
  });
  assert.deepEqual(seen.sort(), ["customers", "dashboardSessions"]);
  assert.equal((await store.snapshot()).customers[0].touched, true);
});

test("overlapping writes outside the scope are retried instead of lost", { skip }, async () => {
  await store.transaction((s) => { s.bundles.push({ id: "shared", count: 0 }); });
  await Promise.all(Array.from({ length: 8 }, (_, index) => store.transaction(async (s) => {
    const bundle = s.bundles.find(({ id }) => id === "shared");
    await new Promise((resolve) => setTimeout(resolve, 5));
    bundle.count += 1;
    s.events.unshift({ id: `inc-${index}` });
  }, { scope: [`customer:${index}`] })));
  const state = await store.snapshot();
  assert.equal(state.bundles[0].count, 8);
  assert.equal(state.events.length, 8);
  assert.ok(store.stats.retried > 0, "conflicts were resolved by retrying");
});

test("concurrent log trimming does not conflict", { skip }, async () => {
  await store.transaction((s) => { for (let i = 0; i < 5; i++) s.events.push({ id: `old-${i}` }); });
  const conflicts = store.stats.conflicts;
  await Promise.all(Array.from({ length: 10 }, (_, index) => store.transaction((s) => {
    s.events.unshift({ id: `log-${index}` });
    s.events = s.events.slice(0, 5);
  }, { scope: [`customer:${index}`] })));
  assert.equal(store.stats.conflicts, conflicts, "deleting an already-deleted row is not a conflict");
  // Each transaction trims what it read, so concurrent writers may briefly exceed the cap.
  const events = (await store.snapshot()).events.map(({ id }) => id);
  assert.ok(events.length >= 5 && events.filter((id) => id.startsWith("log-")).length >= 5);
  await store.transaction((s) => { s.events = s.events.slice(0, 5); });
  assert.equal((await store.snapshot()).events.length, 5);
});

test("unscoped transactions report conflicts without retrying side effects", { skip }, async () => {
  await store.transaction((s) => { s.customers.push({ id: "c", phone: "670000041", name: "A" }); });
  let calls = 0;
  await assert.rejects(store.transaction(async (s) => {
    calls++;
    await pool.query("UPDATE customers SET payload = payload || '{\"name\":\"External\"}' WHERE id = 'c'");
    s.customers[0].name = "B";
  }), StoreConflictError);
  assert.equal(calls, 1);
  assert.equal((await store.snapshot()).customers[0].name, "External");
});

test("settings are written only when changed and guarded", { skip }, async () => {
  await store.transaction((s) => { s.zone = { status: "online" }; });
  const [{ updated_at: first }] = await rows("SELECT updated_at FROM app_settings WHERE key = 'zone'");
  await store.transaction((s) => { s.customers.push({ id: "c", phone: "670000051" }); });
  const [{ updated_at: second }] = await rows("SELECT updated_at FROM app_settings WHERE key = 'zone'");
  assert.equal(second.getTime(), first.getTime());
  await store.transaction((s) => { s.zone.status = "maintenance"; });
  assert.equal((await store.snapshot()).zone.status, "maintenance");
});

test("rolled back transactions leave no partial writes", { skip }, async () => {
  await assert.rejects(store.transaction((s) => {
    s.customers.push({ id: "x", phone: "670000061" });
    throw new Error("rollback");
  }, { scope: ["customer:670000061"] }), /rollback/);
  assert.equal((await store.snapshot()).customers.length, 0);
});

test("partial snapshots read only the requested collections", { skip }, async () => {
  await store.transaction((s) => {
    s.customers.push({ id: "customer-1", phone: "670000001" });
    s.payments.push({ id: "payment-1", customerId: "customer-1", status: "pending" });
    s.routerCommands.push({ id: "router:mark_inactive:global", kind: "router_command", status: "queued" });
    s.zone = { ...s.zone, status: "maintenance" };
  });
  const partial = await store.snapshot({ only: ["payments", "routerCommands"] });
  assert.deepEqual(partial.payments.map((p) => p.id), ["payment-1"]);
  assert.deepEqual(partial.routerCommands.map((c) => c.id), ["router:mark_inactive:global"]);
  assert.deepEqual(partial.customers, []);
  assert.notEqual(partial.zone?.status, "maintenance", "settings are not read");
  assert.equal((await store.snapshot()).customers.length, 1);
});

// Connections' router check reads only the saved router setting (#380).
test("a partial snapshot reads the settings it names, and only those", { skip }, async () => {
  await store.transaction((s) => {
    s.customers.push({ id: "customer-2", phone: "670000002" });
    s.networkSetup = { connections: { router: { kind: "router", mode: "live", secret: "sealed" } } };
    s.zone = { ...s.zone, status: "maintenance" };
  });
  const partial = await store.snapshot({ only: [], settings: ["networkSetup", "notASetting"] });
  assert.equal(partial.networkSetup.connections.router.mode, "live");
  assert.deepEqual(partial.customers, []);
  assert.notEqual(partial.zone?.status, "maintenance", "settings not named are not read");
  assert.equal("notASetting" in partial, false);
});

test("operational incident state commits atomically and survives normalized-store restart", { skip }, async () => {
  await store.transaction((s) => {
    s.operationalIncidents.push({ id: "incident-pg", status: "open", count: 1, firstAt: "2030-01-01T00:00:00Z", lastAt: "2030-01-01T00:00:00Z" });
    s.routerCommands.push({ id: "command-pg", action: "sync_usage", operationalIncidentId: "incident-pg", status: "retry" });
  });
  const restarted = createPostgresStore({ pool, initialState: blank });
  assert.equal((await restarted.snapshot()).operationalIncidents[0].count, 1);
  await assert.rejects(store.transaction((s) => { s.operationalIncidents[0].count++; s.routerCommands[0].status = "processed"; throw Error("incident rollback"); }));
  const s = await restarted.snapshot(); assert.equal(s.operationalIncidents[0].count, 1); assert.equal(s.routerCommands[0].status, "retry");
});

// Targeted reads (API optimization phase 1): requests load only the rows they use.
async function seedTargeted() {
  await store.transaction((s) => {
    s.customers.push({ id: "c1", phone: "670000101" }, { id: "c2", phone: "670000102" });
    s.payments.unshift({ id: "p2", customerId: "c2", status: "paid" });
    s.payments.unshift({ id: "p1", customerId: "c1", status: "pending" });
    s.vouchers.unshift({ id: "v1", customerId: "c1", paymentId: "p1", code: "NC-AAAA-BBBB" });
    s.vouchers.unshift({ id: "v2", customerId: "c2", paymentId: "p2", code: "NC-CCCC-DDDD" });
    s.routerCommands.push({ id: "router:sync_usage:global", action: "sync_usage", status: "processed" });
    s.events.push({ id: "e1", type: "seed" });
    s.zone = { id: "z", status: "maintenance", notes: "" };
  });
}

test("targeted reads return only the selected rows, following dependent steps", { skip }, async () => {
  await seedTargeted();
  const state = await store.read([
    { rows: { customers: { phone: ["670000101"] } }, settings: ["zone"] },
    (s) => ({ rows: { vouchers: { customerId: s.customers.map((c) => c.id) } } }),
    (s) => ({ rows: { payments: { id: s.vouchers.map((v) => v.paymentId) }, bundles: true } }),
  ]);
  assert.deepEqual(state.customers.map((c) => c.id), ["c1"]);
  assert.deepEqual(state.vouchers.map((v) => v.id), ["v1"]);
  assert.deepEqual(state.payments.map((p) => p.id), ["p1"]);
  assert.deepEqual([state.events, state.routerCommands, state.bundles], [[], [], []]);
  assert.equal(state.zone.status, "maintenance");
  assert.equal(state.networkSetup, undefined, "unrequested settings are not read");
  // A filter on a field without its own column matches the payload.
  assert.deepEqual((await store.read([{ rows: { payments: { status: ["paid"] } } }])).payments.map((p) => p.id), ["p2"]);
  assert.deepEqual((await store.read([{ rows: { vouchers: { code: [] } } }])).vouchers, []);
  await assert.rejects(store.read([{ rows: { payments: { "status'": ["x"] } } }]), /Invalid filter field/);
});

test("targeted transactions write only loaded rows and keep their place in the order", { skip }, async () => {
  await seedTargeted();
  const before = await rows("SELECT id, ordinal, xmin::text AS version FROM payments ORDER BY ordinal");
  const result = await store.transaction((s) => {
    assert.deepEqual(s.payments.map((p) => p.id), ["p2"]);
    s.payments[0].status = "refunded";
    s.payments.reverse();
    return "done";
  }, { load: [{ rows: { payments: { id: ["p2"] } } }] });
  assert.equal(result, "done");
  const after = await rows("SELECT id, ordinal, xmin::text AS version FROM payments ORDER BY ordinal");
  assert.deepEqual(after.map(({ id, ordinal }) => [id, ordinal]), before.map(({ id, ordinal }) => [id, ordinal]));
  assert.equal(after.find(({ id }) => id === "p1").version, before.find(({ id }) => id === "p1").version, "p1 was not rewritten");
  assert.equal((await store.snapshot()).payments.find(({ id }) => id === "p2").status, "refunded");
  assert.equal(store.stats.targeted, 1);
  assert.equal(store.stats.fullFallbacks, 0);
});

test("a targeted transaction that adds rows or writes outside its load reruns on the full state", { skip }, async () => {
  await seedTargeted();
  const seen = [];
  await store.transaction((s) => {
    seen.push(s.payments.length);
    s.payments.unshift({ id: "p3", customerId: "c1", status: "pending" });
  }, { load: [{ rows: { payments: { customerId: ["c1"] } } }] });
  assert.deepEqual(seen, [1, 2], "the second run saw every payment");
  assert.deepEqual((await store.snapshot()).payments.map(({ id }) => id), ["p3", "p1", "p2"], "the new row is placed as on the full state");
  await store.transaction((s) => { s.events.push({ id: "e2", type: "log" }); }, { load: [{ rows: { payments: { id: ["p1"] } } }] });
  await store.transaction((s) => { s.zone.status = "degraded"; }, { load: [{ rows: { payments: { id: ["p1"] } } }] });
  const state = await store.snapshot();
  assert.deepEqual(state.events.map(({ id }) => id), ["e1", "e2"]);
  assert.equal(state.zone.status, "degraded");
  assert.equal(store.stats.fullFallbacks, 3);
});

test("a loaded setting without a row is not written back as its default", { skip }, async () => {
  await store.transaction(() => {}, { load: [{ settings: ["networkSetup", "zone"] }] });
  assert.deepEqual(await rows("SELECT key FROM app_settings"), []);
  await store.transaction((s) => { s.zone = { ...s.zone, status: "maintenance" }; }, { load: [{ settings: ["zone"] }] });
  assert.equal((await rows("SELECT value FROM app_settings WHERE key = 'zone'"))[0].value.status, "maintenance");
});

test("targeted transactions retry on a concurrent change and run beside other scopes", { skip }, async () => {
  await seedTargeted();
  let calls = 0;
  await store.transaction(async (s) => {
    calls++;
    if (calls === 1) await pool.query(`UPDATE payments SET payload = payload || '{"note":"external"}' WHERE id = 'p1'`);
    s.payments[0].status = "expired";
  }, { load: [{ rows: { payments: { id: ["p1"] } } }] });
  assert.equal(calls, 2, "the conflicting attempt was retried");
  const p1 = (await store.snapshot()).payments.find(({ id }) => id === "p1");
  assert.deepEqual([p1.status, p1.note], ["expired", "external"]);
  // A scoped customer transaction holding its lock does not block a targeted one.
  const held = gate(), release = gate();
  const blocker = store.transaction(async () => { held.open(); await release.opened; }, { scope: ["customer:670000102"] });
  await held.opened;
  assert.equal(await settled(store.transaction((s) => { s.payments[0].status = "paid"; }, { load: [{ rows: { payments: { id: ["p1"] } } }] })), true);
  release.open();
  await blocker;
});

test("snapshots are independent copies built without change tracking", { skip }, async () => {
  await seedTargeted();
  const first = await store.snapshot();
  first.payments[0].status = "mutated";
  assert.notEqual((await store.snapshot()).payments[0].status, "mutated");
});
