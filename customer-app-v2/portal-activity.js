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
export const activityDay = (value) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: "Africa/Douala" }) : "";
};
const ICONS = {
  wifi: "M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01",
  shop: "M3 9h18l-2-6H5Zm2 0v12h14V9M9 21v-7h6v7",
};
export const activityIcon = (name) => `<span class="portal-activity__icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[name]}"></path></svg></span>`;
// Payment pills: the word stays lower case in the page (journeys read it) and CSS capitalises it.
const PAY = { paid: "success", pending: "warning", processing: "warning", failed: "danger", "refund-pending": "info" };
export const paymentPill = (status) => `<span class="nd-pill portal-activity__pill${PAY[status] ? " nd-pill--" + PAY[status] : ""}">${h(L("portalPay_" + String(status || "").replace(/-/g, "_")) || status)}</span>`;

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
  return `<a class="portal-activity__waiting full" data-portal-view="payments" data-activity-kind="internet" href="#billing"><strong>${h(waiting.length === 1 ? L("portalWaitingOne") : L("portalWaitingMany", { count: waiting.length }))}</strong> ${h(L("portalWaitingHint"))}</a>`;
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
  // actions and hooks; #activityOrders only carries the orders' empty or
  // unavailable note, so the Orders filter still says something.
  const host = document.getElementById("activityOrders"), list = document.querySelector("#billing .portal-activity__list");
  if (!host || !list) return;
  call("/api/account/store/context").then((context) => {
    const orders = (context && context.orders) || [];
    list.querySelectorAll("[data-order-row]").forEach((row) => row.remove());
    host.innerHTML = orders.length ? "" : `<p class="nd-meta portal-activity__empty">${h(L("portalNoOrders"))}</p>`;
    if (!orders.length) return;
    if (!list.querySelector(".portal-activity__columns")) list.insertAdjacentHTML("afterbegin", `<div class="portal-activity__columns nd-wide-only" aria-hidden="true">${["portalColDate", "portalColWhat", "portalColPaidWith", "portalColAmount", "adminColStatus"].map((key) => `<span>${h(L(key))}</span>`).join("")}</div>`);
    const lang = currentLanguage();
    list.insertAdjacentHTML("beforeend", orders.map((o) => {
      const product = o.product && (typeof o.product.name === "object" ? o.product.name[lang] || o.product.name.en : o.product.name);
      const tone = { ready: "info", collected: "", preparing: "warning", awaiting_payment: "warning", review: "danger" }[o.status];
      const amount = Number.isFinite(Number(o.amount)) ? `${Number(o.amount).toLocaleString()} FCFA` : "—";
      // Orders don't record how they were paid, so that column says "—".
      return `<a class="portal-activity__order" data-order-row="${h(o.id)}" data-activity-kind="orders" data-activity-at="${h(o.createdAt || "")}" href="/dashboard#order/${encodeURIComponent(o.id)}">${activityIcon("shop")}<span class="portal-activity__date nd-wide-only">${h(activityDay(o.createdAt))}</span><span class="portal-activity__main"><strong>${h(L("portalOrderTitle", { product: product || o.reference }))}</strong><span class="nd-meta">${h([activityDay(o.createdAt), o.reference].filter(Boolean).join(" · "))}</span></span><span class="portal-activity__method nd-wide-only">—</span><span class="portal-activity__amount nd-wide-only">${h(amount)}</span><span class="portal-activity__status"><span class="nd-pill${tone ? " nd-pill--" + tone : ""}">${h(L("portalOrder_" + o.status) || o.status)}</span></span></a>`;
    }).join(""));
    sortActivity(list);
  }).catch(() => { host.innerHTML = `<p class="nd-meta portal-activity__empty">${h(L("portalOrdersUnavailable"))}</p>`; });
}

// Newest first across payments and orders; moving a row keeps its open state.
export function sortActivity(list) {
  const at = (row) => Date.parse(row.dataset.activityAt) || 0;
  const rows = [...list.querySelectorAll(":scope > [data-activity-at]")];
  rows.sort((a, b) => at(b) - at(a)).forEach((row) => list.appendChild(row));
}
