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
  // A bundle the server knows but doesn't sell: "no longer on sale" (#333).
  const offSale = async (planId) => { const r = await buy(planId); return r.status === 409 && r.body.code === "BUNDLE_NOT_ON_SALE"; };
  const buy = (planId) => call("/api/purchase", { phone: "699" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"), planId, requestKey: randomUUID() });
  return { store, call, buy, offSale, now };
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
  assert.ok(await f.offSale("unlimited-24h-1"), "Unlimited bundles can't be bought yet");
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
  assert.ok(await f.offSale("weekly"), "fixed-data: no longer on sale");
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
  assert.ok(await f.offSale(id), "unpublished: not on sale");
  await f.call("/api/admin/catalogue/publish", { id }, "operator");
  assert.ok((await f.call("/api/plans")).body.plans.some((p) => p.id === id && p.price === 1500));
  const edited = await f.call("/api/admin/catalogue/update", { id, version: 2, price: 1800 }, "owner");
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal((await f.call("/api/admin/catalogue/update", { id, version: 2, price: 1900 }, "owner")).status, 409, "stale version");
  assert.equal((await f.call("/api/plans")).body.plans.find((p) => p.id === id).price, 1800);
  await f.call("/api/admin/catalogue/unpublish", { id }, "operator");
  assert.ok(await f.offSale(id), "unpublishing blocks new checkout at once");
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
  // An edit may change the access type (canvas AdminBundleEdit, #339); Home WISP is still one router.
  assert.deepEqual([bundleInput({ accessType: "home_wisp_unlimited" }, { ...ok }).accessType, bundleInput({ accessType: "home_wisp_unlimited" }, { ...ok }).deviceSlots], ["home_wisp_unlimited", 1]);
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
  assert.ok(await f.offSale("unlimited-7d-1"), "archived: off sale");
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

// Admin → Bundles (#338, canvas AdminBundles): "Used by", "Most bought", the
// delete dialog's choice and the earlier plans' place in the list, all from the API.
test("the admin list says how each bundle is used, which sells most, and whether it can be deleted", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    // 7 days · 2 devices: two paid checkouts (one still running) and a gift waiting for its first connection.
    s.payments.push({ id: "p1", planId: "unlimited-7d-2", status: "paid" }, { id: "p2", planId: "unlimited-7d-2", status: "pending" });
    s.vouchers.push({ id: "u1", planId: "unlimited-7d-2", paymentId: "p1", status: "active" },
      { id: "u2", planId: "unlimited-7d-2", status: "available", startsOnFirstConnection: true, generatedByAdmin: true, saleType: "gift" },
      { id: "u3", planId: "unlimited-24h-1", status: "expired", generatedByAdmin: true, saleType: "gift" });
  });
  const list = (await f.call("/api/admin/catalogue", null, "operator")).body;
  const row = (id) => list.bundles.find((b) => b.id === id);
  assert.deepEqual([row("unlimited-7d-2").orders, row("unlimited-7d-2").active, row("unlimited-7d-2").inUse, row("unlimited-7d-2").mostBought], [3, 2, true, true]);
  assert.deepEqual([row("unlimited-24h-1").orders, row("unlimited-24h-1").active, row("unlimited-24h-1").mostBought], [1, 0, false]);
  assert.deepEqual([row("unlimited-7d-3").orders, row("unlimited-7d-3").inUse], [0, false], "never bought: the dialog offers a permanent delete");
  assert.equal(list.bundles.filter((b) => b.mostBought).length, 1);
  const weekly = list.legacy.find((p) => p.id === "weekly");
  assert.deepEqual([weekly.orders, weekly.active, weekly.inUse, weekly.status], [1, 1, true, "published"]);
  assert.ok(list.legacy.every((p) => p.displayOrder > Math.max(...list.bundles.map((b) => b.displayOrder))), "earlier plans list after the Unlimited bundles");
});

test("reordering can place an earlier plan anywhere in the list without changing it or what is on sale", async (t) => {
  const f = await fixture(t);
  const before = await f.call("/api/plans");
  const { bundles, legacy } = (await f.call("/api/admin/catalogue", null, "owner")).body;
  const ids = [bundles[0].id, "weekly", ...bundles.slice(1).map((b) => b.id), ...legacy.filter((p) => p.id !== "weekly").map((p) => p.id)];
  const moved = await f.call("/api/admin/catalogue/reorder", { ids }, "owner");
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const order = [...moved.body.bundles, ...moved.body.legacy].sort((a, b) => a.displayOrder - b.displayOrder).map((b) => b.id);
  assert.deepEqual(order, ids);
  assert.deepEqual(await f.call("/api/plans"), before, "the legacy checkout is unchanged while the switch is legacy");
  const s = await f.store.snapshot();
  assert.deepEqual(s.catalogue.legacyOrder.weekly, 20);
  assert.equal(findPlan(s, "weekly").displayOrder, undefined, "the plan itself is untouched");
  assert.equal((await f.call("/api/admin/catalogue/reorder", { ids: ["weekly", "no-such-plan"] }, "owner")).status, 400);
});

test("the earlier bundle endpoints refuse Unlimited bundles: the catalogue manages them", async (t) => {
  const f = await fixture(t);
  for (const path of ["/api/admin/bundles/update", "/api/admin/bundles/delete"]) {
    const r = await f.call(path, { bundleId: "unlimited-7d-1", name: "Changed", price: 1, quotaGb: 5, validityHours: 1, deviceLimit: 1 }, "owner");
    assert.deepEqual([r.status, r.body.error], [409, "Unlimited bundles are managed in the bundle catalogue."], path);
  }
  const b = (await f.store.snapshot()).bundles.find((x) => x.id === "unlimited-7d-1");
  assert.deepEqual([b.name, b.price, b.quotaGb], ["Personal Unlimited", 2500, null]);
});

// Edit bundle (#339, canvas AdminBundleEdit): what the edit screen sends and shows.
test("an edit may change the access type and the place in the list; orders and vouchers keep their terms", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    s.payments.push({ id: "pend-1", planId: "unlimited-7d-2", status: "pending", amount: 4000, planSnapshot: { id: "unlimited-7d-2", price: 4000, accessType: "personal_unlimited", deviceSlots: 2 } },
      { id: "pend-2", planId: "unlimited-7d-2", status: "pending", amount: 4000, planSnapshot: { id: "unlimited-7d-2", price: 4000 } });
    s.vouchers.push({ id: "running", customerId: "amina", planId: "unlimited-7d-2", status: "active", accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, sharing: false });
  });
  let row = (await f.call("/api/admin/catalogue", null, "owner")).body.bundles.find((b) => b.id === "unlimited-7d-2");
  assert.deepEqual([row.pending, row.pendingPrice, row.active], [2, 4000, 1], "Who a change affects");
  const before = JSON.stringify((await f.store.snapshot()).payments) + JSON.stringify((await f.store.snapshot()).vouchers);
  const r = await f.call("/api/admin/catalogue/update", { id: "unlimited-7d-2", version: row.version, name: "Personal Unlimited", price: "4200", accessType: "home_wisp_unlimited",
    validityValue: 7, validityUnit: "days", deviceSlots: 2, status: "unpublished", position: 1 }, "owner");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.bundle.accessType, r.body.bundle.deviceSlots, r.body.bundle.sharing, r.body.bundle.price, r.body.bundle.status], ["home_wisp_unlimited", null, true, 4200, "unpublished"]);
  const order = [...r.body.bundles, ...r.body.legacy].sort((a, b) => a.displayOrder - b.displayOrder).map((b) => b.id);
  assert.equal(order[0], "unlimited-7d-2", "display order 1 puts it first");
  const s = await f.store.snapshot();
  assert.equal(JSON.stringify(s.payments) + JSON.stringify(s.vouchers), before, "pending orders keep their price and the running bundle its terms");
  assert.ok(s.auditLogs.some((a) => a.action === "catalogue.bundle_updated" && a.meta.before.accessType === "personal_unlimited" && a.meta.after.accessType === "home_wisp_unlimited"));
});

test("Add bundle can publish at once and place the bundle; bad status or place is refused", async (t) => {
  const f = await fixture(t);
  const terms = { name: "Personal Unlimited · 5 hours · 2 devices", price: "450", accessType: "personal_unlimited", validityValue: 5, validityUnit: "hours", deviceSlots: 2 };
  const made = await f.call("/api/admin/catalogue/create", { ...terms, status: "published", position: 2 }, "operator");
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.bundle.status, "published");
  const order = [...made.body.bundles, ...made.body.legacy].sort((a, b) => a.displayOrder - b.displayOrder).map((b) => b.id);
  assert.equal(order[1], made.body.bundle.id);
  for (const extra of [{ status: "archived" }, { status: "live" }, { position: 0 }, { position: "x" }])
    assert.equal((await f.call("/api/admin/catalogue/create", { ...terms, ...extra }, "owner")).status, 400, JSON.stringify(extra));
  await f.call("/api/admin/catalogue/mode", { mode: "unlimited" }, "owner");
  assert.ok((await f.call("/api/plans")).body.plans.some((p) => p.id === made.body.bundle.id), "published: on sale once the switch is on");
});
