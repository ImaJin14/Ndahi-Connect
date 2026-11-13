import { observedWifiDevices, wifiReadingMaxAgeMs } from "./wifi-devices.mjs";
// Server-side filtering and pagination for administrator record lists (PERF-003).
// Pure functions over application state, so they are testable without a server.

export const maxPageSize = 100;
const defaultPageSize = 25;
// Customers filters (redesign AdminCustomers, #256): "Stale after" choices.
export const staleDayChoices = Object.freeze([7, 14, 30, 60, 90]);
export const customerActivityStates = Object.freeze(["active", "stale", "suspended"]);
const dayMs = 86400000;

const safeCustomer = ({
  pendingEmail: _pendingEmail,
  authMigrationPending: _authMigrationPending,
  authMigrationIntent: _authMigrationIntent,
  totpSecret,
  pinHash: _pinHash,
  authMigration: _authMigration,
  wifiMainDevice: _wifiMainDevice,
  recoveryCodes: _recoveryCodes,
  accountBackupCodes: _accountBackupCodes,
  pushSubscriptions: _pushSubscriptions,
  authenticatorRecoveryPermit: _authenticatorRecoveryPermit,
  mfaCompletion: _mfaCompletion,
  mfaProofs: _mfaProofs,
  mfaCheck: _mfaCheck,
  passkeys = [],
  ...customer
}) => ({ ...customer, authenticatorEnrolled: Boolean(totpSecret), passkeys: passkeys.length });

// Lists are returned newest first. Collections that prepend new rows are already
// in that order; the others are appended to and are read in reverse.
export const recordSources = Object.freeze({
  wifiDevices: {
    items: (s, { now }) => observedWifiDevices(s, now),
    search: (d, lookup) => [d.name, d.mac, d.address, d.voucherId, lookup.customerPhone(d.customerId)],
    status: (d) => d.disconnect?.status || (d.fresh ? "connected" : "stale"),
    statuses: ["connected", "stale", "disconnecting", "retrying", "failed"],
    // The device list names the customer; the endpoint drops it for roles without contacts.
    present: (d, lookup) => (lookup ? { ...d, customerName: lookup.customerName(d.customerId) ?? null } : d),
  },
  customers: {
    items: (s) => s.customers.toReversed(),
    search: (c) => [c.name, c.phone, c.email, c.id],
    status: (c) => c.status || "active",
    statuses: ["active", "suspended"],
    // The list adds a summary; called without a lookup it is just the safe customer.
    present: (c, lookup) => ({ ...safeCustomer(c), ...(lookup ? { summary: lookup.customerSummary(c.id), activity: lookup.customerActivity(c.id) } : {}) }),
  },
  vouchers: {
    items: (s) => s.vouchers,
    search: (v, lookup) => [v.code, v.id, v.planId, v.paymentId, lookup.customerPhone(v.customerId)],
    status: (v) => v.status,
    statuses: ["available", "active", "expired", "exhausted", "renewed", "switched", "revoked", "suspended", "refunded"],
    present: (v, lookup) => lookup.voucherView(v),
  },
  payments: {
    items: (s) => s.payments,
    search: (p) => [p.id, p.providerReference, p.payerPhone, p.customerName, p.provider, p.customerId],
    status: (p) => p.status,
    statuses: ["pending", "paid", "failed", "expired", "cancelled", "refund-pending", "refunded"],
    present: ({ requestKey: _requestKey, guestSetup: _guestSetup, ...p }) => p,
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
    // The audit log's type chips filter on the action's area ("voucher.revoked" → "voucher").
    status: (a) => String(a.action || "").split(".")[0],
    statuses: ["admin", "bundle", "configuration", "customer", "device", "home", "integration", "network", "payment", "reseller", "store", "voucher", "wifi_device", "wifi_devices"],
    present: (a) => a,
  },
});

// When a used bundle stopped: quota cut-off, expiry, or for revoked, switched,
// renewed and refunded bundles (which record no stop time) the latest time they
// carry. Never later than now.
function bundleEndedAt(v, now) {
  const at = [v.exhaustedAt, v.expiresAt, v.updatedAt, v.activatedAt, v.createdAt].map(Date.parse).find(Number.isFinite);
  return Number.isFinite(at) ? Math.min(at, +now) : null;
}

// Each customer's activity, derived from voucher history (server task 1):
// active (a bundle now, or one ended within `staleDays`), stale (none for that
// long, or signed up and never bought) or suspended; plus whether a device is
// online now, when the last bundle ended and how many days ago that was.
export function customerActivity(s, { now = new Date(), staleDays = 30 } = {}) {
  const used = new Map(), online = new Set(), seen = new Map();
  // Online and last seen come from the router's device readings, not legacy
  // app sessions (which never establish a Wi-Fi connection): online when a
  // reading is fresh, last seen at the latest reading that listed a device.
  // (The readings themselves, without building each device's full view.)
  for (const v of s.vouchers) {
    if (v.status !== "active" || !v.customerId || !Array.isArray(v.wifiDevices) || !v.wifiDevices.length) continue;
    const at = Date.parse(v.wifiDevicesAt);
    if (!Number.isFinite(at)) continue;
    if (+now - at >= -5000 && +now - at <= wifiReadingMaxAgeMs) online.add(v.customerId);
    if (at > (seen.get(v.customerId) ?? -Infinity)) seen.set(v.customerId, Math.min(at, +now));
  }
  for (const v of s.vouchers) {
    if (!v.customerId || v.status === "available") continue;
    const entry = used.get(v.customerId) || { hasBundle: false, lastEndedAt: null };
    if (v.status === "active") entry.hasBundle = true;
    else {
      const ended = bundleEndedAt(v, now);
      if (ended !== null && (entry.lastEndedAt === null || ended > entry.lastEndedAt)) entry.lastEndedAt = ended;
    }
    used.set(v.customerId, entry);
  }
  const result = new Map();
  for (const c of s.customers) {
    const entry = used.get(c.id), joined = Date.parse(c.createdAt);
    const neverBought = !entry, hasBundle = Boolean(entry?.hasBundle);
    const since = hasBundle ? null : entry?.lastEndedAt ?? (Number.isFinite(joined) ? joined : null);
    const idleDays = since === null ? null : Math.max(0, Math.floor((+now - since) / dayMs));
    const suspended = c.status === "suspended" || c.suspended === true;
    const state = suspended ? "suspended" : neverBought || (!hasBundle && idleDays !== null && idleDays >= staleDays) ? "stale" : "active";
    result.set(c.id, {
      state, online: online.has(c.id), hasBundle, neverBought, idleDays,
      lastEndedAt: entry?.lastEndedAt != null ? new Date(entry.lastEndedAt).toISOString() : null,
      lastSeenAt: online.has(c.id) ? new Date(+now).toISOString() : seen.has(c.id) ? new Date(seen.get(c.id)).toISOString() : null,
      joinedAt: Number.isFinite(joined) ? new Date(joined).toISOString() : null,
    });
  }
  return result;
}

// The customer list's summary (admin Customers screen): the current bundle
// (active first, otherwise the newest), whether a payment is waiting, and how
// many store orders the customer has. Bundle fields come from the caller's
// voucher view, so codes and payment fields follow the caller's access.
function customerSummaries(s) {
  const bundles = new Map(), waiting = new Set(), orders = new Map();
  for (const v of s.vouchers) {
    if (!v.customerId) continue;
    const current = bundles.get(v.customerId);
    // Vouchers are newest first, so the first one seen wins unless a later one is active.
    if (!current || (current.status !== "active" && v.status === "active")) bundles.set(v.customerId, v);
  }
  for (const p of s.payments) if (p.customerId && p.status === "pending") waiting.add(p.customerId);
  for (const o of s.storeOrders || []) if (o.customerId) orders.set(o.customerId, (orders.get(o.customerId) || 0) + 1);
  return { bundles, waiting, orders };
}

function bundleSummary(view) {
  return {
    id: view.id,
    name: view.plan?.name ?? null,
    status: view.status,
    quotaBytes: view.quotaBytes ?? null,
    remainingBytes: view.remainingBytes ?? null,
    // Unlimited bundles show data used, not data left.
    usedBytes: view.usedBytes ?? null,
    expiresAt: view.expiresAt ?? null,
    activeDevices: view.activeDevices ?? 0,
    deviceLimit: view.deviceLimit ?? null,
  };
}

export class RecordQueryError extends Error {}

export function parseRecordQuery(params) {
  const collection = String(params.get("collection") || "");
  if (!Object.hasOwn(recordSources, collection)) throw new RecordQueryError("Unknown record collection.");
  const from = String(params.get("from") || ""), to = String(params.get("to") || "");
  const validDate = (v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
  if ((from || to) && collection !== "vouchers" || !validDate(from) || !validDate(to) || from && to && from > to) throw new RecordQueryError("Choose a valid voucher date range (UTC).");
  const integer = (name, fallback, min, max) => {
    const raw = params.get(name);
    if (raw === null || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new RecordQueryError(`${name} must be an integer from ${min} to ${max}.`);
    }
    return value;
  };
  const activity = String(params.get("activity") || "");
  if (activity && (collection !== "customers" || !customerActivityStates.includes(activity))) throw new RecordQueryError("Choose a customer filter: active, stale or suspended.");
  const staleDays = integer("staleDays", 30, 1, 365);
  if (!staleDayChoices.includes(staleDays)) throw new RecordQueryError(`staleDays must be one of ${staleDayChoices.join(", ")}.`);
  return {
    collection,
    ...(collection === "customers" ? { activity, staleDays } : {}),
    page: integer("page", 1, 1, 1e6),
    pageSize: integer("pageSize", defaultPageSize, 1, maxPageSize),
    q: String(params.get("q") || "").trim().toLowerCase().slice(0, 100),
    status: String(params.get("status") || "").slice(0, 40),
    ...(from || to ? { from, to } : {}),
  };
}

export function queryRecords(s, { collection, page = 1, pageSize = defaultPageSize, q = "", status = "", from = "", to = "", activity = "", staleDays = 30 }, { voucherView, voucherSearch, now = new Date() } = {}) {
  const source = recordSources[collection];
  let phones, names, summaries, activities;
  const lookup = {
    customerPhone(id) {
      phones ??= new Map(s.customers.map((c) => [c.id, c.phone]));
      return phones.get(id);
    },
    customerName(id) {
      names ??= new Map(s.customers.map((c) => [c.id, c.name || ""]));
      return names.get(id);
    },
    voucherView: voucherView || ((v) => v),
    customerSummary(id) {
      summaries ??= customerSummaries(s);
      const voucher = summaries.bundles.get(id);
      return { bundle: voucher ? bundleSummary(lookup.voucherView(voucher)) : null, paymentWaiting: summaries.waiting.has(id), storeOrders: summaries.orders.get(id) || 0 };
    },
    customerActivity(id) {
      activities ??= customerActivity(s, { now, staleDays });
      return activities.get(id) || null;
    },
  };
  let items = source.items(s, { now });
  if (from || to) items = items.filter((v) => {
    const at = v.activatedAt || v.createdAt, date = String(at || "").slice(0, 10);
    return Number.isFinite(Date.parse(at)) && (!from || date >= from) && (!to || date <= to);
  });
  if (status && source.status) items = items.filter((item) => source.status(item) === status);
  if (q) {
    items = items.filter((item) => (collection === "vouchers" && voucherSearch ? voucherSearch(item, lookup) : source.search(item, lookup))
      .some((value) => value != null && String(value).toLowerCase().includes(q)));
  }
  // Customers: a count per activity filter (for its chip), then the chosen one.
  let counts;
  if (collection === "customers") {
    counts = { all: items.length, active: 0, stale: 0, suspended: 0 };
    for (const c of items) counts[lookup.customerActivity(c.id).state]++;
    if (activity) items = items.filter((c) => lookup.customerActivity(c.id).state === activity);
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
    ...(counts ? { counts, staleDays } : {}),
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
