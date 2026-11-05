import { escapeHtml as h } from "/shared/safe-html.js";
const api = window.NDAHI_CONFIG.apiUrl;
const output = document.querySelector("#homeAdminMessage"), list = document.querySelector("#homeAdminList");
let csrf;
async function call(path, input) {
  const response = await fetch(api + path, { credentials: "include",
    ...(input ? { method: "POST", body: JSON.stringify(input) } : {}),
    headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) } });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Home management unavailable.");
  return data;
}
const duration = value => Number.isFinite(value) ? `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s` : "Not observed";
const number = value => Number.isFinite(value) ? value.toLocaleString() : "Not measured";
const pilotStatus = value => value === "reported_pass" ? "Reported pass; evidence review required"
  : value === "simulation_only" ? "Simulation only; physical evidence required"
  : value === "incomplete_or_failed" ? "Incomplete or failed checks" : "No report recorded";
function diagnostics(info) {
  const d = info.diagnostics;
  if (!d) return;
  document.querySelector("#homeDiagnostics").innerHTML = `<h2>Home operations</h2>
    <p>Observed ${h(d.observedAt)}. Configuration checks and reported trials do not certify a router model or enable Home.</p>
    <dl class="profile-facts">
      <dt>Active households</dt><dd>${h(d.activeHouseholds)}</dd>
      <dt>Pending / needs review</dt><dd>${h(d.queue.pending)} / ${h(d.queue.needsReview)}</dd>
      <dt>Oldest pending operation</dt><dd id="homeQueueAge">${h(duration(d.queue.oldestAgeMs))}</dd>
      <dt>Fresh / stale or missing usage</dt><dd>${h(d.usage.fresh)} / <span id="homeUsageStale">${h(d.usage.stale)}</span> (60-second freshness target)</dd>
      <dt>Payment-to-first-authorization p95</dt><dd>${h(duration(d.activation.p95Ms))} · ${h(d.activation.samples)} server-observed samples, including outages</dd>
      <dt>Accounting discontinuities / active review</dt><dd>${h(d.accounting.discontinuities)} / ${h(d.accounting.activeReview)}</dd>
      <dt>Confirmed gateway revocations at cutoff</dt><dd>${h(d.cutoffs.gatewayConfirmed)}; packet-level cutoff still requires physical evidence</dd>
      <dt>Latest operator-reported pilot</dt><dd id="homePilotStatus">${h(pilotStatus(d.pilot.status))}</dd>
      <dt>Reported quota / activation trials</dt><dd>${h(d.pilot.quotaSamples ?? 0)} / ${h(d.pilot.activationSamples ?? 0)}</dd>
      <dt>Reported maximum overshoot</dt><dd>${h(number(d.pilot.maxOvershootBytes))} bytes</dd>
    </dl>`;
}
async function refresh() {
  const reasons = new Map(Array.from(list.querySelectorAll("[data-reason]"), el => [el.dataset.reason, el.value]));
  const info = await call("/api/admin/home");
  diagnostics(info);
  list.innerHTML = info.households.map(row => `<section class="surface"><h2>${h(row.name)} · ${h(row.link?.name || "No current link")}</h2>
    <p>Identifier …${h(row.link?.identifierSuffix || "—")} · ${h(row.accessMode)}</p>
    <p>${h(row.bundle?.status || "No bundle")} · ${h(row.bundle?.authorization || "pending")}</p>
    <p>Recorded usage: ${h(row.bundle?.usedBytes ?? "—")} bytes · updated ${h(row.bundle?.lastUpdatedAt || "unavailable")}</p>
    ${row.operations.map(o => `<p>${h(o.kind)} · ${h(o.status)} · ${h(o.code || "")}</p>${["retry", "needs_review"].includes(o.status)
      ? `<button data-customer="${h(row.customerId)}" data-retry="${h(o.id)}">Retry safely</button>` : ""}`).join("")}
    <label>Audit reason<input data-reason="${h(row.customerId)}" maxlength="300" required></label>
    <button data-customer="${h(row.customerId)}" data-revoke>Revoke household connection</button></section>`).join("") || "<p>No household links.</p>";
  for (const input of list.querySelectorAll("[data-reason]")) input.value = reasons.get(input.dataset.reason) || "";
  for (const button of list.querySelectorAll("button")) button.onclick = async () => {
    button.disabled = true;
    const customerId = button.dataset.customer, retry = button.dataset.retry;
    try {
      const reason = Array.from(list.querySelectorAll("[data-reason]")).find(el => el.dataset.reason === customerId).value;
      if (!reason.trim()) throw Error("Enter an audit reason.");
      await call(`/api/admin/home/${button.hasAttribute("data-revoke") ? "revoke" : "retry"}`, { customerId, operationId: retry, reason });
      output.textContent = "Waiting for router confirmation. No allowance reset or new charge.";
      await refresh();
      (Array.from(list.querySelectorAll("button")).find(el => el.dataset.customer === customerId && el.dataset.retry === retry) || document.querySelector("#refreshHomeAdmin")).focus();
    } catch (error) { output.textContent = error.message; }
    finally { button.disabled = false; }
  };
}
const refreshButton = document.querySelector("#refreshHomeAdmin");
refreshButton.onclick = async () => {
  refreshButton.disabled = true;
  try { await refresh(); } catch (error) { output.textContent = error.message; }
  finally { refreshButton.disabled = false; }
};
document.querySelector("#checkHomeReadiness").onclick = async event => {
  event.currentTarget.disabled = true;
  try {
    const report = await call("/api/admin/home/readiness");
    document.querySelector("#homeReadiness").innerHTML = `<h2>Readiness checks</h2><p>Home: ${report.enabled ? "enabled" : "disabled"} · Database indexes: ${h(report.database.status)} · Gateway configuration: ${h(report.gateway.status)}</p>
      <p>Native router, traffic, captive portal and provider acceptance: pending independent physical evidence. These checks make no router changes.</p>
      <ul>${(report.database.checks || []).map(check => `<li>${h(check.id)}: ${h(check.status)} ${h(check.reasons?.join(", ") || "")}</li>`).join("")}
      ${(report.gateway.checks || []).map(check => `<li>${h(check.id.replaceAll("_", " "))}: ${h(check.status)}</li>`).join("")}</ul>`;
  } catch (error) { output.textContent = error.message; }
  finally { document.querySelector("#checkHomeReadiness").disabled = false; }
};
document.querySelector("#downloadHomePilotTemplate").onclick = async () => {
  try {
    const template = await call("/api/admin/home/pilot-template");
    const url = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "ndahi-home-pilot.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { output.textContent = error.message; }
};
document.querySelector("#homePilotImport").onsubmit = async event => {
  event.preventDefault();
  const button = event.target.querySelector("button[type=submit]"); button.disabled = true;
  try {
    const file = document.querySelector("#homePilotFile").files[0];
    if (!file || file.size > 1000000) throw Error("Choose a JSON pilot report smaller than 1 MB.");
    let report;
    try { report = JSON.parse(await file.text()); } catch { throw Error("Choose a valid JSON pilot report."); }
    const result = await call("/api/admin/home/pilot", { report, reason: document.querySelector("#homePilotReason").value });
    output.textContent = `${pilotStatus(result.summary.status)}. Home was not enabled by this report.`;
    await refresh();
  } catch (error) { output.textContent = error.message; }
  finally { button.disabled = false; }
};
(async () => { try { csrf = (await call("/api/admin/dashboard")).csrfToken; await refresh(); } catch (error) { output.textContent = error.message; } })();
