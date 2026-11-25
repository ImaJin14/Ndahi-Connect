// Cash and settlements (canvas: AdminCash; #379). Today, 7 days or Month, in
// Douala time (owner, 25 Nov: the periods replace the fixed "since 1 November"
// total). Every figure comes from the API's report for the period
// (GET /api/admin/cash), and changing the period fetches it again:
// - internet payments, store purchases and completed refunds, on saved gateway
//   confirmations; the reseller cash handed over in the period;
// - Net provider settlements, per network (owner, 25 Nov): confirmed
//   collections, what customers paid (the price plus the fee saved on each
//   payment), the fees, completed refunds, and the net MeSomb should pay into
//   the bank. It is not a completed settlement read from MeSomb (#191).
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { saveFile } from "/payments.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr" : "en-GB");
// Whole FCFA, as drawn.
const amount = (value) => (value == null ? L("adminUnavailable") : `${Math.round(Number(value)).toLocaleString(locale())} FCFA`);
const metric = (value, label) => `<div class="nd-metric"><b class="nd-metric__value">${h(value)}</b><span class="nd-metric__label">${h(label)}</span></div>`;
const PERIODS = [["today", "adminCashToday"], ["week", "adminCash7Days"], ["month", "adminCashMonth"]];
const WORDS = { today: "adminCashWordToday", week: "adminCashWordWeek", month: "adminCashWordMonth" };
const NETWORKS = [["mtn", "MTN MoMo"], ["orange", "Orange Money"]];

// A CSV cell that a spreadsheet will not run as a formula.
const cell = (value) => {
  let text = String(value == null ? "" : value);
  if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
};

export function mountCashCollectedReport(initial, { call } = {}) {
  const root = document.getElementById("cashCollectedReport"), group = document.getElementById("cashPeriods");
  if (!root) return;
  let report = initial || null, period = (initial && initial.period) || "week", request = 0;

  const renderPeriods = () => {
    if (!group) return;
    group.innerHTML = PERIODS.map(([id, key]) => `<button type="button" class="admin-period" data-cash-period="${id}" aria-pressed="${id === period}">${h(L(key))}</button>`).join("");
    group.querySelectorAll("[data-cash-period]").forEach((button) => { button.onclick = () => pick(button.dataset.cashPeriod); });
  };
  const render = () => {
    const words = L(WORDS[period]), available = report && report.status === "available" && report.sources && report.networks;
    const sources = available ? report.sources : null;
    const figures = [
      metric(sources ? amount(sources.internet.collected) : L("adminUnavailable"), L("adminCashInternet", { period: words })),
      metric(sources ? amount(sources.store.collected) : L("adminUnavailable"), L("adminCashStore", { period: words })),
      metric(available ? amount(report.refunded) : L("adminUnavailable"), L("adminCashRefunds", { period: words })),
      metric(report && report.resellerCash ? amount(report.resellerCash.amount) : L("adminUnavailable"), L("adminCashResellers", { period: words })),
    ];
    const heads = ["adminColProvider", "adminColCollected", "adminColBeforeFees", "adminColFees", "adminColSettleRefunds", "adminColNetToSettle"].map((key) => `<th scope="col">${h(L(key))}</th>`).join("");
    // Phones show each row as a card, so every value carries its column name.
    const labels = ["adminColCollected", "adminColBeforeFees", "adminColFees", "adminColSettleRefunds", "adminColNetToSettle"].map((key) => h(L(key)));
    const row = ([id, name]) => {
      const n = report.networks[id];
      return `<tr><td><strong>${h(name)}</strong></td><td data-label="${labels[0]}">${h(n.payments)}</td><td data-label="${labels[1]}">${h(amount(n.cashBeforeFees))}</td><td data-label="${labels[2]}">${h(amount(n.fees))}</td>`
        + `<td data-label="${labels[3]}">${h(n.refunded ? amount(n.refunded) : "—")}</td><td data-label="${labels[4]}"><strong>${h(amount(n.net))}</strong></td></tr>`;
    };
    root.innerHTML = `<div class="nd-metrics admin-cash__metrics">${figures.join("")}</div>
<section class="nd-panel admin-cash__settlements" aria-labelledby="cashReportTitle"><h2 class="nd-h2" id="cashReportTitle">${h(L("adminCashSettlementsTitle"))}</h2>
<p class="admin-cash__lede">${h(L("adminCashSettlementsLede", { period: words }))}</p>
${available ? `<div class="nd-table-wrap"><table class="nd-table admin-cash__table"><thead><tr>${heads}</tr></thead><tbody>${NETWORKS.map(row).join("")}</tbody></table></div>`
  : `<p class="nd-callout nd-callout--warning" role="status">${h(L("adminCashReview"))}</p>`}
<div class="admin-cash__actions">${available ? `<button type="button" class="nd-btn nd-btn--secondary" data-cash-export>${h(L("adminCashExport"))}</button>` : ""}<a class="admin-link admin-cash__link" href="/dashboard#payments">${h(L("adminCashSeePayments"))} →</a></div></section>`;
    const exportButton = root.querySelector("[data-cash-export]");
    if (exportButton) exportButton.onclick = () => {
      // The table as shown, for an accountant: one row per network, with the period.
      const rows = [["provider", "confirmed_collections", "cash_before_fees_xaf", "fees_xaf", "refunds_xaf", "net_to_settle_xaf", "from", "to"]];
      for (const [id] of NETWORKS) { const n = report.networks[id]; rows.push([id, n.payments, n.cashBeforeFees, n.fees, n.refunded, n.net, report.from, report.to]); }
      saveFile(`ndahi-settlements-${period}.csv`, new Blob([rows.map((r) => r.map(cell).join(",")).join("\n")], { type: "text/csv" }));
    };
  };
  // A period change reloads every figure; a slower earlier answer never replaces a later one.
  async function pick(next) {
    if (next === period) return;
    period = next;
    renderPeriods();
    const mine = ++request;
    root.setAttribute("aria-busy", "true");
    try {
      const fresh = await call(`/api/admin/cash?period=${encodeURIComponent(next)}`);
      if (mine === request) report = fresh;
    } catch {
      if (mine === request) report = null;
    } finally {
      if (mine === request) { root.removeAttribute("aria-busy"); render(); }
    }
  }
  renderPeriods();
  render();
}
