// Admin home (canvas: Admin; #377): five figures, Needs attention and Latest
// payments. Every figure and row comes from the API:
// - the dashboard's metrics (devices online, bundles sold and revenue today on
//   the cash report's basis, router uptime over 7 days) and its count of
//   payments waiting over ten minutes;
// - the store's orders to prepare and low stock;
// - the payments list (records collection allPayments): bundle payments, store
//   orders and reseller cash handoffs, newest first.
// Owner decision (25 Nov, #377): Needs attention also raises the operational
// alerts (payment notifications, payment checks, router commands, network
// checks), and says so when nothing needs attention.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { setAdminBadges } from "/navigation.js";
import { fcfa, maskPhone, paymentFor, paymentMethod, paymentStatus } from "/payments.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const $ = (selector) => document.querySelector(selector);
const percent = (value) => new Intl.NumberFormat(currentLanguage() === "fr" ? "fr-FR" : "en-GB", { style: "percent", maximumFractionDigits: 1 }).format(value / 100);
const named = (name) => (name && typeof name === "object" ? name[currentLanguage()] || name.en || "" : name || "");

// The five figures, in the canvas's order. Takings need the payments role.
export function homeMetricsMarkup(x, { contacts, storeRole }) {
  const m = x.metrics || {}, unavailable = L("adminUnavailable");
  const figures = [
    [m.activeSessions == null ? unavailable : String(m.activeSessions), L("adminMetricDevicesOnline"), "activeSessionsMetric"],
    [contacts && m.bundlesSoldToday != null ? String(m.bundlesSoldToday) : unavailable, L("adminMetricBundlesSoldToday"), "bundlesSoldTodayMetric"],
    [contacts && m.revenueToday != null ? fcfa(m.revenueToday) : unavailable, L("adminMetricRevenueToday"), "revenueTodayMetric"],
    storeRole ? ["…", L("adminMetricOrdersToPrepare"), "homeOrdersMetric"] : null,
    // No checks recorded yet: no figure rather than a made-up one.
    [m.routerUptime?.percent == null ? "—" : percent(m.routerUptime.percent), L("adminMetricRouterUptime"), "routerUptimeMetric"],
  ];
  return figures.filter(Boolean).map(([value, label, id]) =>
    `<div class="nd-metric"><b class="nd-metric__value"${id ? ` id="${id}"` : ""}>${h(value)}</b><span class="nd-metric__label">${h(label)}</span></div>`).join("");
}

// Needs attention: real signals only, each linking to where it is handled.
export async function loadHomeAttention(x, storeSnapshot, contacts) {
  const host = $("#homeAttention");
  if (!host) return;
  // Tones follow the canvas: waiting money orange, orders blue, stock neutral; failures red.
  const items = [], item = (href, text, tone) => items.push(`<a class="admin-attention admin-attention--${tone}" href="${href}">${h(text)}<span aria-hidden="true">→</span></a>`);
  const late = contacts ? x.payments?.waitingOverTen || 0 : 0;
  if (late) item("/dashboard#payments", late === 1 ? L("adminAttentionPaymentsOne") : L("adminAttentionPayments", { count: late }), "warning");
  const badges = { payments: late }, store = await storeSnapshot;
  if (store) {
    const preparing = store.orders.filter((o) => o.status === "preparing").length;
    const orders = $("#homeOrdersMetric");
    if (orders) orders.textContent = String(preparing);
    badges.store = preparing;
    if (preparing) item("/dashboard#store", preparing === 1 ? L("adminAttentionOrdersOne") : L("adminAttentionOrders", { count: preparing }), "info");
    store.products.filter((p) => p.status === "published" && p.available <= 3)
      .forEach((p) => item("/dashboard#products", L("adminAttentionStock", { name: named(p.name), count: p.available }), "neutral"));
  } else if ($("#homeOrdersMetric")) $("#homeOrdersMetric").textContent = L("adminUnavailable");
  if (x.paymentWebhooks?.deadLetters) item("/dashboard#payments", L("adminAttentionWebhooks", { count: x.paymentWebhooks.deadLetters }), "danger");
  if (x.paymentReconciliation?.issues?.length) item("/dashboard#payments", L("adminAttentionPaymentChecks", { count: x.paymentReconciliation.issues.length }), "warning");
  if (x.networkCommands?.deadLetters) item("/dashboard#connections", L("adminAttentionCommands", { count: x.networkCommands.deadLetters }), "danger");
  if (x.networkReconciliation?.issues?.length) item("/dashboard#connections", L("adminAttentionNetworkChecks", { count: x.networkReconciliation.issues.length }), "warning");
  // Side menu counts, as on the canvas: payments waiting, orders to prepare.
  setAdminBadges(badges);
  host.innerHTML = items.length ? items.join("") : `<p class="nd-meta">${h(L(contacts ? "adminAttentionNone" : "adminUnavailable"))}</p>`;
}

// One row of Latest payments: who paid, for what, how, and where it stands.
function paymentRow(p) {
  const cash = p.kind === "cash";
  const who = cash ? L("adminWhoReseller", { name: p.resellerName || "" }) : maskPhone(p.payerPhone);
  const what = cash ? L("adminForCashHandoff") : p.kind === "order" ? L("adminForOrderItem", { name: named(p.product) }) : paymentFor(p);
  return `<tr><td>${h(who)}</td><td>${h(what)}</td><td>${h(cash ? L("adminMethodCash") : paymentMethod(p))}</td><td>${paymentStatus(p)}</td></tr>`;
}

// Latest payments: the newest four of every kind.
export async function loadHomePayments(call) {
  const host = $("#homePayments");
  if (!host) return;
  const result = await call("/api/admin/records?collection=allPayments&pageSize=4").catch(() => null);
  if (!result) { host.closest("section").hidden = true; return; }
  const heads = ["adminColCustomer", "adminColFor", "adminColMethod", "adminColStatus"].map((key) => `<th scope="col">${h(L(key))}</th>`).join("");
  host.innerHTML = result.items.length
    ? `<table class="nd-table admin-home__table"><thead><tr>${heads}</tr></thead><tbody>${result.items.map(paymentRow).join("")}</tbody></table>`
    : `<p class="nd-meta">${h(L("adminNoPayments"))}</p>`;
}
