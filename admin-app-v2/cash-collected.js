// Redesigned Cash screen (canvas: AdminCash): cash collected before fees from
// the API's fixed reporting period, by source, plus reseller cash handed over.
// Provider settlements (net of fees) are not recorded yet, so this screen has
// no settlement table and no period switch; the period is the report's own.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { saveFile } from "/payments.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr" : "en-GB");
const ZONE = "Africa/Douala";
const amount = (value) => (value == null ? L("adminUnavailable") : `${Number(value).toLocaleString(locale(), { maximumFractionDigits: 2 })} FCFA`);
const day = (value, month = "long") => new Date(value).toLocaleDateString(locale(), { day: "numeric", month, year: "numeric", timeZone: ZONE });
const metric = (value, label) => `<div class="nd-metric"><b class="nd-metric__value">${h(value)}</b><span class="nd-metric__label">${h(label)}</span></div>`;

// A CSV cell that a spreadsheet will not run as a formula.
const cell = (value) => {
  let text = String(value == null ? "" : value);
  if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
};

export function mountCashCollectedReport(report, { resellers } = {}) {
  const root = document.getElementById("cashCollectedReport"),
    metricOnHome = document.getElementById("cashCollectedMetric");
  if (metricOnHome) metricOnHome.textContent = amount(report && report.amount);
  if (!root) return;
  const available = report && report.status === "available";
  const period = report ? L("adminCashSince", { date: day(report.from, "short") }) : "";
  const sources = available ? report.sources : null;
  const figures = [
    metric(sources ? amount(sources.internet.collected) : L("adminUnavailable"), L("adminCashInternet", { period })),
    metric(sources ? amount(sources.store.collected) : L("adminUnavailable"), L("adminCashStore", { period })),
    metric(available ? amount(report.refunded) : L("adminUnavailable"), L("adminCashRefunds", { period })),
  ];
  if (resellers) figures.push(metric(amount(resellers.remittedTotal || 0), L("adminCashResellers")));
  // Phones show each row as a card, so every value carries its column name.
  const cols = ["adminColPayments", "adminColCollected", "adminColRefunds", "adminColBeforeFees"].map((key) => h(L(key)));
  const values = (count, collected, refunded, net) => `<td data-label="${cols[0]}">${h(count)}</td><td data-label="${cols[1]}">${h(amount(collected))}</td><td data-label="${cols[2]}">${h(amount(refunded))}</td><td data-label="${cols[3]}"><strong>${h(amount(net))}</strong></td>`;
  const source = (label, value) => `<tr><td><strong>${h(label)}</strong></td>${values(value.payments, value.collected, value.refunded, value.amount)}</tr>`;
  root.innerHTML = `<div class="nd-metrics admin-cash__metrics">${figures.join("")}</div>
<section class="nd-panel" aria-labelledby="cashReportTitle"><h2 class="nd-h2" id="cashReportTitle">${h(L("adminCashTitle"))}</h2>
${available ? `<p class="nd-meta admin-cash__lede">${h(L("adminCashLede", { date: day(report.from) }))}</p>
<div class="nd-table-wrap"><table class="nd-table"><thead><tr><th scope="col">${h(L("adminColSource"))}</th><th scope="col">${h(L("adminColPayments"))}</th><th scope="col">${h(L("adminColCollected"))}</th><th scope="col">${h(L("adminColRefunds"))}</th><th scope="col">${h(L("adminColBeforeFees"))}</th></tr></thead><tbody>${source(L("adminCashSourceInternet"), sources.internet)}${source(L("adminCashSourceStore"), sources.store)}</tbody><tfoot><tr><th scope="row">${h(L("adminCashTotal"))}</th>${values(sources.internet.payments + sources.store.payments, report.collected, report.refunded, report.amount)}</tr></tfoot></table></div>
<p class="nd-meta">${h(L("adminCashFees"))} ${h(L("adminCashThrough", { date: new Date(report.to).toLocaleString(locale(), { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: ZONE }) }))}</p>` : `<p class="nd-callout nd-callout--warning" role="status">${h(L("adminCashReview"))}</p>`}
<div class="admin-cash__actions">${available ? `<button type="button" class="nd-btn nd-btn--secondary" data-cash-export>${h(L("adminCashExport"))}</button>` : ""}<a class="admin-link admin-cash__link" href="/dashboard#payments">${h(L("adminCashSeePayments"))} <span aria-hidden="true">→</span></a></div></section>`;
  const exportButton = root.querySelector("[data-cash-export]");
  if (exportButton) exportButton.onclick = () => {
    // The table as shown, for an accountant: one row per source, then the total.
    const rows = [["source", "payments", "confirmed_collections_xaf", "completed_refunds_xaf", "cash_before_fees_xaf", "from", "to"]];
    for (const [name, value] of [["internet", sources.internet], ["store", sources.store]]) rows.push([name, value.payments, value.collected, value.refunded, value.amount, report.from, report.to]);
    rows.push(["total", sources.internet.payments + sources.store.payments, report.collected, report.refunded, report.amount, report.from, report.to]);
    saveFile("ndahi-cash-before-fees.csv", new Blob([rows.map((row) => row.map(cell).join(",")).join("\n")], { type: "text/csv" }));
  };
}
