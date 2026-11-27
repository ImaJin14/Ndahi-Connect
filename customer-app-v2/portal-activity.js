// Redesigned Activity tab (canvas: PhoneActivity, DesktopActivity): bundle
// payments and shop orders in one chronological list, filtered All |
// Internet | Orders. Payment rows keep v1's actions and messages (journeys
// select #billing [data-payment-row]); orders come from the account store
// context and are placed among them by date.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr" : "en-GB");
const douala = (at) => new Date(at).toLocaleDateString("en-CA", { timeZone: "Africa/Douala" });
export const activityDay = (value, { today = false } = {}) => {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "";
  // Phones say "Today" for today's entries (canvas: PhoneActivity).
  if (today && douala(at) === douala(Date.now())) return L("portalActivityToday");
  return new Date(at).toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: "Africa/Douala" });
};
const ICONS = {
  wifi: "M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01",
  shop: "M3 9h18l-2-6H5Zm2 0v12h14V9M9 21v-7h6v7",
  ticket: "M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4Zm12 0v14",
};
// One thing said two ways: the phone board's words and the desktop board's.
const both = (narrow, wide) => (narrow === wide ? h(narrow) : `<span class="nd-narrow-only">${h(narrow)}</span><span class="nd-wide-only">${h(wide)}</span>`);
// The desktop table's last column (canvas: DesktopActivity): Check, Track,
// Receipt or View. It sits inside the row, so it opens what the row opens.
export const activityOpen = (key) => `<span class="portal-activity__open nd-wide-only">${h(L(key))}</span>`;
// How it was paid, as the rows name it: "MTN MoMo", "Orange Money".
const METHODS = { mtn: "MTN MoMo", orange: "Orange Money" };
export const activityMethod = (network) => METHODS[network] || "Mobile Money";
// A payment row's line under its title: "Today · MTN MoMo", and "· Receipt"
// once its receipt is ready (canvas: PhoneActivity).
export const paymentMeta = (payment) => [activityDay(payment.createdAt, { today: true }), payment.provider === "mock" ? payment.methodLabel : activityMethod(payment.network),
  ...(payment.receiptAvailable && (payment.confirmedAt || payment.status === "paid") ? [L("portalActivityReceipt")] : [])].filter(Boolean).join(" · ");

// "Voucher redeemed" rows (owner, 26 Nov): codes on the account that it didn't
// buy with its own Mobile Money payment (those are its "Bundle" rows), dated
// when first used. A store order's free month and a bulk gift from staff were
// never entered, so they aren't listed. They open Internet's vouchers.
export function voucherRows(vouchers, payments) {
  const own = new Set((payments || []).map((p) => p.id));
  return (vouchers || []).filter((v) => v.code && v.activatedAt && !own.has(v.paymentId) && !v.orderId && !v.giftBatchId).map((v) =>
    `<a class="portal-activity__order portal-activity__voucher" data-voucher-row="${h(v.id)}" data-activity-kind="internet" data-activity-at="${h(v.activatedAt)}" href="/dashboard#vouchers">${activityIcon("ticket")}<span class="portal-activity__date nd-wide-only">${h(activityDay(v.activatedAt))}</span><span class="portal-activity__main"><strong>${both(L("portalVoucherRedeemed"), L("portalVoucherRedeemedWide", { code: v.code }))}</strong><span class="nd-meta">${h([activityDay(v.activatedAt, { today: true }), v.code].join(" · "))}</span></span><span class="portal-activity__method nd-wide-only">—</span><span class="portal-activity__amount nd-wide-only">—</span><span class="portal-activity__status"><span class="nd-pill">${h(L("portalVoucherUsed"))}</span></span>${activityOpen("portalActivityView")}</a>`).join("");
}
export const activityIcon = (name) => `<span class="portal-activity__icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[name]}"></path></svg></span>`;
// Payment pills: the word stays lower case in the page (journeys read it) and CSS capitalises it.
const PAY = { paid: "success", pending: "warning", processing: "warning", failed: "danger", "refund-pending": "info" };
// Order pills (canvas): Ready to collect in blue, Collected grey.
const ORDER = { ready: "info", preparing: "warning", awaiting_payment: "warning", review: "danger" };
export const paymentPill = (status) => `<span class="nd-pill portal-activity__pill${PAY[status] ? " nd-pill--" + PAY[status] : ""}">${h(L("portalPay_" + String(status || "").replace(/-/g, "_")) || status)}</span>`;

// The desktop table's headings; the last column, the row's link, has none on screen.
export const activityColumns = () => ["portalColDate", "portalColWhat", "portalColPaidWith", "portalColAmount", "adminColStatus"].map((key) => `<span>${h(L(key))}</span>`).join("") + "<span></span>";

export function activityFilters() {
  return `<div class="nd-segmented portal-activity__filters full" role="group" aria-label="${h(L("portalActivityShow"))}" data-portal-view="payments">${[["all", "portalActivityAll"], ["internet", "portalInternetLabel"], ["orders", "portalActivityOrders"]].map(([id, key], index) => `<button type="button" class="nd-segmented__option" aria-pressed="${index ? "false" : "true"}" data-activity-filter="${id}">${h(L(key))}</button>`).join("")}</div>`;
}

// "1 payment waiting." banner above the list, linking to the waiting payment.
// Tapping the banner opens the first waiting payment (canvas: "tap here to check").
document.addEventListener("click", (event) => {
  const banner = event.target.closest && event.target.closest(".portal-activity__waiting");
  const row = banner && document.querySelector('details[data-payment-row][data-waiting]');
  if (row) row.open = true;
});
export function waitingBanner(payments) {
  const waiting = payments.filter((p) => ["pending", "processing"].includes(p.status));
  if (!waiting.length) return "";
  const one = waiting.length === 1;
  return `<a class="portal-activity__waiting full" data-portal-view="payments" data-activity-kind="internet" href="#billing"><strong>${both(one ? L("portalWaitingOne") : L("portalWaitingMany", { count: waiting.length }), one ? L("portalWaitingOneWide") : L("portalWaitingManyWide", { count: waiting.length }))}</strong> ${both(L("portalWaitingHint"), L("portalWaitingHintWide"))}</a>`;
}

export function mountActivity({ call }) {
  const buttons = document.querySelectorAll("[data-activity-filter]");
  const pick = (value) => {
    document.body.setAttribute("data-activity-filter", value);
    buttons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.activityFilter === value)));
  };
  buttons.forEach((button) => { button.onclick = () => pick(button.dataset.activityFilter); });
  pick("all");
  // Shop orders join the payments in one chronological stream (canvas:
  // PhoneActivity, DesktopActivity: "Order · TP-Link CPE210 · Ready to
  // collect" between bundle payments). Payment rows keep their markup,
  // actions and hooks; #activityOrders only carries the orders' notes. "No
  // orders yet" belongs to the Orders view; "orders could not be loaded" shows
  // in All and Orders so a failed lookup never passes for a complete list.
  const host = document.getElementById("activityOrders"), list = document.querySelector("#billing .portal-activity__list");
  if (!host || !list) return;
  // Payments and redeemed vouchers by date, before the orders arrive.
  sortActivity(list);
  call("/api/account/store/context").then((context) => {
    // A context without an order list (or that does not know this customer)
    // cannot vouch for "no orders": report it as unavailable instead.
    if (!context || context.authenticated === false || !Array.isArray(context.orders)) throw new Error("store context unavailable");
    const orders = context.orders;
    list.querySelectorAll("[data-order-row]").forEach((row) => row.remove());
    host.innerHTML = orders.length ? "" : `<p class="nd-meta portal-activity__empty" data-orders-note="empty">${h(L("portalNoOrders"))}</p>`;
    if (!orders.length) return;
    if (!list.querySelector(".portal-activity__columns")) list.insertAdjacentHTML("afterbegin", `<div class="portal-activity__columns nd-wide-only" aria-hidden="true">${activityColumns()}</div>`);
    const lang = currentLanguage();
    list.insertAdjacentHTML("beforeend", orders.map((o) => {
      const product = o.product && (typeof o.product.name === "object" ? o.product.name[lang] || o.product.name.en : o.product.name);
      const tone = ORDER[o.status];
      const amount = Number.isFinite(Number(o.amount)) ? `${Number(o.amount).toLocaleString()} FCFA` : "—";
      // Date and how it was paid (canvas: "8 Nov · Orange Money").
      const method = o.network ? activityMethod(o.network) : "—";
      // A running payment plan opens "Your payment plan" (owner, 27 Nov, #375).
      const href = o.plan?.status === "running" ? `/dashboard#plan/${encodeURIComponent(o.id)}` : `/dashboard#order/${encodeURIComponent(o.id)}`;
      return `<a class="portal-activity__order" data-order-row="${h(o.id)}" data-activity-kind="orders" data-activity-at="${h(o.createdAt || "")}" href="${href}">${activityIcon("shop")}<span class="portal-activity__date nd-wide-only">${h(activityDay(o.createdAt))}</span><span class="portal-activity__main"><strong>${both(L("portalOrderTitle", { product: product || o.reference }), product ? L("portalOrderTitleWide", { reference: o.reference, product }) : o.reference)}</strong><span class="nd-meta">${h([activityDay(o.createdAt, { today: true }), o.network ? method : o.reference].filter(Boolean).join(" · "))}</span></span><span class="portal-activity__method nd-wide-only">${h(method)}</span><span class="portal-activity__amount nd-wide-only">${h(amount)}</span><span class="portal-activity__status"><span class="nd-pill${tone ? " nd-pill--" + tone : ""}">${h(L("portalOrder_" + o.status) || o.status)}</span></span>${activityOpen(["collected", "cancelled", "expired"].includes(o.status) ? "portalActivityView" : "portalActivityTrack")}</a>`;
    }).join(""));
    sortActivity(list);
  }).catch(() => {
    list.querySelectorAll("[data-order-row]").forEach((row) => row.remove());
    host.innerHTML = `<p class="nd-meta portal-activity__empty portal-activity__unavailable" data-orders-note="unavailable">${h(L("portalOrdersUnavailable"))}</p>`;
  });
}

// Newest first across payments and orders; moving a row keeps its open state.
export function sortActivity(list) {
  const at = (row) => Date.parse(row.dataset.activityAt) || 0;
  const rows = [...list.querySelectorAll(":scope > [data-activity-at]")];
  rows.sort((a, b) => at(b) - at(a)).forEach((row) => list.appendChild(row));
}
