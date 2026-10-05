#!/usr/bin/env node
// Provider sandbox write exercises (TEST-003). Complements the read-only
// `npm run check:providers -- --sandbox` checks: this script creates fresh
// Flutterwave test-mode charges and sends Resend test-inbox emails through the
// production adapters, then checks every response against the contracts in
// test/provider-contracts/contracts.mjs.
//
// Safety: it reads the dedicated CONTRACT_* variables only, refuses any value
// equal to a production credential, requires a Flutterwave test-mode key, sends
// email only to @resend.dev test inboxes, and runs MeSomb read-only unless a
// collection is explicitly allowed for an acknowledged test-mode account.
// Run instructions: docs/operations/provider-contract-verification.md.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FlutterwavePaymentAdapter, MeSombPaymentAdapter } from "../lib/payments.mjs";
import { ResendEmailAdapter } from "../lib/email.mjs";
import { contracts, violations } from "../test/provider-contracts/contracts.mjs";
import { guardedFetch, serializeProviderChecks, errorCategory } from "./check-provider-contracts.mjs";

export const providers = ["flutterwave", "mesomb", "resend"];
// Same acknowledgement as scripts/check-provider-contracts.mjs: MeSomb test mode
// ends when the account is verified, so a person must confirm it before collections.
export const MESOMB_TEST_ACK = "I_CONFIRM_MESOMB_TEST_MODE_ACCOUNT";
const localPhone = /^6\d{8}$/;
const resendTestInbox = "delivered@resend.dev";
const productionTwins = { flutterwave: [["CONTRACT_FLW_SECRET_KEY", "FLW_SECRET_KEY"]],
  mesomb: [["CONTRACT_MESOMB_APPLICATION_KEY", "MESOMB_APPLICATION_KEY"], ["CONTRACT_MESOMB_ACCESS_KEY", "MESOMB_ACCESS_KEY"],
    ["CONTRACT_MESOMB_SECRET_KEY", "MESOMB_SECRET_KEY"]],
  resend: [["CONTRACT_RESEND_API_KEY", "EMAIL_API_KEY"]] };
const amount = (value) => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null);
const reference = /^[A-Za-z0-9._:-]{1,100}$/;
const syntheticReference = /^contract-(?:missing-)?[a-f0-9-]{36}$/;
const invalidAmount = (env, names) => names.find((name) => env[name] !== undefined && !amount(env[name]));
const incomplete = (env, names) => names.some((name) => env[name]) && !names.every((name) => env[name]);

// Decides what each provider may run with the given environment. A provider is either
// skipped (not configured), refused (unsafe configuration) or given its settings.
export function sandboxPlan(env = {}, { allowWrites = false, selectedProviders = providers } = {}) {
  const plan = {};
  const reused = (provider) => productionTwins[provider].find(([contract, production]) => env[contract] && env[contract] === env[production]);
  const flw = env.CONTRACT_FLW_SECRET_KEY;
  if (!flw) plan.flutterwave = { skip: "CONTRACT_FLW_SECRET_KEY is not set" };
  else if (reused("flutterwave")) plan.flutterwave = { refuse: "CONTRACT_FLW_SECRET_KEY equals the production FLW_SECRET_KEY" };
  else if (!/^FLWSECK_TEST-/.test(flw)) plan.flutterwave = { refuse: "CONTRACT_FLW_SECRET_KEY is not a Flutterwave test-mode key (FLWSECK_TEST-...)" };
  else if (!localPhone.test(env.CONTRACT_FLW_PHONE || "670000000")) plan.flutterwave = { refuse: "CONTRACT_FLW_PHONE must be a nine-digit Cameroon number" };
  else if (!/^[^@\s]+@example\.(?:com|test)$/.test(env.CONTRACT_FLW_EMAIL || "sandbox-contracts@example.com")) plan.flutterwave = { refuse: "CONTRACT_FLW_EMAIL must use a synthetic example.com or example.test address" };
  else if (invalidAmount(env, ["CONTRACT_FLW_AMOUNT", "CONTRACT_FLW_REFUND_AMOUNT"])) plan.flutterwave = { refuse: "Flutterwave exercise amounts must be positive safe integers" };
  else if (incomplete(env, ["CONTRACT_FLW_REFUND_ID", "CONTRACT_FLW_REFUND_TRANSACTION_ID", "CONTRACT_FLW_REFUND_AMOUNT"]) ||
    (env.CONTRACT_FLW_REFUND_ID && (!/^\d+$/.test(env.CONTRACT_FLW_REFUND_ID) || !/^\d+$/.test(env.CONTRACT_FLW_REFUND_TRANSACTION_ID || "")))) plan.flutterwave = { refuse: "Flutterwave refund reads require numeric refund/transaction IDs and an amount" };
  else if (!allowWrites) plan.flutterwave = { refuse: "Charge exercises require explicit --allow-writes" };
  else {
    plan.flutterwave = {
      secretKey: flw,
      apiUrl: "https://api.flutterwave.com/v3",
      phone: env.CONTRACT_FLW_PHONE || "670000000",
      network: env.CONTRACT_FLW_NETWORK === "orange" ? "orange" : "mtn",
      email: env.CONTRACT_FLW_EMAIL || "sandbox-contracts@example.com",
      amount: amount(env.CONTRACT_FLW_AMOUNT) || 100,
      refund: env.CONTRACT_FLW_REFUND_ID && env.CONTRACT_FLW_REFUND_TRANSACTION_ID && amount(env.CONTRACT_FLW_REFUND_AMOUNT)
        ? { id: env.CONTRACT_FLW_REFUND_ID, transactionId: env.CONTRACT_FLW_REFUND_TRANSACTION_ID, amount: amount(env.CONTRACT_FLW_REFUND_AMOUNT) } : null,
    };
  }
  const mesomb = [env.CONTRACT_MESOMB_APPLICATION_KEY, env.CONTRACT_MESOMB_ACCESS_KEY, env.CONTRACT_MESOMB_SECRET_KEY];
  const collect = env.CONTRACT_MESOMB_ALLOW_COLLECT === "true";
  if (!mesomb.every(Boolean)) plan.mesomb = { skip: "CONTRACT_MESOMB_APPLICATION_KEY, _ACCESS_KEY and _SECRET_KEY are not all set" };
  else if (reused("mesomb")) plan.mesomb = { refuse: `${reused("mesomb")[0]} equals the production ${reused("mesomb")[1]}` };
  else if (env.CONTRACT_MESOMB_TEST_ACCOUNT_ACK !== MESOMB_TEST_ACK) {
    plan.mesomb = { refuse: `MeSomb exercises need CONTRACT_MESOMB_TEST_ACCOUNT_ACK=${MESOMB_TEST_ACK} after confirming test mode` };
  } else if (collect && !localPhone.test(env.CONTRACT_MESOMB_PAYER || "")) {
    plan.mesomb = { refuse: "CONTRACT_MESOMB_ALLOW_COLLECT needs CONTRACT_MESOMB_PAYER set to a nine-digit test number" };
  } else if (invalidAmount(env, ["CONTRACT_MESOMB_AMOUNT", "CONTRACT_MESOMB_EXPECTED_AMOUNT", "CONTRACT_MESOMB_REFUND_AMOUNT"])) {
    plan.mesomb = { refuse: "MeSomb exercise amounts must be positive safe integers" };
  } else if (incomplete(env, ["CONTRACT_MESOMB_TRANSACTION_REF", "CONTRACT_MESOMB_EXPECTED_AMOUNT"]) ||
    incomplete(env, ["CONTRACT_MESOMB_REFUND_ID", "CONTRACT_MESOMB_REFUND_AMOUNT"]) ||
    [env.CONTRACT_MESOMB_TRANSACTION_REF, env.CONTRACT_MESOMB_REFUND_ID].some((id) => id && !reference.test(id))) {
    plan.mesomb = { refuse: "MeSomb reads require a single valid reference and its expected amount" };
  } else if (collect && !allowWrites) {
    plan.mesomb = { refuse: "Collection exercises require explicit --allow-writes" };
  } else {
    const [applicationKey, accessKey, secretKey] = mesomb;
    plan.mesomb = {
      applicationKey, accessKey, secretKey,
      collect: collect ? { payer: env.CONTRACT_MESOMB_PAYER, network: env.CONTRACT_MESOMB_NETWORK === "orange" ? "orange" : "mtn",
        amount: amount(env.CONTRACT_MESOMB_AMOUNT) || 100 } : null,
      payment: env.CONTRACT_MESOMB_TRANSACTION_REF && amount(env.CONTRACT_MESOMB_EXPECTED_AMOUNT)
        ? { id: env.CONTRACT_MESOMB_TRANSACTION_REF, amount: amount(env.CONTRACT_MESOMB_EXPECTED_AMOUNT) } : null,
      refund: env.CONTRACT_MESOMB_REFUND_ID && amount(env.CONTRACT_MESOMB_REFUND_AMOUNT)
        ? { id: env.CONTRACT_MESOMB_REFUND_ID, amount: amount(env.CONTRACT_MESOMB_REFUND_AMOUNT) } : null,
    };
  }
  const to = env.CONTRACT_RESEND_TO || "delivered@resend.dev";
  if (!env.CONTRACT_RESEND_API_KEY) plan.resend = { skip: "CONTRACT_RESEND_API_KEY is not set" };
  else if (reused("resend")) plan.resend = { refuse: "CONTRACT_RESEND_API_KEY equals the production EMAIL_API_KEY" };
  else if (!env.CONTRACT_RESEND_FROM) plan.resend = { refuse: "CONTRACT_RESEND_FROM is required for send exercises" };
  else if (to !== resendTestInbox) plan.resend = { refuse: "CONTRACT_RESEND_TO must be delivered@resend.dev" };
  else if (!allowWrites) plan.resend = { refuse: "Email send exercises require explicit --allow-writes" };
  else plan.resend = { apiKey: env.CONTRACT_RESEND_API_KEY, apiUrl: "https://api.resend.com", from: env.CONTRACT_RESEND_FROM, to };
  for (const provider of providers) {
    if (!selectedProviders.includes(provider)) plan[provider] = { skip: "provider not selected" };
    else if (env.NODE_ENV === "production") plan[provider] = { refuse: "Sandbox exercises cannot run with NODE_ENV=production" };
  }
  return plan;
}

const piiKey = /(email|phone|payer|b_party|party|name|customer|ip|^to$|^from$|account|key|token|secret|authorization|logo|url|address|message|detail|description|narration|html|text|meta)/i;
const enumKeys = new Set(["status", "currency", "country", "service", "type", "object", "mode", "event", "event_type", "last_event"]);
const enumValues = new Set(["success", "error", "successful", "pending", "failed", "PENDING", "SUCCESS", "FAILED", "processing", "completed", "cancelled", "paid", "XAF", "CM", "MTN", "ORANGE", "COLLECT", "REFUND", "email", "callback", "redirect", "sent", "delivered", "bounced", "complained", "delivery_delayed", "charge.completed", "transaction.success"]);
const numericKeys = new Set(["amount", "charged_amount", "app_fee", "merchant_fee", "fees", "amount_refunded", "AmountRefunded", "statusCode", "value"]);
// Record only known contract enums and numeric amounts. Free text, identifiers and
// unknown fields may contain personal data even when their key looks harmless.
export function redact(value, key = "", sensitive = false) {
  const hidden = sensitive || piiKey.test(key);
  if (Array.isArray(value)) return value.map((item) => redact(item, key, hidden));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k, hidden)]));
  if (value === null || value === undefined) return value;
  if (hidden) return "<redacted>";
  if (typeof value === "string") return enumKeys.has(key) && enumValues.has(value) ? value : "<redacted>";
  if (typeof value === "number") return numericKeys.has(key) ? value : 0;
  return typeof value === "boolean" ? value : "<redacted>";
}

class SandboxCheckError extends Error {}

function requestBody(init, predicate) {
  try { return predicate(JSON.parse(init.body)); } catch { return false; }
}

export function exerciseFetch(provider, cfg, baseFetch, timeoutMs = 10000) {
  const rule = (method, host, path, allow) => ({ method, host, path, allow });
  const noQuery = ({ url }) => !url.search;
  const rules = provider === "flutterwave" ? [
    rule("POST", "api.flutterwave.com", /^\/v3\/charges$/, ({ url, init }) =>
      url.searchParams.size === 1 && url.searchParams.get("type") === "mobile_money_franco" &&
      requestBody(init, (body) => syntheticReference.test(body.tx_ref) && body.amount === cfg.amount && body.currency === "XAF" && body.email === cfg.email)),
    rule("GET", "api.flutterwave.com", /^\/v3\/transactions\/\d+\/verify$/, noQuery),
    rule("GET", "api.flutterwave.com", /^\/v3\/transactions\/verify_by_reference$/, ({ url }) =>
      url.searchParams.size === 1 && syntheticReference.test(url.searchParams.get("tx_ref") || "")),
    ...(cfg.refund ? [rule("GET", "api.flutterwave.com", /^\/v3\/refunds\/\d+$/, ({ url }) => !url.search && url.pathname === `/v3/refunds/${cfg.refund.id}`)] : []),
  ] : provider === "mesomb" ? [
    rule("GET", "mesomb.hachther.com", /^\/api\/v1\.1\/payment\/status\/$/, noQuery),
    rule("GET", "mesomb.hachther.com", /^\/api\/v1\.1\/payment\/transactions\/check\/$/, ({ url }) => {
      if (url.searchParams.size !== 2 || url.searchParams.getAll("ids").length !== 1) return false;
      const id = url.searchParams.get("ids"), source = url.searchParams.get("source");
      return source === "EXTERNAL" && (syntheticReference.test(id || "") || Boolean(cfg.payment && id === cfg.payment.id)) ||
        source === "MESOMB" && Boolean(cfg.refund && id === cfg.refund.id);
    }),
    ...(cfg.collect ? [rule("POST", "mesomb.hachther.com", /^\/api\/v1\.1\/payment\/collect\/$/, ({ url, init }) => !url.search &&
      requestBody(init, (body) => body.payer === cfg.collect.payer && body.amount === cfg.collect.amount && body.currency === "XAF" && syntheticReference.test(body.reference)))] : []),
  ] : provider === "resend" ? [
    rule("POST", "api.resend.com", /^\/emails$/, ({ url, init }) => !url.search && requestBody(init, (body) =>
      Array.isArray(body.to) && body.to.length === 1 && body.to[0] === resendTestInbox && body.cc === undefined && body.bcc === undefined && body.reply_to === undefined)),
    rule("GET", "api.resend.com", /^\/emails\/[A-Za-z0-9-]+$/, noQuery),
  ] : [];
  return guardedFetch({ fetchImpl: baseFetch, rules, timeoutMs });
}

async function readResponse(response, timeoutMs) {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0, timer;
  const read = async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks).toString("utf8");
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new SandboxCheckError("Provider response exceeds the recording size limit");
      chunks.push(Buffer.from(value));
    }
  };
  try {
    return await Promise.race([read(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SandboxCheckError("Provider response body timed out")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

function recorder(baseFetch, timeoutMs) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const response = await baseFetch(url, options);
    let text;
    try { text = await readResponse(response.clone(), timeoutMs); }
    catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
    let body;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
    calls.push({ url: String(url), method: options.method || "GET", status: response.status, body });
    return response;
  };
  return { fetcher, calls, last: () => calls.at(-1) };
}

function expectContract(contract, response, label) {
  if (!response) throw new SandboxCheckError(`${label}: no provider response was captured`);
  const problems = violations(contract, response.body);
  if (problems.length) throw new SandboxCheckError(`${label} (HTTP ${response.status}) broke the contract: ${problems.join("; ")}`);
}

async function expectRejection(task, label) {
  try { await task(); } catch (error) { return error; }
  throw new SandboxCheckError(`${label} was accepted, but the adapter expects a rejection`);
}

const expectEqual = (actual, expected, label) => {
  if (actual !== expected) throw new SandboxCheckError(`${label} mismatch`);
};

function flutterwaveChecks(cfg, rec) {
  const adapter = new FlutterwavePaymentAdapter({ apiUrl: cfg.apiUrl, secretKey: cfg.secretKey, secretHash: "unused-for-outbound-checks" });
  const payment = { id: `contract-${randomUUID()}`, amount: cfg.amount, currency: "XAF", payerPhone: cfg.phone, email: cfg.email,
    customerName: "Contract Check", network: cfg.network, clientIp: "127.0.0.1", planId: "contract-check" };
  // The billing guard settles only when tx_ref, amount and currency match the order exactly.
  const matchesOrder = (verified, label) => {
    expectEqual(verified.transactionReference, payment.id, `${label} tx_ref`);
    expectEqual(verified.amount, payment.amount, `${label} amount`);
    expectEqual(verified.currency, payment.currency, `${label} currency`);
  };
  const checks = [
    ["create mobile money charge", async () => {
      const made = await adapter.createPayment(payment);
      expectContract(contracts.flutterwave.charge, rec.last(), "charge");
      if (!made.providerReference) throw Error("charge returned no transaction reference");
      payment.providerReference = made.providerReference;
      return `reference received, provider status ${rec.last().body.data.status}, authorization ${made.authorizationMode}`;
    }],
    ["verify by transaction ID", async () => {
      if (!/^\d+$/.test(String(payment.providerReference || ""))) throw Error("the charge reference is not a numeric transaction ID");
      const verified = await adapter.verifyPayment(payment);
      expectContract(contracts.flutterwave.verify, rec.last(), "verify");
      matchesOrder(verified, "verify");
      return `status ${verified.status}; tx_ref, amount and currency match the order`;
    }],
    ["verify by merchant reference", async () => {
      const verified = await adapter.verifyPayment({ ...payment, providerReference: undefined });
      expectEqual(new URL(rec.last().url).pathname.endsWith("/transactions/verify_by_reference"), true, "fallback endpoint");
      expectContract(contracts.flutterwave.verify, rec.last(), "verify_by_reference");
      matchesOrder(verified, "verify_by_reference");
      return `status ${verified.status}; lost create responses can be recovered by reference`;
    }],
    ["unknown transaction is rejected", async () => {
      const error = await expectRejection(() => adapter.verifyPayment({ id: `contract-missing-${randomUUID()}` }), "an unknown reference");
      expectContract(contracts.flutterwave.error, rec.last(), "unknown transaction");
      if (error.message.includes(cfg.secretKey)) throw Error("the adapter error exposes the secret key");
      return `HTTP ${rec.last().status} with a sanitized adapter error`;
    }],
  ];
  if (cfg.refund) {
    checks.push(["read refund status", async () => {
      const result = await adapter.verifyRefund({ providerReference: cfg.refund.transactionId, amount: cfg.refund.amount, refund: { providerReference: cfg.refund.id } });
      expectContract(contracts.flutterwave.refund, rec.last(), "refund status");
      return `refund ${result.status}; transaction and amount match`;
    }]);
  }
  return checks;
}

function mesombChecks(cfg, rec) {
  const adapter = new MeSombPaymentAdapter({ applicationKey: cfg.applicationKey, accessKey: cfg.accessKey, secretKey: cfg.secretKey });
  const checks = [
    ["signed application status", async () => {
      await adapter.operation().getStatus();
      expectContract(contracts.mesomb.status, rec.last(), "status");
      return "credentials and request signing accepted";
    }],
    ["unknown external reference is missing", async () => {
      const error = await expectRejection(() => adapter.verifyPayment({ id: `contract-missing-${randomUUID()}` }), "an unknown reference");
      expectContract(contracts.mesomb.transactions, rec.last(), "transaction check");
      expectEqual(rec.last().body.length, 0, "matching transactions");
      expectEqual(error.code, "PAYMENT_NOT_FOUND", "adapter error code");
      return "empty result maps to PAYMENT_NOT_FOUND, as reconciliation expects";
    }],
  ];
  if (cfg.payment) {
    checks.push(["verify a known payment", async () => {
      const verified = await adapter.verifyPayment({ id: cfg.payment.id, providerReference: undefined });
      expectContract(contracts.mesomb.transactions, rec.last(), "transaction check");
      expectEqual(verified.amount, cfg.payment.amount, "amount");
      expectEqual(verified.currency, "XAF", "currency");
      return `status ${verified.status}; amount and currency match`;
    }]);
  }
  if (cfg.collect) {
    const payment = { id: `contract-${randomUUID()}`, amount: cfg.collect.amount, currency: "XAF", payerPhone: cfg.collect.payer,
      email: "sandbox-contracts@example.com", customerName: "Contract Check", network: cfg.collect.network, planId: "contract-check" };
    checks.push(["collect (explicitly allowed)", async () => {
      const made = await adapter.createPayment(payment);
      expectContract(contracts.mesomb.collect, rec.last(), "collect");
      return `transaction ${made.status}, authorization ${made.authorizationMode}`;
    }], ["verify the collection", async () => {
      const verified = await adapter.verifyPayment(payment);
      expectContract(contracts.mesomb.transactions, rec.last(), "transaction check");
      expectEqual(verified.amount, payment.amount, "amount");
      return `status ${verified.status}`;
    }]);
  }
  if (cfg.refund) {
    checks.push(["read refund status", async () => {
      const result = await adapter.verifyRefund({ amount: cfg.refund.amount, currency: "XAF", refund: { providerReference: cfg.refund.id } });
      expectContract(contracts.mesomb.transactions, rec.last(), "refund check");
      return `refund ${result.status}`;
    }]);
  }
  return checks;
}

function resendChecks(cfg, rec, pause) {
  const adapter = new ResendEmailAdapter({ apiUrl: cfg.apiUrl, apiKey: cfg.apiKey, from: cfg.from, portalUrl: "https://portal.example.test", fetcher: rec.fetcher });
  const run = randomUUID(), sent = {};
  const voucher = (code) => ({
    customer: { name: "Contract Check", email: cfg.to }, payment: { amount: 500, currency: "XAF" },
    plan: { name: "Contract check", quotaGb: 1 },
    voucher: { id: `contract-${run}`, code, deviceLimit: 1, expiresAt: "2026-12-31T12:00:00.000Z" },
  });
  return [
    ["send with an idempotency key", async () => {
      sent.first = await adapter.sendVoucher(voucher("NC-TEST-0001"));
      expectContract(contracts.resend.send, rec.last(), "send");
      return "message accepted";
    }],
    ["identical retry returns the original message", async () => {
      await pause();
      const retry = await adapter.sendVoucher(voucher("NC-TEST-0001"));
      expectContract(contracts.resend.send, rec.last(), "retry");
      expectEqual(retry.messageId, sent.first.messageId, "retried message ID");
      return "same idempotency key and payload were not sent twice";
    }],
    ["changed payload under the same key is rejected", async () => {
      await pause();
      await expectRejection(() => adapter.sendVoucher(voucher("NC-TEST-0002")), "a changed payload under a reused key");
      expectEqual(rec.last().status, 409, "HTTP status");
      expectContract(contracts.resend.error, rec.last(), "idempotency conflict");
      return "HTTP 409: retries must resend the identical message";
    }],
    ["receipt with PDF attachment", async () => {
      await pause();
      const receipt = { number: `NC-contract-${run}`, paymentId: `contract-${run}`, paidAt: "2026-10-05T08:00:00.000Z", provider: "mesomb",
        network: "mtn", providerReference: "contract-reference", amount: 500, currency: "XAF", customerName: "Contract Check",
        plan: { id: "contract", name: "Contract check", quotaGb: 1, durationDays: 1, deviceLimit: 1 }, policyVersion: "contract" };
      await adapter.sendReceipt({ to: cfg.to, receipt });
      expectContract(contracts.resend.send, rec.last(), "receipt");
      return "attachment accepted";
    }],
    ["retrieve the accepted message", async () => {
      await pause();
      const response = await rec.fetcher(`${cfg.apiUrl}/emails/${encodeURIComponent(sent.first.messageId)}`, {
        headers: { authorization: `Bearer ${cfg.apiKey}`, accept: "application/json" }, signal: AbortSignal.timeout(10000) });
      expectContract(contracts.resend.email, rec.last(), "retrieve");
      expectEqual(rec.last().body.id, sent.first.messageId, "retrieved message ID");
      if (!response.ok) throw Error(`retrieve returned HTTP ${response.status}`);
      return `last event ${rec.last().body.last_event || "not reported yet"}`;
    }],
    ["invalid key is rejected without echoing it", async () => {
      await pause();
      const invalidKey = "re_contract_invalid_key";
      const rejected = new ResendEmailAdapter({ apiUrl: cfg.apiUrl, apiKey: invalidKey, from: cfg.from, fetcher: rec.fetcher });
      const error = await expectRejection(() => rejected.sendVoucher(voucher("NC-TEST-0003")), "an invalid API key");
      if (![401, 403].includes(rec.last().status)) throw Error(`expected HTTP 401 or 403, got ${rec.last().status}`);
      expectContract(contracts.resend.error, rec.last(), "invalid key");
      if (error.message.includes(invalidKey)) throw Error("the adapter error exposes the API key");
      return `HTTP ${rec.last().status} with a sanitized adapter error`;
    }],
  ];
}

// Runs the configured checks. `fetch` is injectable so the offline tests can drive this
// runner against simulated providers; the MeSomb SDK always uses the global fetch.
export function runSandboxChecks(options = {}) {
  return serializeProviderChecks(() => runSandboxChecksSerial(options));
}

async function runSandboxChecksSerial({ env = {}, fetch: baseFetch = globalThis.fetch, require = [],
  selectedProviders = providers, allowWrites = false, timeoutMs = 10000,
  pause = () => new Promise((resolve) => setTimeout(resolve, 600)), record } = {}) {
  if (!Array.isArray(selectedProviders) || !selectedProviders.length || selectedProviders.some((p) => !providers.includes(p)) ||
    !Array.isArray(require) || require.some((p) => !selectedProviders.includes(p)) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new SandboxCheckError("Select known providers and a positive request timeout");
  }
  const plan = sandboxPlan(env, { allowWrites, selectedProviders }), results = [], recordings = {};
  const originalFetch = globalThis.fetch;
  try {
    for (const provider of providers) {
      const cfg = plan[provider];
      if (cfg.skip || cfg.refuse) {
        const status = cfg.refuse || require.includes(provider) ? "fail" : "skip";
        results.push({ provider, check: "configuration", status, detail: cfg.refuse || cfg.skip });
        continue;
      }
      const rec = recorder(exerciseFetch(provider, cfg, baseFetch, timeoutMs), timeoutMs);
      globalThis.fetch = rec.fetcher;
      const checks = provider === "flutterwave" ? flutterwaveChecks(cfg, rec)
        : provider === "mesomb" ? mesombChecks(cfg, rec) : resendChecks(cfg, rec, pause);
      for (const [check, task] of checks) {
        const before = rec.calls.length;
        try {
          await task();
          results.push({ provider, check, status: "pass", detail: "contract verified" });
        } catch (error) {
          const category = errorCategory(error);
          results.push({ provider, check, status: "fail", detail: error instanceof SandboxCheckError ? error.message : category.error,
            ...(category.httpStatus ? { httpStatus: category.httpStatus } : {}) });
        }
        if (record) (recordings[provider] ??= {})[check] = rec.calls.slice(before).map((c) => ({ status: c.status, body: redact(c.body) }));
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (record) {
    await mkdir(record, { recursive: true });
    for (const [provider, data] of Object.entries(recordings)) {
      await writeFile(join(record, `${provider}.json`), `${JSON.stringify({ _provenance: "Sandbox recording (redacted); replace identifiers with synthetic values and review before using as a fixture.", ...data }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    }
  }
  return { results, failed: results.some((r) => r.status === "fail") };
}

export function parseSandboxArgs(argv) {
  const options = { allowWrites: false };
  for (const arg of argv) {
    if (arg === "--allow-writes") options.allowWrites = true;
    else if (arg.startsWith("--provider=")) options.selectedProviders = arg.slice("--provider=".length).split(",");
    else if (arg.startsWith("--record=") && arg.slice("--record=".length)) options.record = arg.slice("--record=".length);
    else throw new SandboxCheckError("Use --provider=flutterwave|mesomb|resend, optional --allow-writes and --record=directory");
  }
  if (!options.selectedProviders?.length || options.selectedProviders.some((p) => !providers.includes(p))) {
    throw new SandboxCheckError("An explicit selection of known providers is required");
  }
  options.require = [...options.selectedProviders];
  return options;
}

async function main() {
  let options;
  try { options = parseSandboxArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  let results, failed;
  try { ({ results, failed } = await runSandboxChecks({ ...options, env: process.env })); }
  catch { console.error("Sandbox exercise could not complete; check configuration and recording output permissions."); process.exitCode = 1; return; }
  const actions = process.env.GITHUB_ACTIONS === "true";
  for (const r of results) {
    console.log(`${r.status.toUpperCase().padEnd(4)} ${r.provider} ${r.check}: ${r.detail}`);
    if (actions && r.status !== "pass") console.log(`::${r.status === "fail" ? "error" : "warning"} title=${r.provider} ${r.check}::${r.detail}`);
  }
  const count = (status) => results.filter((r) => r.status === status).length;
  console.log(`\n${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped.`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
