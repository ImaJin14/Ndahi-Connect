// TEST-003 provider contract runner.
//
// Offline (default): exercises the real Flutterwave, MeSomb and Resend adapters
// against injected fixtures. Global fetch is replaced for the whole run, so no
// network request, charge, refund or email can leave the process.
//
// Sandbox (explicit `--sandbox --provider=...`): reads pre-existing test
// transactions with dedicated CONTRACT_* credentials taken from process.env only
// (.env is never loaded). Only read-only verification endpoints are allowlisted;
// a Resend test send to the documented test recipient additionally requires
// `--resend-test-send`.
//
// Output contains provider/check names, pass flags, normalized statuses and
// error categories only. Credentials, identifiers, customer details, voucher
// codes and raw provider payloads are never printed.
import { pathToFileURL } from "node:url";
import { PaymentOperation } from "@hachther/mesomb";
import { FlutterwavePaymentAdapter, MeSombPaymentAdapter } from "../lib/payments.mjs";
import { ResendEmailAdapter } from "../lib/email.mjs";
import { ensureReceipt } from "../lib/billing.mjs";
import { receiptFilename } from "../lib/receipt-pdf.mjs";

export const PROVIDERS = Object.freeze(["flutterwave", "mesomb", "resend"]);
export const MODES = Object.freeze(["offline", "sandbox"]);
export const MESOMB_TEST_ACK = "I_CONFIRM_MESOMB_TEST_MODE_ACCOUNT";
// Resend's documented test address: accepted by the API, never reaches a person.
export const RESEND_TEST_RECIPIENT = "delivered@resend.dev";
const FLUTTERWAVE_API_URL = "https://api.flutterwave.com/v3";
const RESEND_API_URL = "https://api.resend.com";
// Default host of the @hachther/mesomb SDK. If the SDK calls another host the
// guard blocks it and the run fails closed.
const MESOMB_HOSTS = Object.freeze(["mesomb.hachther.com"]);
const DEFAULT_TIMEOUT_MS = 15_000;

export const SANDBOX_KEYS = Object.freeze({
  flutterwave: ["CONTRACT_FLW_SECRET_KEY", "CONTRACT_FLW_TRANSACTION_ID", "CONTRACT_FLW_TX_REF",
    "CONTRACT_FLW_EXPECTED_AMOUNT", "CONTRACT_FLW_EXPECTED_CURRENCY"],
  mesomb: ["CONTRACT_MESOMB_TEST_ACCOUNT_ACK", "CONTRACT_MESOMB_APPLICATION_KEY", "CONTRACT_MESOMB_ACCESS_KEY",
    "CONTRACT_MESOMB_SECRET_KEY", "CONTRACT_MESOMB_TRANSACTION_REF", "CONTRACT_MESOMB_EXPECTED_AMOUNT",
    "CONTRACT_MESOMB_EXPECTED_CURRENCY"],
  resend: ["CONTRACT_RESEND_API_KEY", "CONTRACT_RESEND_EMAIL_ID"],
});
export const RESEND_SEND_KEYS = Object.freeze(["CONTRACT_RESEND_FROM"]);
// Dedicated contract credentials must never be the production ones.
const PRODUCTION_PAIRS = Object.freeze({
  flutterwave: [["CONTRACT_FLW_SECRET_KEY", "FLW_SECRET_KEY"]],
  mesomb: [["CONTRACT_MESOMB_APPLICATION_KEY", "MESOMB_APPLICATION_KEY"],
    ["CONTRACT_MESOMB_ACCESS_KEY", "MESOMB_ACCESS_KEY"], ["CONTRACT_MESOMB_SECRET_KEY", "MESOMB_SECRET_KEY"]],
  resend: [["CONTRACT_RESEND_API_KEY", "EMAIL_API_KEY"]],
});
const SECRET_ENV_KEYS = ["FLW_SECRET_KEY", "FLW_SECRET_HASH", "MESOMB_APPLICATION_KEY", "MESOMB_ACCESS_KEY",
  "MESOMB_SECRET_KEY", "MESOMB_WEBHOOK_SECRET", "EMAIL_API_KEY"];

// Read-only evidence never covers these; they stay untested by this runner.
export const NOT_VERIFIED = Object.freeze({
  flutterwave: ["charge_creation", "refund", "refund_verification", "webhook_delivery"],
  mesomb: ["collection_creation", "refund", "refund_verification", "webhook_delivery", "test_account_state"],
  resend: ["delivery_to_real_recipients", "delivery_webhooks"],
});

export class ContractError extends Error {
  constructor(message, code = "contract_error") {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

const SENSITIVE_PATTERNS = [
  [/Bearer\s+[^\s"',]+/gi, "Bearer [redacted]"],
  [/FLW(?:SECK|PUBK)(?:_TEST)?-[A-Za-z0-9-]+/g, "[redacted-key]"],
  [/\bre_[A-Za-z0-9_]{6,}/g, "[redacted-key]"],
  [/[^\s"'<>@,;:()]+@[^\s"'<>@,;:()]+\.[A-Za-z]{2,}/g, "[redacted-email]"],
  [/\bNC-[A-Z0-9]{4}-[A-Z0-9]{4}\b/gi, "[redacted-voucher]"],
  [/\+?\b(?:237)?6\d{8}\b/g, "[redacted-phone]"],
];

export function redact(value, secrets = []) {
  let text = value instanceof Error ? value.message : String(value ?? "");
  for (const secret of [...secrets].filter((s) => typeof s === "string" && s.length >= 4).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[redacted]");
  }
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) text = text.replace(pattern, replacement);
  return text.replace(/[\r\n\t]+/g, " ").slice(0, 200);
}

export function secretValues(env = {}) {
  return Object.entries(env)
    .filter(([key]) => key.startsWith("CONTRACT_") || SECRET_ENV_KEYS.includes(key))
    .map(([, value]) => String(value ?? ""));
}

// Provider messages can echo payloads, so only a category (and HTTP status) is reported.
export function errorCategory(error, secrets = []) {
  if (error instanceof ContractError) return { error: error.code, message: redact(error.message, secrets) };
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return { error: "timeout" };
  if (error?.code === "PAYMENT_NOT_FOUND") return { error: "not_found" };
  const status = /\((\d{3})\)/.exec(String(error?.message || ""))?.[1];
  return status ? { error: "provider_http_error", httpStatus: Number(status) } : { error: "provider_error" };
}

export function parseArgs(argv = []) {
  const options = { mode: "offline", providers: null, json: false, resendTestSend: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (const arg of argv) {
    const [flag, value = ""] = arg.split(/=(.*)/s);
    if (flag === "--json") options.json = true;
    else if (flag === "--sandbox") options.mode = "sandbox";
    else if (flag === "--mode") options.mode = value;
    else if (flag === "--provider" || flag === "--providers") options.providers = value.split(",").map((p) => p.trim()).filter(Boolean);
    else if (flag === "--resend-test-send") options.resendTestSend = true;
    else if (flag === "--timeout-ms") options.timeoutMs = Number(value);
    else throw new ContractError(`Unknown argument ${flag.slice(0, 40)}`, "usage");
  }
  if (!MODES.includes(options.mode)) throw new ContractError("--mode must be offline or sandbox", "usage");
  if (options.mode === "sandbox" && !options.providers?.length) {
    throw new ContractError("Sandbox mode requires an explicit --provider=flutterwave,mesomb,resend list", "usage");
  }
  options.providers ??= [...PROVIDERS];
  const unknown = options.providers.filter((p) => !PROVIDERS.includes(p));
  if (unknown.length || !options.providers.length) throw new ContractError(`--provider accepts ${PROVIDERS.join(", ")}`, "usage");
  options.providers = [...new Set(options.providers)];
  if (options.resendTestSend && (options.mode !== "sandbox" || !options.providers.includes("resend"))) {
    throw new ContractError("--resend-test-send requires --sandbox with --provider including resend", "usage");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 60_000) {
    throw new ContractError("--timeout-ms must be an integer between 1000 and 60000", "usage");
  }
  return options;
}

const filled = (env, key) => String(env[key] ?? "").trim() !== "";
const positiveAmount = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const STATUSES = ["paid", "pending", "failed", "refunded"];

// Validates sandbox configuration. Messages name keys only, never values.
export function sandboxConfig(provider, env = {}, { resendTestSend = false } = {}) {
  const required = [...SANDBOX_KEYS[provider], ...(provider === "resend" && resendTestSend ? RESEND_SEND_KEYS : [])];
  const missing = required.filter((key) => !filled(env, key)), errors = [];
  const value = (key) => String(env[key] ?? "").trim();
  if (env.NODE_ENV === "production") errors.push("NODE_ENV is production; sandbox contracts refuse to run there");
  for (const [contractKey, productionKey] of PRODUCTION_PAIRS[provider]) {
    if (filled(env, contractKey) && filled(env, productionKey) && value(contractKey) === value(productionKey)) {
      errors.push(`${contractKey} must not reuse ${productionKey}`);
    }
  }
  if (provider === "flutterwave") {
    if (filled(env, "CONTRACT_FLW_SECRET_KEY") && !value("CONTRACT_FLW_SECRET_KEY").startsWith("FLWSECK_TEST-")) {
      errors.push("CONTRACT_FLW_SECRET_KEY must be a Flutterwave test key (FLWSECK_TEST-); live keys are rejected");
    }
    if (filled(env, "CONTRACT_FLW_API_URL")) errors.push(`CONTRACT_FLW_API_URL is not supported; only ${FLUTTERWAVE_API_URL} is contacted`);
    if (filled(env, "CONTRACT_FLW_TRANSACTION_ID") && !/^\d+$/.test(value("CONTRACT_FLW_TRANSACTION_ID"))) {
      errors.push("CONTRACT_FLW_TRANSACTION_ID must be a numeric Flutterwave transaction id");
    }
  }
  if (provider === "mesomb" && filled(env, "CONTRACT_MESOMB_TEST_ACCOUNT_ACK") &&
    value("CONTRACT_MESOMB_TEST_ACCOUNT_ACK") !== MESOMB_TEST_ACK) {
    errors.push(`CONTRACT_MESOMB_TEST_ACCOUNT_ACK must equal ${MESOMB_TEST_ACK} after confirming test mode in the MeSomb dashboard`);
  }
  if (provider === "mesomb" && filled(env, "CONTRACT_MESOMB_TRANSACTION_REF") &&
    !/^[A-Za-z0-9._:-]{1,100}$/.test(value("CONTRACT_MESOMB_TRANSACTION_REF"))) {
    errors.push("CONTRACT_MESOMB_TRANSACTION_REF must be a single external transaction reference");
  }
  if (provider === "resend") {
    if (filled(env, "CONTRACT_RESEND_API_KEY") && !value("CONTRACT_RESEND_API_KEY").startsWith("re_")) {
      errors.push("CONTRACT_RESEND_API_KEY must be a Resend API key (re_)");
    }
    if (filled(env, "CONTRACT_RESEND_EMAIL_ID") && !/^[A-Za-z0-9-]{8,64}$/.test(value("CONTRACT_RESEND_EMAIL_ID"))) {
      errors.push("CONTRACT_RESEND_EMAIL_ID must be a Resend email id");
    }
    if (filled(env, "CONTRACT_RESEND_API_URL")) errors.push(`CONTRACT_RESEND_API_URL is not supported; only ${RESEND_API_URL} is contacted`);
  }
  const prefix = { flutterwave: "CONTRACT_FLW", mesomb: "CONTRACT_MESOMB" }[provider];
  if (prefix) {
    if (filled(env, `${prefix}_EXPECTED_AMOUNT`) && !positiveAmount(value(`${prefix}_EXPECTED_AMOUNT`))) {
      errors.push(`${prefix}_EXPECTED_AMOUNT must be a positive number`);
    }
    if (filled(env, `${prefix}_EXPECTED_CURRENCY`) && !/^[A-Z]{3}$/.test(value(`${prefix}_EXPECTED_CURRENCY`))) {
      errors.push(`${prefix}_EXPECTED_CURRENCY must be an ISO currency code such as XAF`);
    }
    if (filled(env, `${prefix}_EXPECTED_STATUS`) && !STATUSES.includes(value(`${prefix}_EXPECTED_STATUS`))) {
      errors.push(`${prefix}_EXPECTED_STATUS must be one of ${STATUSES.join(", ")}`);
    }
  }
  const config = Object.fromEntries([...required, "CONTRACT_FLW_EXPECTED_STATUS", "CONTRACT_MESOMB_EXPECTED_STATUS"]
    .filter((key) => filled(env, key)).map((key) => [key, value(key)]));
  return { ok: !missing.length && !errors.length, missing, errors, config };
}

// Mirrors the verification rules in lib/payment-reconciliation.mjs so contract
// evidence uses the same definition of a matching provider transaction.
export function transactionMismatches(expected, verified) {
  if (!verified) return ["verification_missing"];
  const issues = [], reference = verified.providerReference;
  if (!STATUSES.includes(verified.status)) issues.push("status_unknown");
  if (reference === undefined || reference === null || reference === "" || reference === "undefined") issues.push("provider_reference_missing");
  else if (expected.providerReference != null && String(reference) !== String(expected.providerReference)) issues.push("provider_reference_mismatch");
  if (verified.transactionReference !== expected.reference) issues.push("reference_mismatch");
  if (!Number.isFinite(Number(verified.amount)) || Number(verified.amount) !== Number(expected.amount)) issues.push("amount_mismatch");
  if (verified.currency !== expected.currency) issues.push("currency_mismatch");
  if (expected.status && verified.status !== expected.status) issues.push("status_mismatch");
  return issues;
}

// Comparable, non-sensitive view of a verification result (drops `raw`).
const comparable = (v) => JSON.stringify([v?.status, String(v?.providerReference), v?.transactionReference, Number(v?.amount), v?.currency]);

export function guardedFetch({ fetchImpl, rules = [], timeoutMs = DEFAULT_TIMEOUT_MS, calls = [] }) {
  return async function contractFetch(input, init = {}) {
    let url;
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); } catch { url = null; }
    const method = String(init.method || input?.method || "GET").toUpperCase();
    const rule = url && url.protocol === "https:" && !url.port && !url.username && !url.password
      ? rules.find((r) => r.method === method && r.host === url.hostname && r.path.test(url.pathname) && (!r.allow || r.allow({ url, init })))
      : undefined;
    calls.push({ method, host: url?.hostname || "invalid", endpoint: rule?.label || "blocked", allowed: Boolean(rule) });
    if (!rule) throw new ContractError(`Blocked ${method} request to a non-allowlisted endpoint`, "blocked_by_guard");
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    return withTimeout(fetchImpl(input, { ...init, signal, redirect: "error" }), timeoutMs);
  };
}

export const denyAllFetch = (calls = []) => guardedFetch({ fetchImpl: () => { throw new ContractError("unreachable", "blocked_by_guard"); }, rules: [], calls });

// Only single EXTERNAL-reference lookups reach the MeSomb client.
export function readOnlyMeSombClient(client, calls = []) {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property === "checkTransactions") {
        return async (ids, source) => {
          const allowed = source === "EXTERNAL" && Array.isArray(ids) && ids.length === 1;
          calls.push({ method: "checkTransactions", source: String(source), allowed });
          if (!allowed) throw new ContractError("Only single EXTERNAL transaction lookups are allowed", "blocked_by_guard");
          return client.checkTransactions(ids, source);
        };
      }
      return async () => {
        calls.push({ method: String(property), allowed: false });
        throw new ContractError(`MeSomb ${String(property)} is blocked in contract mode`, "blocked_by_guard");
      };
    },
  });
}

export const FLUTTERWAVE_RULES = Object.freeze([
  { label: "flutterwave_verify_by_id", method: "GET", host: "api.flutterwave.com", path: /^\/v3\/transactions\/\d+\/verify$/ },
  { label: "flutterwave_verify_by_reference", method: "GET", host: "api.flutterwave.com", path: /^\/v3\/transactions\/verify_by_reference$/ },
]);
export const MESOMB_RULES = Object.freeze(MESOMB_HOSTS.map((host) =>
  ({ label: "mesomb_transaction_lookup", method: "GET", host, path: /^\/api\/v1\.1\/payment\/transactions\/check\/$/,
    allow: ({ url }) => url.searchParams.get("source") === "EXTERNAL" &&
      url.searchParams.getAll("ids").length === 1 && /^[A-Za-z0-9._:-]{1,100}$/.test(url.searchParams.get("ids") || "") })));
const RESEND_READ_RULE = { label: "resend_retrieve_email", method: "GET", host: "api.resend.com", path: /^\/emails\/[A-Za-z0-9-]+$/ };
export function onlyTestRecipient({ init }) {
  try {
    const body = JSON.parse(init.body);
    return Array.isArray(body.to) && body.to.length === 1 && body.to[0] === RESEND_TEST_RECIPIENT &&
      body.cc === undefined && body.bcc === undefined;
  } catch { return false; }
}
const RESEND_TEST_SEND_RULE = { label: "resend_test_send", method: "POST", host: "api.resend.com", path: /^\/emails$/, allow: onlyTestRecipient };

async function withGlobalFetch(replacement, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ContractError("Provider contract exceeded its overall timeout", "timeout")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function checkList(evidence, secrets) {
  const checks = [];
  return {
    checks,
    async run(name, fn) {
      try {
        const { issues = [], ...details } = (await fn()) || {};
        checks.push({ name, pass: issues.length === 0, evidence, ...details, ...(issues.length ? { issues } : {}) });
      } catch (error) {
        checks.push({ name, pass: false, evidence, ...errorCategory(error, secrets) });
      }
    },
  };
}

const failing = (conditions) => Object.entries(conditions).filter(([, ok]) => !ok).map(([issue]) => issue);
async function rejection(promise) {
  try { await promise; return null; } catch (error) { return error; }
}

// ---------- Offline fixtures (no network, synthetic data only) ----------

const fixtureCustomer = { email: "fixture-customer@example.test", phone_number: "237670000001", name: "Fixture Customer" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export function flutterwaveFixture(transactions) {
  const requests = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = String(init.method || "GET").toUpperCase();
    requests.push({ method, path: url.pathname });
    if (method !== "GET") return json({ status: "error", message: "fixture refuses writes" }, 405);
    const byId = url.pathname.match(/\/transactions\/(\d+)\/verify$/)?.[1];
    const transaction = byId ? transactions.find((t) => String(t.id) === byId)
      : url.pathname.endsWith("/verify_by_reference") ? transactions.find((t) => t.tx_ref === url.searchParams.get("tx_ref")) : undefined;
    if (!transaction) return json({ status: "error", message: `No transaction was found for ${fixtureCustomer.email}`, data: null }, 404);
    return json({ status: "success", message: "Transaction fetched successfully", data: { ...transaction, customer: fixtureCustomer } });
  };
  return { fetch, requests };
}

export function mesombFixture(transactions) {
  const requests = [];
  const client = {
    async checkTransactions(ids, source) {
      requests.push({ method: "checkTransactions", ids: [...ids], source });
      if (source !== "EXTERNAL") return [];
      return ids.filter((id) => transactions[id]).map((id) => {
        const data = { ...transactions[id], customer: fixtureCustomer };
        return { ...transactions[id], getData: () => data };
      });
    },
    async makeCollect() { requests.push({ method: "makeCollect" }); return { success: true }; },
    async refundTransaction() { requests.push({ method: "refundTransaction" }); return { success: true }; },
  };
  return { client, requests };
}

export function resendFixture() {
  const requests = [];
  let next = 0;
  const byKey = new Map();
  const fetch = async (input, init = {}) => {
    const key = init.headers?.["idempotency-key"];
    requests.push({ url: String(input), method: init.method, headers: { ...init.headers }, body: JSON.parse(init.body) });
    // Resend replays the original response for a repeated idempotency key.
    if (!byKey.has(key)) byKey.set(key, `fixture-email-${++next}`);
    return json({ id: byKey.get(key) });
  };
  return { fetch, requests };
}

const syntheticReceipt = (id) => ensureReceipt({
  id, status: "paid", confirmedAt: "2026-10-01T09:00:00Z", amount: 100, currency: "XAF",
  provider: "mesomb", network: "mtn", providerReference: "contract-synthetic", customerName: "Contract Test",
}, { name: "Contract test", quotaGb: 1, deviceLimit: 1, validityHours: 1 });

const syntheticVoucher = (id) => ({
  customer: { name: "Fixture Customer", email: fixtureCustomer.email },
  payment: { amount: 500, currency: "XAF" },
  plan: { name: "Weekly", quotaGb: 5 },
  voucher: { id, code: "NC-FXTR-2345", deviceLimit: 1, expiresAt: "2026-10-08T12:00:00.000Z" },
});

// ---------- Offline contracts ----------

async function offlineFlutterwave({ secrets }) {
  const fixture = flutterwaveFixture([
    { id: 1001, tx_ref: "ndahi-success", amount: 500, currency: "XAF", status: "successful" },
    { id: 1002, tx_ref: "ndahi-pending", amount: 500, currency: "XAF", status: "pending" },
    { id: 1003, tx_ref: "ndahi-failed", amount: 500, currency: "XAF", status: "failed" },
    { id: 1004, tx_ref: "ndahi-other", amount: 400, currency: "NGN", status: "successful" },
  ]);
  const calls = [], list = checkList("offline_fixture", secrets);
  const guarded = guardedFetch({ fetchImpl: fixture.fetch, rules: FLUTTERWAVE_RULES, calls });
  const adapter = new FlutterwavePaymentAdapter({ secretKey: "FLWSECK_TEST-offline-fixture", secretHash: "offline-fixture-hash" });
  const expected = (id, reference) => ({ providerReference: String(id), reference, amount: 500, currency: "XAF" });
  await withGlobalFetch(guarded, async () => {
    await list.run("status_mapping_success_pending_failed", async () => {
      const statuses = [];
      for (const [id, reference] of [[1001, "ndahi-success"], [1002, "ndahi-pending"], [1003, "ndahi-failed"]]) {
        const verified = await adapter.verifyPayment({ id: reference, providerReference: String(id) });
        statuses.push(verified.status);
        if (transactionMismatches(expected(id, reference), verified).length) return { issues: [`unexpected_mismatch_${id}`] };
      }
      return { issues: failing({ status_mapping: JSON.stringify(statuses) === JSON.stringify(["paid", "pending", "failed"]) }) };
    });
    await list.run("verify_by_reference_without_transaction_id", async () => {
      const before = calls.length, verified = await adapter.verifyPayment({ id: "ndahi-pending" });
      return { issues: [...transactionMismatches(expected(1002, "ndahi-pending"), verified),
        ...failing({ used_reference_endpoint: calls[before]?.endpoint === "flutterwave_verify_by_reference" })] };
    });
    await list.run("missing_reference_is_reported", async () => {
      const byId = await rejection(adapter.verifyPayment({ id: "ndahi-success", providerReference: "9999" }));
      const byReference = await rejection(adapter.verifyPayment({ id: "ndahi-unknown" }));
      return { issues: failing({
        missing_id_rejected: errorCategory(byId).httpStatus === 404,
        missing_reference_rejected: errorCategory(byReference).httpStatus === 404,
      }) };
    });
    await list.run("detects_amount_currency_reference_mismatch", async () => {
      const verified = await adapter.verifyPayment({ id: "ndahi-success", providerReference: "1004" });
      const issues = transactionMismatches(expected(1004, "ndahi-success"), verified);
      return { issues: failing({
        amount_mismatch_detected: issues.includes("amount_mismatch"),
        currency_mismatch_detected: issues.includes("currency_mismatch"),
        reference_mismatch_detected: issues.includes("reference_mismatch"),
      }) };
    });
    await list.run("repeated_verification_is_read_only", async () => {
      const first = await adapter.verifyPayment({ id: "ndahi-success", providerReference: "1001" });
      const second = await adapter.verifyPayment({ id: "ndahi-success", providerReference: "1001" });
      return { issues: failing({
        stable_result: comparable(first) === comparable(second),
        only_get_requests: fixture.requests.every((r) => r.method === "GET"),
        only_verify_endpoints: calls.every((c) => c.allowed),
      }) };
    });
    await list.run("charge_and_refund_blocked_by_guard", async () => {
      const seen = fixture.requests.length;
      const charge = await rejection(adapter.createPayment({ id: "ndahi-new", amount: 500, currency: "XAF", payerPhone: "670000001", network: "mtn" }));
      const refund = await rejection(adapter.refundPayment({ id: "ndahi-success", providerReference: "1001", amount: 500 }));
      return { issues: failing({
        charge_blocked: charge?.code === "blocked_by_guard",
        refund_blocked: refund?.code === "blocked_by_guard",
        fixture_never_reached: fixture.requests.length === seen,
      }) };
    });
  });
  return { checks: list.checks, calls };
}

async function offlineMeSomb({ secrets }) {
  const fixture = mesombFixture({
    "ndahi-success": { pk: "msb-1", status: "SUCCESS", amount: 500, currency: "XAF" },
    "ndahi-pending": { pk: "msb-2", status: "PENDING", amount: 500, currency: "XAF" },
    "ndahi-failed": { pk: "msb-3", status: "FAILED", amount: 500, currency: "XAF" },
    "ndahi-other": { pk: "msb-4", status: "SUCCESS", amount: 400, currency: "EUR" },
  });
  const calls = [], list = checkList("offline_fixture", secrets);
  const adapter = new MeSombPaymentAdapter({ client: readOnlyMeSombClient(fixture.client, calls) });
  const expected = (reference, providerReference) => ({ providerReference, reference, amount: 500, currency: "XAF" });
  await list.run("status_mapping_success_pending_failed", async () => {
    const statuses = [];
    for (const [reference, pk] of [["ndahi-success", "msb-1"], ["ndahi-pending", "msb-2"], ["ndahi-failed", "msb-3"]]) {
      const verified = await adapter.verifyPayment({ id: reference });
      statuses.push(verified.status);
      if (transactionMismatches(expected(reference, pk), verified).length) return { issues: [`unexpected_mismatch_${reference}`] };
    }
    return { issues: failing({ status_mapping: JSON.stringify(statuses) === JSON.stringify(["paid", "pending", "failed"]) }) };
  });
  await list.run("sdk_external_reference_lookup", async () => {
    const before = fixture.requests.length;
    await adapter.verifyPayment({ id: "ndahi-success" });
    const request = fixture.requests[before];
    return { issues: failing({
      external_source: request?.source === "EXTERNAL",
      looked_up_by_payment_id: JSON.stringify(request?.ids) === JSON.stringify(["ndahi-success"]),
    }) };
  });
  await list.run("missing_reference_is_reported", async () => {
    const error = await rejection(adapter.verifyPayment({ id: "ndahi-unknown" }));
    return { issues: failing({ not_found: errorCategory(error).error === "not_found" }) };
  });
  await list.run("detects_amount_currency_mismatch", async () => {
    const issues = transactionMismatches(expected("ndahi-other", "msb-4"), await adapter.verifyPayment({ id: "ndahi-other" }));
    return { issues: failing({
      amount_mismatch_detected: issues.includes("amount_mismatch"),
      currency_mismatch_detected: issues.includes("currency_mismatch"),
    }) };
  });
  await list.run("repeated_verification_is_read_only", async () => {
    const first = await adapter.verifyPayment({ id: "ndahi-success" });
    const second = await adapter.verifyPayment({ id: "ndahi-success" });
    return { issues: failing({
      stable_result: comparable(first) === comparable(second),
      only_lookups: fixture.requests.every((r) => r.method === "checkTransactions" && r.source === "EXTERNAL"),
    }) };
  });
  await list.run("collect_and_refund_blocked_by_guard", async () => {
    const seen = fixture.requests.length;
    const collect = await rejection(adapter.createPayment({ id: "ndahi-new", amount: 500, currency: "XAF", payerPhone: "670000001", network: "mtn" }));
    const refund = await rejection(adapter.refundPayment({ providerReference: "msb-1", amount: 500, currency: "XAF" }));
    const refundCheck = await rejection(adapter.verifyRefund({ refund: { providerReference: "msb-r1" }, amount: 500, currency: "XAF" }));
    return { issues: failing({
      collect_blocked: collect?.code === "blocked_by_guard",
      refund_blocked: refund?.code === "blocked_by_guard",
      non_external_lookup_blocked: refundCheck?.code === "blocked_by_guard",
      fixture_never_reached: fixture.requests.length === seen,
    }) };
  });
  return { checks: list.checks, calls };
}

async function offlineResend({ secrets }) {
  const fixture = resendFixture(), calls = [], list = checkList("offline_fixture", secrets);
  const fetcher = guardedFetch({ fetchImpl: fixture.fetch, calls,
    rules: [{ label: "resend_send_fixture", method: "POST", host: "api.resend.com", path: /^\/emails$/ }] });
  const apiKey = "re_offline_fixture_key";
  const adapter = new ResendEmailAdapter({ apiKey, from: "NDAHI Connect <receipts@example.test>", portalUrl: "https://portal.example.test", fetcher });
  await list.run("voucher_idempotency_key_is_stable", async () => {
    const first = await adapter.sendVoucher(syntheticVoucher("voucher-a"));
    const retry = await adapter.sendVoucher(syntheticVoucher("voucher-a"));
    const other = await adapter.sendVoucher(syntheticVoucher("voucher-b"));
    const keys = fixture.requests.slice(-3).map((r) => r.headers["idempotency-key"]);
    return { issues: failing({
      key_format: keys[0] === "voucher-confirmation/voucher-a",
      retry_reuses_key: keys[0] === keys[1],
      retry_returns_same_message: first.messageId === retry.messageId,
      distinct_voucher_distinct_key: keys[2] !== keys[0] && other.messageId !== first.messageId,
    }) };
  });
  await list.run("receipt_pdf_attachment_shape", async () => {
    const receipt = syntheticReceipt("contract-offline-receipt");
    await adapter.sendReceipt({ to: fixtureCustomer.email, receipt });
    const { headers, body } = fixture.requests.at(-1), attachment = body.attachments?.[0];
    const pdf = attachment ? Buffer.from(attachment.content, "base64") : Buffer.alloc(0);
    return { issues: failing({
      idempotency_key: headers["idempotency-key"] === "payment-receipt/contract-offline-receipt",
      single_attachment: body.attachments?.length === 1,
      pdf_filename: attachment?.filename === receiptFilename(receipt) && /\.pdf$/.test(attachment.filename),
      pdf_content: pdf.subarray(0, 5).toString("latin1") === "%PDF-",
      single_recipient: Array.isArray(body.to) && body.to.length === 1,
    }) };
  });
  await list.run("api_key_only_in_authorization_header", async () => {
    return { issues: failing({
      header_present: fixture.requests.every((r) => r.headers.authorization === `Bearer ${apiKey}`),
      not_in_body_or_url: fixture.requests.every((r) => !JSON.stringify(r.body).includes(apiKey) && !r.url.includes(apiKey)),
    }) };
  });
  return { checks: list.checks, calls };
}

// ---------- Sandbox contracts (read-only unless --resend-test-send) ----------

async function sandboxFlutterwave({ config, fetchImpl, timeoutMs, secrets }) {
  const calls = [], list = checkList("sandbox_read_only", secrets);
  const guarded = guardedFetch({ fetchImpl, rules: FLUTTERWAVE_RULES, timeoutMs, calls });
  // secretHash only satisfies configured(); webhooks are not exercised.
  const adapter = new FlutterwavePaymentAdapter({ apiUrl: FLUTTERWAVE_API_URL, secretKey: config.CONTRACT_FLW_SECRET_KEY, secretHash: "contract-read-only" });
  const id = config.CONTRACT_FLW_TRANSACTION_ID, reference = config.CONTRACT_FLW_TX_REF;
  const expected = { providerReference: id, reference, amount: Number(config.CONTRACT_FLW_EXPECTED_AMOUNT),
    currency: config.CONTRACT_FLW_EXPECTED_CURRENCY, status: config.CONTRACT_FLW_EXPECTED_STATUS };
  let first;
  await withGlobalFetch(guarded, async () => {
    await list.run("verify_known_transaction_by_id", async () => {
      first = await adapter.verifyPayment({ id: reference, providerReference: id });
      return { status: first.status, issues: transactionMismatches(expected, first) };
    });
    await list.run("verify_known_transaction_by_reference", async () => {
      const verified = await adapter.verifyPayment({ id: reference });
      return { status: verified.status, issues: transactionMismatches(expected, verified) };
    });
    await list.run("repeated_verification_is_read_only", async () => {
      const again = await adapter.verifyPayment({ id: reference, providerReference: id });
      return { issues: failing({
        stable_result: Boolean(first) && comparable(first) === comparable(again),
        only_read_only_endpoints: calls.every((c) => c.allowed && c.method === "GET"),
      }) };
    });
  });
  return { checks: list.checks, calls };
}

async function sandboxMeSomb({ config, fetchImpl, timeoutMs, secrets, mesombClientFactory }) {
  const calls = [], clientCalls = [], list = checkList("sandbox_read_only", secrets);
  const guarded = guardedFetch({ fetchImpl, rules: MESOMB_RULES, timeoutMs, calls });
  const reference = config.CONTRACT_MESOMB_TRANSACTION_REF;
  const expected = { reference, amount: Number(config.CONTRACT_MESOMB_EXPECTED_AMOUNT),
    currency: config.CONTRACT_MESOMB_EXPECTED_CURRENCY, status: config.CONTRACT_MESOMB_EXPECTED_STATUS };
  let first;
  await withGlobalFetch(guarded, async () => {
    const client = await mesombClientFactory({ applicationKey: config.CONTRACT_MESOMB_APPLICATION_KEY,
      accessKey: config.CONTRACT_MESOMB_ACCESS_KEY, secretKey: config.CONTRACT_MESOMB_SECRET_KEY });
    const adapter = new MeSombPaymentAdapter({ client: readOnlyMeSombClient(client, clientCalls) });
    await list.run("sdk_external_reference_lookup", async () => {
      first = await adapter.verifyPayment({ id: reference });
      return { status: first.status, issues: transactionMismatches(expected, first) };
    });
    await list.run("repeated_verification_is_read_only", async () => {
      const again = await adapter.verifyPayment({ id: reference });
      return { issues: failing({
        stable_result: Boolean(first) && comparable(first) === comparable(again),
        only_external_lookups: clientCalls.every((c) => c.allowed && c.method === "checkTransactions"),
        only_allowlisted_http: calls.every((c) => c.allowed),
      }) };
    });
  });
  return { checks: list.checks, calls: [...clientCalls, ...calls] };
}

async function sandboxResend({ config, fetchImpl, timeoutMs, secrets, resendTestSend }) {
  const calls = [], list = checkList("sandbox_read_only", secrets);
  const fetcher = guardedFetch({ fetchImpl, timeoutMs, calls, rules: resendTestSend ? [RESEND_READ_RULE, RESEND_TEST_SEND_RULE] : [RESEND_READ_RULE] });
  const headers = { authorization: `Bearer ${config.CONTRACT_RESEND_API_KEY}`, accept: "application/json" };
  const retrieve = async (id) => {
    const response = await fetcher(`${RESEND_API_URL}/emails/${encodeURIComponent(id)}`, { headers });
    if (!response.ok) throw new ContractError(`Resend email lookup failed (${response.status})`, "provider_http_error");
    return response.json();
  };
  await withGlobalFetch(denyAllFetch(calls), async () => {
    await list.run("retrieve_known_email", async () => {
      const email = await retrieve(config.CONTRACT_RESEND_EMAIL_ID);
      return { issues: failing({ id_matches: email?.id === config.CONTRACT_RESEND_EMAIL_ID, has_created_at: typeof email?.created_at === "string" }) };
    });
    if (!resendTestSend) return;
    const sendList = checkList("sandbox_test_send", secrets);
    const adapter = new ResendEmailAdapter({ apiUrl: RESEND_API_URL, apiKey: config.CONTRACT_RESEND_API_KEY, from: config.CONTRACT_RESEND_FROM, fetcher });
    // One synthetic receipt per UTC day; Resend replays repeated idempotency keys instead of resending.
    const receipt = syntheticReceipt(`contract-${new Date().toISOString().slice(0, 10)}`);
    await sendList.run("receipt_send_to_test_recipient_is_idempotent", async () => {
      const first = await adapter.sendReceipt({ to: RESEND_TEST_RECIPIENT, receipt });
      const retry = await adapter.sendReceipt({ to: RESEND_TEST_RECIPIENT, receipt });
      const stored = await retrieve(first.messageId);
      return { issues: failing({
        message_id_returned: Boolean(first.messageId),
        retry_returns_same_message: first.messageId === retry.messageId,
        message_retrievable: stored?.id === first.messageId,
      }) };
    });
    list.checks.push(...sendList.checks);
  });
  return { checks: list.checks, calls };
}

const OFFLINE = { flutterwave: offlineFlutterwave, mesomb: offlineMeSomb, resend: offlineResend };
const SANDBOX = { flutterwave: sandboxFlutterwave, mesomb: sandboxMeSomb, resend: sandboxResend };

// Flutterwave's adapter uses global fetch. Serialize runs so overlapping callers
// cannot restore another run's fetch or bypass its network guard.
let running = Promise.resolve();
export function runContracts(options = {}) {
  const result = running.then(() => runContractsSerial(options));
  running = result.catch(() => {});
  return result;
}

async function runContractsSerial({
  mode = "offline", providers = [...PROVIDERS], env = {}, fetchImpl = globalThis.fetch,
  mesombClientFactory = (credentials) => new PaymentOperation(credentials),
  timeoutMs = DEFAULT_TIMEOUT_MS, resendTestSend = false,
} = {}) {
  if (!MODES.includes(mode) || !Array.isArray(providers) || !providers.length || providers.some((provider) => !PROVIDERS.includes(provider))) {
    throw new ContractError("Use offline or sandbox mode with known providers", "usage");
  }
  // Offline never consults env, so stray CONTRACT_* values cannot cause network use.
  const secrets = mode === "sandbox" ? secretValues(env) : [];
  const results = [];
  for (const provider of providers) {
    const base = { provider, mode, notVerified: [...NOT_VERIFIED[provider]] };
    if (mode === "sandbox") {
      const { ok, missing, errors, config } = sandboxConfig(provider, env, { resendTestSend });
      if (!ok) {
        results.push({ ...base, pass: false, error: "configuration_invalid", missing, configErrors: errors.map((e) => redact(e, secrets)), checks: [] });
        continue;
      }
      try {
        const { checks, calls } = await withGlobalFetch(denyAllFetch(),
          () => SANDBOX[provider]({ config, fetchImpl, timeoutMs, secrets, mesombClientFactory, resendTestSend }));
        results.push({ ...base, pass: checks.length > 0 && checks.every((c) => c.pass), checks, providerCalls: summarizeCalls(calls) });
      } catch (error) {
        results.push({ ...base, pass: false, checks: [], ...errorCategory(error, secrets) });
      }
      continue;
    }
    try {
      const globalCalls = [];
      const { checks, calls } = await withGlobalFetch(denyAllFetch(globalCalls), () => OFFLINE[provider]({ secrets }));
      const networkSafe = globalCalls.length === 0;
      checks.push({ name: "no_unexpected_network_access", pass: networkSafe, evidence: "offline_fixture" });
      results.push({ ...base, pass: checks.every((c) => c.pass), checks, providerCalls: summarizeCalls(calls) });
    } catch (error) {
      results.push({ ...base, pass: false, checks: [], ...errorCategory(error, secrets) });
    }
  }
  return { schemaVersion: 1, mode, ok: results.length > 0 && results.every((r) => r.pass), results };
}

// Counts by endpoint label only; URLs (which contain identifiers) are dropped.
export function summarizeCalls(calls = []) {
  const counts = {};
  for (const call of calls) {
    const label = `${call.allowed ? "" : "blocked:"}${call.endpoint || call.method}`;
    counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}

export function formatSummary(summary) {
  const lines = [];
  for (const result of summary.results) {
    if (result.error) {
      const detail = [result.missing?.length ? `missing=${result.missing.join(",")}` : "",
        ...(result.configErrors || []), result.message || "", result.httpStatus ? `http=${result.httpStatus}` : ""].filter(Boolean).join("; ");
      lines.push(`FAIL ${result.provider} ${result.mode} ${result.error}${detail ? ` (${detail})` : ""}`);
    }
    for (const check of result.checks) {
      const extra = [check.status ? `status=${check.status}` : "", check.issues ? `issues=${check.issues.join(",")}` : "",
        check.error ? `error=${check.error}${check.httpStatus ? `:${check.httpStatus}` : ""}` : ""].filter(Boolean).join(" ");
      lines.push(`${check.pass ? "PASS" : "FAIL"} ${result.provider} ${result.mode} ${check.name} evidence=${check.evidence}${extra ? ` ${extra}` : ""}`);
    }
    lines.push(`NOT VERIFIED ${result.provider}: ${result.notVerified.join(", ")}`);
  }
  lines.push(`Provider contracts (${summary.mode}): ${summary.ok ? "passed" : "failed"}`);
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), { env = process.env, stdout = console.log, stderr = console.error, ...dependencies } = {}) {
  let options;
  try { options = parseArgs(argv); } catch (error) {
    stderr(`Provider contract check could not run: ${redact(error.message, secretValues(env))}`);
    return 2;
  }
  const summary = await runContracts({ ...options, env, ...dependencies });
  stdout(options.json ? JSON.stringify(summary, null, 2) : formatSummary(summary));
  return summary.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
