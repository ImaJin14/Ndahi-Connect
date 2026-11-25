// Redesigned Payments screen (canvas: AdminPayments; #386) and the payment
// wording the admin Home shares with it. The figures come from the dashboard
// (today's takings on the cash report's basis, and the payments list's counts)
// and the list from the records collection allPayments: bundle payments, store
// orders and reseller cash handoffs (#377). Nothing here is estimated.
// Owner decision (25 Nov, #386): the refund actions, the provider reference,
// paging, "Check with provider" on failed and expired rows, and the Provider
// checks section stay, though the canvas leaves them out.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { mountRecords } from "/records.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr" : "en-GB");
// "Today" is the business day in Africa/Douala (UTC+01, no daylight saving).
const DAY = 86400000, DOUALA = 3600000, ZONE = "Africa/Douala";
export const startOfToday = (now = Date.now()) => Math.floor((now + DOUALA) / DAY) * DAY - DOUALA;

export const fcfa = (amount) => `${Number(amount || 0).toLocaleString(locale())} FCFA`;
export const maskPhone = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "").slice(-9);
  return digits.length === 9 ? `${digits[0]}•• •• ${digits.slice(5, 7)} ${digits.slice(7)}` : "—";
};
const METHODS = { mtn: "MTN MoMo", orange: "Orange Money" };
export const paymentMethod = (p) => p.methodLabel || METHODS[p.network] || METHODS[p.provider] || (p.provider === "mock" ? L("adminMethodTest") : "Mobile Money");
export const paymentFor = (p) => {
  const plan = (p.planSnapshot && p.planSnapshot.name) || (p.plan && p.plan.name);
  return plan ? L("adminForBundle", { plan }) : L("adminForPayment");
};
// Status pills, toned as on the canvas: waiting orange, paid green, failed red.
const STATUS = {
  paid: ["adminStatusPaid", "success"],
  pending: ["adminStatusWaiting", "warning"],
  processing: ["adminStatusWaiting", "warning"],
  failed: ["adminStatusFailed", "danger"],
  expired: ["adminStatusExpired", ""],
  cancelled: ["adminStatusCancelled", ""],
  "refund-pending": ["adminStatusRefundPending", "info"],
  refunded: ["adminStatusRefunded", ""],
  // A reseller's cash handoff (#377), green on Home as drawn.
  recorded: ["adminStatusRecorded", "success"],
};
export const paymentStatus = (p) => {
  const [key, tone] = STATUS[p.status] || ["adminStatusFailed", "danger"];
  return `<span class="nd-pill${tone ? " nd-pill--" + tone : ""}">${h(L(key))}</span>`;
};

function when(value) {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "—";
  const time = new Date(at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", timeZone: ZONE });
  if (at >= startOfToday()) return time;
  return new Date(at).toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: ZONE }) + ", " + time;
}

// The four figures above the list: today's bundle and store takings, payments
// waiting over 10 minutes and payments that failed today, all from the dashboard.
export function showPaymentFigures(x, { storeRole }) {
  const show = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const unavailable = L("adminUnavailable"), takings = (x.metrics && x.metrics.takingsToday) || {}, counts = x.payments || {};
  show("paymentsTodayBundles", takings.bundles == null ? unavailable : fcfa(takings.bundles));
  if (storeRole) show("paymentsTodayStore", takings.store == null ? unavailable : fcfa(takings.store));
  show("paymentsWaiting", counts.waitingOverTen == null ? unavailable : String(counts.waitingOverTen));
  show("paymentsFailedToday", counts.failedToday == null ? unavailable : String(counts.failedToday));
}

// "Export CSV": the API's report (payments, then vouchers), saved as a file.
export async function downloadPaymentsExport(api) {
  const response = await fetch(api + "/api/admin/export", { credentials: "include" });
  if (!response.ok) throw Error(L("adminExportFailed"));
  saveFile("ndahi-report.csv", await response.blob());
}

export function saveFile(name, blob) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

// "All payments": search, status chips and every kind of payment. Bundle rows
// keep the provider actions from v1 (refund approval, refund status, provider
// check); a store order not yet confirmed can be checked with the provider
// too, through the store's own order check. The dashboard's delegated click
// handler runs them.
const who = (p) => (p.kind === "cash" ? L("adminWhoReseller", { name: p.resellerName || "" })
  : p.kind === "order" && p.guest ? L("adminWhoGuest", { phone: maskPhone(p.payerPhone) }) : maskPhone(p.payerPhone));
const what = (p) => (p.kind === "cash" ? L("adminForCashHandoff") : p.kind === "order" ? L("adminForOrderRef", { reference: p.orderReference || "" }) : paymentFor(p));
const UNCONFIRMED = ["pending", "processing", "failed", "expired", "cancelled"];
function actions(p, canManagePayments) {
  if (!canManagePayments || p.kind === "cash") return "";
  if (p.kind === "order") return p.provider !== "mock" && !p.confirmedAt && !p.refund && UNCONFIRMED.includes(p.status) && Number.isInteger(p.orderVersion)
    ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-verify-order="${h(p.orderId)}" data-order-version="${h(p.orderVersion)}">${h(L("adminCheckProvider"))}</button>` : "";
  return [
    p.status === "paid" && (!p.refund || p.refund.status === "requested") ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--quiet" data-refund="${h(p.id)}">${h(L("adminApproveRefund"))}</button>` : "",
    ["paid", "refund-pending"].includes(p.status) && p.refund && p.refund.status === "pending" ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-check-refund="${h(p.id)}">${h(L("adminCheckRefund"))}</button>` : "",
    p.provider !== "mock" && !p.confirmedAt && !p.refund && UNCONFIRMED.includes(p.status) ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-verify-payment="${h(p.id)}">${h(L("adminCheckProvider"))}</button>` : "",
  ].filter(Boolean).join("");
}
// Recorded cash is the kit's neutral grey here, as drawn (green on Home).
const status = (p) => (p.kind === "cash" ? `<span class="nd-pill">${h(L("adminStatusRecorded"))}</span>` : paymentStatus(p));
export function mountPaymentRecords(container, { call, canManagePayments }) {
  return mountRecords(container, {
    call,
    collection: "allPayments",
    title: L("adminAllPayments"),
    headers: [L("adminColWhen"), L("adminColCustomer"), L("adminColFor"), L("adminColMethod"), L("adminColAmount"), L("adminColStatus"), { label: L("adminColAction") }],
    empty: L("adminPaymentsNone"),
    kit: {
      titleId: "paymentRecordsTitle",
      searchLabel: L("adminPaymentsSearch"),
      placeholder: L("adminPaymentsPlaceholder"),
      chipsLabel: L("adminColStatus"),
      chips: [["", L("adminFilterAll")], ["waiting", L("adminStatusWaiting")], ["paid", L("adminStatusPaid")], ["failed", L("adminStatusFailed")]],
      previous: L("adminPagePrevious"),
      next: L("adminPageNext"),
      text: {
        loading: L("adminLoading"),
        failed: L("adminPaymentsFailedToLoad"),
        retry: L("adminTryAgain"),
        none: L("adminPaymentsNone"),
        summary: (page, pages, total) => L("adminPageSummary", { page, pages, total }),
      },
    },
    row: (p) => {
      const refund = p.kind === "bundle" && p.refund ? `<span class="admin-cell__sub">${h(L("adminRefundLine", { status: p.refund.status }))}${[p.refund.message, p.refund.reason, p.refund.providerReference].filter(Boolean).map((line) => `<br>${h(line)}`).join("")}</span>` : "";
      const reference = p.kind !== "cash" && p.providerReference ? `<span class="admin-cell__sub admin-cell__ref" title="${h(p.providerReference)}">${h(p.providerReference)}</span>` : "";
      const method = p.kind === "cash" ? L("adminMethodCash") : paymentMethod(p);
      return `<tr><td>${h(when(p.createdAt))}</td><td>${h(who(p))}</td><td>${h(what(p))}${reference}</td><td>${h(method)}</td><td>${h(fcfa(p.amount))}</td><td>${status(p)}${refund}</td><td><div class="admin-actions">${actions(p, canManagePayments)}</div></td></tr>`;
    },
  });
}
