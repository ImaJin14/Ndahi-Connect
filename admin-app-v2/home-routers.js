// Home router connections (v2 canvas: AdminHomeRouters), inside the admin shell.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { mountStandaloneMenu } from "/navigation.js";
const api = window.NDAHI_CONFIG.apiUrl;
const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr" : "en-GB");
let planNames = new Map();
// Page text in the admin's language.
[["#adminEyebrow", "adminHomeEyebrow"], ["#adminTitle", "adminTitleHomeRouters"], ["#refreshHomeAdmin", "adminRefresh"], ["#checkHomeReadiness", "adminCheckReadiness"],
  ["#homePilotTitle", "adminPilotTitle"], ["#homePilotLede", "adminPilotLede"], ["#homePilotFileLabel", "adminPilotFile"], ["#homePilotReasonLabel", "adminAuditReason"],
  ["#downloadHomePilotTemplate", "adminPilotTemplate"], ["#homePilotSubmit", "adminPilotSubmit"]].forEach(([selector, key]) => { const el = document.querySelector(selector); if (el) el.textContent = L(key); });
document.querySelector("#homeAdminList").setAttribute("aria-label", L("adminLinkedRouters"));
document.querySelector("#homeDiagnostics").setAttribute("aria-label", L("adminHomeOperations"));
document.querySelector("#logout").onclick = async () => {
  try { await fetch(api + "/api/admin/logout", { method: "POST", credentials: "include", headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) } }); }
  finally { location.href = "/login"; }
};
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
  document.querySelector("#homeDiagnostics").innerHTML = `<h2 class="nd-h2">${h(L("adminHomeOperations"))}</h2>
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
  const status = (row) => {
    if (row.operations.some((o) => o.code === "HOME_ACCOUNTING_REVIEW")) return ["adminHomeUsageReview", "danger"];
    if (row.operations.some((o) => ["pending", "retry", "needs_review"].includes(o.status)) || row.bundle?.transition) return ["adminHomeChanging", "warning"];
    if (["authorized", "synced", "active"].includes(row.bundle?.authorization)) return ["adminHomeAuthorized", "success"];
    return [null, ""];
  };
  list.innerHTML = info.households.length ? `<div class="nd-table-wrap"><table class="nd-table"><thead><tr><th scope="col">${h(L("adminColCustomer"))}</th><th scope="col">${h(L("adminColRouter"))}</th><th scope="col">${h(L("adminColMode"))}</th><th scope="col">${h(L("adminFieldBundle"))}</th><th scope="col">${h(L("adminColStatus"))}</th><th scope="col">${h(L("adminColLinked"))}</th></tr></thead><tbody>${info.households.map((row) => {
    const [label, tone] = status(row);
    const linked = row.link?.verifiedAt ? new Date(row.link.verifiedAt).toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: "Africa/Douala" }) : "—";
    return `<tr><td><strong>${h(row.name)}</strong></td><td>${h(row.link?.name || L("adminNoCurrentLink"))}<span class="admin-cell__sub">…${h(row.link?.identifierSuffix || "—")}</span></td><td>${h(L(row.accessMode === "home" ? "adminModeHome" : "adminModeDirect"))}</td><td>${h(row.bundle ? planNames.get(row.bundle.planId) || row.bundle.planId : L("adminFieldNone"))}${row.bundle ? `<span class="admin-cell__sub">${h(row.bundle.status)} · ${h(L("adminUsedBytes", { bytes: row.bundle.usedBytes ?? "—" }))}</span>` : ""}</td><td><span class="nd-pill${tone ? " nd-pill--" + tone : ""}">${h(label ? L(label) : row.bundle?.authorization || "pending")}</span></td><td>${h(linked)}</td></tr>
    <tr class="admin-homerouters__manage"><td colspan="6"><details class="admin-options"><summary>${h(L("adminManageHousehold", { name: row.name }))}</summary><div class="admin-options__body">
    ${row.operations.map((o) => `<p class="nd-meta">${h(o.kind)} · ${h(o.status)}${o.message ? " · " + h(o.message) : ""}${o.code ? " · " + h(o.code) : ""}</p>${["retry", "needs_review"].includes(o.status) ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-customer="${h(row.customerId)}" data-retry="${h(o.id)}">${h(L("adminRetrySafely"))}</button>` : ""}`).join("")}
    <label class="nd-field"><span class="nd-label">${h(L("adminAuditReason"))}</span><input class="nd-input" data-reason="${h(row.customerId)}" maxlength="300" required></label>
    <button type="button" class="nd-btn nd-btn--compact nd-btn--secondary admin-btn--danger" data-customer="${h(row.customerId)}" data-revoke>${h(L("adminRevokeHousehold"))}</button></div></details></td></tr>`;
  }).join("")}</tbody></table></div><p class="nd-meta admin-homerouters__note">${h(L("adminHomeReviewNote"))}</p>` : `<p class="nd-meta">${h(L("adminNoHouseholds"))}</p>`;
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
    document.querySelector("#homeReadiness").innerHTML = `<h2 class="nd-callout__title">Readiness checks</h2><p>Home: ${report.enabled ? "enabled" : "disabled"} · Database indexes: ${h(report.database.status)} · Gateway configuration: ${h(report.gateway.status)}</p>
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
(async () => {
  try {
    const x = await call("/api/admin/dashboard");
    csrf = x.csrfToken;
    planNames = new Map((x.bundles || []).map((plan) => [plan.id, plan.name]));
    mountStandaloneMenu({ role: x.profile?.role, current: "homerouters", sales: Boolean(x.sales) });
    await refresh();
  } catch (error) { output.textContent = error.message; }
})();
