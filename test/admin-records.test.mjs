import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createServer, createStore, blank } from "../server.mjs";
import { parseRecordQuery, queryRecords, RecordQueryError, maxPageSize } from "../lib/admin-records.mjs";

function largeState({ customers = 20000, vouchers = 50000, sessions = 30000 } = {}) {
  const s = blank();
  for (let i = 0; i < customers; i++) {
    s.customers.push({
      id: `c${i}`, phone: String(670000000 + i), name: `Student ${i}`,
      status: i % 50 === 0 ? "suspended" : undefined, pinHash: "secret", totpSecret: i % 7 ? undefined : "totp",
    });
  }
  for (let i = 0; i < vouchers; i++) {
    s.vouchers.push({
      id: `v${i}`, code: `CODE${String(i).padStart(6, "0")}`, planId: "weekly",
      status: ["active", "expired", "available"][i % 3], customerId: `c${i % customers}`, deviceLimit: 2,
      quotaBytes: null, usedBytes: 0,
    });
  }
  for (let i = 0; i < sessions; i++) {
    s.sessions.push({ id: `s${i}`, voucherId: `v${i % vouchers}`, deviceId: `d${i}`, label: "Phone", status: i % 2 ? "online" : "inactive" });
  }
  for (let i = 0; i < 1000; i++) s.auditLogs.push({ id: `a${i}`, action: i % 2 ? "voucher.revoked" : "bundle.created", actor: "owner", at: new Date(0).toISOString() });
  return s;
}

test("record queries validate collection and paging parameters", () => {
  const parse = (query) => parseRecordQuery(new URLSearchParams(query));
  assert.deepEqual(parse("collection=customers"), { collection: "customers", page: 1, pageSize: 25, q: "", status: "" });
  assert.equal(parse("collection=vouchers&page=3&pageSize=100&q=%20ABC%20").q, "abc");
  for (const bad of ["collection=adminSessions", "collection=customers&page=0", `collection=customers&pageSize=${maxPageSize + 1}`, "collection=customers&page=1.5"]) {
    assert.throws(() => parse(bad), RecordQueryError, bad);
  }
});

test("records are filtered, searched and paged newest first without exposing secrets", () => {
  const s = largeState({ customers: 120, vouchers: 60, sessions: 10 });
  const first = queryRecords(s, { collection: "customers", pageSize: 25 });
  assert.equal(first.total, 120);
  assert.equal(first.pages, 5);
  assert.equal(first.items[0].id, "c119", "appended collections are returned newest first");
  assert.equal(first.items.length, 25);
  assert.ok(first.items.every((c) => !("pinHash" in c) && !("totpSecret" in c)));
  assert.equal(first.items.find((c) => c.id === "c112").authenticatorEnrolled, true);
  const suspended = queryRecords(s, { collection: "customers", status: "suspended" });
  assert.deepEqual(suspended.items.map((c) => c.id), ["c100", "c50", "c0"]);
  assert.equal(queryRecords(s, { collection: "customers", q: "student 11" }).total, 11);
  const beyond = queryRecords(s, { collection: "customers", page: 99, pageSize: 50 });
  assert.equal(beyond.page, 3, "pages past the end clamp to the last page");
  assert.equal(queryRecords(s, { collection: "vouchers", q: "670000005" }).items[0].id, "v5", "vouchers are searchable by customer phone");
  assert.equal(queryRecords(s, { collection: "audit", q: "revoked" }).total, 500);
});

test("record queries stay fast and bounded at production scale", () => {
  const s = largeState();
  for (const query of [
    { collection: "customers", q: "student 1999" },
    { collection: "vouchers", status: "active", page: 200 },
    { collection: "vouchers", q: "670019999" },
    { collection: "sessions", status: "online", pageSize: 100 },
  ]) {
    const started = performance.now(), result = queryRecords(s, query), elapsed = performance.now() - started;
    assert.ok(result.items.length <= 100);
    assert.ok(elapsed < 250, `${JSON.stringify(query)} took ${elapsed.toFixed(1)} ms`);
  }
});

test("administrator dashboard and records endpoint serve bounded pages", async (t) => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => Object.assign(s, largeState({ customers: 3000, vouchers: 6000, sessions: 2000 })));
  const server = createServer({
    store,
    env: {
      PAYMENT_MODE: "mock", SESSION_COOKIE_SECURE: "false", ADMIN_SESSION_SECRET: "admin-secret",
      CUSTOMER_SESSION_SECRET: "customer-secret", ADMIN_PIN: "9999",
      ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test",
      BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://admin.test" },
    body: JSON.stringify({ pin: "9999" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0],
    get = (path) => fetch(base + path, { headers: { cookie } });
  assert.equal((await fetch(base + "/api/admin/records?collection=customers")).status, 401);
  const dashboard = await get("/api/admin/dashboard"), text = await dashboard.text(), body = JSON.parse(text);
  assert.equal(dashboard.status, 200);
  assert.equal(body.metrics.customers, 3000);
  assert.equal(body.metrics.activeCodes, 2000);
  assert.equal(body.recordTotals.vouchers, 6000);
  assert.equal(body.customers, undefined, "full customer lists are no longer embedded");
  assert.ok(text.length < 50_000, `dashboard payload is ${text.length} bytes`);
  const page = await (await get("/api/admin/records?collection=vouchers&status=active&page=2&pageSize=50")).json();
  assert.equal(page.total, 2000);
  assert.equal(page.items.length, 50);
  assert.ok(page.items.every((v) => v.status === "active" && typeof v.activeDevices === "number" && v.code));
  const bad = await get("/api/admin/records?collection=adminSessions");
  assert.equal(bad.status, 400);
});
