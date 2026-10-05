import { createHash, createHmac } from "node:crypto";

// Provider response contracts (TEST-003). Each contract lists the fields that
// lib/payments.mjs and lib/email.mjs read from a provider response. The offline
// tests check synthetic fixtures against these contracts and drive the real
// adapters with them; scripts/exercise-provider-sandboxes.mjs checks manually
// selected sandbox responses against the same contracts. No scheduled provider
// write job is configured, and fixtures do not establish live provider compatibility.

const field = (path, types, extra = {}) => ({ path, types: [].concat(types), required: true, ...extra });
const optional = (path, types, extra = {}) => field(path, types, { ...extra, required: false });

export const contracts = {
  flutterwave: {
    charge: {
      operation: "POST /v3/charges?type=mobile_money_franco",
      fields: [
        field("status", "string", { oneOf: ["success"] }),
        field("data", "object"),
        optional("data.id", ["number", "string"]),
        optional("data.flw_ref", "string"),
        field("data.status", "string"),
        optional("meta.authorization", "object"),
        optional("meta.authorization.mode", "string"),
        optional("meta.authorization.redirect_url", ["string", "null"]),
        optional("meta.authorization.redirect", ["string", "null"]),
      ],
      anyOf: [["data.id", "data.flw_ref"]],
    },
    verify: {
      operation: "GET /v3/transactions/:id/verify and /v3/transactions/verify_by_reference",
      fields: [
        field("status", "string", { oneOf: ["success"] }),
        field("data.id", ["number", "string"]),
        field("data.tx_ref", "string"),
        field("data.amount", "number"),
        field("data.currency", "string"),
        field("data.status", "string"),
      ],
    },
    error: {
      operation: "Any rejected request",
      fields: [field("status", "string", { oneOf: ["error"] }), field("message", "string")],
    },
    refund: {
      operation: "POST /v3/transactions/:id/refund and GET /v3/refunds/:id",
      fields: [
        field("status", "string", { oneOf: ["success"] }),
        field("data.id", ["number", "string"]),
        field("data.status", "string"),
        optional("data.meta", ["object", "string", "null"]),
      ],
      anyOf: [["data.tx_id", "data.TransactionId"], ["data.amount_refunded", "data.AmountRefunded"]],
    },
    webhook: {
      // The adapter authenticates only the flutterwave-signature HMAC; v3 documentation
      // describes a verif-hash header carrying the plain secret instead (see fixtures).
      operation: "Charge webhook (flutterwave-signature header)",
      fields: [
        optional("webhook_id", "string"),
        optional("id", ["number", "string"]),
        optional("type", "string"),
        optional("event", "string"),
        field("data.id", ["number", "string"]),
      ],
      anyOf: [["data.tx_ref", "data.reference"]],
    },
  },
  mesomb: {
    status: {
      operation: "GET /api/v1.1/payment/status/",
      // The app never reads this response; the check only needs a signed request to succeed.
      fields: [optional("key", "string"), optional("name", "string"), optional("balances", "array")],
    },
    collect: {
      operation: "POST /api/v1.1/payment/collect/ and /payment/refund/",
      fields: [
        field("success", "boolean"),
        optional("message", ["string", "null"]),
        optional("redirect", ["string", "null"]),
        field("transaction", "object"),
        field("transaction.pk", "string"),
        field("transaction.status", "string"),
        field("transaction.amount", "number"),
        field("transaction.currency", "string"),
        optional("reference", ["string", "null"]),
      ],
    },
    transactions: {
      operation: "GET /api/v1.1/payment/transactions/check/",
      array: true,
      items: [
        field("pk", "string"),
        field("status", "string"),
        field("amount", "number"),
        field("currency", "string"),
      ],
    },
    error: {
      operation: "Any rejected request (raised by the SDK as a typed error)",
      fields: [field("detail", "string"), optional("code", ["string", "null"])],
    },
    webhook: {
      operation: "Signed webhook (x-mesomb-webhook-signature header)",
      fields: [optional("id", ["number", "string"]), optional("event_type", "string"), optional("type", "string")],
      anyOf: [
        ["data.object.reference", "data.object.trxID", "data.object.trx_id", "transaction.reference",
          "transaction.trxID", "transaction.trx_id", "reference"],
      ],
    },
  },
  resend: {
    send: { operation: "POST /emails", fields: [field("id", "string")] },
    error: {
      operation: "Any rejected request",
      fields: [field("message", "string"), optional("name", "string"), optional("statusCode", "number")],
    },
    email: {
      operation: "GET /emails/:id",
      fields: [field("object", "string", { oneOf: ["email"] }), field("id", "string"), optional("last_event", "string")],
    },
  },
};

export function valueAt(value, path) {
  return String(path).split(".").reduce((current, key) => (current == null ? undefined : current[key]), value);
}

const typeOf = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

function fieldViolations(fields, value, prefix = "") {
  const problems = [];
  for (const rule of fields) {
    const found = valueAt(value, rule.path), at = `${prefix}${rule.path}`;
    if (found === undefined) {
      if (rule.required) problems.push(`${at} is missing`);
      continue;
    }
    const type = typeOf(found);
    if (!rule.types.includes(type)) problems.push(`${at} is ${type}, expected ${rule.types.join(" or ")}`);
    else if (rule.oneOf && !rule.oneOf.includes(found)) problems.push(`${at} is outside expected ${rule.oneOf.join(" or ")}`);
  }
  return problems;
}

// Returns a list of human-readable contract violations (empty when the body conforms).
export function violations(contract, body) {
  if (contract.array) {
    if (!Array.isArray(body)) return [`response is ${typeOf(body)}, expected array`];
    return body.flatMap((item, index) => fieldViolations(contract.items, item, `[${index}].`));
  }
  if (typeOf(body) !== "object") return [`response is ${typeOf(body)}, expected object`];
  const problems = fieldViolations(contract.fields || [], body);
  for (const group of contract.anyOf || []) {
    if (!group.some((path) => valueAt(body, path) != null)) problems.push(`one of ${group.join(", ")} is required`);
  }
  return problems;
}

// Independent re-implementation of MeSomb's documented request signature
// (HMAC-SHA1 over a canonical request), so an SDK upgrade that changes how
// requests are signed fails the contract tests instead of production checkouts.
export function mesombSignatureMatches({ method, url, headers, body, accessKey, secretKey }) {
  const authorization = String(headers.Authorization || headers.authorization || "");
  const match = authorization.match(/^HMAC-SHA1 Credential=([^/]+)\/(\S+), SignedHeaders=(\S+), Signature=([a-f0-9]{40})$/);
  if (!match || match[1] !== accessKey) return false;
  const [, , scope, signedHeaders, signature] = match, parsed = new URL(url);
  const signed = { host: `${parsed.protocol}//${parsed.host}`, "x-mesomb-date": headers["x-mesomb-date"],
    "x-mesomb-nonce": headers["x-mesomb-nonce"], ...(method !== "GET" && body ? { "content-type": "application/json" } : {}) };
  const keys = Object.keys(signed).sort();
  if (keys.join(";") !== signedHeaders) return false;
  const sha1 = (value) => createHash("sha1").update(value).digest("hex");
  const canonical = [method, encodeURI(parsed.pathname), parsed.search.slice(1),
    keys.map((key) => `${key}:${signed[key]}`).join("\n"), signedHeaders, sha1(body || "{}")].join("\n");
  const stringToSign = `HMAC-SHA1\n${headers["x-mesomb-date"]}\n${scope}\n${sha1(canonical)}`;
  return createHmac("sha1", secretKey).update(stringToSign).digest("hex") === signature;
}

export const flutterwaveWebhookSignature = (raw, secretHash) =>
  createHmac("sha256", secretHash).update(raw).digest("base64");

export const mesombWebhookSignature = (raw, secret, timestamp) =>
  `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${raw}`, "utf8").digest("hex")}`;
