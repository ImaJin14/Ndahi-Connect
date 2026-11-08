import { escapeHtml as h } from "/shared/safe-html.js";
const amount = (value) =>
  value === null || value === undefined
    ? "Unavailable"
    : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })} FCFA`;
export async function mountSettlementReport({ call }) {
  const root = document.getElementById("settlementReport"),
    metric = document.getElementById("netSettlementsMetric");
  if (!root) return;
  root.innerHTML =
    '<h3>Net provider settlements</h3><p role="status">Checking the payment provider…</p>';
  try {
    const report = await call("/api/admin/settlements");
    if (!root.isConnected) return;
    if (metric) metric.textContent = amount(report.amount);
    root.innerHTML = `<h3>Net provider settlements</h3><p><strong>${h(amount(report.amount))}</strong></p><p>${h(report.message)}</p>${report.sources.map((source) => `<p><strong>${h(source.provider)}</strong>: ${h(amount(source.amount))} — ${h(source.message)}</p>`).join("")}<small>Provider data checked: ${h(new Date(report.observedAt).toLocaleString())}. Cached for up to five minutes. Provider-account scope; includes any other activity using the same provider account. Provider history and retention limits apply.</small>`;
  } catch {
    if (metric) metric.textContent = "Unavailable";
    root.innerHTML =
      '<h3>Net provider settlements</h3><p role="status">The provider report could not be loaded. No estimated revenue is shown.</p>';
  }
}
