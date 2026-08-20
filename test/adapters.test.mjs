import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { FlutterwavePaymentAdapter } from "../lib/payments.mjs";
import { RouterOSAdapter, routerVoucherPayload } from "../lib/routeros.mjs";
import { OmadaAdapter } from "../lib/omada.mjs";

const response = (data = {}, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("Flutterwave creates a Cameroon francophone mobile money charge", async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    calls.push({ url, options });
    return response({ status: "success", data: { id: 12345, status: "pending" } });
  }, async () => {
    const adapter = new FlutterwavePaymentAdapter({
      apiUrl: "https://flutterwave.test/v3",
      secretKey: "secret",
      secretHash: "webhook-secret",
    });
    const result = await adapter.createPayment({
      id: "p1",
      amount: 500,
      currency: "XAF",
      payerPhone: "670000001",
      email: "student@example.test",
      customerName: "Student Name",
      network: "mtn",
      planId: "weekly",
    });
    assert.equal(result.providerReference, "12345");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /charges\?type=mobile_money_franco$/);
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.phone_number, "237670000001");
    assert.equal(body.network, "MTN");
    assert.equal(body.tx_ref, "p1");
  });
});

test("Flutterwave verifies transactions and authenticates signed webhooks", async () => {
  await withFetch(async () => response({
    status: "success",
    data: { id: 12345, tx_ref: "p1", amount: 500, currency: "XAF", status: "successful" },
  }), async () => {
    const adapter = new FlutterwavePaymentAdapter({
      apiUrl: "https://flutterwave.test/v3",
      secretKey: "secret",
      secretHash: "webhook-secret",
    });
    const verified = await adapter.verifyPayment({ providerReference: "12345" });
    assert.equal(verified.status, "paid");
    assert.equal(verified.transactionReference, "p1");
    const raw = JSON.stringify({ id: "event-1", type: "charge.completed", data: { id: 12345, tx_ref: "p1" } });
    const signature = createHmac("sha256", "webhook-secret").update(raw).digest("base64");
    const event = await adapter.handleWebhook(raw, signature);
    assert.equal(event.paymentId, "p1");
    assert.equal(event.transactionId, 12345);
  });
});

test("MikroTik and Omada adapters keep credentials server-side", async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    calls.push({ url, options });
    return response(url.includes("/aps") ? { data: [{ name: "AP-1" }] } : []);
  }, async () => {
    await new RouterOSAdapter({
      url: "https://router.test",
      username: "api",
      password: "secret",
    }).readUsage();
    const status = await new OmadaAdapter({
      url: "https://omada.test",
      token: "secret",
      siteId: "campus",
    }).status();
    assert.equal(status.accessPoints.length, 1);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => !call.url.includes("secret")));
  });
});

test("router voucher payload contains only enforceable subscription data", () => {
  const payload = routerVoucherPayload({
    id: "voucher-1",
    code: "NC-ABCD-5678",
    customerId: "private-customer-id",
    paymentId: "private-payment-id",
    planId: "weekly",
    status: "active",
    expiresAt: "2026-08-26T12:00:00.000Z",
    quotaBytes: 5_000_000_000,
    deviceLimit: 2,
  });
  assert.deepEqual(payload, {
    schemaVersion: 1,
    voucherId: "voucher-1",
    username: "NC-ABCD-5678",
    password: "NC-ABCD-5678",
    profileId: "weekly",
    expiresAt: "2026-08-26T12:00:00.000Z",
    limitBytesTotal: 5_000_000_000,
    simultaneousUsers: 2,
    enabled: true,
  });
  assert.equal("customerId" in payload, false);
  assert.equal("paymentId" in payload, false);
});
