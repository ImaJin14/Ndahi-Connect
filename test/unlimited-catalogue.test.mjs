// The Unlimited catalogue in the database (#332): the starting catalogue is
// inserted once, admins manage it, the owner's switch decides what is on sale,
// and nothing already bought changes (docs/redesign/decisions.md → "Current
// customers keep their terms until their bundle ends").
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { seedCatalogue, SEED, SEED_MARKER, bundleInput } from "../lib/catalogue.mjs";
import { blank, catalogue, findPlan } from "../lib/api/state.mjs";

const secret = "unlimited-catalogue-tests";
const OWNER_PRICES = {
  "5h": [250], "24h": [500, 900, 1300, 1700, 2100, 2500], "7d": [2500, 4000, 5500, 7000, 8500, 10000], "30d": [6000, 10000, 15000, 20000, 25000, 30000],
};

async function fixture(t, { seeded = true } = {}) {
  const store = createStore({ persistent: false });
  const now = new Date("2026-11-25T10:00:00Z");
  await store.transaction((s) => {
    for (const role of ["owner", "operator", "auditor", "reseller"]) {
      s.adminUsers.push({ id: role, role, username: role, active: true });
      s.adminSessions.push({ id: role, userId: role, role, tokenHash: hashSecret(role, secret), csrfToken: "csrf-" + role, expiresAt: "2031-01-01T00:00:00Z" });
    }
    // A customer on a fixed-data bundle bought before the switch, with its payment and receipt.
    s.customers.push({ id: "amina", name: "Amina", phone: "670000001", email: "" });
    s.payments.push({ id: "pay-weekly", customerId: "amina", planId: "weekly", amount: 1000, currency: "XAF", status: "paid", provider: "mock",
      planSnapshot: { id: "weekly", name: "Weekly", price: 1000, quotaGb: 5, validityHours: 168, deviceLimit: 1 }, receipt: { number: "R-1", plan: { id: "weekly", name: "Weekly" } } });
    s.vouchers.push({ id: "v-weekly", customerId: "amina", planId: "weekly", paymentId: "pay-weekly", code: "NC-WEEK-0001", status: "active",
      activatedAt: "2026-11-24T10:00:00.000Z", expiresAt: "2026-12-01T10:00:00.000Z", quotaBytes: 5e9, usedBytes: 1e9, deviceLimit: 1 });
    if (seeded) seedCatalogue(s, now);
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
  const buy = (planId) => call("/api/purchase", { phone: "699" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"), planId, requestKey: randomUUID() });
  return { store, call, buy, now };
}

test("the starting catalogue: 19 Personal Unlimited and Home WISP, at the owner's 24 Nov prices", () => {
  const s = blank();
  assert.deepEqual(seedCatalogue(s, new Date("2026-11-25T00:00:00Z")).length, 20);
  const unlimited = s.bundles.filter((b) => b.catalogue === "unlimited");
  for (const [key, prices] of Object.entries(OWNER_PRICES)) prices.forEach((price, i) => {
    const b = unlimited.find((x) => x.id === `unlimited-${key}-${i + 1}`);
    assert.deepEqual([b.name, b.price, b.accessType, b.deviceSlots, b.deviceLimit, b.quotaGb, b.status], ["Personal Unlimited", price, "personal_unlimited", i + 1, i + 1, null, "published"], b.id);
  });
  assert.equal(unlimited.filter((b) => b.id.startsWith("unlimited-5h-")).length, 1, "five hours: one device only");
  const home = unlimited.find((b) => b.accessType === "home_wisp_unlimited");
  assert.deepEqual([home.name, home.price, home.validityHours, home.deviceSlots, home.sharing], ["Home WISP Unlimited", 50000, 720, 1, true]);
  assert.equal(/\d/.test(home.name), false, "no device or router count in Home WISP's name");
  assert.equal(SEED.length, 20);
  assert.deepEqual([unlimited.find((b) => b.id === "unlimited-24h-1").validityHours, unlimited.find((b) => b.id === "unlimited-7d-1").validityHours, unlimited.find((b) => b.id === "unlimited-5h-1").validityHours], [24, 168, 5]);
});

test("the seed runs once: a second run, or a run after an admin deleted a bundle, never recreates it", () => {
  const s = blank();
  seedCatalogue(s);
  assert.deepEqual(seedCatalogue(s), [], "second run inserts nothing");
  s.bundles = s.bundles.filter((b) => b.id !== "unlimited-24h-3");
  s.bundles.find((b) => b.id === "unlimited-30d-6").status = "archived";
  assert.deepEqual(seedCatalogue(s), []);
  assert.equal(s.bundles.some((b) => b.id === "unlimited-24h-3"), false, "deleted stays deleted");
  assert.equal(s.bundles.find((b) => b.id === "unlimited-30d-6").status, "archived", "archived stays archived");
  assert.ok(s.catalogue.seeds[SEED_MARKER]);
  // An id already present (say, from an earlier partial run) is left as it is.
  const t2 = blank();
  t2.bundles.push({ id: "unlimited-24h-1", catalogue: "unlimited", name: "Edited", price: 999, status: "unpublished" });
  seedCatalogue(t2);
  assert.deepEqual([t2.bundles.filter((b) => b.id === "unlimited-24h-1").length, t2.bundles.find((b) => b.id === "unlimited-24h-1").price], [1, 999]);
});

test("while the switch is legacy (the default), what is on sale is exactly as before", async (t) => {
  const f = await fixture(t);
  const before = catalogue(blank()).map((p) => p.id);
  const { body } = await f.call("/api/plans");
  assert.deepEqual(body.plans.map((p) => p.id), before, "the same fixed-data plans, no Unlimited bundle");
  assert.equal(body.plans.some((p) => p.catalogue === "unlimited"), false);
  assert.equal((await f.buy("unlimited-24h-1")).status, 400, "Unlimited bundles can't be bought yet");
  assert.equal((await f.buy("weekly")).status, 201, "fixed-data still sells");
});

test("switched to unlimited: the 20 offers in order, fixed-data archived, unavailable combinations refused; switching back restores it", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/api/admin/catalogue/mode", { mode: "unlimited" }, "operator")).status, 403, "only the owner switches");
  const switched = await f.call("/api/admin/catalogue/mode", { mode: "unlimited" }, "owner");
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  const { body } = await f.call("/api/plans");
  assert.equal(body.plans.length, 20);
  const expected = [...Object.entries(OWNER_PRICES).flatMap(([key, prices]) => prices.map((price, i) => [`unlimited-${key}-${i + 1}`, price])), ["home-wisp-30d", 50000]];
  assert.deepEqual(body.plans.map((p) => [p.id, p.price]), expected, "every price, in display order, read back from the API");
  assert.ok(body.plans.every((p) => p.quotaGb === null), "all unlimited");
  // Fixed-data: off sale and refused, the same id and terms still found for the customer who has one.
  assert.equal((await f.buy("weekly")).status, 400);
  const s = await f.store.snapshot();
  assert.deepEqual([findPlan(s, "weekly").price, findPlan(s, "weekly").quotaGb], [1000, 5]);
  assert.equal(s.vouchers.find((v) => v.id === "v-weekly").status, "active", "the bundle already bought keeps working");
  // Not offered: five hours for 2-6 devices, or any id outside the catalogue.
  for (const id of ["unlimited-5h-2", "unlimited-5h-6", "made-up"]) assert.equal((await f.buy(id)).status, 400, id);
  assert.equal((await f.buy("unlimited-24h-2")).status, 201);
  // The admin sees the old catalogue as archived.
  const admin = await f.call("/api/admin/catalogue", null, "owner");
  assert.equal(admin.body.mode, "unlimited");
  assert.ok(admin.body.legacy.every((p) => p.status === "archived"));
  // Rollback: the old catalogue is back exactly as it was.
  await f.call("/api/admin/catalogue/mode", { mode: "legacy" }, "owner");
  assert.deepEqual((await f.call("/api/plans")).body.plans.map((p) => p.id), catalogue(blank()).map((p) => p.id));
  const audits = (await f.store.snapshot()).auditLogs.filter((a) => a.action === "catalogue.mode_changed");
  assert.deepEqual(audits.map((a) => [a.meta.from, a.meta.to]).reverse(), [["legacy", "unlimited"], ["unlimited", "legacy"]]);
});

test("admins create, edit, publish, unpublish and reorder; the change is on sale at once", async (t) => {
  const f = await fixture(t);
  await f.call("/api/admin/catalogue/mode", { mode: "unlimited" }, "owner");
  const created = await f.call("/api/admin/catalogue/create", { name: "Weekend test", price: "1500", validityValue: 48, validityUnit: "hours", accessType: "personal_unlimited", deviceSlots: 2 }, "operator");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.bundle.id;
  assert.deepEqual([created.body.bundle.status, created.body.bundle.validityHours, created.body.bundle.deviceSlots], ["unpublished", 48, 2]);
  assert.equal((await f.buy(id)).status, 400, "unpublished: not on sale");
  await f.call("/api/admin/catalogue/publish", { id }, "operator");
  assert.ok((await f.call("/api/plans")).body.plans.some((p) => p.id === id && p.price === 1500));
  const edited = await f.call("/api/admin/catalogue/update", { id, version: 2, price: 1800 }, "owner");
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal((await f.call("/api/admin/catalogue/update", { id, version: 2, price: 1900 }, "owner")).status, 409, "stale version");
  assert.equal((await f.call("/api/plans")).body.plans.find((p) => p.id === id).price, 1800);
  await f.call("/api/admin/catalogue/unpublish", { id }, "operator");
  assert.equal((await f.buy(id)).status, 400, "unpublishing blocks new checkout at once");
  // Reorder: Home WISP first.
  const ids = (await f.call("/api/admin/catalogue", null, "owner")).body.bundles.map((b) => b.id);
  const reordered = ["home-wisp-30d", ...ids.filter((x) => x !== "home-wisp-30d")];
  assert.equal((await f.call("/api/admin/catalogue/reorder", { ids: reordered }, "owner")).status, 200);
  assert.equal((await f.call("/api/plans")).body.plans[0].id, "home-wisp-30d");
  const actions = (await f.store.snapshot()).auditLogs.map((a) => a.action);
  for (const action of ["catalogue.bundle_created", "catalogue.bundle_published", "catalogue.bundle_updated", "catalogue.bundle_unpublished", "catalogue.bundles_reordered"])
    assert.ok(actions.includes(action), action);
});

test("only owners and operators manage the catalogue", async (t) => {
  const f = await fixture(t);
  for (const role of ["auditor", "reseller"]) {
    assert.equal((await f.call("/api/admin/catalogue/create", { name: "X", price: 100, validityValue: 1, validityUnit: "days", accessType: "personal_unlimited", deviceSlots: 1 }, role)).status, 403, role);
  }
  assert.equal((await f.call("/api/admin/catalogue")).status, 401, "signed out");
});

test("the server validates every field", () => {
  const ok = { name: "Personal Unlimited", price: 500, validityValue: 24, validityUnit: "hours", accessType: "personal_unlimited", deviceSlots: 2 };
  assert.deepEqual(bundleInput(ok), { ...ok });
  for (const bad of [{ price: 0 }, { price: "050" }, { price: "1.5" }, { price: "abc" }, { price: 1e9 }, { validityValue: 0 }, { validityValue: 366, validityUnit: "days" },
    { validityValue: 8761, validityUnit: "hours" }, { validityUnit: "weeks" }, { deviceSlots: 0 }, { deviceSlots: 11 }, { accessType: "fixed_data" }, { name: " " }])
    assert.throws(() => bundleInput({ ...ok, ...bad }), (e) => e.status === 400, JSON.stringify(bad));
  // Home WISP is always one router, whatever is sent.
  assert.equal(bundleInput({ ...ok, accessType: "home_wisp_unlimited", deviceSlots: 60 }).deviceSlots, 1);
  // The access type of an existing bundle never changes.
  assert.throws(() => bundleInput({ accessType: "home_wisp_unlimited" }, { ...ok }), (e) => e.status === 400);
});

test("deleting: an unused bundle goes, a sold one is archived and nothing it was sold with changes", async (t) => {
  const f = await fixture(t);
  await f.call("/api/admin/catalogue/mode", { mode: "unlimited" }, "owner");
  const unused = await f.call("/api/admin/catalogue/delete", { id: "unlimited-24h-6" }, "owner");
  assert.equal(unused.body.deleted, true);
  assert.equal((await f.buy("unlimited-7d-1")).status, 201);
  const sBefore = await f.store.snapshot(), payment = sBefore.payments.find((p) => p.planId === "unlimited-7d-1");
  const sold = await f.call("/api/admin/catalogue/delete", { id: "unlimited-7d-1" }, "owner");
  assert.deepEqual([sold.body.archived, sold.body.bundle.status], [true, "archived"]);
  const s = await f.store.snapshot();
  assert.ok(s.bundles.some((b) => b.id === "unlimited-7d-1"), "kept, archived");
  assert.deepEqual(s.payments.find((p) => p.id === payment.id), payment, "the order keeps its snapshot");
  assert.equal((await f.buy("unlimited-7d-1")).status, 400, "archived: off sale");
  assert.equal((await f.call("/api/admin/catalogue/publish", { id: "unlimited-7d-1" }, "owner")).status, 409);
  // A restart (the seed again) recreates neither.
  await f.store.transaction((st) => seedCatalogue(st));
  const after = await f.store.snapshot();
  assert.equal(after.bundles.some((b) => b.id === "unlimited-24h-6"), false);
  assert.equal(after.bundles.find((b) => b.id === "unlimited-7d-1").status, "archived");
});

test("a legacy bundle is unaffected: seeding and switching leave every voucher, payment, receipt and order byte for byte", async (t) => {
  const f = await fixture(t, { seeded: false });
  const keep = (s) => JSON.stringify({ payments: s.payments, vouchers: s.vouchers, storeOrders: s.storeOrders || [], customers: s.customers });
  const before = keep(await f.store.snapshot());
  await f.store.transaction((s) => seedCatalogue(s));
  await f.call("/api/admin/catalogue/mode", { mode: "unlimited" }, "owner");
  await f.call("/api/admin/catalogue/mode", { mode: "legacy" }, "owner");
  assert.equal(keep(await f.store.snapshot()), before);
});
