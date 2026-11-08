import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { storeState } from "../lib/device-store.mjs";
import { hashSecret } from "../lib/security.mjs";
const time = new Date("2030-01-01T10:00:00Z"),
  secret = "store-api-tests-secret";
const text = { en: "Router", fr: "Routeur" };
const newProduct = (overrides) => ({
  sku: randomUUID(),
  name: text,
  description: text,
  specifications: text,
  compatibility: text,
  contents: text,
  warranty: text,
  setup: text,
  images: [],
  price: 10000,
  cost: 6000,
  status: "published",
  featured: true,
  categoryId: "",
  ...overrides,
});
async function fixture(t, { production = false } = {}) {
  const store = createStore({ persistent: false });
  let stateTime = time,
    charges = 0;
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = {
      ...s.storeSettings,
      open: true,
      pickup: "Office",
      contact: "670000001",
      warranty: text,
      returns: text,
    };
    s.storeProducts.push({ id: "p1", version: 1, stock: 5, ...newProduct() });
    for (const role of ["owner", "operator", "reseller", "auditor"]) {
      s.adminUsers.push({ id: role, role, username: role, active: true });
      s.adminSessions.push({
        id: role,
        userId: role,
        role,
        tokenHash: hashSecret(role, secret),
        csrfToken: "csrf-" + role,
        expiresAt: "2031-01-01T00:00:00Z",
      });
    }
    s.customers.push({
      id: "c1",
      name: "Original",
      phone: "670000001",
      email: "original@example.test",
    });
    s.dashboardSessions.push({
      id: "c-session",
      customerId: "c1",
      tokenHash: hashSecret("customer", secret),
      csrfToken: "customer-csrf",
      expiresAt: "2031-01-01T00:00:00Z",
    });
  });
  const adapter = {
    configured: () => true,
    createPayment: async (p) => {
      charges++;
      return { status: "pending", providerReference: "ref-" + p.id };
    },
    verifyPayment: async (p) => ({
      status: "paid",
      amount: p.amount,
      currency: "XAF",
      providerReference: p.providerReference,
      transactionReference: p.id,
    }),
    handleWebhook: async (raw, sig) => {
      if (sig !== "valid") throw Error();
      return JSON.parse(raw);
    },
    refundPayment: async () => ({
      status: "completed",
      providerReference: "refund-ref",
    }),
  };
  const server = createServer({
    store,
    now: () => stateTime,
    validateConfig: false,
    payments: { mesomb: adapter },
    env: {
      NODE_ENV: production ? "production" : "test",
      PAYMENT_MODE: "mesomb",
      STORE_APP_URL: "http://localhost:8083",
      CUSTOMER_APP_URL: "http://localhost:8080",
      ADMIN_SESSION_SECRET: secret,
      CUSTOMER_SESSION_SECRET: secret,
      SECRET_PEPPER: secret,
      PAYMENT_WEBHOOK_REPLAY_ENABLED: "false",
      NETWORK_QUEUE_ENABLED: "false",
      BILLING_WORKER_ENABLED: "false",
      BOOTSTRAP_MODE: "false",
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  const base = "http://127.0.0.1:" + server.address().port;
  async function call(
    path,
    input,
    { role, customer = false, origin, csrf, ...headers } = {},
  ) {
    const r = await fetch(base + path, {
      method: input ? "POST" : "GET",
      headers: {
        ...(input ? { "content-type": "application/json" } : {}),
        ...(role
          ? { cookie: "admin_session=" + role }
          : customer
            ? { cookie: "customer_session=customer" }
            : {}),
        ...(origin ? { origin } : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
        ...headers,
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return { status: r.status, body: await r.json(), headers: r.headers };
  }
  const checkout = (overrides) => ({
    productId: "p1",
    quantity: 1,
    expectedPrice: 10000,
    name: "Guest different name",
    phone: "670000001",
    email: "different@example.test",
    payerPhone: "690000002",
    network: "orange",
    checkoutKey: randomUUID(),
    ...overrides,
  });
  return {
    store,
    call,
    checkout,
    server,
    charges: () => charges,
    advance: (ms) => (stateTime = new Date(+stateTime + ms)),
  };
}
test("guest purchase accepts existing-account phone, isolates identity and verifies hardware only", async (t) => {
  const f = await fixture(t);
  const a = await f.call("/api/store/checkout", f.checkout());
  assert.equal(a.status, 200);
  assert.ok(a.body.token);
  const b = await f.call("/api/store/verify", {
    orderId: a.body.order.id,
    token: a.body.token,
  });
  assert.equal(b.body.order.paymentStatus, "paid");
  const s = await f.store.snapshot();
  assert.equal(s.customers.length, 1);
  assert.equal(s.customers[0].name, "Original");
  assert.equal(s.vouchers.length, 0);
  assert.equal(s.storeProducts[0].stock, 4);
});
test("guest order number alone cannot expose an order and bad guesses are throttled", async (t) => {
  const f = await fixture(t),
    a = await f.call("/api/store/checkout", f.checkout());
  for (let i = 0; i < 29; i++)
    assert.equal(
      (
        await f.call("/api/store/order", {
          orderId: a.body.order.id,
          token: "bad",
        })
      ).status,
      404,
    );
  assert.equal(
    (
      await f.call("/api/store/order", {
        orderId: a.body.order.id,
        token: "bad",
      })
    ).status,
    429,
  );
});
test("stock reservations are atomic under concurrent HTTP checkout", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => (s.storeProducts[0].stock = 1));
  const results = await Promise.all([
    f.call("/api/store/checkout", f.checkout()),
    f.call("/api/store/checkout", f.checkout()),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(f.charges(), 1);
});
test("repeat checkout submits a single payment and conflicts on changed buyer", async (t) => {
  const f = await fixture(t),
    input = f.checkout();
  const [a, b] = await Promise.all([
    f.call("/api/store/checkout", input),
    f.call("/api/store/checkout", input),
  ]);
  assert.equal(a.body.order.id, b.body.order.id);
  assert.equal(f.charges(), 1);
  assert.equal(
    (await f.call("/api/store/checkout", { ...input, name: "Changed" })).status,
    409,
  );
});
test("signed-in checkout and guest-order attachment require CSRF and verified order token", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.call("/api/account/store/checkout", f.checkout(), {
        customer: true,
      })
    ).status,
    403,
  );
  const a = await f.call("/api/account/store/checkout", f.checkout(), {
    customer: true,
    csrf: "customer-csrf",
  });
  assert.equal(a.status, 200);
  const context = await f.call("/api/account/store/context", undefined, {
    customer: true,
  });
  assert.equal(context.body.orders.length, 1);
  const guest = await f.call("/api/store/checkout", f.checkout());
  assert.equal(
    (
      await f.call(
        "/api/account/store/claim",
        { orderId: guest.body.order.id },
        { customer: true, csrf: "customer-csrf" },
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.call(
        "/api/account/store/claim",
        { orderId: guest.body.order.id, token: guest.body.token },
        { customer: true, csrf: "customer-csrf" },
      )
    ).status,
    200,
  );
});
test("store origin is restricted to store routes and cannot access admin or other account endpoints", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.call("/api/store/catalogue", undefined, {
        origin: "http://localhost:8083",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.call("/api/admin/store", undefined, {
        role: "owner",
        origin: "http://localhost:8083",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call("/api/account/dashboard", undefined, {
        customer: true,
        origin: "http://localhost:8083",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call("/api/store/catalogue", undefined, {
        origin: "https://evil.test",
      })
    ).status,
    403,
  );
});
test("production store mutations require trusted origin and admin CSRF", async (t) => {
  const f = await fixture(t, { production: true });
  assert.equal((await f.call("/api/store/checkout", f.checkout())).status, 403);
  assert.equal(
    (
      await f.call("/api/admin/store/products/save", newProduct(), {
        role: "owner",
        origin: "http://localhost:8081",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call("/api/admin/store/products/save", newProduct(), {
        role: "owner",
        origin: "http://localhost:8081",
        csrf: "csrf-owner",
      })
    ).status,
    200,
  );
});
test("admin CRUD validates roles, versions and deletion safeguards", async (t) => {
  const f = await fixture(t);
  for (const role of ["reseller", "auditor"]) {
    assert.equal(
      (await f.call("/api/admin/store", undefined, { role })).status,
      403,
    );
    assert.equal(
      (await f.call("/api/admin/store/products/save", newProduct(), { role }))
        .status,
      403,
    );
  }
  const a = await f.call("/api/admin/store/products/save", newProduct(), {
    role: "owner",
  });
  assert.equal(a.status, 200);
  const p = a.body.products.find((p) => p.id !== "p1");
  assert.equal(
    (
      await f.call(
        "/api/admin/store/products/save",
        { ...p, version: 0 },
        { role: "owner" },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call(
        "/api/admin/store/products/delete",
        { id: p.id, version: p.version },
        { role: "owner" },
      )
    ).status,
    200,
  );
  await f.call("/api/store/checkout", f.checkout());
  assert.equal(
    (
      await f.call(
        "/api/admin/store/products/delete",
        { id: "p1", version: 1 },
        { role: "owner" },
      )
    ).status,
    409,
  );
  const op = await f.call("/api/admin/store", undefined, { role: "operator" });
  assert.equal(op.body.products[0].cost, undefined);
});
test("admin stock adjustment retries are idempotent and cannot remove reserved stock", async (t) => {
  const f = await fixture(t),
    i = {
      id: "p1",
      version: 1,
      delta: 2,
      reason: "Delivery",
      operationKey: randomUUID(),
    };
  assert.equal(
    (await f.call("/api/admin/store/stock/adjust", i, { role: "owner" }))
      .status,
    200,
  );
  assert.equal(
    (await f.call("/api/admin/store/stock/adjust", i, { role: "owner" })).body
      .replayed,
    true,
  );
  assert.equal((await f.store.snapshot()).storeProducts[0].stock, 7);
  assert.equal(
    (
      await f.call(
        "/api/admin/store/stock/adjust",
        { ...i, delta: 3 },
        { role: "owner" },
      )
    ).status,
    409,
  );
});
test("admin collection needs paid ready order and code; tracking rotation revokes old token", async (t) => {
  const f = await fixture(t),
    a = await f.call("/api/store/checkout", f.checkout()),
    id = a.body.order.id;
  assert.equal(
    (
      await f.call(
        "/api/admin/store/orders/update",
        { id, version: 1, action: "ready" },
        { role: "owner" },
      )
    ).status,
    409,
  );
  await f.call("/api/store/verify", { orderId: id, token: a.body.token });
  let o = (await f.store.snapshot()).storeOrders[0];
  await f.call(
    "/api/admin/store/orders/update",
    { id, version: o.version, action: "ready" },
    { role: "owner" },
  );
  o = (await f.store.snapshot()).storeOrders[0];
  assert.equal(
    (
      await f.call(
        "/api/admin/store/orders/update",
        { id, version: o.version, action: "collect", collectionCode: "bad" },
        { role: "owner" },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call(
        "/api/admin/store/orders/update",
        {
          id,
          version: o.version,
          action: "collect",
          collectionCode: o.collectionCode,
        },
        { role: "owner" },
      )
    ).status,
    200,
  );
  o = (await f.store.snapshot()).storeOrders[0];
  const rotated = await f.call(
    "/api/admin/store/orders/update",
    { id, version: o.version, action: "rotate-link" },
    { role: "owner" },
  );
  assert.equal(
    (await f.call("/api/store/order", { orderId: id, token: a.body.token }))
      .status,
    404,
  );
  assert.equal(
    (
      await f.call("/api/store/order", {
        orderId: id,
        token: rotated.body.token,
      })
    ).status,
    200,
  );
});
test("signed webhooks verify store payments and do not issue vouchers", async (t) => {
  const f = await fixture(t),
    a = await f.call("/api/store/checkout", f.checkout()),
    s = await f.store.snapshot(),
    order = s.storeOrders[0];
  const event = {
    paymentId: order.payment.id,
    eventId: "store-event",
    transactionId: order.payment.providerReference,
  };
  assert.equal(
    (
      await f.call("/api/webhooks/mesomb", event, {
        "x-mesomb-webhook-signature": "invalid",
      })
    ).status,
    401,
  );
  f.advance(20000);
  assert.equal(
    (
      await f.call("/api/webhooks/mesomb", event, {
        "x-mesomb-webhook-signature": "valid",
      })
    ).status,
    200,
  );
  const state = await f.store.snapshot();
  assert.equal(state.storeOrders[0].payment.status, "paid");
  assert.equal(state.vouchers.length, 0);
});
test("store static service is isolated and includes responsive storefront assets", async (t) => {
  const app = createStaticServer("store", { apiUrl: "http://localhost:8082" });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        app.closeAllConnections();
        app.close(r);
      }),
  );
  const base = "http://127.0.0.1:" + app.address().port;
  assert.equal((await fetch(base + "/")).status, 200);
  assert.match(await (await fetch(base + "/")).text(), /NDAHI Store/);
  assert.equal((await fetch(base + "/readme.md")).status, 404);
  assert.equal((await fetch(base + "/login.html")).status, 404);
  assert.match(
    await (await fetch(base + "/config.js")).text(),
    /"app":"store"/,
  );
});

test("store refund authorization is owner-only and verified refund restores stock once", async (t) => {
  const f = await fixture(t),
    a = await f.call("/api/store/checkout", f.checkout()),
    id = a.body.order.id;
  await f.call("/api/store/verify", { orderId: id, token: a.body.token });
  const o = (await f.store.snapshot()).storeOrders[0],
    request = {
      id,
      version: o.version,
      action: "refund",
      reason: "Uncollected equipment",
      restock: true,
    };
  assert.equal(
    (
      await f.call("/api/admin/store/orders/update", request, {
        role: "operator",
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.call("/api/admin/store/orders/update", request, { role: "owner" }))
      .status,
    200,
  );
  let current;
  for (let i = 0; i < 50; i++) {
    current = (await f.store.snapshot()).storeOrders[0];
    if (current.payment.status === "refunded") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(current.payment.status, "refunded");
  assert.equal((await f.store.snapshot()).storeProducts[0].stock, 5);
  assert.equal(
    (
      await f.call(
        "/api/admin/store/orders/update",
        { ...request, version: current.version },
        { role: "owner" },
      )
    ).status,
    409,
  );
});
