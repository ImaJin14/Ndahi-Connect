import { observedWifiDevices } from "./wifi-devices.mjs";
// Server-side filtering and pagination for administrator record lists (PERF-003).
// Pure functions over application state, so they are testable without a server.

export const maxPageSize = 100;
const defaultPageSize = 25;

const safeCustomer = ({
  pendingEmail: _pendingEmail,
  totpSecret,
  pinHash: _pinHash,
  recoveryCodes: _recoveryCodes,
          accountBackupCodes: _accountBackupCodes,
  pushSubscriptions: _pushSubscriptions,
  passkeys = [],
  ...customer
}) => ({ ...customer, authenticatorEnrolled: Boolean(totpSecret), passkeys: passkeys.length });

// Lists are returned newest first. Collections that prepend new rows are already
// in that order; the others are appended to and are read in reverse.
export const recordSources = Object.freeze({
  wifiDevices: {
    items: (s, { now }) => observedWifiDevices(s, now),
    search: (d, lookup) => [d.mac, d.address, d.voucherId, lookup.customerPhone(d.customerId)],
    status: (d) => d.disconnect?.status || (d.fresh ? "connected" : "stale"),
    statuses: ["connected", "stale", "disconnecting", "retrying", "failed"],
    present: (d) => d,
  },
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

export function queryRecords(s, { collection, page = 1, pageSize = defaultPageSize, q = "", status = "" }, { voucherView, now = new Date() } = {}) {
  const source = recordSources[collection];
  let phones;
  const lookup = {
    customerPhone(id) {
      phones ??= new Map(s.customers.map((c) => [c.id, c.phone]));
      return phones.get(id);
    },
    voucherView: voucherView || ((v) => v),
  };
  let items = source.items(s, { now });
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
export function dashboardTotals(s, { live = false, now = new Date() } = {}) {
  const vouchers = { active: 0, expired: 0, exhausted: 0 };
  const byPlan = new Map();
  for (const v of s.vouchers) {
    if (Object.hasOwn(vouchers, v.status)) vouchers[v.status]++;
    byPlan.set(v.planId, (byPlan.get(v.planId) || 0) + 1);
  }
  // Revenue is every bundle actually sold: settled online payments plus
  // admin-generated vouchers sold offline, counted once activated (resale
  // codes when a customer claims them) and dropped if revoked. Gifts are
  // tracked by count and face value only.
  const sales = {
    online: { bundles: 0, amount: 0 }, vouchers: { bundles: 0, amount: 0 },
    gifts: { bundles: 0, faceValue: 0 }, unclassified: { bundles: 0 },
  };
  for (const p of s.payments) if (p.status === "paid") { sales.online.bundles++; sales.online.amount += p.amount; }
  for (const v of s.vouchers) {
    if (v.paymentId || !v.generatedByAdmin) continue;
    if (!["sold", "gift"].includes(v.saleType)) { sales.unclassified.bundles++; continue; }
    if (!v.activatedAt || v.status === "revoked") continue;
    if (v.saleType === "sold") { sales.vouchers.bundles++; sales.vouchers.amount += v.saleAmount || 0; }
    else { sales.gifts.bundles++; sales.gifts.faceValue += v.faceValue || 0; }
  }
  let activeSessions = 0;
  if (live) activeSessions = observedWifiDevices(s, now).filter((d) => d.fresh).length;
  else for (const x of s.sessions) if (x.status === "online") activeSessions++;
  return { vouchers, byPlan, revenue: sales.online.amount + sales.vouchers.amount, sales, activeSessions };
}
