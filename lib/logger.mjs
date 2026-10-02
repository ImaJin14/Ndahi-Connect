import { correlation } from "./correlation.mjs";

// Structured JSON application logs (OBS-001). Only allowlisted field names are written,
// and string values that look like personal data or secrets are redacted, so a careless
// call cannot leak PINs, voucher codes, phone numbers, email addresses, or credentials.
const levels = { debug: 10, info: 20, warn: 30, error: 40 };

// Field names that describe operations, outcomes, and opaque identifiers only.
const allowed = new Set([
  "requestId", "correlationId", "method", "route", "status", "durationMs",
  "code", "hint", "errorName", "errorMessage", "reason",
  "host", "port", "node", "commit", "healthPath",
  "operation", "worker", "kind", "action", "provider", "state", "attempts", "count", "counts",
  "customerId", "paymentId", "voucherId", "commandId", "webhookId", "alertId", "adminId",
]);

// Lookarounds keep UUID segments (joined by hyphens) from matching the code and digit patterns.
const sensitive = [
  /[^\s@<>"'()]+@[^\s@<>"'()]+\.[a-z]{2,}/gi, // email address
  /(?<![\w-])\+?\d{9,15}(?![\w-])/g, // phone or account number
  /\bNC-?[0-9A-Z]{4}-?[0-9A-Z]{4}\b/gi, // voucher code
  /(?<![\w-])[0-9A-Z]{4}-[0-9A-Z]{4}(?![\w-])/gi, // recovery code
  /\bbearer\s+\S+/gi,
  /\/\/[^/\s:@]+:[^/\s@]+@/g, // credentials in a URL
  /(?<![\w-])[A-Za-z0-9_]{32,}(?![\w-])/g, // API key or token
];
// Values produced by this codebase rather than by callers or providers; webhook IDs
// embed a SHA-256 digest that would otherwise look like a token.
const structural = new Set(["commit", "webhookId"]);

function safeValue(key, value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    // Redact before truncating so a cut-off secret cannot slip past its pattern.
    let text = value.slice(0, 2000);
    if (!structural.has(key)) for (const pattern of sensitive) text = text.replace(pattern, "[redacted]");
    return text.slice(0, key === "errorMessage" || key === "reason" ? 300 : 120);
  }
  // Plain numeric tallies only, such as retention counts per table.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length <= 50 && entries.every(([k, v]) => /^[A-Za-z_][\w.-]{0,40}$/.test(k) && Number.isFinite(v))) {
      return Object.fromEntries(entries);
    }
  }
  return undefined;
}

export function logRecord({ level, service, event, fields = {}, now = new Date() }) {
  const record = { time: now.toISOString(), level, service, event };
  const dropped = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const safe = allowed.has(key) ? safeValue(key, value) : undefined;
    if (safe === undefined) dropped.push(key);
    else record[key] = safe;
  }
  // Key names are chosen by code, so listing them helps developers fix the call safely.
  if (dropped.length) record.droppedFields = dropped.filter((key) => /^[A-Za-z_]\w{0,40}$/.test(key));
  return record;
}

const defaultWrite = (level, line) => (levels[level] >= levels.warn ? process.stderr : process.stdout).write(`${line}\n`);

export function createLogger({ service, level = "info", write = defaultWrite, now = () => new Date(), bound = {} } = {}) {
  const threshold = levels[level] ?? levels.info;
  const emit = (name) => (event, fields = {}) => {
    if (levels[name] < threshold) return;
    // The current request and operation IDs are attached automatically.
    write(name, JSON.stringify(logRecord({ level: name, service, event, fields: { ...correlation(), ...bound, ...fields }, now: now() })));
  };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: (fields) => createLogger({ service, level, write, now, bound: { ...bound, ...fields } }),
  };
}

// For modules constructed without a logger, such as in unit tests.
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silentLogger };

// Provider and application messages may contain PINs or names that cannot be
// safely recognized by patterns. Log the error class and code only.
export const errorFields = (error) => ({
  errorName: error?.name,
  code: typeof error?.code === "string" ? error.code : undefined,
});
