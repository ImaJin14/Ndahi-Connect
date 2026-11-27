import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { notificationPreferences } from "../lib/notifications.mjs";

// Shop order updates (#357, owner: built as drawn, off by default): a paid
// order's notice follows it from placed to ready to collected, only for its
// own customer and only while the Account switch is on.
const endpoint = "/api/account/notifications";
const order = (id, customerId, status, extra = {}) => ({ id, reference: "NS-" + id.toUpperCase(), customerId, status, product: { name: { en: "TP-Link router", fr: "Routeur TP-Link" } },
  createdAt: "2030-01-01T09:00:00.000Z", history: [], payment: { status: "paid", confirmedAt: "2030-01-01T09:05:00.000Z" }, collectionCode: "481923", ...extra });

async function fixture(t) {
  const f = await pairingFixture({ env: { ADMIN_APP_URL: "http://customer.test" } }); t.after(f.close);
  await f.store.transaction((s) => {
    s.storeOrders ??= [];
    s.storeOrders.push(order("a1", "c1", "preparing"), order("a2", "c1", "awaiting_payment", { payment: { status: "pending" } }), order("b1", "c2", "ready"));
  });
  return f;
}
const orderItems = (body) => body.items.filter((n) => n.category === "orders");

test("shop order updates start off and show only the customer's paid orders once switched on", async (t) => {
  const f = await fixture(t);
  let inbox = (await f.call(endpoint)).body;
  assert.equal(inbox.preferences.categories.orders, false, "off by default, as drawn");
  assert.equal(inbox.categories.orders, "Shop orders");
  assert.deepEqual(orderItems(inbox), []);
  assert.equal((await f.call(endpoint, { action: "preferences", categories: { orders: true } })).status, 200);
  inbox = (await f.call(endpoint)).body;
  assert.deepEqual(orderItems(inbox).map((n) => [n.id, n.title, n.actionRequired, n.url]),
    [["order:a1", "Order placed", false, "/dashboard#order/a1"]], "not the unpaid order, not another customer's");
  assert.equal(orderItems(inbox)[0].body, "TP-Link router: we're preparing it. We'll let you know when it's ready to collect.");
  assert.equal(orderItems(inbox)[0].updatedAt, "2030-01-01T09:05:00.000Z");
  assert.doesNotMatch(JSON.stringify(orderItems(inbox)), /481923/, "the collection code stays on the order page");
  // Another browser of the account sees the same setting; the other customer doesn't.
  assert.equal((await f.call(endpoint, undefined, { session: "secondary" })).body.preferences.categories.orders, true);
  assert.equal((await f.call(endpoint, undefined, { session: "other" })).body.preferences.categories.orders, false);
});

test("an order's notice follows it to ready and collected, and the switch turns it off again", async (t) => {
  const f = await fixture(t);
  await f.call(endpoint, { action: "preferences", categories: { orders: true } });
  const placed = orderItems((await f.call(endpoint)).body)[0];
  await f.call(endpoint, { action: "read", id: placed.id });
  await f.store.transaction((s) => { const o = s.storeOrders.find((x) => x.id === "a1"); o.status = "ready"; o.history.push({ action: "ready", actor: "owner", at: "2030-01-01T11:00:00.000Z" }); });
  let item = orderItems((await f.call(endpoint)).body)[0];
  assert.deepEqual([item.id, item.title, item.read, item.updatedAt, item.actionRequired], ["order:a1", "Order ready to collect", false, "2030-01-01T11:00:00.000Z", false], "a new status is unread again");
  assert.equal(item.body, "TP-Link router is ready to collect. Open the order for its collection code and pickup details.");
  assert.notEqual(item.version, placed.version);
  await f.store.transaction((s) => { const o = s.storeOrders.find((x) => x.id === "a1"); o.status = "collected"; o.history.push({ action: "collect", actor: "owner", at: "2030-01-01T12:00:00.000Z" }); });
  item = orderItems((await f.call(endpoint)).body)[0];
  assert.deepEqual([item.title, item.body, item.updatedAt], ["Order collected", "TP-Link router was collected. Thank you for shopping with NDAHI.", "2030-01-01T12:00:00.000Z"]);
  await f.call(endpoint, { action: "preferences", categories: { orders: false } });
  assert.deepEqual(orderItems((await f.call(endpoint)).body), []);
});

test("the orders category is off by default while every other category stays on", () => {
  const prefs = notificationPreferences({ notificationStates: [] }, "customer:c1");
  assert.equal(prefs.categories.orders, false);
  for (const key of ["devices", "payments", "usage", "security", "service"]) assert.equal(prefs.categories[key], true, key);
  const saved = notificationPreferences({ notificationStates: [{ id: "preferences:customer:c1", categories: { orders: true, usage: false } }] }, "customer:c1");
  assert.equal(saved.categories.orders, true); assert.equal(saved.categories.usage, false);
});
