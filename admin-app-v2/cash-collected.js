import { escapeHtml as h } from "/shared/safe-html.js";
const amount = (value) =>
  value == null
    ? "Unavailable"
    : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })} FCFA`;
export function mountCashCollectedReport(report) {
  const root = document.getElementById("cashCollectedReport"),
    metric = document.getElementById("cashCollectedMetric");
  if (metric) metric.textContent = amount(report?.amount);
  if (!root) return;
  if (!report || report.status !== "available") {
    root.innerHTML =
      '<h3>Cash collected before fees</h3><p role="status">The cash total needs review. No partial or estimated amount is shown.</p>';
    return;
  }
  const source = (label, value) =>
    `<tr><td>${h(label)}</td><td>${h(value.payments)}</td><td>${h(amount(value.collected))}</td><td>${h(amount(value.refunded))}</td><td>${h(amount(value.amount))}</td></tr>`;
  root.innerHTML = `<h3>Cash collected before fees</h3><p><strong>${h(amount(report.amount))}</strong></p><p>From 1 November 2026 onward · Africa/Douala</p><div class="table-scroll"><table><thead><tr><th>Source</th><th>Payments</th><th>Confirmed collections</th><th>Completed refunds</th><th>Cash before fees</th></tr></thead><tbody>${source("Internet payments", report.sources.internet)}${source("Store purchases", report.sources.store)}</tbody></table></div><p class="form-help">${h(report.message)}</p><small>Recorded confirmations through ${h(new Date(report.to).toLocaleString(undefined, { timeZone: "Africa/Douala" }))} (Africa/Douala).</small>`;
}
