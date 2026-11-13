// Redesigned Payments screen (canvas: AdminPayments) and the payment wording
// the admin Home shares with it. Figures come from the records API and the
// store snapshot; nothing here is estimated.
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

// Every payment of one status created since `stop`, newest first. Returns null
// rather than a partial list when there are more than 1,000 of them.
async function paymentsSince(call, status, stop) {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const result = await call(`/api/admin/records?${new URLSearchParams({ collection: "payments", status, page, pageSize: 100 })}`);
    items.push(...result.items);
    const last = result.items[result.items.length - 1];
    if (page >= result.pages || !last || Date.parse(last.createdAt) < stop) return items;
  }
  return null;
}

// The four figures above the list: today's bundle and store takings, payments
// waiting over 10 minutes and payments that failed today.
export async function loadPaymentFigures({ call, storeRole, storeSnapshot }) {
  const today = startOfToday(), show = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const unavailable = L("adminUnavailable");
  const [paid, pending, failed, store] = await Promise.all([
    // A payment started late yesterday can be confirmed today, so read one day further back.
    paymentsSince(call, "paid", today - DAY).catch(() => null),
    paymentsSince(call, "pending", -Infinity).catch(() => null),
    paymentsSince(call, "failed", today).catch(() => null),
    storeSnapshot,
  ]);
  show("paymentsTodayBundles", paid ? fcfa(paid.filter((p) => Date.parse(p.confirmedAt || p.createdAt) >= today).reduce((sum, p) => sum + Number(p.amount || 0), 0)) : unavailable);
  if (storeRole) show("paymentsTodayStore", store ? fcfa(store.orders.filter((o) => o.paymentStatus === "paid" && Date.parse(o.createdAt) >= today).reduce((sum, o) => sum + Number(o.amount || 0), 0)) : unavailable);
  show("paymentsWaiting", pending ? String(pending.filter((p) => Date.now() - Date.parse(p.createdAt) > 10 * 60000).length) : unavailable);
  show("paymentsFailedToday", failed ? String(failed.filter((p) => Date.parse(p.createdAt) >= today).length) : unavailable);
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

// "All payments": search, status chips and the provider actions from v1
// (refund approval, refund status, provider check), which the dashboard's
// delegated click handler runs.
export function mountPaymentRecords(container, { call, canManagePayments }) {
  return mountRecords(container, {
    call,
    collection: "payments",
    title: L("adminAllPayments"),
    headers: [L("adminColWhen"), L("adminColCustomer"), L("adminColFor"), L("adminColMethod"), L("adminColAmount"), L("adminColStatus"), { label: L("adminColAction") }],
    empty: L("adminPaymentsNone"),
    kit: {
      titleId: "paymentRecordsTitle",
      searchLabel: L("adminPaymentsSearch"),
      placeholder: L("adminPaymentsPlaceholder"),
      chipsLabel: L("adminColStatus"),
      chips: [["", L("adminFilterAll")], ["pending", L("adminStatusWaiting")], ["paid", L("adminStatusPaid")], ["failed", L("adminStatusFailed")]],
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
      const refund = p.refund ? `<span class="admin-cell__sub">${h(L("adminRefundLine", { status: p.refund.status }))}${[p.refund.message, p.refund.reason, p.refund.providerReference].filter(Boolean).map((line) => `<br>${h(line)}`).join("")}</span>` : "";
      const actions = [
        p.status === "paid" && (!p.refund || p.refund.status === "requested") && canManagePayments ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--quiet" data-refund="${h(p.id)}">${h(L("adminApproveRefund"))}</button>` : "",
        ["paid", "refund-pending"].includes(p.status) && p.refund && p.refund.status === "pending" && canManagePayments ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-check-refund="${h(p.id)}">${h(L("adminCheckRefund"))}</button>` : "",
        canManagePayments && p.provider !== "mock" && !p.confirmedAt && !p.refund && ["pending", "processing", "failed", "expired", "cancelled"].includes(p.status) ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-verify-payment="${h(p.id)}">${h(L("adminCheckProvider"))}</button>` : "",
      ].filter(Boolean).join("");
      return `<tr><td>${h(when(p.createdAt))}</td><td>${h(maskPhone(p.payerPhone))}</td><td>${h(paymentFor(p))}${p.providerReference ? `<span class="admin-cell__sub admin-cell__ref" title="${h(p.providerReference)}">${h(p.providerReference)}</span>` : ""}</td><td>${h(paymentMethod(p))}</td><td>${h(fcfa(p.amount))}</td><td>${paymentStatus(p)}${refund}</td><td><div class="admin-actions">${actions}</div></td></tr>`;
    },
  });
}
