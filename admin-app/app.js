import { requestAdminActionProof } from "/action-proof.js";
import { mountAdminAuthenticationMigration } from "/authentication-migration.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { mountNetworkSetup } from "/network-setup.js";
import { mountCustomerPicker, mountRecords } from "/records.js";
import { runButton } from "/shared/pending.js";
import { startUpdates } from "/shared/updates.js";
import { activeAdminView, mountAdminNavigation } from "/navigation.js";
import { mountAdminInstall } from "/install.js";
import { mountNotifications } from "/shared/notifications.js";
import { openAuthenticatorRecovery } from "/authenticator-recovery.js";
import { mountIncidentDetails } from "/incident-details.js";

const api = window.NDAHI_CONFIG.apiUrl,
  $ = (s) => document.querySelector(s),
  rows = (items, render) => items.map(render).join("");
let bundleIndex = new Map();
const saleLabel = (v) => v.paymentId ? "Online" : v.saleType === "sold" ? "Sold" : v.saleType === "gift" ? "Gift" : v.generatedByAdmin ? "Unclassified" : "—";
const fcfa = (amount) => `${Number(amount || 0).toLocaleString()} FCFA`;
// Revenue counts settled online payments and activated vouchers sold offline; gifts are shown separately.
function revenueSummary(sales) {
  if (!sales) return "";
  const bundles = (n) => `${n} bundle${n === 1 ? "" : "s"}`,
    line = (label, n, amount) => `<tr><td>${h(label)}</td><td>${h(bundles(n))}</td><td>${h(amount)}</td></tr>`;
  return `<h3>Revenue</h3><div class="table-scroll"><table><thead><tr><th>Source</th><th>Bundles</th><th>Amount</th></tr></thead><tbody>${
    line("Online payments", sales.online.bundles, fcfa(sales.online.amount))}${
    line("Voucher sales", sales.vouchers.bundles, fcfa(sales.vouchers.amount))}${
    line("Total revenue", sales.online.bundles + sales.vouchers.bundles, fcfa(sales.online.amount + sales.vouchers.amount))}${
    line("Gifts (not revenue)", sales.gifts.bundles, `${fcfa(sales.gifts.faceValue)} face value`)}</tbody></table></div><p class="form-help">Voucher sales count once a voucher is activated; resale codes count when a customer claims them, and revoked sales are excluded.${sales.unclassified.bundles ? ` ${h(bundles(sales.unclassified.bundles))} generated before sale tracking ${sales.unclassified.bundles === 1 ? "is" : "are"} unclassified: mark each as sold or gift in Vouchers.` : ""}</p>`;
}
let activeAdminTab = "home", wifiRecords, wifiTimer, wifiLoading = false, adminRole, wifiLive = false, adminAuthenticatorRetired = false;
let csrfToken = "";
let passkeyEnrollmentRunning = false;
window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  const message = document.querySelector("#actionMessage") || document.querySelector("#app");
  message.textContent = event.reason?.message || "The action could not be completed.";
});
async function call(path, options = {}) {
  const r = await fetch(api + path, {
      credentials: "include",
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.method && options.method !== "GET" && csrfToken ? { "x-csrf-token": csrfToken } : {}),
        ...(options.headers || {}),
      },
    }),
    j = await r.json();
  if (r.status === 401 && j.code !== "VERIFICATION_FAILED") {
    location.href = "/login";
    throw Error("Login required");
  }
  if (r.status === 503 && path !== "/api/admin/network/setup/purchase-access") {
    sessionStorage.setItem("ndahi-admin-login-notice", j.error || "Administration is temporarily unavailable while setup is completed.");
    location.replace("/login");
    throw Error("Service setup incomplete");
  }
  if (!r.ok) throw Error(j.error);
  return j;
}
async function runAction(button, text, task, message = "#actionMessage") {
  try {
    await runButton(button, text, task, {
      controls: [...(button.closest("form, tr")?.querySelectorAll("button") || [])],
    });
  } catch (error) {
    ($(message) || $("#actionMessage") || $("#app")).textContent = error.message || "The action could not be completed.";
  }
}
async function load() {
  const x = await call("/api/admin/dashboard");
  adminRole = x.profile.role;
  adminAuthenticatorRetired = x.profile.authenticatorRetired === true;
  wifiLive = x.wifi.live;
  activeAdminTab = activeAdminView(adminRole);
  csrfToken = x.csrfToken;
  mountNotifications({ apiUrl: api, path: "/api/admin/notifications", csrf: () => csrfToken, admin: true });
  const canManagePayments = ["owner", "operator"].includes(x.profile?.role),
    bundleOptions = rows(
      x.bundles,
      (b) => `<option value="${h(b.id)}">${h(b.name)}</option>`,
    );
  bundleIndex = new Map(x.bundles.map((bundle) => [bundle.id, bundle]));
  $("#app").innerHTML = `<div id="actionMessage" class="error" role="alert" aria-live="assertive"></div>
${x.deployment?.mode === "setup" ? `<section class="setup-banner" role="status"><div><p class="section-kicker">Setup mode</p><h2>Finish connecting production services</h2><p>The dashboard and stored data are available. Customer purchases stay paused until every required service is connected and <code>BOOTSTRAP_MODE</code> is set to <code>false</code>.</p></div><div class="setup-services">${Object.entries(x.deployment.providers).map(([name, ready]) => `<span class="status-chip ${ready ? "status-good" : "status-warning"}">${h(name)}: ${h(ready === true ? "ready" : ready || "needs setup")}</span>`).join("")}</div></section>` : ""}
<section class="card tab-panel" data-tab-panel="home" id="panel-home"><h2>Overview</h2><div class="metrics">${
    Object.entries(x.metrics).map(([k, v]) =>
      `<div class="metric"><b${k === "activeSessions" ? ' id="activeSessionsMetric"' : ""}>${h(v)}</b>${k === "activeSessions" ? '<a href="/dashboard#devices"><span class="live-pulse" aria-hidden="true"></span>Active Wi-Fi sessions</a>' : h(k.replace(/([A-Z])/g, " $1"))}</div>`
    ).join("")
  }</div><p>Manage live connections, vouchers and payments from the navigation.</p><div class="action-row"><a class="button-link" href="/dashboard#devices">View devices</a><a class="button-link secondary-link" href="/dashboard#connections">Network commands &amp; health</a></div></section>
<section class="card tab-panel" data-tab-panel="devices" id="panel-devices"><h2>Live Wi-Fi devices</h2><div class="device-controls"><button type="button" id="refreshWifi" ${canManagePayments && x.wifi.live ? "" : "hidden"}>Refresh devices</button><div id="wifiSummary" role="status" aria-live="polite"></div></div><div id="wifiMessage" role="status" aria-live="polite"></div><div id="wifiRecords"></div></section>
<section class="card more-menu" data-admin-more><h2>More</h2><div class="admin-tabs" role="tablist" aria-label="Admin dashboard sections">
  ${[
    ["connections", "Connections"],
    ...(x.profile.role === "owner" ? [["network-setup", "Network setup"]] : []),
    ["bundles", "Bundles"],
    ["voucher-create", "Generate voucher"],
    ["customers", "Customers"],
    ["audit", "Audit"],
  ].map(([id, label]) => `<button role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${activeAdminTab === id}" tabindex="${activeAdminTab === id ? "0" : "-1"}" data-tab="${id}">${label}</button>`).join("")}
</div><div id="adminInstall"></div></section><div class="tab-panels">
<section class="card integration-card tab-panel" id="panel-connections" role="tabpanel" aria-labelledby="tab-connections" data-tab-panel="connections" ${activeAdminTab === "connections" ? "" : "hidden"}><div class="section-heading"><div><p class="section-kicker">System health</p><h2>Connections & security</h2></div><span class="payment-chip">Payments: ${h(x.integrations.payments)}</span></div><div class="integration-grid">
  <article class="integration-item"><div class="integration-copy"><div class="integration-title"><h3>MikroTik</h3><span class="status-chip ${x.integrations.mikrotik === "live" ? "status-good" : "status-warning"}">${h(x.integrations.mikrotik)}</span></div><p>Refresh hotspot usage and quota readings from the router.</p></div><button class="secondary-action" id="syncUsage">Sync usage</button></article>
  <article class="integration-item"><div class="integration-copy"><div class="integration-title"><h3>Omada</h3><span class="status-chip ${["live", "standalone"].includes(x.integrations.omada) ? "status-good" : "status-warning"}">${h(x.integrations.omada)}</span></div><p>${x.integrations.omada === "standalone" ? "Access points run standalone. No Omada controller is used." : "Check controller connectivity and access-point availability."}</p></div>${x.integrations.omada === "standalone" ? "" : '<button class="secondary-action" id="checkOmada">Check connection</button>'}</article>
  <article class="integration-item"><div class="integration-copy"><div class="integration-title"><h3>PIN &amp; passkeys</h3></div><p>Use your PIN or a passkey. Sensitive changes require fresh verification.</p></div><form id="mfa"><button type="button" class="secondary-action" id="enrollPasskey">Add passkey</button></form><ul>${(x.profile.passkeyList || []).map((key,index) => `<li>${h(key.label || `Passkey ${index+1}`)} <button type="button" data-remove-admin-passkey="${h(key.id)}">Remove passkey</button></li>`).join("")}</ul></article>
</div><div id="integrationMessage" role="status" aria-live="polite"></div><h3>Network reconciliation</h3><p>Automatic checks are ${x.networkReconciliation?.enabled ? "enabled" : "disabled"}. Drift against the router is repaired automatically through the durable command queue.</p>${x.networkReconciliation?.issues?.length ? `<table><thead><tr><th>Voucher</th><th>Finding</th><th>Last checked</th></tr></thead><tbody>${rows(x.networkReconciliation.issues, (v) => `<tr><td>${h(v.voucherId)}</td><td>${h(String(v.issue).replaceAll("_", " "))}</td><td>${h(new Date(v.checkedAt).toLocaleString())}</td></tr>`)}</tbody></table>` : "<p>No network reconciliation findings recorded.</p>"}<h3>Network commands</h3><p>${h(x.networkCommands?.pending || 0)} pending · ${h(x.networkCommands?.deadLetters || 0)} need review</p>${x.networkCommands?.commands?.length ? `<table><thead><tr><th>Action</th><th>Target</th><th>Status</th><th>Attempts</th><th>Reason</th><th>Action</th></tr></thead><tbody>${rows(x.networkCommands.commands, (c) => `<tr><td>${h(c.action.replaceAll("_", " "))}</td><td>${h(c.targetId)}</td><td>${h(c.status.replaceAll("_", " "))}</td><td>${h(c.totalAttempts)}</td><td>${h((c.lastError || "").replaceAll("_", " "))}</td><td>${["owner", "operator"].includes(x.profile?.role) ? `${c.canReplay ? `<button data-replay-command="${h(c.id)}">Replay</button>` : ""}${c.recoveryAction === "refresh_devices" ? `<a href="/dashboard#devices">Refresh devices</a>${c.canResolve ? ` <button data-resolve-command="${h(c.id)}">Mark obsolete</button>` : ""}` : ""}` : ""}</td></tr>`)}</tbody></table>` : "<p>No network commands awaiting recovery.</p>"}</section>
${x.profile.role === "owner" ? `<section class="card tab-panel" id="panel-network-setup" role="tabpanel" aria-labelledby="tab-network-setup" data-tab-panel="network-setup" ${activeAdminTab === "network-setup" ? "" : "hidden"}><div id="networkSetup"></div></section>` : ""}
<section class="card tab-panel" id="panel-bundles" role="tabpanel" aria-labelledby="tab-bundles" data-tab-panel="bundles" ${activeAdminTab === "bundles" ? "" : "hidden"}><h2>Bundle management</h2><h3>Create bundle</h3><form id="bundle"><input name="name" aria-label="Bundle name" placeholder="Name" required><input name="price" aria-label="Price in FCFA" type="number" min="0" placeholder="FCFA" required><input name="quotaGb" aria-label="Quota in gigabytes" type="number" min="0" step="0.1" placeholder="GB (blank = unlimited)"><input name="validityHours" aria-label="Validity in hours" type="number" min="1" placeholder="Hours" required><input name="deviceLimit" aria-label="Device limit" type="number" min="1" placeholder="Devices" required><button>Create</button></form><form id="bundleEdit" hidden><input name="bundleId" type="hidden"><input name="name" aria-label="Bundle name" placeholder="Name" required><input name="price" aria-label="Price in FCFA" type="number" min="0" required><input name="quotaGb" aria-label="Quota in gigabytes" type="number" min="0" step="0.1" placeholder="Unlimited"><input name="validityHours" aria-label="Validity in hours" type="number" min="1" required><input name="deviceLimit" aria-label="Device limit" type="number" min="1" required><button>Save changes</button><button type="button" data-cancel-edit>Cancel</button></form><div id="bundleMessage" role="status" aria-live="polite"></div><table><thead><tr><th>Name</th><th>Price</th><th>Quota</th><th>Validity</th><th>Devices</th><th>Type</th><th>Actions</th></tr></thead><tbody>${
    rows(x.bundles, (b) =>
      `<tr><td>${h(b.name)}</td><td>${h(b.price)} FCFA</td><td>${
        h(b.quotaGb ?? "Unlimited")
      } GB</td><td>${h(b.validityHours)} hours</td><td>${h(b.deviceLimit)}</td><td>${
        b.custom ? "Custom" : "System"
      }</td><td><button data-edit-bundle="${h(b.id)}">Edit</button>${
        b.custom ? ` <button data-delete-bundle="${h(b.id)}">Delete</button>` : ""
      }</td></tr>`)
  }</tbody></table></section>
<section class="card tab-panel" id="panel-voucher-create" role="tabpanel" aria-labelledby="tab-voucher-create" data-tab-panel="voucher-create" ${activeAdminTab === "voucher-create" ? "" : "hidden"}><div class="section-heading"><div><p class="section-kicker">Voucher inventory</p><h2>Generate vouchers</h2></div></div><form id="generate" class="voucher-builder">
  <label>Purpose<select name="purpose" id="voucherPurpose"><option value="resale">Resale inventory</option><option value="assigned">Assign to customer</option></select></label>
  <div id="voucherCustomer" class="customer-picker" hidden><label>Find customer<input type="search" id="customerSearch" maxlength="100" placeholder="Name or phone"></label><label>Customer<select name="customerId" id="customerSelect"></select></label><label id="voucherReplaceActiveField" class="checkbox"><input type="checkbox" name="replaceActive" id="voucherReplaceActive" value="true"> Replace customer's existing active bundle</label></div>
  <label>Sale type<select name="saleType" id="voucherSaleType" required><option value="">Choose…</option><option value="sold" selected>Sold — counts as revenue</option>${["owner", "operator"].includes(x.profile.role) ? '<option value="gift">Gift — complimentary, no revenue</option>' : ""}</select></label>
  <label>Bundle type<select name="planMode" id="voucherPlanMode"><option value="existing">Existing bundle</option><option value="custom">Custom voucher</option></select></label>
  <label id="voucherExistingPlan">Bundle<select name="planId">${bundleOptions}</select></label>
  <div id="voucherCustomFields" class="custom-voucher-fields" hidden>
    <label>Voucher name<input name="name" maxlength="80" placeholder="Weekend resale"></label>
    <label>Resale price (FCFA)<input name="price" type="number" min="0" placeholder="1000"></label>
    <label>Data allowance (GB)<input name="quotaGb" type="number" min="0.1" step="0.1" placeholder="Blank = unlimited"></label>
    <label>Validity after activation (hours)<input name="validityHours" type="number" min="1" placeholder="168"></label>
    <label>Device limit<input name="deviceLimit" type="number" min="1" value="1"></label>
  </div>
  <label id="voucherQuantity">Quantity<input name="quantity" type="number" min="1" max="100" value="1"></label>
  <p class="form-help" id="voucherHelp">Codes remain inactive and unassigned until the buyer first redeems them.</p>
  <button>Generate resale vouchers</button>
</form><div id="generated" data-sensitive-output role="status" aria-live="polite"></div></section>
<section class="card tab-panel" id="panel-customers" role="tabpanel" aria-labelledby="tab-customers" data-tab-panel="customers" ${activeAdminTab === "customers" ? "" : "hidden"}><h2>Customers and session history</h2><div id="customerRecords"></div><details><summary>Legacy application-session history</summary><p>These records do not establish which devices are connected to Wi-Fi now. Use Devices for live connections.</p><div id="sessionRecords"></div></details></section>
<section class="card tab-panel" id="panel-vouchers" role="tabpanel" aria-labelledby="admin-nav-vouchers" data-tab-panel="vouchers" ${activeAdminTab === "vouchers" ? "" : "hidden"}><h2>Vouchers</h2><p><a class="button-link" href="/dashboard#voucher-create">Generate vouchers</a></p><div id="voucherRecords"></div></section>
<section class="card tab-panel" id="panel-payments" role="tabpanel" aria-labelledby="admin-nav-payments" data-tab-panel="payments" ${activeAdminTab === "payments" ? "" : "hidden"}><h2>Payments and usage</h2>${revenueSummary(x.sales)}<h3>Payment reconciliation</h3><p>Automatic checks are ${x.paymentReconciliation?.enabled ? "enabled" : "disabled"}. Findings require review before changing payment or voucher status.</p>${x.paymentReconciliation?.issues?.length ? `<table><thead><tr><th>Payment</th><th>Provider</th><th>Findings</th><th>Last checked</th></tr></thead><tbody>${rows(x.paymentReconciliation.issues, (p) => `<tr><td>${h(p.paymentId)}</td><td>${h(p.provider)}</td><td>${h(p.issues.join(", ").replaceAll("_", " "))}</td><td>${h(new Date(p.checkedAt).toLocaleString())}</td></tr>`)}</tbody></table>` : "<p>No reconciliation findings recorded.</p>"}<h3>Webhook recovery</h3><p>${h(x.paymentWebhooks?.pending || 0)} pending · ${h(x.paymentWebhooks?.deadLetters || 0)} need review</p>${x.paymentWebhooks?.events?.length ? `<table><thead><tr><th>Payment</th><th>Provider</th><th>Status</th><th>Attempts</th><th>Reason</th><th>Action</th></tr></thead><tbody>${rows(x.paymentWebhooks.events, (event) => `<tr><td>${h(event.paymentId)}</td><td>${h(event.provider)}</td><td>${h(event.status.replaceAll("_", " "))}</td><td>${h(event.totalAttempts)}</td><td>${h((event.lastError || "").replaceAll("_", " "))}</td><td>${["retry", "dead_letter"].includes(event.status) && ["owner", "operator"].includes(x.profile?.role) ? `<button data-replay-webhook="${h(event.id)}">Replay</button>` : ""}</td></tr>`)}</tbody></table>` : "<p>No failed webhooks awaiting recovery.</p>"}<div id="paymentRecords"></div></section>
<section class="card tab-panel" id="panel-audit" role="tabpanel" aria-labelledby="tab-audit" data-tab-panel="audit" ${activeAdminTab === "audit" ? "" : "hidden"}><h2>Audit log</h2><div id="auditRecords"></div><div id="securityRecords"></div></section></div>`;
  for (const table of $("#app").querySelectorAll("table")) {
    if (table.closest(".table-scroll")) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll";
    table.before(wrapper); wrapper.append(table);
  }
  mountAdminNavigation(adminRole, (view) => { activeAdminTab = view; if (view === "devices") void refreshWifiSummary(); });
  if (["owner", "operator"].includes(adminRole)) void mountIncidentDetails(call);
  mountAdminInstall($("#adminInstall"));
  renderWifiSummary(x.wifi);
  $("#refreshWifi").onclick = async (event) => {
    await runAction(event.currentTarget, "Requesting reading…", async () => {
      const result = await call("/api/admin/wifi-devices/refresh", { method: "POST", body: "{}" });
      renderWifiSummary(result);
      $("#wifiMessage").textContent = result.state === "refreshing" || result.state === "retrying" ? "A router reading was requested. The list will update after it succeeds." : "Device reading is current.";
    }, "#wifiMessage");
    await refreshWifiSummary();
  };
  let customerPicker;
  const updateVoucherBuilder = (event) => {
    const purposeChanged = event?.target?.id === "voucherPurpose";
    const resale = $("#voucherPurpose").value === "resale",
      custom = $("#voucherPlanMode").value === "custom",
      form = $("#generate");
    $("#voucherCustomer").hidden = resale;
    $("#customerSelect").required = !resale;
    // Resale stock defaults to sold; an assigned voucher needs an explicit choice.
    if (resale && !$("#voucherSaleType").value) $("#voucherSaleType").value = "sold";
    if (!resale && purposeChanged) $("#voucherSaleType").value = "";
    if (!resale) customerPicker ??= mountCustomerPicker($("#customerSearch"), $("#customerSelect"), call);
    $("#voucherQuantity").hidden = !resale;
    $("#voucherExistingPlan").hidden = custom;
    $("#voucherCustomFields").hidden = !custom;
    $("#voucherHelp").textContent = resale
      ? "Codes remain inactive and unassigned until the buyer first redeems them."
      : "The voucher activates immediately and is linked to the selected customer.";
    form.querySelector('button[type="submit"], button:not([type])').textContent = resale
      ? "Generate resale vouchers"
      : "Generate assigned voucher";
    for (const input of $("#voucherCustomFields").querySelectorAll("input")) {
      input.required = custom && input.name !== "quotaGb";
    }
  };
  $("#voucherPurpose").onchange = updateVoucherBuilder;
  $("#voucherPlanMode").onchange = updateVoucherBuilder;
  updateVoucherBuilder();
  $("#bundle").onsubmit = async (e) => {
    e.preventDefault();
    await runAction(e.target.querySelector("button:not([type]), button[type=submit]"), "Saving…", async () => {
      await call("/api/admin/bundles", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
      });
      await load();
    }, "#bundleMessage");
  };
  $("#bundleEdit").onsubmit = async (e) => {
    e.preventDefault();
    await runAction(e.target.querySelector("button:not([type]), button[type=submit]"), "Saving…", async () => {
      await call("/api/admin/bundles/update", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
      });
      await load();
    }, "#bundleMessage");
  };
  $("#generate").onsubmit = async (e) => {
    e.preventDefault();
    await runAction(e.target.querySelector("button:not([type]), button[type=submit]"), "Generating…", async () => {
      const formData = new FormData(e.target);
      const payload = Object.fromEntries(formData);
      if (formData.get("replaceActive") === "true") payload.replaceActive = true;
      const result = await call("/api/admin/vouchers/generate", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const vouchers = result.vouchers || [result.voucher];
      $("#generated").innerHTML = `<div class="generated-heading"><div><strong>${h(vouchers.length)} voucher${vouchers.length === 1 ? "" : "s"} generated</strong><p>${result.voucher.status === "available" ? "Ready for resale. Validity starts on first redemption." : result.replacedVoucher ? "Assigned and active (replaced previous active bundle)." : "Assigned and active."}</p></div><div><button type="button" class="secondary-action" id="downloadVouchers">Download CSV</button><button type="button" class="secondary-action" id="closeGenerated">Close codes</button></div></div><div class="generated-codes">${vouchers.map((voucher) => `<code>${h(voucher.code)}</code>`).join("")}</div>`;
      $("#closeGenerated").onclick = () => { $("#generated").replaceChildren(); $("#generate").reset(); updateVoucherBuilder(); };
      $("#downloadVouchers").onclick = () => {
        const csv = ["code,bundle,status", ...vouchers.map((voucher) => `${voucher.code},"${String(result.plan.name).replaceAll('"', '""')}",${voucher.status}`)].join("\n"),
          link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        link.download = `ndahi-vouchers-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
      };
    });
  };
  void mountNetworkSetup($("#networkSetup"), call);
  mountRecordViews(canManagePayments, x.profile.authenticatorRetired);
  $("#syncUsage").onclick = async () => {
    await runAction($("#syncUsage"), "Syncing…", async () => {
      const result = await call("/api/admin/integrations/sync-usage", {
        method: "POST",
        body: "{}",
      });
      $("#integrationMessage").textContent =
        `Updated ${result.updated} of ${result.readings} usage records.`;
    }, "#integrationMessage");
  };
  if ($("#checkOmada")) $("#checkOmada").onclick = async () => {
    await runAction($("#checkOmada"), "Checking…", async () => {
      const result = await call("/api/admin/integrations/omada");
      $("#integrationMessage").textContent = result.connected
        ? `Omada connected (${result.accessPoints.length} access points).`
        : result.error;
    }, "#integrationMessage");
  };
  document.querySelectorAll("[data-remove-admin-passkey]").forEach(button => { button.onclick = async () => {
    try { await runAction(button, "Removing…", async () => {
      const credentialId = button.dataset.removeAdminPasskey;
      const proof = await requestAdminActionProof({ call, purpose: "passkey_remove", input: { credentialId } });
      await call("/api/admin/profile/passkeys/remove", { method: "POST", body: JSON.stringify({ credentialId, ...proof }) });
      await load();
    }, "#integrationMessage"); } catch (error) { $("#integrationMessage").textContent = error.message; }
  }; });
  $("#enrollPasskey").onclick = async () => {
    if (passkeyEnrollmentRunning) return;
    const button = $("#enrollPasskey");
    passkeyEnrollmentRunning = true;
    button.disabled = true;
    button.textContent = "Waiting for device…";
    try {
      const proof = await requestAdminActionProof({ call, purpose: "passkey_add" });
      let result = await call("/api/admin/profile/passkeys/options", { method: "POST", body: JSON.stringify(proof) });
      if (result.options.rp?.id && result.options.rp.id !== location.hostname) {
        throw Error(`Open the admin panel at http://${result.options.rp.id}:8081 before enrolling this passkey.`);
      }
      const credential = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: result.options });
      result = await call("/api/admin/profile/passkeys/verify", { method: "POST", body: JSON.stringify({ challengeId: result.challengeId, response: credential }) });
      $("#integrationMessage").textContent = `Passkey enrolled. This account now has ${result.passkeys} passkey${result.passkeys === 1 ? "" : "s"}.`;
    } catch (error) {
      $("#integrationMessage").textContent = error.name === "AbortError" || /abort signal/i.test(error.message)
        ? "The browser cancelled the passkey prompt. Close any other passkey prompt, reload this page, and select Add passkey once."
        : error.message;
    } finally {
      passkeyEnrollmentRunning = false;
      button.disabled = false;
      button.textContent = "Add passkey";
    }
  };
  if ($("#enrollMfa")) $("#enrollMfa").onclick = async () => {
    await runAction($("#enrollMfa"), "Preparing…", async () => {
      const proof = await requestAdminActionProof({ call, purpose: "legacy_mfa", input: { action: "enroll" } });
      const result = await call("/api/admin/profile/mfa/enroll", {
        method: "POST", body: JSON.stringify({ ...proof, action: "enroll" }),
      });
      $("#mfaEnrollment").innerHTML =
        `<p>Add this secret to your authenticator: <code>${h(result.secret)}</code></p><input id="totpCode" inputmode="numeric" maxlength="6" placeholder="Authenticator code"><button type="button" id="confirmMfa">Confirm</button>`;
      $("#confirmMfa").onclick = async () => {
        await runAction($("#confirmMfa"), "Verifying…", async () => {
          await call("/api/admin/profile/mfa/confirm", {
            method: "POST",
            body: JSON.stringify({ code: $("#totpCode").value, challengeId: result.challengeId }),
          });
          await load();
        }, "#integrationMessage");
      };
    }, "#integrationMessage");
  };
  if ($("#disableMfa")) $("#disableMfa").onclick = async () => {
    await runAction($("#disableMfa"), "Disabling…", async () => {
      const proof = await requestAdminActionProof({ call, purpose: "legacy_mfa", input: { action: "set", enabled: false } });
      await call("/api/admin/profile/mfa", {
        method: "POST", body: JSON.stringify({ ...proof, action: "set", enabled: false }),
      });
      await load();
    }, "#integrationMessage");
  };
}
function mountRecordViews(canManagePayments, retired) {
  const date = (value) => (value ? h(new Date(value).toLocaleString()) : "");
  void mountRecords($("#customerRecords"), {
    call,
    collection: "customers",
    title: "Customers",
    headers: ["Name", "Phone", "Status", "Actions"],
    row: (c) => `<tr><td>${h(c.name)}</td><td>${h(c.phone)}</td><td>${h(c.status || "active")}</td><td><button data-customer="${h(c.id)}" data-suspended="${c.status === "suspended"}">${c.status === "suspended" ? "Restore account" : "Suspend"}</button>${(retired || c.authenticatorEnrolled) && adminRole === "owner" ? ` <button class="secondary-action" data-reset-authenticator="${h(c.id)}">${retired ? "Recover PIN" : "Recover authenticator"}</button>` : ""}</td></tr>`,
  });
  wifiRecords = mountRecords($("#wifiRecords"), {
    call, collection: "wifiDevices", title: "Wi-Fi devices", refreshMs: 5000,
    headers: ["Device", "Bundle", "Status", "Last Wi-Fi check", "Actions"],
    row: (d) => {
      const stale = !d.fresh;
      const pending = d.disconnect && ["disconnecting", "retrying"].includes(d.disconnect.status);
      const isLive = !stale && !pending && Boolean(d.sessionId);
      const pulse = isLive ? '<span class="live-pulse" title="Live active session" aria-label="Active session"></span>' : '';
      return `<tr><td>${h(d.name || "Unnamed device")}${d.main ? " · Main device" : ""}<br>${h(d.mac)}<br>${h(d.address || "")}</td><td>${h(d.voucherId)}</td><td>${pulse}${h(d.disconnect?.message || "Connected at last check")}${stale ? " · Waiting for a current Wi-Fi update" : ""}</td><td>${date(d.syncedAt)}</td><td>${canManagePayments ? `<button data-wifi-voucher="${h(d.voucherId)}" data-wifi-mac="${h(d.mac)}" data-wifi-session="${h(d.sessionId || "")}" data-wifi-started="${h(d.startedAt || "")}" ${stale || pending || !d.sessionId || !d.startedAt ? "disabled" : ""}>${pending ? "Disconnecting…" : "Disconnect"}</button>` : ""}</td></tr>`;
    },
  });
  void mountRecords($("#sessionRecords"), {
    call,
    collection: "sessions",
    title: "Legacy application sessions",
    headers: ["Device", "Device ID", "Status", "Last seen", "Actions"],
    row: (s) => `<tr><td>${h(s.label)}</td><td>${h(s.deviceId)}</td><td>${h(s.status)}</td><td>${date(s.lastSeenAt)}</td><td><a href="/dashboard#devices">Open live devices</a></td></tr>`,
  });
  if (!retired) {
  const migrationPanel = document.createElement("div");
  migrationPanel.id = "adminAuthenticationMigration";
  $("#panel-connections").append(migrationPanel);
  mountAdminAuthenticationMigration({ container: migrationPanel, call });
  }
  void mountRecords($("#voucherRecords"), {
    call,
    collection: "vouchers",
    title: "Vouchers",
    headers: ["Code", "Bundle", "Status", "Sale", "Email", "Devices", "Actions"],
    row: (v) => `<tr><td><code>${h(v.code)}</code></td><td>${h(v.plan?.name)}</td><td>${h(v.status)}</td><td>${h(saleLabel(v))}</td><td>${h(v.emailStatus || "not sent")}</td><td>${h(v.activeDevices)}/${h(v.deviceLimit)}</td><td>${
      v.status === "active" ? `<button data-voucher="${h(v.id)}">Revoke</button>` : ""
    }${v.paymentId && v.emailStatus !== "sent" ? ` <button class="secondary-action" data-resend-email="${h(v.id)}">Retry email</button>` : ""}${
      v.generatedByAdmin && !v.paymentId && canManagePayments ? ["sold", "gift"].filter((type) => v.saleType !== type).map((type) => ` <button class="secondary-action" data-classify="${h(v.id)}" data-sale-type="${type}">Mark ${type === "sold" ? "sold" : "gift"}</button>`).join("") : ""
    }</td></tr>`,
  });
  void mountRecords($("#paymentRecords"), {
    call,
    collection: "payments",
    title: "Payments",
    headers: ["Amount", "Provider", "Reference", "Status", "Created", "Actions"],
    row: (p) => `<tr><td>${h(p.amount)} ${h(p.currency)}</td><td>${h(p.provider)}</td><td>${h(p.providerReference)}</td><td>${h(p.status)}${p.refund ? `<p>Refund: ${h(p.refund.status)}<br>${h(p.refund.message || "")}<br>${h(p.refund.reason || "")}<br>${h(p.refund.providerReference || "Awaiting provider reference")}</p>` : ""}</td><td>${date(p.createdAt)}</td><td>${
      p.status === "paid" && (!p.refund || p.refund.status === "requested") && canManagePayments
        ? `<button data-refund="${h(p.id)}">Approve full refund</button>`
        : ""
    }${["paid", "refund-pending"].includes(p.status) && p.refund?.status === "pending" && canManagePayments ? `<button data-check-refund="${h(p.id)}">Check refund status</button>` : ""}${
      canManagePayments && p.provider !== "mock" && !p.confirmedAt && !p.refund && ["pending", "processing", "failed", "expired", "cancelled"].includes(p.status)
        ? ` <button class="secondary-action" data-verify-payment="${h(p.id)}">Check provider</button>`
        : ""
    }</td></tr>`,
  });
  void mountRecords($("#auditRecords"), {
    call,
    collection: "audit",
    title: "Administrator actions",
    headers: ["Time", "Action", "Actor", "IP"],
    row: (a) => `<tr><td>${date(a.at)}</td><td>${h(a.action)}</td><td>${h(a.actor)}</td><td>${h(a.ip)}</td></tr>`,
  });
  void mountRecords($("#securityRecords"), {
    call,
    collection: "security",
    title: "Security events",
    headers: ["Time", "Event", "IP"],
    row: (e) => `<tr><td>${date(e.at)}</td><td>${h(e.type)}</td><td>${h(e.ip)}</td></tr>`,
  });
}
$("#app").onclick = async (e) => {
  const button = e.target.closest("button");
  if (!button || button.disabled) return;
  if (button.dataset.editBundle) {
    const bundle = bundleIndex.get(button.dataset.editBundle),
      form = $("#bundleEdit");
    form.hidden = false;
    $("#bundle").hidden = true;
    for (
      const [name, value] of Object.entries({
        bundleId: bundle.id,
        name: bundle.name,
        price: bundle.price,
        quotaGb: bundle.quotaGb ?? "",
        validityHours: bundle.validityHours,
        deviceLimit: bundle.deviceLimit,
      })
    ) form.elements[name].value = value;
    form.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (button.hasAttribute("data-cancel-edit")) {
    $("#bundleEdit").hidden = true;
    $("#bundle").hidden = false;
    return;
  }
  if (!["deleteBundle", "resendEmail", "classify", "voucher", "resetAuthenticator", "customer", "wifiVoucher", "session", "replayWebhook", "replayCommand", "resolveCommand", "checkRefund", "refund", "verifyPayment"].some((key) => button.dataset[key])) return;
  await runAction(button, "Working…", async () => {
    if (button.dataset.deleteBundle) {
      if (!confirm("Delete this custom bundle? This cannot be undone.")) return;
      try {
        await call("/api/admin/bundles/delete", {
          method: "POST",
          body: JSON.stringify({ bundleId: button.dataset.deleteBundle }),
        });
      } catch (error) {
        $("#bundleMessage").textContent = error.message;
        return;
      }
    } else if (button.dataset.resendEmail) {
      const result = await call("/api/admin/vouchers/resend-email", {
        method: "POST",
        body: JSON.stringify({ voucherId: button.dataset.resendEmail }),
      });
      if (!result.sent) throw Error(result.error || "Email could not be sent.");
    } else if (button.dataset.classify) {
      await call("/api/admin/vouchers/classify", {
        method: "POST",
        body: JSON.stringify({ voucherId: button.dataset.classify, saleType: button.dataset.saleType }),
      });
    } else if (button.dataset.voucher) {
      if (!confirm("Revoke this voucher and disconnect its access?")) return;
      await call("/api/admin/vouchers/revoke", {
        method: "POST",
        body: JSON.stringify({ voucherId: button.dataset.voucher }),
      });
    } else if (button.dataset.resetAuthenticator) {
      openAuthenticatorRecovery({ customerId: button.dataset.resetAuthenticator, call, opener: button, retired: adminAuthenticatorRetired }); return;
    } else if (button.dataset.customer) {
      const restoring = button.dataset.suspended === "true";
      if (!confirm(restoring ? "Restore this customer account?" : "Suspend this customer and disconnect active vouchers?")) return;
      await call("/api/admin/customers/suspend", {
        method: "POST",
        body: JSON.stringify({ customerId: button.dataset.customer, suspended: button.dataset.suspended !== "true" }),
      });
    } else if (button.dataset.wifiVoucher) {
      if (!confirm("Disconnect this Wi-Fi device? Its slot is released after router confirmation.")) return;
      await call("/api/admin/wifi-devices/disconnect", { method: "POST", body: JSON.stringify({
        voucherId: button.dataset.wifiVoucher, mac: button.dataset.wifiMac, sessionId: button.dataset.wifiSession, startedAt: button.dataset.wifiStarted,
      }) });
      await wifiRecords.refresh(); await refreshWifiSummary();
      return;
    } else if (button.dataset.session) {
      if (!confirm("Disconnect this device session?")) return;
      await call("/api/admin/devices/disconnect", {
        method: "POST",
        body: JSON.stringify({ sessionId: button.dataset.session }),
      });
    } else if (button.dataset.replayWebhook) {
      if (!confirm("Replay this webhook after reviewing the provider transaction? The payment will be verified again before access is issued.")) return;
      await call("/api/admin/payments/webhooks/replay", {
        method: "POST",
        body: JSON.stringify({ eventId: button.dataset.replayWebhook }),
      });
    } else if (button.dataset.resolveCommand) {
      if (!confirm("Mark this legacy job obsolete? This preserves its history and does not disconnect a device. Use a fresh Wi-Fi reading for a new disconnect.")) return;
      await call("/api/admin/network/commands/resolve", { method: "POST", body: JSON.stringify({ commandId: button.dataset.resolveCommand }) });
    } else if (button.dataset.replayCommand) {
      if (!confirm("Replay this network command after resolving the underlying router problem?")) return;
      await call("/api/admin/network/commands/replay", {
        method: "POST",
        body: JSON.stringify({ commandId: button.dataset.replayCommand }),
      });
    } else if (button.dataset.checkRefund) {
      await call("/api/admin/payments/refund/check", { method: "POST", body: JSON.stringify({ paymentId: button.dataset.checkRefund }) });
    } else if (button.dataset.refund) {
      if (!confirm("Request a full refund for this payment?")) return;
      await call("/api/admin/payments/refund", {
        method: "POST",
        body: JSON.stringify({ paymentId: button.dataset.refund }),
      });
    } else if (button.dataset.verifyPayment) {
      if (!confirm("Check this unconfirmed payment with the provider now?")) return;
      await call("/api/admin/payments/verify", {
        method: "POST",
        body: JSON.stringify({ paymentId: button.dataset.verifyPayment }),
      });
    } else return;
    await load();
  });
};
$("#logout").onclick = async (event) => {
  await runAction(event.currentTarget, "Logging out…", async () => {
    await call("/api/admin/logout", { method: "POST", body: "{}" });
    location.href = "/login";
  });
};
load();

function renderWifiSummary(summary) {
  const target = $("#wifiSummary");
  if (!target) return;
  const states = { ready: "Router reading current", idle: "No active bundles", refreshing: "Router reading in progress", retrying: "Router unavailable; reading will retry", failed: "Router reading failed; review the connection", stale: "Waiting for a current router reading" };
  target.textContent = `${summary.unreadVouchers && !summary.activeCount ? "Current connections unknown" : `${summary.activeCount} confirmed connected`}${summary.staleCount ? ` · ${summary.staleCount} last seen in an older reading` : ""}. ${states[summary.state] || "Reading unavailable"}.${summary.syncedAt ? ` Last successful check: ${new Date(summary.syncedAt).toLocaleString()}.` : ""}`;
  if (!summary.live && summary.live !== undefined) target.textContent = "Connect a live router to see current Wi-Fi devices.";
  if (summary.refresh?.canReplay && ["owner", "operator"].includes(adminRole)) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry router reading";
    retry.onclick = async () => { await runAction(retry, "Retrying…", async () => { await call("/api/admin/network/commands/replay", { method: "POST", body: JSON.stringify({ commandId: summary.refresh.id }) }); }, "#wifiMessage"); await refreshWifiSummary(); };
    target.append(" ", retry);
  }
  const metric = $("#activeSessionsMetric");
  if (metric && wifiLive) metric.textContent = summary.unreadVouchers && !summary.activeCount ? "—" : String(summary.activeCount);
}
async function refreshWifiSummary() {
  if (wifiLoading || document.hidden || !$("#wifiSummary")) return;
  wifiLoading = true;
  try { renderWifiSummary(await call("/api/admin/wifi-devices")); }
  catch (error) { if ($("#wifiSummary")) $("#wifiSummary").textContent = `Unable to refresh devices: ${error.message}. Previous readings remain on screen.`; }
  finally { wifiLoading = false; }
}
function watchWifiSummary() {
  clearTimeout(wifiTimer);
  wifiTimer = setTimeout(async () => { if (["home", "devices"].includes(activeAdminTab)) await refreshWifiSummary(); watchWifiSummary(); }, 5000);
}
watchWifiSummary();
window.addEventListener("online", () => { void refreshWifiSummary(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshWifiSummary(); });
startUpdates({ isBusy: () => passkeyEnrollmentRunning || Boolean(document.querySelector('#totpCode, [data-sensitive-output]:not(:empty), [data-review-output]:not(:empty), [data-setup-pending="true"]')) });
