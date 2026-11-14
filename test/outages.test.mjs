// Outages (#259, server task 4): staff post a notice (EN + FR), post updates
// and close it, giving time back once (fresh proof). Customers see the notice
// on Home, the public notice serves the hotspot page, and bundles that ran
// during the outage get the time, including ones that ended during it.
import test from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { notificationItems } from "../lib/notifications.mjs";

const secret = "outages-secret", pin = "482913", at = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();

async function start(t) {
  const store = createStore({ persistent: false }), passwordHash = await argon2.hash(pin);
  await store.transaction((s) => {
    for (const role of ["owner", "operator", "auditor", "reseller"]) {
      s.adminUsers.push({ id: `staff-${role}`, username: role, displayName: role === "owner" ? "Owner" : role, role, active: true, passwordHash, passkeys: [] });
      s.adminSessions.push({ userId: `staff-${role}`, role, tokenHash: hashSecret(`token-${role}`, secret), csrfToken: `csrf-${role}`, expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    s.customers.push({ id: "c-on", name: "On", phone: "670000101" }, { id: "c-ended", name: "Ended", phone: "670000102" }, { id: "c-none", name: "None", phone: "670000103" });
    s.dashboardSessions.push({ id: "sess-on", customerId: "c-on", role: "customer", tokenHash: hashSecret("on", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.vouchers.push(
      { id: "v-on", customerId: "c-on", planId: "weekly", code: "NC-ON00-0001", status: "active", activatedAt: at(-3000), expiresAt: at(2880), quotaBytes: 5e9, usedBytes: 1e9, deviceLimit: 1 },
      // Ended by time during the outage: extended and running again.
      { id: "v-ended", customerId: "c-ended", planId: "daily", code: "NC-END0-0001", status: "expired", activatedAt: at(-1500), expiresAt: at(-60), quotaBytes: 1e9, usedBytes: 1e8, deviceLimit: 1 },
      // Ended before the outage: nothing.
      { id: "v-old", customerId: "c-none", planId: "daily", code: "NC-OLD0-0001", status: "expired", activatedAt: at(-3000), expiresAt: at(-1600), quotaBytes: 1e9, usedBytes: 1e8, deviceLimit: 1 });
  });
  const server = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: "https://portal.example.test", ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock",
    MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, data, role) => {
    const headers = role === "customer" ? { cookie: "customer_session=on" } : role ? { cookie: `admin_session=token-${role}`, origin: "http://admin.test", "x-csrf-token": `csrf-${role}` } : {};
    const r = await fetch(base + path, { method: data === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: r.status, body: await r.json().catch(() => ({})), cache: r.headers.get("cache-control") };
  };
  return { store, call };
}
const notice = { area: "All sites · Bamenda", startedAt: at(-145), nextUpdateBy: at(30), showToCustomers: true, notify: true,
  message: { en: "Our satellite link dropped at 14:20. We're working on it. The time you lose will be added back to your bundle.",
    fr: "Notre liaison satellite est coupée depuis 14 h 20. Nous y travaillons. Le temps perdu sera ajouté à votre forfait." } };

test("staff post a notice that customers and the hotspot page see, then updates", async (t) => {
  const { store, call } = await start(t);
  assert.equal((await call("/api/admin/outages", notice, "auditor")).status, 403);
  assert.equal((await call("/api/admin/outages", undefined, "reseller")).status, 403);
  assert.equal((await call("/api/admin/outages", { ...notice, message: { en: "Down" } }, "owner")).status, 400, "both languages");
  const posted = await call("/api/admin/outages", notice, "owner");
  assert.equal(posted.status, 201);
  const id = posted.body.outage.id;
  assert.equal((await call("/api/admin/outages", notice, "operator")).status, 409, "one outage at a time");
  const read = (await call("/api/admin/outages", undefined, "auditor")).body;
  assert.deepEqual([read.current.status, read.current.affected, read.activeBundles, read.canManage], ["live", 2, 1, false]);
  const pub = await call("/api/outage");
  assert.deepEqual([pub.body.outage.area, pub.body.outage.message.fr, pub.cache], ["All sites · Bamenda", notice.message.fr, "public, max-age=30"]);
  const dashboard = (await call("/api/account/dashboard", undefined, "customer")).body;
  assert.equal(dashboard.outage.state, "down");
  assert.equal(dashboard.outage.message.en, notice.message.en);
  const s = await store.snapshot(), items = (id) => notificationItems(s, { type: "customer", id }, new Date());
  assert.equal(items("c-on").find((n) => n.id.startsWith("outage:")).title, "Internet is down in All sites · Bamenda");
  assert.equal(items("c-none").some((n) => n.id.startsWith("outage:")), false, "only customers whose bundle ran during it");
  const updated = await call("/api/admin/outages/update", { outageId: id, text: "Engineer on site, expected back by 17:00", nextUpdateBy: at(60) }, "operator");
  assert.deepEqual([updated.body.outage.updates.length, updated.body.outage.updates[0].by], [1, "operator"]);
  assert.equal((await call("/api/outage")).body.outage.lastUpdate, "Engineer on site, expected back by 17:00");
  assert.ok(s.auditLogs.some((a) => a.action === "outage.posted"));
});

test("closing gives the time back once, with fresh proof, to bundles that ran during it", async (t) => {
  const { store, call } = await start(t);
  const id = (await call("/api/admin/outages", notice, "owner")).body.outage.id;
  const before = (await store.snapshot()).vouchers;
  assert.equal((await call("/api/admin/outages/close", { outageId: id, compensation: "round" }, "owner")).body.code, "VERIFICATION_FAILED", "time back needs fresh proof");
  const closed = await call("/api/admin/outages/close", { outageId: id, compensation: "round", currentPassword: pin }, "owner");
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.body.outage.compensation, { hours: 3, customers: 2 }, "2 h 25 min rounds up to 3 hours");
  const s = await store.snapshot(), v = (vid) => s.vouchers.find((x) => x.id === vid), was = (vid) => before.find((x) => x.id === vid);
  assert.equal(Date.parse(v("v-on").expiresAt) - Date.parse(was("v-on").expiresAt), 3 * 36e5);
  assert.deepEqual([v("v-ended").status, Date.parse(v("v-ended").expiresAt) - Date.parse(was("v-ended").expiresAt)], ["active", 3 * 36e5], "ended during it: extended and running again");
  assert.equal(v("v-old").expiresAt, was("v-old").expiresAt, "ended before it: nothing");
  assert.ok(s.routerCommands.some((c) => c.action === "sync_voucher" && c.targetId === "v-ended"));
  // Idempotent: closing again never doubles the time.
  assert.equal((await call("/api/admin/outages/close", { outageId: id, compensation: "day", currentPassword: pin }, "owner")).body.idempotent, true);
  assert.equal((await store.snapshot()).vouchers.find((x) => x.id === "v-on").expiresAt, v("v-on").expiresAt);
  // Customers: "We're back online" with their own hours, on Home and in notifications.
  const dashboard = (await call("/api/account/dashboard", undefined, "customer")).body;
  assert.deepEqual([dashboard.outage.state, dashboard.outage.addedHours], ["restored", 3]);
  assert.equal(notificationItems(s, { type: "customer", id: "c-on" }, new Date()).find((n) => n.id.startsWith("outage-fixed:")).body,
    "Sorry for the interruption. We added 3 hours to your bundle to make up for it.");
  assert.equal((await call("/api/outage")).body.outage, null, "no notice once fixed");
  const audit = s.auditLogs.find((a) => a.action === "outage.closed");
  assert.deepEqual([audit.meta.compensation, audit.meta.hours, audit.meta.vouchers, audit.meta.customers], ["round", 3, 2, 2]);
  const past = (await call("/api/admin/outages", undefined, "owner")).body.past;
  assert.deepEqual([past.length, past[0].compensation.hours], [1, 3]);
});

test("closing with nothing given back needs no proof", async (t) => {
  const { store, call } = await start(t);
  const id = (await call("/api/admin/outages", { ...notice, startedAt: at(-15) }, "operator")).body.outage.id;
  const closed = await call("/api/admin/outages/close", { outageId: id, compensation: "none" }, "operator");
  assert.deepEqual([closed.status, closed.body.outage.compensation], [200, { hours: 0, customers: 0 }]);
  assert.equal((await store.snapshot()).vouchers.find((x) => x.id === "v-on").outageCredits, undefined);
});
