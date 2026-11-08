import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createStore } from "../server.mjs";
import { createStoreCommerce } from "../lib/store-commerce.mjs";
import {
  storeState,
  reserveOrder,
  settleOrder,
  movement,
  available,
  productInput,
  catalogue,
  canTrack,
  orderView,
} from "../lib/device-store.mjs";
const at = new Date("2030-01-01T10:00:00Z"),
  secret = "store-tests-only";
const names = { en: "Travel router", fr: "Routeur de voyage" };
function fixture(stock = 2) {
  const s = storeState({});
  s.storeSettings.open = true;
  s.storeSettings.pickup = "Office";
  s.storeSettings.hours = "09–17";
  s.storeProducts.push({
    id: "p1",
    version: 1,
    sku: "TEST",
    name: names,
    description: { en: "Router", fr: "Routeur" },
    price: 10000,
    cost: 5000,
    stock,
    status: "published",
    categoryId: "",
    images: [],
    warranty: { en: "One year", fr: "Un an" },
  });
  return s;
}
function input(overrides = {}) {
  return {
    productId: "p1",
    quantity: 1,
    expectedPrice: 10000,
    name: "Buyer",
    phone: "670000001",
    email: "buyer@example.test",
    payerPhone: "690000002",
    network: "orange",
    checkoutKey: randomUUID(),
    ...overrides,
  };
}
const reserve = (s, i = input(), now = at) =>
  reserveOrder(s, i, { now, secret, provider: "mesomb" });
const verified = (o) => ({
  status: "paid",
  transactionReference: o.payment.id,
  providerReference: "ref-" + o.id,
  amount: o.payment.amount,
  currency: "XAF",
});

test("guest checkout keeps account data separate and snapshots product terms", () => {
  const s = fixture();
  s.customers = [{ id: "original", phone: "670000001", name: "Original" }];
  const r = reserve(s);
  assert.equal(r.order.customerId, null);
  assert.equal(s.customers[0].name, "Original");
  s.storeProducts[0].price = 12000;
  s.storeProducts[0].warranty.en = "Changed";
  assert.equal(r.order.payment.amount, 10000);
  assert.equal(r.order.product.warranty.en, "One year");
  assert.equal(r.order.product.cost, undefined);
  assert.equal(canTrack(r.order, r.token, secret), true);
  assert.equal(canTrack(r.order, "bad", secret), false);
  assert.equal(JSON.stringify(orderView(r.order)).includes("690000002"), false);
});
test("exact retry reuses order and token while conflicting retry fails", () => {
  const s = fixture(),
    i = input(),
    a = reserve(s, i),
    b = reserve(s, i);
  assert.equal(a.order.id, b.order.id);
  assert.equal(a.token, b.token);
  assert.equal(s.storeOrders.length, 1);
  assert.throws(() => reserve(s, { ...i, name: "Other" }), /already used/);
});
test("last unit can be reserved only once and settled exactly once", () => {
  const s = fixture(1),
    a = reserve(s);
  assert.equal(available(s, s.storeProducts[0], at), 0);
  assert.throws(() => reserve(s), /stock/);
  settleOrder(s, a.order, verified(a.order), at);
  settleOrder(s, a.order, verified(a.order), at);
  assert.equal(s.storeProducts[0].stock, 0);
  assert.equal(s.storeMovements.length, 1);
  assert.equal(a.order.status, "preparing");
});
test("late successful payment requires review without consuming another reservation", () => {
  const s = fixture(1),
    a = reserve(s),
    later = new Date(+at + 11 * 60000),
    b = reserve(s, input(), later);
  settleOrder(s, a.order, verified(a.order), later);
  assert.equal(a.order.payment.status, "paid");
  assert.equal(a.order.status, "review");
  assert.equal(a.order.payment.review, "late_payment");
  assert.equal(s.storeProducts[0].stock, 1);
  assert.equal(available(s, s.storeProducts[0], later), 0);
  settleOrder(s, b.order, verified(b.order), later);
  assert.equal(s.storeProducts[0].stock, 0);
});
test("provider mismatch never consumes stock or marks payment paid", () => {
  for (const change of [
    { amount: 1 },
    { currency: "USD" },
    { transactionReference: "wrong" },
    { providerReference: "" },
  ]) {
    const s = fixture(),
      o = reserve(s).order;
    assert.throws(
      () => settleOrder(s, o, { ...verified(o), ...change }, at),
      /match/,
    );
    assert.equal(o.payment.status, "pending");
    assert.equal(s.storeProducts[0].stock, 2);
  }
});
test("failed payment releases reservation and stock cannot fall below reservations", () => {
  const s = fixture(1),
    o = reserve(s).order;
  assert.throws(
    () => movement(s, s.storeProducts[0], -1, "remove", "owner", at),
    /reserved/,
  );
  settleOrder(s, o, { ...verified(o), status: "failed" }, at);
  assert.equal(available(s, s.storeProducts[0], at), 1);
});
test("checkout rejects changed price, invalid quantities, hidden catalogue and closed store", () => {
  for (const quantity of [0, -1, 1.5, 21])
    assert.throws(() => reserve(fixture(), input({ quantity })));
  assert.throws(
    () => reserve(fixture(), input({ expectedPrice: 1 })),
    /price changed/,
  );
  const s = fixture();
  s.storeSettings.open = false;
  assert.throws(() => reserve(s), /not accepting/);
  s.storeSettings.open = true;
  s.storeCategories = [{ id: "hidden", hidden: true }];
  s.storeProducts[0].categoryId = "hidden";
  assert.equal(catalogue(s, at).products.length, 0);
  assert.throws(() => reserve(s), /unavailable/);
});
test("public catalogue excludes internal costs and unpublished products", () => {
  const s = fixture();
  s.storeProducts.push({ ...s.storeProducts[0], id: "draft", status: "draft" });
  const c = catalogue(s, at);
  assert.equal(c.products.length, 1);
  assert.equal(c.products[0].cost, undefined);
  assert.equal(c.products[0].stock, undefined);
});
test("product validation rejects active content image sources and duplicate SKUs", () => {
  const s = fixture(),
    p = {
      ...s.storeProducts[0],
      description: names,
      specifications: names,
      compatibility: names,
      contents: names,
      setup: names,
    };
  assert.throws(
    () =>
      productInput(s, {
        ...p,
        sku: "OTHER",
        images: [{ data: "data:image/svg+xml;base64,PHN2Zz4=", alt: names }],
      }),
    /Upload/,
  );
  assert.throws(() => productInput(s, p), /already exists/);
});

test("concurrent provider submissions and checks are leased and settle once", async () => {
  const store = createStore({ persistent: false });
  let creates = 0,
    checks = 0;
  let id;
  await store.transaction((s) => {
    Object.assign(s, fixture(1));
    id = reserve(s).order.id;
  });
  const commerce = createStoreCommerce({
    store,
    clock: () => at,
    pays: {
      mesomb: {
        createPayment: async (p) => {
          creates++;
          return { providerReference: "ref-" + id };
        },
        verifyPayment: async (p) => {
          checks++;
          return {
            status: "paid",
            transactionReference: p.id,
            providerReference: p.providerReference,
            amount: p.amount,
            currency: p.currency,
          };
        },
      },
    },
  });
  await Promise.all([commerce.start(id), commerce.start(id)]);
  await Promise.all([
    commerce.verify(id, { force: true }),
    commerce.verify(id, { force: true }),
  ]);
  const s = await store.snapshot();
  assert.equal(creates, 1);
  assert.equal(checks, 1);
  assert.equal(s.storeOrders[0].payment.status, "paid");
  assert.equal(s.vouchers.length, 0);
  assert.equal(s.storeProducts[0].stock, 0);
});
test("uncertain creation is verified without submitting another charge", async () => {
  const store = createStore({ persistent: false });
  let creates = 0,
    id;
  await store.transaction((s) => {
    Object.assign(s, fixture());
    id = reserve(s).order.id;
  });
  const commerce = createStoreCommerce({
    store,
    clock: () => at,
    pays: {
      mesomb: {
        createPayment: async () => {
          creates++;
          throw Error("lost response");
        },
        verifyPayment: async (p) => ({
          status: "paid",
          transactionReference: p.id,
          providerReference: "recovered",
          amount: p.amount,
          currency: p.currency,
        }),
      },
    },
  });
  await commerce.start(id);
  await commerce.start(id);
  await commerce.verify(id, { force: true });
  assert.equal(creates, 1);
  assert.equal((await store.snapshot()).storeOrders[0].payment.status, "paid");
});
test("expired reservation cannot submit a new payment", async () => {
  const store = createStore({ persistent: false });
  let id,
    calls = 0;
  await store.transaction((s) => {
    Object.assign(s, fixture());
    id = reserve(s).order.id;
  });
  const commerce = createStoreCommerce({
    store,
    clock: () => new Date(+at + 11 * 60000),
    pays: {
      mesomb: {
        createPayment: async () => {
          calls++;
        },
      },
    },
  });
  await commerce.start(id);
  assert.equal(calls, 0);
});
test("cancelled reservation late payment remains reviewable", () => {
  const s = fixture(),
    o = reserve(s).order;
  o.status = "cancelled";
  o.stockState = "released";
  settleOrder(s, o, verified(o), at);
  assert.equal(o.status, "review");
  assert.equal(s.storeProducts[0].stock, 2);
});
test("refund submission and confirmed restock are idempotent", async () => {
  const store = createStore({ persistent: false });
  let id,
    calls = 0,
    time = at;
  await store.transaction((s) => {
    Object.assign(s, fixture(1));
    const o = reserve(s).order;
    id = o.id;
    settleOrder(s, o, verified(o), at);
    o.payment.refund = { id: "refund1", status: "requested", restock: true };
    o.payment.status = "refund-pending";
  });
  const commerce = createStoreCommerce({
    store,
    clock: () => time,
    pays: {
      mesomb: {
        refundPayment: async () => {
          calls++;
          return { status: "completed", providerReference: "refund-ref" };
        },
      },
    },
  });
  await Promise.all([commerce.refund(id), commerce.refund(id)]);
  time = new Date(+at + 60000);
  await commerce.refund(id);
  const s = await store.snapshot();
  assert.equal(calls, 1);
  assert.equal(s.storeOrders[0].payment.status, "refunded");
  assert.equal(s.storeProducts[0].stock, 1);
  assert.equal(s.storeMovements.length, 2);
});
test("uncertain refund cannot be submitted twice", async () => {
  const store = createStore({ persistent: false });
  let id,
    calls = 0,
    time = at;
  await store.transaction((s) => {
    Object.assign(s, fixture());
    const o = reserve(s).order;
    id = o.id;
    settleOrder(s, o, verified(o), at);
    o.payment.refund = { id: "refund1", status: "requested" };
  });
  const commerce = createStoreCommerce({
    store,
    clock: () => time,
    pays: {
      mesomb: {
        refundPayment: async () => {
          calls++;
          throw Error("timeout");
        },
      },
    },
  });
  await commerce.refund(id);
  time = new Date(+at + 120000);
  await commerce.refund(id);
  assert.equal(calls, 1);
  assert.equal(
    (await store.snapshot()).storeOrders[0].payment.refund.status,
    "uncertain",
  );
});

test(
  "PostgreSQL store persists catalogue, reservations, stock ledger and settings across reopen",
  { skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL is not set" },
  async () => {
    const { default: pg } = await import("pg");
    const { createPostgresStore } = await import("../lib/postgres-store.mjs");
    const { blank } = await import("../lib/api/state.mjs");
    const { applySchemaMigrations } = await import(
      "../scripts/migrate-postgres.mjs"
    );
    const schema = "device_store_" + process.pid,
      admin = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 5,
    });
    try {
      const client = await pool.connect();
      try {
        await applySchemaMigrations(client);
      } finally {
        client.release();
      }
      const first = createPostgresStore({ pool, initialState: blank }),
        second = createPostgresStore({ pool, initialState: blank });
      await first.transaction((s) => {
        Object.assign(s, fixture(1));
      });
      const outcomes = await Promise.allSettled([
        first.transaction((s) => reserve(s)),
        second.transaction((s) => reserve(s)),
      ]);
      assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
      let snapshot = await second.snapshot();
      assert.equal(snapshot.storeOrders.length, 1);
      const id = snapshot.storeOrders[0].id;
      await first.transaction((s) => {
        const o = s.storeOrders.find((o) => o.id === id);
        settleOrder(s, o, verified(o), at);
      });
      const reopened = createPostgresStore({ pool, initialState: blank });
      snapshot = await reopened.snapshot();
      assert.equal(snapshot.storeProducts[0].stock, 0);
      assert.equal(snapshot.storeOrders[0].payment.status, "paid");
      assert.equal(snapshot.storeMovements.length, 1);
      assert.equal(snapshot.storeSettings.pickup, "Office");
      // Independent database uniqueness constraints defend provider and checkout identities.
      await assert.rejects(
        pool.query(
          "INSERT INTO events (kind,id,ordinal,payload) VALUES ('store_order','duplicate',9,$1)",
          [JSON.stringify({ ...snapshot.storeOrders[0], id: "duplicate" })],
        ),
        (e) => e.code === "23505",
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test("paid/ready email jobs retry without changing payment or stock", async () => {
  const store = createStore({ persistent: false });
  let id,
    calls = 0,
    time = at;
  await store.transaction((s) => {
    Object.assign(s, fixture());
    const o = reserve(s).order;
    id = o.id;
    settleOrder(s, o, verified(o), at);
  });
  const commerce = createStoreCommerce({
    store,
    clock: () => time,
    pays: {},
    email: {
      configured: () => true,
      sendStoreOrder: async () => {
        calls++;
        if (calls === 1) throw Error("email outage");
      },
    },
  });
  await commerce.run();
  time = new Date(+at + 120000);
  await commerce.run();
  await commerce.run();
  let s = await store.snapshot();
  assert.equal(calls, 2);
  assert.equal(s.storeOrders[0].payment.status, "paid");
  assert.equal(s.storeProducts[0].stock, 1);
  await store.transaction((s) => {
    s.storeOrders[0].status = "ready";
  });
  await commerce.run();
  assert.equal(calls, 3);
});

test("invalid stock adjustment types are rejected without corrupting quantities", () => {
  for (const delta of ["2", true, NaN, Infinity, 1.5]) {
    const s = fixture();
    assert.throws(() =>
      movement(s, s.storeProducts[0], delta, "invalid", "owner", at),
    );
    assert.equal(s.storeProducts[0].stock, 2);
  }
});
test("failed refund retains paid funds and does not restock equipment", async () => {
  const store = createStore({ persistent: false });
  let id;
  await store.transaction((s) => {
    Object.assign(s, fixture(1));
    const o = reserve(s).order;
    id = o.id;
    settleOrder(s, o, verified(o), at);
    o.payment.refund = {
      id: "failed-refund",
      status: "requested",
      restock: true,
    };
    o.payment.status = "refund-pending";
  });
  const commerce = createStoreCommerce({
    store,
    clock: () => at,
    pays: { mesomb: { refundPayment: async () => ({ status: "failed" }) } },
  });
  await commerce.refund(id);
  const s = await store.snapshot();
  assert.equal(s.storeOrders[0].payment.status, "paid");
  assert.equal(s.storeOrders[0].payment.refund.status, "failed");
  assert.equal(orderView(s.storeOrders[0]).refundStatus, "failed");
  assert.equal(s.storeProducts[0].stock, 0);
});
