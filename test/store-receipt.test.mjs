import test from "node:test";
import assert from "node:assert/strict";
import {
  storeReceipt,
  storeReceiptPdf,
  storeOrderEmail,
} from "../lib/store-receipt.mjs";
const order = () => ({
  id: "id-123",
  reference: "NS-123",
  seller: { name: "NDAHI Store", contact: "Store desk" },
  product: {
    name: { en: "Travel router", fr: "Routeur de voyage" },
    sku: "TR-1",
    price: 10000,
    warranty: { en: "Warranty", fr: "Garantie" },
  },
  quantity: 2,
  contact: { name: "Buyer" },
  pickup: "Office",
  hours: "09–17",
  returns: { en: "Returns", fr: "Retours" },
  status: "preparing",
  payment: {
    customerName: "Original buyer",
    amount: 20000,
    provider: "mesomb",
    providerReference: "provider-123",
    confirmedAt: "2030-01-01T00:00:00Z",
    payerPhone: "670000001",
    status: "paid",
  },
});
test("receipts require confirmed payment and retain the original purchase snapshot", async () => {
  const o = order();
  delete o.payment.confirmedAt;
  assert.throws(() => storeReceipt(o), /verified payment/);
  o.payment.confirmedAt = "2030-01-01T00:00:00Z";
  o.receipt = storeReceipt(o);
  o.contact.name = "Corrected contact";
  o.product.price = 2;
  o.product.name.en = "Edited name";
  assert.equal(storeReceipt(o).buyerName, "Original buyer");
  assert.equal(storeReceipt(o).item.name.en, "Travel router");
  assert.equal(storeReceipt(o).amount, 20000);
  const pdf = await storeReceiptPdf(o);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 5000);
});
test("email updates distinguish unpaid, review, pickup, pending refunds and completed refunds", () => {
  const o = order();
  o.status = "awaiting_payment";
  delete o.payment.confirmedAt;
  o.payment.status = "pending";
  assert.match(storeOrderEmail(o).text, /not a payment receipt/);
  assert.doesNotMatch(storeOrderEmail(o).text, /is attached/);
  o.payment.confirmedAt = "2030-01-01T00:00:00Z";
  o.payment.status = "paid";
  o.status = "ready";
  o.collectionCode = "PRIVATE-CODE";
  assert.match(storeOrderEmail(o).text, /PRIVATE-CODE/);
  assert.match(storeOrderEmail(o).text, /receipt.*attached/);
  o.status = "review";
  assert.doesNotMatch(storeOrderEmail(o).text, /PRIVATE-CODE/);
  assert.match(storeOrderEmail(o).text, /Do not pay again/);
  o.payment.refund = { status: "pending" };
  assert.match(storeOrderEmail(o).subject, /being processed/);
  o.payment.status = "refunded";
  o.payment.refund.status = "completed";
  o.status = "cancelled";
  assert.match(storeOrderEmail(o).subject, /refund is confirmed/);
});

test("private receipt endpoint refuses an absent/wrong tracking token and never issues an unpaid receipt", async (t) => {
  const { createServer, createStore } = await import("../server.mjs");
  const { storeState } = await import("../lib/device-store.mjs");
  const { hashSecret } = await import("../lib/security.mjs");
  const store = createStore({ persistent: false }),
    secret = "receipt-fixture-secret",
    token = "private-fixture-token-with-at-least-forty-characters";
  await store.transaction((s) => {
    storeState(s);
    const o = order();
    o.trackingHash = hashSecret(token, secret);
    s.storeOrders.push(o);
  });
  const server = createServer({
    store,
    validateConfig: false,
    env: {
      NODE_ENV: "test",
      SECRET_PEPPER: secret,
      PAYMENT_MODE: "mock",
      BILLING_WORKER_ENABLED: "false",
      SECURITY_ALERTS_ENABLED: "false",
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const get = (input) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/store/receipt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: "id-123", ...input }),
    });
  assert.equal((await get({})).status, 404);
  assert.equal((await get({ token: "wrong" })).status, 404);
  const paid = await get({ token });
  assert.equal(paid.status, 200);
  assert.equal(paid.headers.get("cache-control"), "no-store");
  assert.match(paid.headers.get("content-type"), /application\/pdf/);
  assert.equal(
    Buffer.from(await paid.arrayBuffer())
      .subarray(0, 5)
      .toString(),
    "%PDF-",
  );
  await store.transaction((s) => {
    delete s.storeOrders[0].payment.confirmedAt;
  });
  assert.equal((await get({ token })).status, 409);
});

test("store emails use NS branding and attach a PDF only for verified payments", async () => {
  const { ResendEmailAdapter } = await import("../lib/email.mjs");
  const bodies = [];
  const adapter = new ResendEmailAdapter({
    apiKey: "fixture-key",
    from: "store@example.test",
    fetcher: async (_, input) => {
      bodies.push(JSON.parse(input.body));
      return new Response(JSON.stringify({ id: "fixture-mail" }), {
        status: 200,
      });
    },
  });
  const o = order();
  await adapter.sendStoreOrder({
    to: "buyer@example.test",
    order: o,
    deliveryKey: "fixture-paid",
  });
  assert.match(bodies[0].html, /NS · NDAHI STORE/);
  assert.equal(bodies[0].attachments.length, 1);
  assert.equal(
    Buffer.from(bodies[0].attachments[0].content, "base64")
      .subarray(0, 5)
      .toString(),
    "%PDF-",
  );
  delete o.payment.confirmedAt;
  o.payment.status = "pending";
  o.status = "awaiting_payment";
  await adapter.sendStoreOrder({
    to: "buyer@example.test",
    order: o,
    deliveryKey: "fixture-pending",
  });
  assert.equal(bodies[1].attachments, undefined);
  assert.match(bodies[1].text, /not a payment receipt/);
});

test("older customer order updates are not starved behind already-notified newer orders", async () => {
  const { createStore } = await import("../server.mjs");
  const { storeState } = await import("../lib/device-store.mjs");
  const { createStoreCommerce } = await import("../lib/store-commerce.mjs");
  const store = createStore({ persistent: false }),
    sent = [];
  await store.transaction((s) => {
    storeState(s);
    for (let n = 0; n < 105; n++) {
      const o = order();
      o.id = `order-${n}`;
      o.contact.email = "buyer@example.test";
      o.payment.creationState = "created";
      if (n < 104)
        o.emailDelivery = {
          completedKey: `preparing:paid:none:${o.contact.email}`,
        };
      s.storeOrders.push(o);
    }
  });
  const commerce = createStoreCommerce({
    store,
    pays: {},
    clock: () => new Date("2030-01-01T01:00:00Z"),
    email: {
      configured: () => true,
      sendStoreOrder: async (input) => sent.push(input),
    },
  });
  await commerce.run();
  await commerce.run();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].order.id, "order-104");
  await store.transaction((s) => {
    s.storeOrders[104].status = "ready";
  });
  await commerce.run();
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].deliveryKey, sent[1].deliveryKey);
});
