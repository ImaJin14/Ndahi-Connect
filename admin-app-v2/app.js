import { mountCashCollectedReport } from "/cash-collected.js";
import { mountVoucherRecords } from "/vouchers.js";
import { mountCustomerRecords, showCustomerDetail } from "/customers.js";
import { bundleCards, showBundleEdit } from "/bundles.js";
import { deviceSummaryText, mountDeviceRecords } from "/devices.js";
import { adminSecurity, serviceCards } from "/connections.js";
import { exportAudit, mountAuditRecords } from "/audit.js";
import { downloadPaymentsExport, loadPaymentFigures, maskPhone, mountPaymentRecords, paymentFor, paymentMethod, paymentStatus } from "/payments.js";
import { mountStore } from '/store.js';
import { requestAdminActionProof } from "/action-proof.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { mountNetworkSetup } from "/network-setup.js";
import { mountCustomerPicker, mountRecords } from "/records.js";
import { runButton } from "/shared/pending.js";
import { startUpdates } from "/shared/updates.js";
import { activeAdminView, adminViewParam, mountAdminNavigation, setAdminBadges, setAdminHead } from "/navigation.js";
import { mountAdminInstall } from "/install.js";
import { mountNotifications } from "/shared/notifications.js";
import { openAuthenticatorRecovery } from "/authenticator-recovery.js";
import { mountIncidentDetails } from "/incident-details.js";
import { mountGeneratedVoucherPrint } from "/voucher-print.js";
import { mountResellerLedger } from "/reseller-ledger.js";
import { format, t } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const api = window.NDAHI_CONFIG.apiUrl,
  $ = (s) => document.querySelector(s),
  rows = (items, render) => items.map(render).join("");
let bundleIndex = new Map();
const fcfa = (amount) => `${Number(amount || 0).toLocaleString()} FCFA`;
let activeAdminTab = "home", wifiRecords, wifiTimer, wifiLoading = false, adminRole, wifiLive = false, adminAuthenticatorRetired = false;
let csrfToken = "";
let passkeyEnrollmentRunning = false;
let activePrintController = null;
// The last generated batch, kept in memory only for its print screen.
let lastBatch = null, voucherRecords, prefillAssignedVoucher = () => {};
function clearPrintContainers() {
  activePrintController?.destroy();
  activePrintController = null;
  for (const selector of ["#generated", "#activeVoucherPrint", "#customerVoucherPrint", "#voucherPrintTray", "#voucherPrintActions"]) {
    $(selector)?.replaceChildren();
  }
}
function openSingleVoucherPrintPreview(targetContainer, result) {
  if (!targetContainer || !result?.voucher) return;
  clearPrintContainers();
  if ($("#actionMessage")) $("#actionMessage").textContent = "";
  const voucher = result.voucher;
  targetContainer.innerHTML = `<div class="generated-heading"><div><strong>Voucher slip ready to print (${h(voucher.code)})</strong><p>${voucher.status === "available" ? "Ready for resale. Validity starts on first redemption." : "Active voucher. Customer and payment details are excluded from the printed slip."}</p></div><div class="action-row"><button type="button" class="secondary-action" data-close-voucher-print>Close print preview</button></div></div><div class="generated-codes"><code>${h(voucher.code)}</code></div><div id="voucherPrintPreview"></div>`;
  activePrintController = mountGeneratedVoucherPrint({
    container: targetContainer.querySelector("#voucherPrintPreview"),
    vouchers: [voucher],
    plan: result.plan,
    layout: "thermal-58",
  });
  targetContainer.querySelector("[data-close-voucher-print]").onclick = () => {
    clearPrintContainers();
  };
  targetContainer.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
}
// Print screen (canvas: AdminVoucherPrint): the batch's slips, mounted while the
// screen is open. Without a batch in memory (after a reload) it goes back to Vouchers.
function showBatchPrint(view) {
  const tray = $("#voucherPrintTray");
  if (!tray) return;
  if (view !== "voucher-print") {
    if (tray.childElementCount) { activePrintController?.destroy(); activePrintController = null; tray.replaceChildren(); $("#voucherPrintActions")?.replaceChildren(); }
    return;
  }
  if (!lastBatch) { location.replace("/dashboard#vouchers"); return; }
  const { vouchers, plan, reseller } = lastBatch, count = vouchers.length;
  setAdminHead({
    title: count === 1 ? L("adminPrintTitleOne", { code: vouchers[0].code }) : L("adminPrintTitle", { count }),
    lede: [count === 1 ? L("adminSlipsOne") : L("adminSlips", { count }), plan?.name, reseller ? L("adminForName", { name: reseller }) : ""].filter(Boolean).join(" · "),
  });
  tray.innerHTML = '<div id="voucherPrintPreview"></div>';
  activePrintController = mountGeneratedVoucherPrint({
    container: $("#voucherPrintPreview"),
    toolbar: $("#voucherPrintActions"),
    vouchers,
    plan,
    layout: "thermal-58",
    labels: { region: L("adminPrintRegion"), format: L("adminPrintFormat"), thermal58: L("adminThermal58"), thermal80: L("adminThermal80"), print: count === 1 ? L("adminPrintOne") : L("adminPrintMany", { count }), openHere: L("adminPrintOpenHere") },
  });
}

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
  if (r.status === 503 && path !== "/api/admin/network/setup/purchase-access" && !path.startsWith("/api/admin/store")) {
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
const L = (key, values) => format(key, values || {}, currentLanguage());

// Needs attention: only real signals, each linking to where it is handled.
async function loadHomeAttention(x, storeSnapshot, contacts) {
  const host = $("#homeAttention");
  if (!host) return;
  // Tones follow the canvas: waiting money orange, orders blue, stock neutral, failures red.
  const items = [], item = (href, text, tone) => items.push(`<a class="admin-attention admin-attention--${tone}" href="${href}">${h(text)}<span aria-hidden="true">→</span></a>`);
  const [pending, store] = await Promise.all([
    contacts ? call("/api/admin/records?collection=payments&status=pending&pageSize=50").catch(() => null) : null,
    storeSnapshot,
  ]);
  const late = (pending?.items || []).filter((p) => Date.now() - Date.parse(p.createdAt) > 10 * 60000).length;
  if (late) item("/dashboard#payments", late === 1 ? L("adminAttentionPaymentsOne") : L("adminAttentionPayments", { count: late }), "warning");
  const badges = { payments: late };
  if (store) {
    const preparing = store.orders.filter((o) => o.status === "preparing").length;
    const orders = $("#homeOrdersMetric");
    if (orders) orders.textContent = String(preparing);
    badges.store = preparing;
    if (preparing) item("/dashboard#store", preparing === 1 ? L("adminAttentionOrdersOne") : L("adminAttentionOrders", { count: preparing }), "info");
    const lang = currentLanguage();
    store.products.filter((p) => p.status === "published" && p.available <= 3).forEach((p) => item("/dashboard#products", L("adminAttentionStock", { name: typeof p.name === "object" ? p.name[lang] || p.name.en : p.name, count: p.available }), "neutral"));
  }
  if (x.paymentWebhooks?.deadLetters) item("/dashboard#payments", L("adminAttentionWebhooks", { count: x.paymentWebhooks.deadLetters }), "danger");
  if (x.paymentReconciliation?.issues?.length) item("/dashboard#payments", L("adminAttentionPaymentChecks", { count: x.paymentReconciliation.issues.length }), "warning");
  if (x.networkCommands?.deadLetters) item("/dashboard#connections", L("adminAttentionCommands", { count: x.networkCommands.deadLetters }), "danger");
  if (x.networkReconciliation?.issues?.length) item("/dashboard#connections", L("adminAttentionNetworkChecks", { count: x.networkReconciliation.issues.length }), "warning");
  // Side menu counts, as on the canvas: payments waiting, orders to prepare.
  setAdminBadges(badges);
  host.innerHTML = items.length ? items.join("") : `<p class="nd-meta">${h(L("adminAttentionNone"))}</p>`;
}

async function loadHomePayments() {
  const host = $("#homePayments");
  if (!host) return;
  const result = await call("/api/admin/records?collection=payments&pageSize=4").catch(() => null);
  if (!result) { host.closest("section").hidden = true; return; }
  host.innerHTML = result.items.length ? `<table class="nd-table"><thead><tr><th scope="col">${h(L("adminColCustomer"))}</th><th scope="col">${h(L("adminColFor"))}</th><th scope="col">${h(L("adminColMethod"))}</th><th scope="col">${h(L("adminColStatus"))}</th></tr></thead><tbody>${result.items.map((p) => `<tr><td>${h(maskPhone(p.payerPhone))}</td><td>${h(paymentFor(p))}</td><td>${h(paymentMethod(p))}</td><td>${paymentStatus(p)}</td></tr>`).join("")}</tbody></table>` : `<p class="nd-meta">${h(L("adminNoPayments"))}</p>`;
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
  // Redesigned Home (canvas: Admin). Contacts decide whether payments can be listed.
  const storeRole = ["owner", "operator"].includes(adminRole), access = { contacts: x.recordTotals?.payments !== undefined && adminRole !== "reseller" };
  $("#adminHeadActions").innerHTML = `<a class="nd-btn nd-btn--sm nd-btn--secondary" data-head-view="home" href="/dashboard#vouchers">${h(L("adminHomePrintVouchers"))}</a>${storeRole ? `<a class="nd-btn nd-btn--sm" data-head-view="home" href="/dashboard#products">${h(L("adminHomeAddProduct"))}</a>` : ""}<div class="nd-cluster" data-head-view="voucher-print" id="voucherPrintActions"></div><button type="button" class="nd-btn nd-btn--secondary" data-head-view="audit" id="auditExport">${h(L("adminExport"))}</button><div class="admin-devices__head" data-head-view="devices"><span class="admin-live" id="wifiLive"><span class="admin-live__dot" aria-hidden="true"></span><span id="wifiSummary" role="status" aria-live="polite"></span></span><button type="button" class="nd-btn nd-btn--secondary" id="refreshWifi" ${canManagePayments && x.wifi.live ? "" : "hidden"}>${h(L("adminRefreshDevices"))}</button></div><div data-head-view="customers" id="customerSearchHost" class="admin-head-search"></div><div data-head-view="customer" id="customerStatusHost"></div>${access.contacts ? `<button type="button" class="nd-btn nd-btn--secondary" data-head-view="payments" data-payments-export>${h(L("adminExportCsv"))}</button>` : ""}`;
  $("#auditExport").onclick = () => runAction($("#auditExport"), L("adminExporting"), () => exportAudit(call));
  const paymentsExport = $("[data-payments-export]");
  if (paymentsExport) paymentsExport.onclick = () => runAction(paymentsExport, L("adminExporting"), () => downloadPaymentsExport(api));
  $("#app").innerHTML = `<div id="actionMessage" class="error" role="alert" aria-live="assertive"></div>
${x.deployment?.mode === "setup" ? `<section class="setup-banner" role="status"><div><p class="section-kicker">Setup mode</p><h2>Finish connecting production services</h2><p>The dashboard and stored data are available. Customer purchases stay paused until every required service is connected and <code>BOOTSTRAP_MODE</code> is set to <code>false</code>.</p></div><div class="setup-services">${Object.entries(x.deployment.providers).map(([name, ready]) => `<span class="status-chip ${ready ? "status-good" : "status-warning"}">${h(name)}: ${h(ready === true ? "ready" : ready || "needs setup")}</span>`).join("")}</div></section>` : ""}
<section class="tab-panel admin-home" data-tab-panel="home" id="panel-home" aria-labelledby="adminTitle"><div class="nd-metrics admin-home__metrics">
<div class="nd-metric"><b class="nd-metric__value" id="activeSessionsMetric">${h(x.metrics.activeSessions)}</b><a class="nd-metric__label" href="/dashboard#devices">${h(L("adminMetricDevicesOnline"))}</a></div>
<div class="nd-metric"><b class="nd-metric__value">${h(x.metrics.bundlesSold)}</b><span class="nd-metric__label">${h(L("adminMetricBundlesSold"))}</span></div>
<div class="nd-metric"><b class="nd-metric__value" id="cashCollectedMetric">${x.cashCollected?.amount == null ? h(L("adminUnavailable")) : fcfa(x.cashCollected.amount)}</b><span class="nd-metric__label">${h(L("adminMetricCollected"))}</span></div>
${storeRole ? `<div class="nd-metric"><b class="nd-metric__value" id="homeOrdersMetric">…</b><a class="nd-metric__label" href="/dashboard#store">${h(L("adminMetricOrdersToPrepare"))}</a></div>` : ""}
</div><div class="admin-home__row"><section class="nd-panel admin-home__attention" aria-labelledby="homeAttentionTitle"><h2 class="nd-h2" id="homeAttentionTitle">${h(L("adminAttentionTitle"))}</h2><div id="homeAttention" aria-live="polite"></div></section>
${access.contacts ? `<section class="nd-panel admin-home__payments" aria-labelledby="homePaymentsTitle"><div class="nd-panel__head"><h2 class="nd-h2" id="homePaymentsTitle">${h(L("adminLatestPayments"))}</h2><a class="admin-link" href="/dashboard#payments">${h(L("adminAllPayments"))}</a></div><div class="nd-table-wrap" id="homePayments"></div></section>` : ""}</div></section>
<section class="tab-panel admin-devices" data-tab-panel="devices" id="panel-devices" aria-labelledby="adminTitle" ${activeAdminTab === "devices" ? "" : "hidden"}><p id="wifiMessage" class="nd-meta" role="status" aria-live="polite"></p><section class="nd-panel admin-devices__list" aria-label="${h(L("adminDevicesList"))}"><div id="wifiRecords"></div></section></section>
<section class="tab-panel admin-profile" id="panel-profile" aria-labelledby="adminTitle" data-tab-panel="profile" ${activeAdminTab === "profile" ? "" : "hidden"}><section class="nd-panel admin-passkeys" aria-labelledby="adminPasskeysTitle"><h2 class="nd-h2" id="adminPasskeysTitle">${h(L("adminPasskeysTitle"))}</h2><p class="nd-meta">${h(L("adminPasskeysLede"))}</p><form id="adminPasskeys"><button type="button" class="nd-btn nd-btn--secondary" id="enrollPasskey">${h(L("adminAddPasskey"))}</button></form><ul class="admin-passkeys__list">${(x.profile.passkeyList || []).map((key,index) => `<li>${h(key.label || `Passkey ${index+1}`)} <button type="button" class="nd-btn nd-btn--compact nd-btn--quiet admin-btn--danger" data-remove-admin-passkey="${h(key.id)}">${h(L("adminRemovePasskey"))}</button></li>`).join("")}</ul></section><div id="adminInstall"></div></section><div class="tab-panels">
<section class="tab-panel admin-connections" id="panel-connections" aria-labelledby="adminTitle" data-tab-panel="connections" ${activeAdminTab === "connections" ? "" : "hidden"}><div class="admin-connections__grid">${serviceCards(x)}</div><p id="integrationMessage" class="nd-meta" role="status" aria-live="polite"></p>
<section class="nd-panel admin-security" aria-labelledby="adminSecurityTitle"><h2 class="nd-h2" id="adminSecurityTitle">${h(L("adminSecurityTitle"))}</h2>${adminSecurity(x)}</section>
<section class="nd-panel admin-payments__checks" aria-labelledby="routerChecksTitle"><h2 class="nd-h2" id="routerChecksTitle">${h(L("adminRouterChecksTitle"))}</h2><h3 class="nd-h3">${h(L("adminNetworkChecks"))}</h3><p class="nd-meta">${h(L(x.networkReconciliation?.enabled ? "adminNetworkChecksOn" : "adminNetworkChecksOff"))}</p>${x.networkReconciliation?.issues?.length ? `<table class="nd-table"><thead><tr><th>Voucher</th><th>Finding</th><th>Last checked</th></tr></thead><tbody>${rows(x.networkReconciliation.issues, (v) => `<tr><td>${h(v.voucherId)}</td><td>${h(String(v.issue).replaceAll("_", " "))}</td><td>${h(new Date(v.checkedAt).toLocaleString())}</td></tr>`)}</tbody></table>` : `<p>${h(L("adminNetworkChecksNone"))}</p>`}<h3 class="nd-h3">${h(L("adminRouterCommands"))}</h3><p class="nd-meta">${h(L("adminRouterCommandsCount", { pending: x.networkCommands?.pending || 0, review: x.networkCommands?.deadLetters || 0 }))}</p>${x.networkCommands?.commands?.length ? `<table class="nd-table"><thead><tr><th>Action</th><th>Target</th><th>Status</th><th>Attempts</th><th>Reason</th><th>Action</th></tr></thead><tbody>${rows(x.networkCommands.commands, (c) => `<tr><td>${h(c.action.replaceAll("_", " "))}</td><td>${h(c.targetId)}</td><td>${h(c.status.replaceAll("_", " "))}</td><td>${h(c.totalAttempts)}</td><td>${h((c.lastError || "").replaceAll("_", " "))}</td><td>${["owner", "operator"].includes(x.profile?.role) ? `${c.canReplay ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-replay-command="${h(c.id)}">${h(L("adminReplay"))}</button>` : ""}${c.recoveryAction === "refresh_devices" ? `<a href="/dashboard#devices">Refresh devices</a>${c.canResolve ? ` <button type="button" class="nd-btn nd-btn--compact nd-btn--quiet" data-resolve-command="${h(c.id)}">Mark obsolete</button>` : ""}` : ""}` : ""}</td></tr>`)}</tbody></table>` : `<p>${h(L("adminRouterCommandsNone"))}</p>`}</section></section>
${x.profile.role === "owner" ? `<section class="card tab-panel" id="panel-network-setup" aria-labelledby="adminTitle" data-tab-panel="network-setup" ${activeAdminTab === "network-setup" ? "" : "hidden"}><div id="networkSetup"></div></section>` : ""}
<section class="tab-panel admin-bundles" id="panel-bundles" aria-labelledby="adminTitle" data-tab-panel="bundles" ${activeAdminTab === "bundles" ? "" : "hidden"}><div class="admin-bundles__grid">${bundleCards(x.bundles, x.usageByBundle)}</div><p id="bundleMessage" class="nd-meta" role="status" aria-live="polite"></p>
<section class="nd-panel" aria-labelledby="bundleCreateTitle"><h2 class="nd-h2" id="bundleCreateTitle">${h(L("adminNewBundle"))}</h2><form id="bundle" class="admin-form admin-form--row">
  <label class="nd-field"><span class="nd-label">${h(L("adminFieldName"))}</span><input class="nd-input" name="name" maxlength="80" placeholder="${h(L("adminBundleNameHint"))}" required></label>
  <label class="nd-field"><span class="nd-label">${h(L("adminFieldPrice"))}</span><input class="nd-input" name="price" type="number" min="0" required></label>
  <label class="nd-field"><span class="nd-label">${h(L("adminFieldDataGb"))}</span><input class="nd-input" name="quotaGb" type="number" min="0.1" step="0.1" placeholder="${h(L("adminFieldDataGbHint"))}"></label>
  <label class="nd-field"><span class="nd-label">${h(L("adminFieldValidityShort"))}</span><input class="nd-input" name="validityHours" type="number" min="1" required></label>
  <label class="nd-field"><span class="nd-label">${h(L("adminFieldDeviceLimit"))}</span><input class="nd-input" name="deviceLimit" type="number" min="1" value="1" required></label>
  <button type="submit" class="nd-btn">${h(L("adminCreateBundle"))}</button>
</form></section></section>
<section class="tab-panel admin-bundle-edit" id="panel-bundle-edit" aria-labelledby="adminTitle" data-tab-panel="bundle-edit" ${activeAdminTab === "bundle" ? "" : "hidden"}><div class="admin-bundle-edit__row">
<section class="nd-panel admin-bundle-edit__form" aria-label="${h(L("adminBundleSettings"))}"><form id="bundleEdit" class="admin-form"><input name="bundleId" type="hidden">
  <div class="admin-form__grid">
    <label class="nd-field"><span class="nd-label">${h(L("adminFieldName"))}</span><input class="nd-input" name="name" maxlength="80" required></label>
    <label class="nd-field"><span class="nd-label">${h(L("adminFieldPrice"))}</span><input class="nd-input" name="price" type="number" min="0" required></label>
    <label class="nd-field"><span class="nd-label">${h(L("adminFieldValidityShort"))}</span><input class="nd-input" name="validityHours" type="number" min="1" required></label>
    <label class="nd-field"><span class="nd-label">${h(L("adminFieldDeviceLimit"))}</span><input class="nd-input" name="deviceLimit" type="number" min="1" required></label>
  </div>
  <label class="admin-check admin-check--lg"><input type="checkbox" name="unlimited"> ${h(L("adminUnlimitedData"))}</label>
  <label class="nd-field admin-bundle-edit__quota" id="bundleQuotaField"><span class="nd-label">${h(L("adminFieldDataGb"))}</span><input class="nd-input" name="quotaGb" type="number" min="0.1" step="0.1"></label>
  <p class="nd-callout nd-callout--warning admin-callout">${h(L("adminBundleEditNote"))}</p>
  <div class="admin-form__actions"><button type="submit" class="nd-btn">${h(L("adminSaveBundle"))}</button><span id="bundleEditMessage" class="admin-saved" role="status" aria-live="polite"></span></div>
</form></section>
<section class="admin-bundle-edit__preview" aria-labelledby="bundlePreviewTitle"><h2 id="bundlePreviewTitle" class="admin-preview-title">${h(L("adminWhatCustomersSee"))}</h2><div class="admin-plan-preview" id="bundlePreview"><span><strong data-preview-name></strong><span data-preview-detail></span></span><strong data-preview-price></strong></div></section>
</div></section>
<section class="tab-panel admin-vouchers" id="panel-vouchers" aria-labelledby="adminTitle" data-tab-panel="vouchers" ${activeAdminTab === "vouchers" ? "" : "hidden"}><div class="admin-vouchers__row">
<section class="nd-panel admin-vouchers__create" aria-labelledby="voucherCreateTitle"><h2 class="nd-h2" id="voucherCreateTitle">${h(L("adminVoucherCreateTitle"))}</h2><form id="generate" class="admin-form">
  <label class="nd-field" id="voucherExistingPlan"><span class="nd-label">${h(L("adminFieldBundle"))}</span><select class="nd-input" name="planId">${bundleOptions}</select></label>
  <div class="admin-form__pair">
    <label class="nd-field" id="voucherQuantity"><span class="nd-label">${h(L("adminFieldHowMany"))}</span><input class="nd-input" name="quantity" type="number" min="1" max="100" value="1"></label>
    <label class="nd-field" id="voucherResellerField" ${["owner", "operator"].includes(x.profile.role) && x.resellerLedger?.resellers?.some((r) => r.active && r.role === "reseller") ? "" : "hidden"}><span class="nd-label">${h(L("adminFieldForReseller"))}</span><select class="nd-input" name="assignedResellerId" id="voucherResellerSelect"><option value="">${h(L("adminFieldNone"))}</option>${rows((x.resellerLedger?.resellers || []).filter((r) => r.active && r.role === "reseller"), (r) => `<option value="${h(r.resellerId)}">${h(r.displayName || r.username)} (@${h(r.username)})</option>`)}</select></label>
  </div>
  <details class="admin-options" id="voucherOptions"><summary>${h(L("adminMoreOptions"))}</summary><div class="admin-options__body">
    <label class="nd-field"><span class="nd-label">${h(L("adminFieldPurpose"))}</span><select class="nd-input" name="purpose" id="voucherPurpose"><option value="resale">${h(L("adminPurposeResale"))}</option><option value="assigned">${h(L("adminPurposeAssigned"))}</option></select></label>
    <div id="voucherCustomer" class="customer-picker" hidden><label class="nd-field"><span class="nd-label">${h(L("adminFindCustomer"))}</span><input class="nd-input" type="search" id="customerSearch" maxlength="100" placeholder="${h(L("adminFindCustomerHint"))}"></label><label class="nd-field"><span class="nd-label">${h(L("adminColCustomer"))}</span><select class="nd-input" name="customerId" id="customerSelect"></select></label><label id="voucherReplaceActiveField" class="admin-check"><input type="checkbox" name="replaceActive" id="voucherReplaceActive" value="true"> ${h(L("adminReplaceActive"))}</label></div>
    <label class="nd-field"><span class="nd-label">${h(L("adminFieldSaleType"))}</span><select class="nd-input" name="saleType" id="voucherSaleType" required><option value="">${h(L("adminChoose"))}</option><option value="sold" selected>${h(L("adminSaleSold"))}</option>${["owner", "operator"].includes(x.profile.role) ? `<option value="gift">${h(L("adminSaleGift"))}</option>` : ""}</select></label>
    <label class="nd-field"><span class="nd-label">${h(L("adminFieldBundleType"))}</span><select class="nd-input" name="planMode" id="voucherPlanMode"><option value="existing">${h(L("adminBundleExisting"))}</option><option value="custom">${h(L("adminBundleCustom"))}</option></select></label>
    <div id="voucherCustomFields" class="custom-voucher-fields" hidden>
      <label class="nd-field"><span class="nd-label">${h(L("adminFieldVoucherName"))}</span><input class="nd-input" name="name" maxlength="80" placeholder="Weekend resale"></label>
      <label class="nd-field"><span class="nd-label">${h(L("adminFieldResalePrice"))}</span><input class="nd-input" name="price" type="number" min="0" placeholder="1000"></label>
      <label class="nd-field"><span class="nd-label">${h(L("adminFieldDataGb"))}</span><input class="nd-input" name="quotaGb" type="number" min="0.1" step="0.1" placeholder="${h(L("adminFieldDataGbHint"))}"></label>
      <label class="nd-field"><span class="nd-label">${h(L("adminFieldValidityHours"))}</span><input class="nd-input" name="validityHours" type="number" min="1" placeholder="168"></label>
      <label class="nd-field"><span class="nd-label">${h(L("adminFieldDeviceLimit"))}</span><input class="nd-input" name="deviceLimit" type="number" min="1" value="1"></label>
    </div>
  </div></details>
  <p class="nd-hint" id="voucherHelp"></p>
  <button type="submit" class="nd-btn nd-btn--block"></button>
</form><div id="generated" data-sensitive-output role="status" aria-live="polite"></div></section>
<section class="nd-panel admin-vouchers__list" aria-labelledby="voucherRecordsTitle"><div id="activeVoucherPrint" data-sensitive-output role="status" aria-live="polite"></div><div id="voucherRecords"></div></section>
</div></section>
<section class="tab-panel admin-print" id="panel-voucher-print" aria-labelledby="adminTitle" data-tab-panel="voucher-print" ${activeAdminTab === "voucher-print" ? "" : "hidden"}><p class="nd-callout nd-callout--warning admin-print__note">${h(L("adminPrintNote"))}</p><div class="admin-print__tray" id="voucherPrintTray" data-sensitive-output></div></section>
<section class="tab-panel admin-resellers" id="panel-resellers" aria-labelledby="adminTitle" data-tab-panel="resellers" ${activeAdminTab === "resellers" ? "" : "hidden"}><div id="resellerLedger"></div></section>
<section class="tab-panel admin-customers" id="panel-customers" aria-labelledby="adminTitle" data-tab-panel="customers" ${activeAdminTab === "customers" ? "" : "hidden"}><section class="nd-panel admin-customers__list" aria-label="${h(L("adminCustomerList"))}"><div id="customerRecords"></div><p class="nd-meta admin-customers__note">${h(L("adminSuspendNote"))}</p></section><details class="admin-options admin-legacy"><summary>${h(L("adminLegacySessions"))}</summary><p class="nd-meta">${h(L("adminLegacySessionsNote"))}</p><div id="sessionRecords"></div></details></section>
<section class="tab-panel admin-customer" id="panel-customer" aria-labelledby="adminTitle" data-tab-panel="customer" ${activeAdminTab === "customer" ? "" : "hidden"}><div id="customerVoucherPrint" data-sensitive-output role="status" aria-live="polite"></div><div id="customerDetail"></div></section>
<section class="tab-panel admin-payments" id="panel-payments" aria-labelledby="adminTitle" data-tab-panel="payments" ${activeAdminTab === "payments" ? "" : "hidden"}>${access.contacts ? `<div class="nd-metrics admin-payments__metrics">
<div class="nd-metric"><b class="nd-metric__value" id="paymentsTodayBundles">—</b><span class="nd-metric__label">${h(L("adminPaymentsTodayBundles"))}</span></div>
${storeRole ? `<div class="nd-metric"><b class="nd-metric__value" id="paymentsTodayStore">—</b><span class="nd-metric__label">${h(L("adminPaymentsTodayStore"))}</span></div>` : ""}
<div class="nd-metric"><b class="nd-metric__value" id="paymentsWaiting">—</b><span class="nd-metric__label">${h(L("adminPaymentsWaiting"))}</span></div>
<div class="nd-metric"><b class="nd-metric__value" id="paymentsFailedToday">—</b><span class="nd-metric__label">${h(L("adminPaymentsFailedToday"))}</span></div></div>` : ""}
<section class="nd-panel" aria-labelledby="paymentRecordsTitle"><div id="paymentRecords"></div></section>
<section class="nd-panel admin-payments__checks" aria-labelledby="paymentChecksTitle"><h2 class="nd-h2" id="paymentChecksTitle">${h(L("adminChecksTitle"))}</h2>
<h3 class="nd-h3">${h(L("adminReconTitle"))}</h3><p class="nd-meta">${h(L(x.paymentReconciliation?.enabled ? "adminReconOn" : "adminReconOff"))}</p>${x.paymentReconciliation?.issues?.length ? `<table class="nd-table"><thead><tr><th scope="col">${h(L("adminColPayment"))}</th><th scope="col">${h(L("adminColProvider"))}</th><th scope="col">${h(L("adminColFindings"))}</th><th scope="col">${h(L("adminColChecked"))}</th></tr></thead><tbody>${rows(x.paymentReconciliation.issues, (p) => `<tr><td>${h(p.paymentId)}</td><td>${h(p.provider)}</td><td>${h(p.issues.join(", ").replaceAll("_", " "))}</td><td>${h(new Date(p.checkedAt).toLocaleString())}</td></tr>`)}</tbody></table>` : `<p>${h(L("adminReconNone"))}</p>`}
<h3 class="nd-h3">${h(L("adminWebhooksTitle"))}</h3><p class="nd-meta">${h(L("adminWebhooksCount", { pending: x.paymentWebhooks?.pending || 0, review: x.paymentWebhooks?.deadLetters || 0 }))}</p>${x.paymentWebhooks?.events?.length ? `<table class="nd-table"><thead><tr><th scope="col">${h(L("adminColPayment"))}</th><th scope="col">${h(L("adminColProvider"))}</th><th scope="col">${h(L("adminColStatus"))}</th><th scope="col">${h(L("adminColAttempts"))}</th><th scope="col">${h(L("adminColReason"))}</th><th scope="col"><span class="nd-visually-hidden">${h(L("adminColAction"))}</span></th></tr></thead><tbody>${rows(x.paymentWebhooks.events, (event) => `<tr><td>${h(event.paymentId)}</td><td>${h(event.provider)}</td><td>${h(event.status.replaceAll("_", " "))}</td><td>${h(event.totalAttempts)}</td><td>${h((event.lastError || "").replaceAll("_", " "))}</td><td>${["retry", "dead_letter"].includes(event.status) && ["owner", "operator"].includes(x.profile?.role) ? `<button type="button" class="nd-btn nd-btn--sm nd-btn--secondary" data-replay-webhook="${h(event.id)}">${h(L("adminReplay"))}</button>` : ""}</td></tr>`)}</tbody></table>` : `<p>${h(L("adminWebhooksNone"))}</p>`}</section></section>
${x.sales ? `<section class="tab-panel admin-cash" id="panel-cash" aria-labelledby="adminTitle" data-tab-panel="cash" ${activeAdminTab === "cash" ? "" : "hidden"}><div id="cashCollectedReport"></div></section>` : ""}
<section class="tab-panel admin-audit" id="panel-audit" aria-labelledby="adminTitle" data-tab-panel="audit" ${activeAdminTab === "audit" ? "" : "hidden"}><section class="nd-panel admin-audit__list" aria-label="${h(L("adminAuditEntries"))}"><div id="auditRecords"></div></section><details class="admin-options admin-legacy"><summary>${h(L("adminSecurityEvents"))}</summary><p class="nd-meta">${h(L("adminSecurityEventsNote"))}</p><div id="securityRecords"></div></details></section></div>`;
  for (const table of $("#app").querySelectorAll("table")) {
    if (table.closest(".table-scroll, .nd-table-wrap")) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll";
    table.before(wrapper); wrapper.append(table);
  }
  // Customer detail (canvas: AdminCustomerDetail) for #customer/<id>.
  const openCustomer = () => {
    $("#customerVoucherPrint").replaceChildren();
    return showCustomerDetail($("#customerDetail"), { call, id: adminViewParam(), role: adminRole, canManage: canManagePayments, storeRole, setHead: setAdminHead, statusHost: $("#customerStatusHost") });
  };
  let storeManagement;
  if (["owner", "operator"].includes(adminRole)) {
    const panel = document.createElement("section");
    panel.className = "card tab-panel";
    panel.dataset.tabPanel = "store";
    panel.id = "panel-store";
    panel.setAttribute("aria-labelledby", "adminTitle");
    panel.hidden = activeAdminTab !== "store";
    $("#app").append(panel);
    storeManagement = mountStore(panel, { call, role: adminRole, csrf: () => csrfToken });
  }
  if (x.sales) mountCashCollectedReport(x.cashCollected, { resellers: x.resellerLedger?.totals });
  mountAdminNavigation(adminRole, (view) => { activeAdminTab = view; showBatchPrint(view); if (view === "customer") void openCustomer(); if (view === "bundle" && !showBundleEdit(bundleIndex.get(adminViewParam()), { setHead: setAdminHead })) location.replace("/dashboard#bundles"); if (view === "store" || view === "products") void storeManagement?.activate(); if (view === "devices") void refreshWifiSummary(); });
  if (["owner", "operator"].includes(adminRole)) void mountIncidentDetails(call);
  // Home and Payments both read the store's orders; fetch them once.
  const storeSnapshot = storeRole ? call("/api/admin/store").catch(() => null) : Promise.resolve(null);
  void loadHomeAttention(x, storeSnapshot, access.contacts);
  void loadHomePayments();
  if (access.contacts) void loadPaymentFigures({ call, storeRole, storeSnapshot });
  mountAdminInstall($("#adminInstall"));
  renderWifiSummary(x.wifi);
  $("#refreshWifi").onclick = async (event) => {
    await runAction(event.currentTarget, L("adminRequestingReading"), async () => {
      const result = await call("/api/admin/wifi-devices/refresh", { method: "POST", body: "{}" });
      renderWifiSummary(result);
      $("#wifiMessage").textContent = L(result.state === "refreshing" || result.state === "retrying" ? "adminWifiRequested" : "adminWifiCurrent");
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
    if ($("#voucherResellerField")) {
      const hasResellerOptions = ($("#voucherResellerSelect")?.options?.length || 0) > 1;
      $("#voucherResellerField").hidden = !resale || !["owner", "operator"].includes(adminRole) || !hasResellerOptions;
    }
    $("#voucherExistingPlan").hidden = custom;
    $("#voucherCustomFields").hidden = !custom;
    $("#voucherHelp").textContent = L(resale ? "adminVoucherHelpResale" : "adminVoucherHelpAssigned");
    // Canvas: "Create 20 vouchers", following How many.
    const count = Math.max(1, Math.floor(Number(form.elements.quantity.value) || 1));
    form.querySelector('button[type="submit"]').textContent = resale
      ? (count === 1 ? L("adminCreateVoucherOne") : L("adminCreateVouchers", { count }))
      : L("adminCreateAssigned");
    for (const input of $("#voucherCustomFields").querySelectorAll("input")) {
      input.required = custom && input.name !== "quotaGb";
    }
  };
  $("#voucherPurpose").onchange = updateVoucherBuilder;
  // "Replace bundle" on a customer: Vouchers with an assigned voucher for them,
  // replacing their active bundle. The picker searches by their phone.
  prefillAssignedVoucher = (phone) => {
    $("#voucherOptions").open = true;
    $("#voucherPurpose").value = "assigned";
    $("#customerSearch").value = phone;
    const picker = customerPicker;
    updateVoucherBuilder({ target: $("#voucherPurpose") });
    if (picker) $("#customerSearch").dispatchEvent(new Event("input"));
    $("#voucherReplaceActive").checked = true;
    location.hash = "vouchers";
  };
  $("#generate").elements.quantity.oninput = updateVoucherBuilder;
  $("#voucherPlanMode").onchange = updateVoucherBuilder;
  updateVoucherBuilder();
  $("#bundle").onsubmit = async (e) => {
    e.preventDefault();
    // Blank data means unlimited; the API reads an empty string as 0 GB.
    const fields = Object.fromEntries(new FormData(e.target));
    if (fields.quotaGb === "") fields.quotaGb = null;
    await runAction(e.target.querySelector("button[type=submit]"), L("adminSaving"), async () => {
      await call("/api/admin/bundles", {
        method: "POST",
        body: JSON.stringify(fields),
      });
      await load();
    }, "#bundleMessage");
  };
  $("#bundleEdit").onsubmit = async (e) => {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(e.target));
    delete fields.unlimited;
    if (e.target.elements.unlimited.checked) fields.quotaGb = "";
    await runAction(e.target.querySelector("button[type=submit]"), L("adminSaving"), async () => {
      await call("/api/admin/bundles/update", { method: "POST", body: JSON.stringify(fields) });
      await load();
      // load() redraws the screen; say so on the fresh form.
      const message = $("#bundleEditMessage");
      if (message) { message.dataset.forBundle = fields.bundleId; message.textContent = L("adminBundleSaved"); }
    }, "#bundleEditMessage");
  };
  const resellerLedgerView = mountResellerLedger($("#resellerLedger"), {
    initialLedger: x.resellerLedger,
    scopeKey: x.scopeKey,
    role: adminRole,
    call,
  });
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
      clearPrintContainers();
      // Canvas: a ready box with Print slips, which opens the print screen.
      const resellerName = $("#voucherResellerSelect")?.selectedOptions[0]?.value ? $("#voucherResellerSelect").selectedOptions[0].textContent : "";
      lastBatch = { vouchers, plan: result.plan, reseller: resellerName };
      $("#generated").innerHTML = `<div class="admin-batch"><div class="generated-heading"><strong>${h(vouchers.length === 1 ? L("adminGeneratedOne") : L("adminGeneratedMany", { count: vouchers.length }))}</strong><p class="nd-meta">${h(L(result.voucher.status === "available" ? "adminGeneratedResale" : result.replacedVoucher ? "adminGeneratedReplaced" : "adminGeneratedAssigned"))}</p></div><div class="generated-codes">${vouchers.map((voucher) => `<code>${h(voucher.code)}</code>`).join("")}</div><a class="nd-btn nd-btn--dark nd-btn--block" href="/dashboard#voucher-print">${h(L("adminPrintSlips"))}</a><div class="admin-batch__more"><button type="button" class="nd-btn nd-btn--compact nd-btn--quiet" id="downloadVouchers">${h(L("adminDownloadCsv"))}</button><button type="button" class="nd-btn nd-btn--compact nd-btn--quiet" id="closeGenerated">${h(L("adminCloseCodes"))}</button></div></div>`;
      $("#closeGenerated").onclick = () => { clearPrintContainers(); lastBatch = null; $("#generate").reset(); updateVoucherBuilder(); };
      $("#downloadVouchers").onclick = () => {
        const csv = ["code,bundle,status", ...vouchers.map((voucher) => `${voucher.code},"${String(result.plan.name).replaceAll('"', '""')}",${voucher.status}`)].join("\n"),
          link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        link.download = `ndahi-vouchers-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
      };
      void voucherRecords?.refresh();
      await resellerLedgerView.refresh();
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

}
function mountRecordViews(canManagePayments, retired) {
  const date = (value) => (value ? h(new Date(value).toLocaleString()) : "");
  void mountCustomerRecords($("#customerRecords"), { call, searchHost: $("#customerSearchHost") });
  wifiRecords = mountDeviceRecords($("#wifiRecords"), { call, canManage: canManagePayments });
  void mountRecords($("#sessionRecords"), {
    call,
    collection: "sessions",
    title: "Legacy application sessions",
    headers: ["Device", "Device ID", "Status", "Last seen", "Actions"],
    row: (s) => `<tr><td>${h(s.label)}</td><td>${h(s.deviceId)}</td><td>${h(s.status)}</td><td>${date(s.lastSeenAt)}</td><td><a href="/dashboard#devices">Open live devices</a></td></tr>`,
  });
  if (!retired) {
  }
  voucherRecords = mountVoucherRecords($("#voucherRecords"), { call, canManagePayments });
  void mountPaymentRecords($("#paymentRecords"), { call, canManagePayments });
  void mountAuditRecords($("#auditRecords"), { call });
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
  if (button.dataset.replaceBundle) {
    prefillAssignedVoucher(button.dataset.replacePhone || "");
    return;
  }
  if (!["deleteBundle", "resendEmail", "classify", "voucher", "printVoucher", "printCustomerVoucher", "resetAuthenticator", "customer", "wifiVoucher", "session", "replayWebhook", "replayCommand", "resolveCommand", "checkRefund", "refund", "verifyPayment"].some((key) => button.dataset[key])) return;
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
    } else if (button.dataset.printVoucher) {
      const result = await call("/api/admin/vouchers/print", {
        method: "POST",
        body: JSON.stringify({ voucherId: button.dataset.printVoucher }),
      });
      openSingleVoucherPrintPreview($("#activeVoucherPrint"), result);
      return;
    } else if (button.dataset.printCustomerVoucher) {
      const result = await call("/api/admin/vouchers/print", {
        method: "POST",
        body: JSON.stringify({ customerId: button.dataset.printCustomerVoucher }),
      });
      openSingleVoucherPrintPreview($("#customerVoucherPrint"), result);
      return;
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
  target.textContent = deviceSummaryText(summary);
  const live = $("#wifiLive");
  if (live) live.dataset.state = summary.live === false ? "off" : summary.state || "";
  if (summary.refresh?.canReplay && ["owner", "operator"].includes(adminRole)) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "nd-btn nd-btn--compact nd-btn--secondary";
    retry.textContent = L("adminRetryReading");
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
startUpdates({ isBusy: () => passkeyEnrollmentRunning || Boolean(document.querySelector(' [data-sensitive-output]:not(:empty), [data-review-output]:not(:empty), [data-setup-pending="true"]')) });
