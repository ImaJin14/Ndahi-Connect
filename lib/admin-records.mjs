// Server-side filtering and pagination for administrator record lists (PERF-003).
// Pure functions over application state, so they are testable without a server.

export const maxPageSize = 100;
const defaultPageSize = 25;

const safeCustomer = ({
  totpSecret,
  pinHash: _pinHash,
  recoveryCodes: _recoveryCodes,
  passkeys = [],
  ...customer
}) => ({ ...customer, authenticatorEnrolled: Boolean(totpSecret), passkeys: passkeys.length });

// Lists are returned newest first. Collections that prepend new rows are already
// in that order; the others are appended to and are read in reverse.
export const recordSources = Object.freeze({
  customers: {
    items: (s) => s.customers.toReversed(),
    search: (c) => [c.name, c.phone, c.email, c.id],
    status: (c) => c.status || "active",
    statuses: ["active", "suspended"],
    present: (c) => safeCustomer(c),
  },
  vouchers: {
    items: (s) => s.vouchers,
    search: (v, lookup) => [v.code, v.id, v.planId, v.paymentId, lookup.customerPhone(v.customerId)],
    status: (v) => v.status,
    statuses: ["available", "active", "expired", "exhausted", "revoked", "suspended", "refunded"],
    present: (v, lookup) => lookup.voucherView(v),
  },
  payments: {
    items: (s) => s.payments,
    search: (p) => [p.id, p.providerReference, p.payerPhone, p.customerName, p.provider],
    status: (p) => p.status,
    statuses: ["pending", "paid", "failed", "expired", "cancelled", "refund-pending", "refunded"],
    present: (p) => p,
  },
  sessions: {
    items: (s) => s.sessions.toReversed(),
    search: (x) => [x.label, x.deviceId, x.voucherId],
    status: (x) => x.status,
    statuses: ["online", "inactive", "disconnected"],
    present: (x) => x,
  },
  events: {
    items: (s) => s.events,
    search: (e) => [e.type, JSON.stringify(e.meta ?? "")],
    present: (e) => e,
  },
  security: {
    items: (s) => s.securityEvents,
    search: (e) => [e.type, e.ip],
    present: (e) => e,
  },
  audit: {
    items: (s) => s.auditLogs,
    search: (a) => [a.action, a.actor, a.ip],
    present: (a) => a,
  },
});

export class RecordQueryError extends Error {}

export function parseRecordQuery(params) {
  const collection = String(params.get("collection") || "");
  if (!Object.hasOwn(recordSources, collection)) throw new RecordQueryError("Unknown record collection.");
  const integer = (name, fallback, min, max) => {
    const raw = params.get(name);
    if (raw === null || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new RecordQueryError(`${name} must be an integer from ${min} to ${max}.`);
    }
    return value;
  };
  return {
    collection,
    page: integer("page", 1, 1, 1e6),
    pageSize: integer("pageSize", defaultPageSize, 1, maxPageSize),
    q: String(params.get("q") || "").trim().toLowerCase().slice(0, 100),
    status: String(params.get("status") || "").slice(0, 40),
  };
}

export function queryRecords(s, { collection, page = 1, pageSize = defaultPageSize, q = "", status = "" }, { voucherView } = {}) {
  const source = recordSources[collection];
  let phones;
  const lookup = {
    customerPhone(id) {
      phones ??= new Map(s.customers.map((c) => [c.id, c.phone]));
      return phones.get(id);
    },
    voucherView: voucherView || ((v) => v),
  };
  let items = source.items(s);
  if (status && source.status) items = items.filter((item) => source.status(item) === status);
  if (q) {
    items = items.filter((item) => source.search(item, lookup)
      .some((value) => value != null && String(value).toLowerCase().includes(q)));
  }
  const total = items.length, pages = Math.max(1, Math.ceil(total / pageSize)), current = Math.min(page, pages);
  return {
    collection,
    items: items.slice((current - 1) * pageSize, current * pageSize).map((item) => source.present(item, lookup)),
    total,
    page: current,
    pageSize,
    pages,
    statuses: source.statuses || [],
  };
}

// Dashboard counters computed in one pass instead of one scan per metric.
export function dashboardTotals(s) {
  const vouchers = { active: 0, expired: 0, exhausted: 0 };
  const byPlan = new Map();
  for (const v of s.vouchers) {
    if (Object.hasOwn(vouchers, v.status)) vouchers[v.status]++;
    byPlan.set(v.planId, (byPlan.get(v.planId) || 0) + 1);
  }
  let revenue = 0;
  for (const p of s.payments) if (p.status === "paid") revenue += p.amount;
  let activeSessions = 0;
  for (const x of s.sessions) if (x.status === "online") activeSessions++;
  return { vouchers, byPlan, revenue, activeSessions };
}
