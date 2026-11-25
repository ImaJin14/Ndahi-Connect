// Every payment an admin follows, in one list (canvas: AdminPayments "All
// payments" and Admin "Latest payments"; #377, #386): bundle payments,
// store-order payments and resellers' cash handoffs, newest first. A handoff's
// "For" reads "Cash handoff" (owner, 25 Nov, on #377 and #386).
//
// `group` is the status chip a row falls under: waiting, paid (with recorded
// cash, as drawn) or failed (with expired and cancelled); refunds appear under
// All only. Phone numbers stay whole: the records API serves this list to
// owners and operators only, and the screens mask them.
const GROUPS = Object.freeze({ pending: "waiting", processing: "waiting", paid: "paid", recorded: "paid", failed: "failed", expired: "failed", cancelled: "failed" });
export const PAYMENT_GROUPS = Object.freeze(["waiting", "paid", "failed"]);
const DAY = 86400000, DOUALA = 3600000; // Africa/Douala is UTC+01, without daylight saving.
const time = (row) => Date.parse(row.createdAt) || 0;

// Midnight in Douala at the start of `now`'s day.
export const doualaDayStart = (now = new Date()) => new Date(Math.floor((+now + DOUALA) / DAY) * DAY - DOUALA);

export function paymentFeed(s) {
  const rows = [];
  for (const p of s.payments || []) {
    const { requestKey: _key, guestSetup: _setup, ...payment } = p;
    rows.push({ ...payment, kind: "bundle", group: GROUPS[p.status] || "other" });
  }
  for (const o of s.storeOrders || []) {
    const p = o.payment;
    if (!p) continue;
    rows.push({
      kind: "order", id: p.id, orderId: o.id, orderReference: o.reference || null, product: o.product?.name ?? null, quantity: o.quantity,
      guest: !o.customerId, payerPhone: p.payerPhone || o.contact?.phone || null, network: p.network || null, provider: p.provider,
      amount: p.amount, currency: p.currency || "XAF", status: p.status, group: GROUPS[p.status] || "other",
      providerReference: p.providerReference || null, confirmedAt: p.confirmedAt || null, createdAt: p.createdAt || o.createdAt,
      ...(p.refund ? { refund: { status: p.refund.status } } : {}),
    });
  }
  for (const u of s.adminUsers || []) for (const r of u.remittances || []) {
    if (!r || !Number.isFinite(r.amount)) continue;
    rows.push({ kind: "cash", id: r.id, resellerId: u.id, resellerName: u.displayName || u.username || r.resellerName || null,
      amount: r.amount, currency: "XAF", status: "recorded", group: "paid", createdAt: r.createdAt, recordedBy: r.recordedBy || null });
  }
  return rows.sort((a, b) => time(b) - time(a));
}

// What the search box matches: phone, order or reference (as drawn), plus the
// payment id and the reseller's name.
export const paymentFeedSearch = (row) => [row.id, row.providerReference, row.payerPhone, row.orderReference, row.resellerName];

// Payments waiting more than ten minutes, and payments that failed today.
export function paymentCounts(rows, now = new Date()) {
  const stale = +now - 10 * 60000, today = +doualaDayStart(now);
  let waitingOverTen = 0, failedToday = 0;
  for (const row of rows) {
    if (row.group === "waiting" && time(row) < stale) waitingOverTen++;
    if (row.group === "failed" && time(row) >= today) failedToday++;
  }
  return { waitingOverTen, failedToday };
}

// Bundles sold since midnight in Douala: bundle payments confirmed today (test
// payments aside) and the admin's sold voucher codes once a customer started
// them, as the dashboard counts sales. Gifts are not sales.
export function bundlesSoldToday(s, now = new Date()) {
  const today = +doualaDayStart(now), on = (value) => { const at = Date.parse(value); return Number.isFinite(at) && at >= today && at <= +now; };
  let count = 0;
  for (const p of s.payments || []) if (p.status === "paid" && p.provider !== "mock" && on(p.confirmedAt || p.createdAt)) count++;
  for (const v of s.vouchers || []) if (!v.paymentId && v.generatedByAdmin && v.saleType === "sold" && v.status !== "revoked" && on(v.activatedAt)) count++;
  return count;
}
