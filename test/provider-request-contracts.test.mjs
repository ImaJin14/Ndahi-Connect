import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlutterwavePaymentAdapter, MeSombPaymentAdapter } from "../lib/payments.mjs";
import { ResendEmailAdapter } from "../lib/email.mjs";
import {
  contracts, violations, mesombSignatureMatches, flutterwaveWebhookSignature, mesombWebhookSignature,
} from "./provider-contracts/contracts.mjs";
import { sandboxPlan, redact, runSandboxChecks, MESOMB_TEST_ACK, exerciseFetch, parseSandboxArgs } from "../scripts/exercise-provider-sandboxes.mjs";
import { runContracts } from "../scripts/check-provider-contracts.mjs";

// TEST-003 request/response contracts. Complements test/provider-contracts.test.mjs
// (response handling and sandbox read guards): synthetic provider responses are checked
// against the shared contracts, then replayed through the real adapters (and, for MeSomb,
// the real SDK and its request signing) to pin the exact request each adapter sends,
// the webhook signature schemes, and Resend idempotent retries.

const fixture = (name) => JSON.parse(readFileSync(new URL(`./provider-contracts/fixtures/${name}.json`, import.meta.url), "utf8"));
const flw = fixture("flutterwave"), mesomb = fixture("mesomb"), resend = fixture("resend");
const reply = ({ status = 200, body }) => new Response(body === undefined ? null : JSON.stringify(body),
  { status, headers: { "content-type": "application/json" } });

async function withFetch(handler, fn) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length);
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

const payment = {
  id: "contract-payment-1", amount: 500, currency: "XAF", payerPhone: "670000001", email: "ada@example.test",
  customerName: "Ada Lovelace Byron", network: "mtn", planId: "weekly", clientIp: "203.0.113.7",
};

test("TEST-003 synthetic fixtures satisfy every provider contract they represent", () => {
  const cases = [
    [contracts.flutterwave.charge, ["chargeCallback", "chargeRedirect"].map((k) => flw[k].body)],
    [contracts.flutterwave.verify, ["verifySuccessful", "verifyFailed", "verifyPending"].map((k) => flw[k].body)],
    [contracts.flutterwave.error, [flw.notFound.body, flw.unauthorized.body]],
    [contracts.flutterwave.refund, ["refundCompleted", "refundPendingStringMeta", "refundDisburseFailed"].map((k) => flw[k].body)],
    [contracts.flutterwave.webhook, [flw.webhook.body, flw.webhookV3.body]],
    [contracts.mesomb.status, [mesomb.status.body]],
    [contracts.mesomb.collect, ["collectPending", "collectRedirect", "collectRejected", "refundSuccessful"].map((k) => mesomb[k].body)],
    [contracts.mesomb.transactions, ["checkSuccessful", "checkFailed", "checkMissing", "checkRefund"].map((k) => mesomb[k].body)],
    [contracts.mesomb.error, [mesomb.unauthorized.body]],
    [contracts.mesomb.webhook, [mesomb.webhook.body]],
    [contracts.resend.send, [resend.sent.body]],
    [contracts.resend.error, ["validationError", "unauthorized", "idempotencyConflict"].map((k) => resend[k].body)],
    [contracts.resend.email, [resend.email.body]],
  ];
  for (const [contract, bodies] of cases) {
    for (const body of bodies) assert.deepEqual(violations(contract, body), [], `${contract.operation}: ${JSON.stringify(body).slice(0, 80)}`);
  }
  for (const data of [flw, mesomb, resend]) assert.match(data._provenance, /Not yet a sandbox recording/);
});

test("TEST-003 contracts reject the response changes the adapters cannot absorb", () => {
  const drop = (body, path) => {
    const copy = structuredClone(body), keys = path.split("."), last = keys.pop();
    delete keys.reduce((node, key) => node[key], copy)[last];
    return copy;
  };
  assert.deepEqual(violations(contracts.flutterwave.verify, drop(flw.verifySuccessful.body, "data.tx_ref")), ["data.tx_ref is missing"]);
  assert.deepEqual(violations(contracts.flutterwave.verify, { ...flw.verifySuccessful.body, data: { ...flw.verifySuccessful.body.data, amount: "500" } }),
    ["data.amount is string, expected number"]);
  assert.deepEqual(violations(contracts.flutterwave.charge, drop(drop(flw.chargeCallback.body, "data.id"), "data.flw_ref")),
    ["one of data.id, data.flw_ref is required"]);
  assert.deepEqual(violations(contracts.flutterwave.verify, { ...flw.verifySuccessful.body, status: "error" }),
    ['status is outside expected success']);
  assert.deepEqual(violations(contracts.mesomb.collect, drop(mesomb.collectPending.body, "transaction.pk")), ["transaction.pk is missing"]);
  assert.deepEqual(violations(contracts.mesomb.transactions, { results: [] }), ["response is object, expected array"]);
  assert.deepEqual(violations(contracts.mesomb.transactions, [{ ...mesomb.checkSuccessful.body[0], amount: null }]), ["[0].amount is null, expected number"]);
  assert.deepEqual(violations(contracts.mesomb.webhook, { id: "evt", data: { object: {} } }).length, 1);
  assert.deepEqual(violations(contracts.resend.send, {}), ["id is missing"]);
  assert.deepEqual(violations(contracts.resend.email, { ...resend.email.body, object: "list" }), ['object is outside expected email']);
});

test("TEST-003 Flutterwave charge request and response follow the contract", async () => {
  await withFetch(() => reply(flw.chargeCallback), async (calls) => {
    const adapter = new FlutterwavePaymentAdapter({ apiUrl: "https://api.flutterwave.com/v3", secretKey: "FLWSECK_TEST-contract", secretHash: "hash" });
    const made = await adapter.createPayment(payment);
    assert.deepEqual(made, { providerReference: "4106581", status: "pending", authorizationMode: "callback", checkoutUrl: undefined });
    const [{ url, options }] = calls;
    assert.equal(url, "https://api.flutterwave.com/v3/charges?type=mobile_money_franco");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.authorization, "Bearer FLWSECK_TEST-contract");
    assert.equal(options.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(options.body), {
      amount: 500, currency: "XAF", phone_number: "237670000001", email: "ada@example.test", tx_ref: "contract-payment-1",
      country: "CM", network: "MTN", fullname: "Ada Lovelace Byron", client_ip: "203.0.113.7",
      meta: { paymentId: "contract-payment-1", planId: "weekly" },
    });
  });
  await withFetch(() => reply(flw.chargeRedirect), async (calls) => {
    const adapter = new FlutterwavePaymentAdapter({ secretKey: "FLWSECK_TEST-contract", secretHash: "hash" });
    const made = await adapter.createPayment({ ...payment, id: "contract-payment-2", network: "orange" });
    assert.equal(JSON.parse(calls[0].options.body).network, "ORANGEMONEY");
    assert.equal(made.authorizationMode, "redirect");
    assert.equal(made.checkoutUrl, "https://checkout.flutterwave.com/authorize/contract-2");
  });
  // flw_ref is the only fallback reference when the provider omits the numeric ID.
  const noId = structuredClone(flw.chargeCallback);
  delete noId.body.data.id;
  await withFetch(() => reply(noId), async () => {
    const made = await new FlutterwavePaymentAdapter({ secretKey: "k", secretHash: "h" }).createPayment(payment);
    assert.equal(made.providerReference, "FLW-MOCK-CONTRACT-1");
  });
});

test("TEST-003 Flutterwave verification maps provider statuses and both lookup paths", async () => {
  const adapter = new FlutterwavePaymentAdapter({ secretKey: "FLWSECK_TEST-contract", secretHash: "hash" });
  for (const [key, status] of [["verifySuccessful", "paid"], ["verifyFailed", "failed"], ["verifyPending", "pending"]]) {
    await withFetch(() => reply(flw[key]), async (calls) => {
      const verified = await adapter.verifyPayment({ ...payment, providerReference: "4106581" });
      assert.equal(calls[0].url, "https://api.flutterwave.com/v3/transactions/4106581/verify");
      assert.equal(calls[0].options.headers.authorization, "Bearer FLWSECK_TEST-contract");
      // These four values are what billing compares before it will settle an order.
      assert.deepEqual([verified.status, verified.providerReference, verified.transactionReference, verified.amount, verified.currency],
        [status, "4106581", "contract-payment-1", 500, "XAF"]);
    });
  }
  // A lost create response leaves no numeric ID: verification falls back to the merchant reference.
  await withFetch(() => reply(flw.verifySuccessful), async (calls) => {
    const verified = await adapter.verifyPayment({ ...payment, providerReference: undefined });
    assert.equal(calls[0].url, "https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=contract-payment-1");
    assert.equal(verified.status, "paid");
  });
});

test("TEST-003 Flutterwave rejections raise sanitized errors, including error bodies sent with HTTP 200", async () => {
  const adapter = new FlutterwavePaymentAdapter({ secretKey: "FLWSECK_TEST-never-print", secretHash: "hash" });
  for (const response of [flw.notFound, flw.unauthorized, { status: 200, body: flw.notFound.body }]) {
    await withFetch(() => reply(response), async () => {
      await assert.rejects(adapter.verifyPayment({ ...payment, providerReference: "4106581" }), (error) => {
        assert.match(error.message, new RegExp(`\\(${response.status}\\): ${response.body.message}`));
        assert.doesNotMatch(error.message, /never-print/);
        return true;
      });
    });
  }
  await withFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }), async () => {
    await assert.rejects(adapter.verifyPayment({ ...payment, providerReference: "4106581" }), /\(502\)/);
  });
});

test("TEST-003 Flutterwave refunds read both field spellings and string metadata", async () => {
  const adapter = new FlutterwavePaymentAdapter({ secretKey: "FLWSECK_TEST-contract", secretHash: "hash" });
  const paid = { ...payment, providerReference: "4106581" };
  await withFetch(() => reply(flw.refundCompleted), async (calls) => {
    assert.deepEqual(await adapter.refundPayment(paid), { status: "completed", providerReference: "75923" });
    assert.equal(calls[0].url, "https://api.flutterwave.com/v3/transactions/4106581/refund");
    assert.deepEqual(JSON.parse(calls[0].options.body), { amount: 500, comments: "NDAHI refund contract-payment-1" });
  });
  const refunded = { ...paid, refund: { providerReference: "75923" } };
  await withFetch(() => reply(flw.refundPendingStringMeta), async (calls) => {
    assert.deepEqual(await adapter.verifyRefund(refunded), { status: "pending", providerReference: "75923" });
    assert.equal(calls[0].url, "https://api.flutterwave.com/v3/refunds/75923");
  });
  await withFetch(() => reply(flw.refundDisburseFailed), async () => {
    assert.equal((await adapter.verifyRefund(refunded)).status, "failed");
  });
  await withFetch(() => reply(flw.refundCompleted), async () => {
    await assert.rejects(adapter.verifyRefund({ ...refunded, amount: 400 }), /Refund details mismatch/);
  });
});

test("TEST-003 Flutterwave webhooks: signature scheme and both payload generations", async () => {
  const adapter = new FlutterwavePaymentAdapter({ secretKey: "k", secretHash: "flw-webhook-hash" });
  // Neither documented envelope carries the top-level `id` the adapter reads (the newer
  // format names it webhook_id), so deduplication falls back to the raw-body digest.
  for (const [body, eventId, type] of [[flw.webhook.body, undefined, "charge.completed"], [flw.webhookV3.body, undefined, undefined]]) {
    const raw = JSON.stringify(body);
    assert.deepEqual(await adapter.handleWebhook(raw, flutterwaveWebhookSignature(raw, "flw-webhook-hash")),
      { eventId, type, paymentId: "contract-payment-1", transactionId: 4106581 });
  }
  const raw = JSON.stringify(flw.webhook.body);
  await assert.rejects(adapter.handleWebhook(raw, flutterwaveWebhookSignature(raw, "wrong-hash")), /Invalid webhook signature/);
  await assert.rejects(adapter.handleWebhook(raw.replace("500", "5"), flutterwaveWebhookSignature(raw, "flw-webhook-hash")), /Invalid webhook signature/);
  // v3 documentation's verif-hash scheme sends the plain secret hash. The adapter accepts only
  // the HMAC, so v3-style deliveries are rejected (handoff finding: confirm with a sandbox delivery).
  await assert.rejects(adapter.handleWebhook(raw, "flw-webhook-hash"), /Invalid webhook signature/);
});

const mesombKeys = { applicationKey: "contract-application", accessKey: "contract-access", secretKey: "contract-secret" };
const mesombRoute = (routes) => (url) => {
  const path = new URL(url).pathname;
  const match = Object.entries(routes).find(([suffix]) => path.endsWith(suffix));
  if (!match) throw Error(`Unexpected MeSomb request: ${path}`);
  return reply(match[1]);
};

test("TEST-003 MeSomb collection goes through the real SDK with a signed asynchronous request", async () => {
  await withFetch(mesombRoute({ "/payment/collect/": mesomb.collectPending }), async (calls) => {
    const made = await new MeSombPaymentAdapter(mesombKeys).createPayment(payment);
    assert.deepEqual(made, { providerReference: "9a4b3c2d-0000-4000-8000-00000000c011", status: "pending",
      authorizationMode: "mobile_money_prompt", checkoutUrl: undefined });
    const [{ url, options }] = calls;
    assert.equal(url, "https://mesomb.hachther.com/api/v1.1/payment/collect/");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["X-MeSomb-Application"], "contract-application");
    // The order ID travels as the external transaction ID that later verification looks up.
    assert.equal(options.headers["X-MeSomb-TrxID"], "contract-payment-1");
    assert.equal(options.headers["X-MeSomb-OperationMode"], "asynchronous");
    assert.deepEqual(JSON.parse(options.body), {
      amount: 500, service: "MTN", payer: "670000001", country: "CM", currency: "XAF", amount_currency: "XAF",
      fees: false, conversion: false,
      customer: { email: "ada@example.test", firstName: "Ada", lastName: "Lovelace Byron", country: "CM" },
      reference: "contract-payment-1", description: "NDAHI Connect weekly package",
    });
    assert.equal(mesombSignatureMatches({ method: "POST", url, headers: options.headers, body: options.body, ...mesombKeys }), true);
    assert.equal(mesombSignatureMatches({ method: "POST", url, headers: options.headers, body: options.body, ...mesombKeys, secretKey: "other" }), false);
  });
  await withFetch(mesombRoute({ "/payment/collect/": mesomb.collectRedirect }), async (calls) => {
    const made = await new MeSombPaymentAdapter(mesombKeys).createPayment({ ...payment, network: "orange" });
    assert.equal(JSON.parse(calls[0].options.body).service, "ORANGE");
    assert.equal(made.authorizationMode, "redirect");
    assert.equal(made.checkoutUrl, "https://mesomb.hachther.com/en/payment/confirm/contract-2/");
  });
  await withFetch(mesombRoute({ "/payment/collect/": mesomb.collectRejected }), async () => {
    await assert.rejects(new MeSombPaymentAdapter(mesombKeys).createPayment(payment), /The payer account cannot be debited/);
  });
});

test("TEST-003 MeSomb verification looks up the external reference and reports missing payments distinctly", async () => {
  const adapter = new MeSombPaymentAdapter(mesombKeys);
  for (const [key, status] of [["checkSuccessful", "paid"], ["checkFailed", "failed"]]) {
    await withFetch(mesombRoute({ "/payment/transactions/check/": mesomb[key] }), async (calls) => {
      const verified = await adapter.verifyPayment(payment);
      const url = new URL(calls[0].url);
      assert.equal(calls[0].options.method, "GET");
      assert.deepEqual([url.searchParams.get("ids"), url.searchParams.get("source")], ["contract-payment-1", "EXTERNAL"]);
      assert.equal(mesombSignatureMatches({ method: "GET", url: calls[0].url, headers: calls[0].options.headers, ...mesombKeys }), true);
      assert.deepEqual([verified.status, verified.providerReference, verified.transactionReference, verified.amount, verified.currency],
        [status, "9a4b3c2d-0000-4000-8000-00000000c011", "contract-payment-1", 500, "XAF"]);
    });
  }
  // Reconciliation reports provider_payment_missing only for this code.
  await withFetch(mesombRoute({ "/payment/transactions/check/": mesomb.checkMissing }), async () => {
    await assert.rejects(adapter.verifyPayment(payment), (error) => error.code === "PAYMENT_NOT_FOUND");
  });
  await withFetch(mesombRoute({ "/payment/transactions/check/": mesomb.unauthorized }), async () => {
    await assert.rejects(adapter.verifyPayment(payment), (error) => {
      assert.equal(error.name, "PermissionDeniedError");
      assert.notEqual(error.code, "PAYMENT_NOT_FOUND");
      assert.doesNotMatch(error.message, /contract-secret/);
      return true;
    });
  });
});

test("TEST-003 MeSomb refunds send the provider transaction and verify by MeSomb ID", async () => {
  const adapter = new MeSombPaymentAdapter(mesombKeys);
  const paid = { ...payment, providerReference: "9a4b3c2d-0000-4000-8000-00000000c011" };
  await withFetch(mesombRoute({ "/payment/refund/": mesomb.refundSuccessful }), async (calls) => {
    assert.deepEqual(await adapter.refundPayment(paid), { status: "completed", providerReference: "9a4b3c2d-0000-4000-8000-0000000000f1" });
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      id: "9a4b3c2d-0000-4000-8000-00000000c011", currency: "XAF", conversion: false, amount_currency: "XAF", amount: 500,
    });
  });
  const refunded = { ...paid, refund: { providerReference: "9a4b3c2d-0000-4000-8000-0000000000f1" } };
  await withFetch(mesombRoute({ "/payment/transactions/check/": mesomb.checkRefund }), async (calls) => {
    assert.deepEqual(await adapter.verifyRefund(refunded), { status: "completed", providerReference: "9a4b3c2d-0000-4000-8000-0000000000f1" });
    assert.equal(new URL(calls[0].url).searchParams.get("source"), "MESOMB");
  });
  await withFetch(mesombRoute({ "/payment/transactions/check/": mesomb.checkRefund }), async () => {
    await assert.rejects(adapter.verifyRefund({ ...refunded, amount: 400 }), /Refund details mismatch/);
  });
});

test("TEST-003 MeSomb webhooks: timestamped signature and reference extraction", async () => {
  const adapter = new MeSombPaymentAdapter({ ...mesombKeys, webhookSecret: "mesomb-webhook-secret", client: {} });
  const raw = JSON.stringify(mesomb.webhook.body), now = Date.parse("2026-10-05T08:02:00Z"), t = Math.floor(now / 1000);
  assert.deepEqual(await adapter.handleWebhook(raw, mesombWebhookSignature(raw, "mesomb-webhook-secret", t), now), {
    eventId: "evt-contract-1", type: "transaction.success", paymentId: "contract-payment-1", transactionId: "9a4b3c2d-0000-4000-8000-00000000c011",
  });
  await assert.rejects(adapter.handleWebhook(raw, mesombWebhookSignature(raw, "mesomb-webhook-secret", t - 301), now), /tolerance/);
  await assert.rejects(adapter.handleWebhook(raw, mesombWebhookSignature(raw, "wrong", t), now), /Invalid webhook signature/);
  const legacy = JSON.stringify({ id: "evt-2", type: "payment", transaction: { trxID: "contract-payment-1", pk: "pk-2" } });
  assert.equal((await adapter.handleWebhook(legacy, mesombWebhookSignature(legacy, "mesomb-webhook-secret", t), now)).paymentId, "contract-payment-1");
});

function resendAdapter(responses, apiKey = "re_contract_key") {
  const calls = [];
  const adapter = new ResendEmailAdapter({ apiKey, from: "NDAHI Connect <connect@updates.ndahiconnect.net>",
    portalUrl: "https://portal.ndahiconnect.net", fetcher: async (url, options) => {
      calls.push({ url, options });
      return reply(responses[Math.min(calls.length - 1, responses.length - 1)]);
    } });
  return { adapter, calls };
}

const receipt = { number: "NC-contract-payment-1", paymentId: "contract-payment-1", paidAt: "2026-10-05T08:00:00.000Z",
  provider: "mesomb", network: "mtn", providerReference: "9a4b3c2d", amount: 500, currency: "XAF", customerName: "Ada",
  plan: { id: "weekly", name: "Weekly", quotaGb: 5, durationDays: 7, deviceLimit: 1 }, policyVersion: "2026-09-25" };
const voucherDelivery = { customer: { name: "Ada", email: "ada@example.test" }, payment: { amount: 500, currency: "XAF" },
  plan: { name: "Weekly", quotaGb: 5 }, voucher: { id: "voucher-1", code: "NC-ABCD-2345", deviceLimit: 1, expiresAt: "2026-10-12T08:00:00.000Z" } };

test("TEST-003 Resend: every message kind posts the documented request with a stable idempotency key", async () => {
  const sends = [
    ["voucher-confirmation/voucher-1", (a) => a.sendVoucher(voucherDelivery)],
    ["payment-receipt/contract-payment-1", (a) => a.sendReceipt({ to: "ada@example.test", receipt })],
    ["security-alert/alert-1", (a) => a.sendSecurityAlert({ to: "ada@example.test", alert: { id: "alert-1", subject: "Your PIN was reset", lines: ["Your PIN was reset."] } })],
    [/^pin-reset\/[a-f0-9]{32}$/, (a) => a.sendPinReset({ customer: { name: "Ada", email: "ada@example.test" }, token: "secret-reset-token" })],
  ];
  for (const [key, send] of sends) {
    const { adapter, calls } = resendAdapter([resend.sent]);
    assert.deepEqual(await send(adapter), { messageId: resend.sent.body.id });
    const [{ url, options }] = calls, body = JSON.parse(options.body);
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.authorization, "Bearer re_contract_key");
    assert.equal(options.headers["content-type"], "application/json");
    if (key instanceof RegExp) assert.match(options.headers["idempotency-key"], key);
    else assert.equal(options.headers["idempotency-key"], key);
    assert.equal(body.from, "NDAHI Connect <connect@updates.ndahiconnect.net>");
    assert.deepEqual(body.to, ["ada@example.test"]);
    for (const part of ["subject", "html", "text"]) assert.equal(typeof body[part], "string", part);
    assert.doesNotMatch(options.headers["idempotency-key"], /secret-reset-token/);
  }
  const { adapter, calls } = resendAdapter([resend.sent]);
  await adapter.sendReceipt({ to: "ada@example.test", receipt });
  const [attachment] = JSON.parse(calls[0].options.body).attachments;
  assert.equal(attachment.filename.endsWith(".pdf"), true);
  assert.equal(Buffer.from(attachment.content, "base64").subarray(0, 5).toString(), "%PDF-");
});

test("TEST-003 Resend: retries resend a byte-identical payload under the same key", async () => {
  // Resend rejects a reused idempotency key with a different payload (HTTP 409), so a
  // retry after a lost response must rebuild exactly the same request.
  for (const send of [(a) => a.sendVoucher(voucherDelivery), (a) => a.sendReceipt({ to: "ada@example.test", receipt }),
    (a) => a.sendPinReset({ customer: { name: "Ada", email: "ada@example.test" }, token: "token-1" })]) {
    const { adapter, calls } = resendAdapter([resend.sent]);
    // A retry happens later: move the clock an hour so any time-dependent content shows up.
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-05T08:00:00Z") });
    try {
      await send(adapter);
      mock.timers.tick(3_600_000);
      await send(adapter);
    } finally { mock.timers.reset(); }
    assert.equal(calls[1].options.headers["idempotency-key"], calls[0].options.headers["idempotency-key"]);
    assert.equal(calls[1].options.body, calls[0].options.body);
  }
});

test("TEST-003 Resend: rejected requests surface provider messages without credentials", async () => {
  for (const response of [resend.validationError, resend.unauthorized, resend.idempotencyConflict]) {
    const { adapter } = resendAdapter([response], "re_never_print");
    await assert.rejects(adapter.sendVoucher(voucherDelivery), (error) => {
      assert.match(error.message, new RegExp(response.body.message.replace(/[.*+?^${}()|[\]\\`]/g, "\\$&")));
      assert.doesNotMatch(error.message, /re_never_print/);
      return true;
    });
    await assert.rejects(resendAdapter([response]).adapter.sendReceipt({ to: "ada@example.test", receipt }), /Receipt email delivery failed/);
  }
  const { adapter } = resendAdapter([{ status: 502, body: undefined }]);
  await assert.rejects(adapter.sendVoucher(voucherDelivery), /Email delivery failed/);
});

test("TEST-003 sandbox exercises refuse production credentials, live keys and real recipients", () => {
  const plan = sandboxPlan({
    CONTRACT_FLW_SECRET_KEY: "FLWSECK-live-key", CONTRACT_MESOMB_APPLICATION_KEY: "app-key-1", CONTRACT_MESOMB_ACCESS_KEY: "access-1",
    CONTRACT_MESOMB_SECRET_KEY: "secret-1", CONTRACT_MESOMB_ALLOW_COLLECT: "true", CONTRACT_MESOMB_PAYER: "670000001",
    CONTRACT_RESEND_API_KEY: "re_x", CONTRACT_RESEND_FROM: "NDAHI <connect@example.com>", CONTRACT_RESEND_TO: "ada@example.com",
  });
  assert.match(plan.flutterwave.refuse, /test-mode key/);
  assert.match(plan.mesomb.refuse, new RegExp(MESOMB_TEST_ACK));
  assert.match(plan.resend.refuse, /delivered@resend\.dev/);
  const twins = sandboxPlan({ CONTRACT_FLW_SECRET_KEY: "FLWSECK_TEST-same", FLW_SECRET_KEY: "FLWSECK_TEST-same",
    CONTRACT_MESOMB_APPLICATION_KEY: "a", CONTRACT_MESOMB_ACCESS_KEY: "shared", MESOMB_ACCESS_KEY: "shared", CONTRACT_MESOMB_SECRET_KEY: "c",
    CONTRACT_RESEND_API_KEY: "re_same", EMAIL_API_KEY: "re_same", CONTRACT_RESEND_FROM: "NDAHI <onboarding@resend.dev>" });
  assert.deepEqual(Object.values(twins).map((p) => p.refuse), ["CONTRACT_FLW_SECRET_KEY equals the production FLW_SECRET_KEY",
    "CONTRACT_MESOMB_ACCESS_KEY equals the production MESOMB_ACCESS_KEY", "CONTRACT_RESEND_API_KEY equals the production EMAIL_API_KEY"]);
  const noPayer = sandboxPlan({ CONTRACT_MESOMB_APPLICATION_KEY: "a", CONTRACT_MESOMB_ACCESS_KEY: "b", CONTRACT_MESOMB_SECRET_KEY: "c",
    CONTRACT_MESOMB_ALLOW_COLLECT: "true", CONTRACT_MESOMB_TEST_ACCOUNT_ACK: MESOMB_TEST_ACK });
  assert.match(noPayer.mesomb.refuse, /CONTRACT_MESOMB_PAYER/);
  // Production variable names alone never enable an exercise.
  const unset = sandboxPlan({ FLW_SECRET_KEY: "FLWSECK_TEST-x", MESOMB_APPLICATION_KEY: "a", EMAIL_API_KEY: "re_x" });
  assert.deepEqual(Object.values(unset).map((p) => Boolean(p.skip)), [true, true, true]);
  const safe = sandboxPlan({ CONTRACT_FLW_SECRET_KEY: "FLWSECK_TEST-x", CONTRACT_MESOMB_APPLICATION_KEY: "a", CONTRACT_MESOMB_ACCESS_KEY: "b",
    CONTRACT_MESOMB_SECRET_KEY: "c", CONTRACT_MESOMB_TEST_ACCOUNT_ACK: MESOMB_TEST_ACK,
    CONTRACT_RESEND_API_KEY: "re_x", CONTRACT_RESEND_FROM: "NDAHI <onboarding@resend.dev>",
    CONTRACT_RESEND_TO: "delivered@resend.dev", CONTRACT_FLW_API_URL: "https://attacker.example" }, { allowWrites: true });
  assert.equal(safe.flutterwave.apiUrl, "https://api.flutterwave.com/v3");
  assert.equal(safe.mesomb.collect, null);
  assert.equal(safe.resend.to, "delivered@resend.dev");
  assert.deepEqual(redact({ to: ["ada@example.com"], data: { tx_ref: "p1", customer: { email: "ada@example.com", phone_number: "2376" } }, key: "app" }),
    { to: ["<redacted>"], data: { tx_ref: "<redacted>", customer: { email: "<redacted>", phone_number: "<redacted>" } }, key: "<redacted>" });
});

// Simulated providers that behave like the synthetic fixtures, so the manual runner's
// own logic (checks, contract enforcement, exit status) is covered offline.
function simulatedProviders({ feeInAmount = false } = {}) {
  const charges = new Map(), emails = new Map();
  return async (url, options = {}) => {
    const { hostname, pathname, searchParams } = new URL(url), method = options.method || "GET";
    if (hostname === "api.flutterwave.com") {
      if (!String(options.headers?.authorization).startsWith("Bearer FLWSECK_TEST-")) return reply(flw.unauthorized);
      if (pathname.endsWith("/charges")) {
        const body = JSON.parse(options.body), id = 4106581 + charges.size;
        charges.set(String(id), body);
        return reply({ status: 200, body: { ...flw.chargeCallback.body, data: { ...flw.chargeCallback.body.data, id, tx_ref: body.tx_ref, amount: body.amount } } });
      }
      const byId = pathname.match(/\/transactions\/(\d+)\/verify$/)?.[1];
      const entry = byId ? [byId, charges.get(byId)] : [...charges].find(([, c]) => c.tx_ref === searchParams.get("tx_ref"));
      if (!entry?.[1]) return reply(flw.notFound);
      const [id, charge] = entry;
      return reply({ status: 200, body: { ...flw.verifyPending.body, data: { ...flw.verifyPending.body.data, id: Number(id),
        tx_ref: charge.tx_ref, amount: charge.amount + (feeInAmount ? 25 : 0) } } });
    }
    if (hostname === "mesomb.hachther.com") {
      if (pathname.endsWith("/payment/status/")) return reply(mesomb.status);
      if (pathname.endsWith("/payment/transactions/check/")) return reply(mesomb.checkMissing);
    }
    if (hostname === "api.resend.com") {
      if (!String(options.headers?.authorization).startsWith("Bearer re_sandbox")) return reply(resend.unauthorized);
      if (method === "POST") {
        const key = options.headers["idempotency-key"], seen = emails.get(key);
        if (seen && seen.body !== options.body) return reply(resend.idempotencyConflict);
        if (!seen) emails.set(key, { id: `email-${emails.size + 1}`, body: options.body });
        return reply({ status: 200, body: { id: emails.get(key).id } });
      }
      const id = pathname.split("/").at(-1);
      return reply({ status: 200, body: { ...resend.email.body, id } });
    }
    throw Error(`Unexpected request ${method} ${url}`);
  };
}
const sandboxEnv = { CONTRACT_FLW_SECRET_KEY: "FLWSECK_TEST-contract", CONTRACT_MESOMB_APPLICATION_KEY: "sandbox-application-key",
  CONTRACT_MESOMB_ACCESS_KEY: "sandbox-access-key", CONTRACT_MESOMB_SECRET_KEY: "sandbox-secret-key",
  CONTRACT_MESOMB_TEST_ACCOUNT_ACK: MESOMB_TEST_ACK,
  CONTRACT_RESEND_API_KEY: "re_sandbox_contract", CONTRACT_RESEND_FROM: "NDAHI Connect <onboarding@resend.dev>" };

test("TEST-003 sandbox exercises pass every check against conforming providers", async () => {
  const fake = simulatedProviders();
  const { results, failed } = await runSandboxChecks({ env: sandboxEnv, fetch: fake, allowWrites: true, pause: async () => {} });
  assert.deepEqual(results.filter((r) => r.status !== "pass"), []);
  assert.equal(failed, false);
  assert.deepEqual(results.map((r) => `${r.provider}: ${r.check}`), [
    "flutterwave: create mobile money charge", "flutterwave: verify by transaction ID", "flutterwave: verify by merchant reference",
    "flutterwave: unknown transaction is rejected", "mesomb: signed application status", "mesomb: unknown external reference is missing",
    "resend: send with an idempotency key", "resend: identical retry returns the original message",
    "resend: changed payload under the same key is rejected", "resend: receipt with PDF attachment",
    "resend: retrieve the accepted message", "resend: invalid key is rejected without echoing it",
  ]);
});

test("TEST-003 sandbox exercises fail on a contract break and when required credentials are missing", async () => {
  // A provider that folds fees into `amount` would make every real order fail verification.
  const { results, failed } = await runSandboxChecks({ env: sandboxEnv, fetch: simulatedProviders({ feeInAmount: true }), allowWrites: true, pause: async () => {} });
  assert.equal(failed, true);
  const broken = results.filter((r) => r.status === "fail");
  assert.deepEqual(broken.map((r) => r.check), ["verify by transaction ID", "verify by merchant reference"]);
  assert.match(broken[0].detail, /verify amount mismatch/);
  const missing = await runSandboxChecks({ env: {}, fetch: simulatedProviders(), require: ["resend"], pause: async () => {} });
  assert.deepEqual(missing.results.map((r) => r.status), ["skip", "skip", "fail"]);
  assert.equal(missing.failed, true);
  const secretEcho = await runSandboxChecks({ env: { CONTRACT_RESEND_API_KEY: "re_sandbox_echo", CONTRACT_RESEND_FROM: "NDAHI <onboarding@resend.dev>" },
    fetch: async () => { throw Error("connect failed for re_sandbox_echo"); }, allowWrites: true, pause: async () => {} });
  assert.equal(secretEcho.results.some((r) => r.detail.includes("re_sandbox_echo")), false);
  assert.equal(globalThis.fetch.name, "fetch");
});

test("TEST-003 sandbox writes require explicit opt-in and provider selection", async () => {
  let contacted = 0;
  const result = await runSandboxChecks({ env: sandboxEnv, selectedProviders: ["flutterwave", "resend"],
    fetch: async () => { contacted++; throw Error("must not run"); } });
  assert.equal(result.failed, true);
  assert.equal(contacted, 0);
  assert.deepEqual(result.results.map((r) => r.status), ["fail", "skip", "fail"]);
  assert.match(result.results[0].detail, /--allow-writes/);
  assert.throws(() => parseSandboxArgs([]), /explicit selection/);
  assert.throws(() => parseSandboxArgs(["--provider=other"]), /known providers/);
  assert.throws(() => parseSandboxArgs(["--provider=resend", "--token=private-key"]), /Use --provider/);
  assert.deepEqual(parseSandboxArgs(["--provider=resend", "--allow-writes", "--record=/tmp/contract-recordings"]),
    { allowWrites: true, selectedProviders: ["resend"], require: ["resend"], record: "/tmp/contract-recordings" });
});

test("TEST-003 exercises reject production mode, malformed amounts and injected references", async () => {
  let contacted = 0;
  const result = await runSandboxChecks({ env: { ...sandboxEnv, NODE_ENV: "production" }, allowWrites: true,
    fetch: async () => { contacted++; throw Error("must not run"); } });
  assert.equal(result.failed, true);
  assert.equal(contacted, 0);
  assert.ok(result.results.every((r) => r.status === "fail"));
  for (const bad of ["Infinity", "NaN", "0", "-1", "1.5", "9007199254740992"]) {
    assert.match(sandboxPlan({ ...sandboxEnv, CONTRACT_FLW_AMOUNT: bad }, { allowWrites: true }).flutterwave.refuse, /amounts/);
    assert.match(sandboxPlan({ ...sandboxEnv, CONTRACT_MESOMB_AMOUNT: bad }, { allowWrites: true }).mesomb.refuse, /amounts/);
  }
  for (const id of ["a&source=MESOMB", "a,b", "../other", "a\nheader"]) {
    assert.match(sandboxPlan({ ...sandboxEnv, CONTRACT_MESOMB_TRANSACTION_REF: id, CONTRACT_MESOMB_EXPECTED_AMOUNT: "100" },
      { allowWrites: true }).mesomb.refuse, /single valid reference/);
  }
  assert.match(sandboxPlan({ ...sandboxEnv, CONTRACT_FLW_REFUND_ID: "901" }, { allowWrites: true }).flutterwave.refuse, /refund reads/);
  assert.match(sandboxPlan({ ...sandboxEnv, CONTRACT_FLW_EMAIL: "customer@private.invalid" }, { allowWrites: true }).flutterwave.refuse, /synthetic/);
});

test("TEST-003 request guards block foreign hosts, extra writes and customer recipients", async () => {
  const plan = sandboxPlan(sandboxEnv, { allowWrites: true });
  let reached = 0;
  const transport = async (_url, init) => {
    reached++;
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({});
  };
  const flwFetch = exerciseFetch("flutterwave", plan.flutterwave, transport);
  const mesombFetch = exerciseFetch("mesomb", plan.mesomb, transport);
  const resendFetch = exerciseFetch("resend", plan.resend, transport);
  for (const [fetcher, url, init] of [
    [flwFetch, "https://api.flutterwave.com.attacker.invalid/v3/transactions/901/verify", {}],
    [flwFetch, "http://api.flutterwave.com/v3/transactions/901/verify", {}],
    [flwFetch, "https://user:password@api.flutterwave.com/v3/transactions/901/verify", {}],
    [flwFetch, "https://api.flutterwave.com:8443/v3/transactions/901/verify", {}],
    [flwFetch, "https://api.flutterwave.com/v3/transactions/901/refund", { method: "POST" }],
    [flwFetch, "https://api.flutterwave.com/v3/charges?type=mobile_money_franco", { method: "POST", body: JSON.stringify({ tx_ref: "real-order" }) }],
    [mesombFetch, "https://mesomb.hachther.com/api/v1.1/payment/collect/", { method: "POST", body: "{}" }],
    [mesombFetch, "https://mesomb.hachther.com/api/v1.1/payment/refund/", { method: "POST", body: "{}" }],
    [mesombFetch, "https://mesomb.hachther.com/api/v1.1/payment/transactions/check/?ids=a,b&source=EXTERNAL", {}],
    [mesombFetch, "https://mesomb.hachther.com/api/v1.1/payment/transactions/check/?ids=a&source=MESOMB", {}],
    [resendFetch, "https://api.resend.com/emails", { method: "POST", body: JSON.stringify({ to: ["customer@private.invalid"] }) }],
    [resendFetch, "https://api.resend.com/emails", { method: "POST", body: JSON.stringify({ to: ["delivered@resend.dev"], cc: ["customer@private.invalid"] }) }],
    [resendFetch, "https://api.resend.com/emails", { method: "POST", body: JSON.stringify({ to: ["delivered@resend.dev"], bcc: ["customer@private.invalid"] }) }],
  ]) await assert.rejects(fetcher(url, init), { code: "blocked_by_guard" });
  assert.equal(reached, 0);
  await flwFetch("https://api.flutterwave.com/v3/transactions/901/verify");
  await mesombFetch("https://mesomb.hachther.com/api/v1.1/payment/status/");
  await resendFetch("https://api.resend.com/emails", { method: "POST", body: JSON.stringify({ to: ["delivered@resend.dev"] }) });
  assert.equal(reached, 3);
});

test("TEST-003 MeSomb collection needs both write opt-in and account acknowledgement", async () => {
  const env = { ...sandboxEnv, CONTRACT_MESOMB_ALLOW_COLLECT: "true", CONTRACT_MESOMB_PAYER: "670000001" };
  assert.match(sandboxPlan(env).mesomb.refuse, /--allow-writes/);
  assert.match(sandboxPlan({ ...env, CONTRACT_MESOMB_TEST_ACCOUNT_ACK: "" }, { allowWrites: true }).mesomb.refuse, /confirming test mode/);
  const cfg = sandboxPlan(env, { allowWrites: true }).mesomb;
  let reached = 0;
  const fetcher = exerciseFetch("mesomb", cfg, async () => { reached++; return Response.json({}); });
  const body = { payer: "670000001", amount: 100, currency: "XAF", reference: "contract-00000000-0000-4000-8000-000000000001" };
  await fetcher("https://mesomb.hachther.com/api/v1.1/payment/collect/", { method: "POST", body: JSON.stringify(body) });
  for (const changes of [{ payer: "670000002" }, { amount: 500 }, { currency: "EUR" }, { reference: "existing-order" }]) {
    await assert.rejects(fetcher("https://mesomb.hachther.com/api/v1.1/payment/collect/", { method: "POST", body: JSON.stringify({ ...body, ...changes }) }), { code: "blocked_by_guard" });
  }
  assert.equal(reached, 1);
});

test("TEST-003 stalled transports and response bodies are bounded and restore fetch", async () => {
  const original = globalThis.fetch;
  for (const transport of [() => new Promise(() => {}), () => new Response(new ReadableStream({ start() {} }))]) {
    const result = await runSandboxChecks({ env: sandboxEnv, selectedProviders: ["resend"], allowWrites: true,
      fetch: transport, timeoutMs: 10, pause: async () => {} });
    assert.equal(result.failed, true);
    assert.ok(result.results.some((r) => /timeout|timed out/.test(r.detail)));
    assert.equal(globalThis.fetch, original);
  }
});

test("TEST-003 recordings hide free text, unknown fields and numeric personal data", () => {
  const sensitive = { message: "Alice customer@private.invalid re_contract_sensitive", detail: "670000001",
    nested: { unexpected: "private-address", number: 670000001 },
    customer: { id: 99, email: "customer@private.invalid", phone: 670000001 },
    status: "SUCCESS", currency: "XAF", amount: 500, data: { id: 4106581, pk: "private-provider-reference" } };
  const clean = redact(sensitive), serialized = JSON.stringify(clean);
  for (const value of ["Alice", "customer@private.invalid", "re_contract_sensitive", "670000001", "private-address", "private-provider-reference", "4106581"]) {
    assert.equal(serialized.includes(value), false, value);
  }
  assert.deepEqual([clean.status, clean.currency, clean.amount], ["SUCCESS", "XAF", 500]);
  assert.deepEqual(violations(contracts.flutterwave.verify, { ...flw.verifySuccessful.body, status: "customer@private.invalid" }),
    ["status is outside expected success"]);
});

test("TEST-003 recording files are private and never overwrite existing evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ndahi-contract-recordings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { env: sandboxEnv, selectedProviders: ["mesomb"], fetch: simulatedProviders(), record: directory };
  const original = globalThis.fetch;
  assert.equal((await runSandboxChecks(options)).failed, false);
  const path = join(directory, "mesomb.json"), content = await readFile(path, "utf8");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(content.includes("NDAHI Connect"), false);
  assert.equal(content.includes("contract-application-key"), false);
  await assert.rejects(runSandboxChecks(options), { code: "EEXIST" });
  assert.equal(await readFile(path, "utf8"), content);
  assert.equal(globalThis.fetch, original);
});

test("TEST-003 sandbox exercises share fetch serialization with read-only contracts", async () => {
  const original = globalThis.fetch;
  const results = await Promise.all([
    runSandboxChecks({ env: sandboxEnv, selectedProviders: ["mesomb"], fetch: simulatedProviders() }),
    runContracts({ providers: ["flutterwave", "mesomb", "resend"] }),
    runSandboxChecks({ env: sandboxEnv, selectedProviders: ["resend"], allowWrites: true, fetch: simulatedProviders(), pause: async () => {} }),
  ]);
  assert.equal(results[0].failed, false);
  assert.equal(results[1].ok, true);
  assert.equal(results[2].failed, false);
  assert.equal(globalThis.fetch, original);
});
