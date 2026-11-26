import { mountCashCollectedReport } from "/cash-collected.js";
import { mountCustomerVoucher, voucherPlanDetail } from "/customer-voucher.js";
import { mountVoucherRecords } from "/vouchers.js";
import { mountCustomerRecords, showCustomerDetail } from "/customers.js";
import { showVoucherDetail } from "/voucher-detail.js";
import { mountBundleEdit } from "/bundles.js";
import { mountCatalogue } from "/bundle-catalogue.js";
import { liveSummaryText, mountLiveDevices } from "/devices.js";
import { adminSecurity, mountServiceTests, serviceCards } from "/connections.js";
import { exportAudit, mountAuditRecords } from "/audit.js";
import { mountProfile, profileMarkup, deviceLabel } from "/profile.js";
// Registers the service worker (offline launch, updates); Profile no longer shows the install card (#389).
import "/install.js";
import { downloadPaymentsExport, mountPaymentRecords, showPaymentFigures } from "/payments.js";
import { homeMetricsMarkup, loadHomeAttention, loadHomePayments } from "/admin-home.js";
import { mountStore } from '/store.js';
import { requestAdminActionProof } from "/action-proof.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { mountNetworkSetup } from "/network-setup.js";
import { mountCustomerPicker, mountRecords } from "/records.js";
import { runButton } from "/shared/pending.js";
import { startUpdates } from "/shared/updates.js";
import { activeAdminView, adminViewParam, mountAdminNavigation, setAdminHead } from "/navigation.js";
import { mountNotifications } from "/shared/notifications.js";
import { openAuthenticatorRecovery } from "/authenticator-recovery.js";
import { mountIncidentDetails } from "/incident-details.js";
import { mountInsights } from "/insights.js";
import { mountGeneratedVoucherPrint } from "/voucher-print.js";
import { mountResellerLedger } from "/reseller-ledger.js";
import { mountResellerHome } from "/reseller-home.js";
import { format, t } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { updateHomeRouterMenu } from "/home-entry.js";
import { showOutages } from "./outages.js";
import { showPromotions } from "./promotions.js";

const api = window.NDAHI_CONFIG.apiUrl,
  $ = (s) => document.querySelector(s),
  rows = (items, render) => items.map(render).join("");
let bundleIndex = new Map();
const fcfa = (amount) => `${Number(amount || 0).toLocaleString()} FCFA`;
let activeAdminTab = "home", liveDevices, liveRows = [], wifiTimer, wifiLoading = false, adminRole, wifiLive = false, adminAuthenticatorRetired = false;
let csrfToken = "";
let passkeyEnrollmentRunning = false;
let activePrintController = null;
// The last generated batch, kept in memory only for its print screen.
let lastBatch = null, voucherRecords, prefillAssignedVoucher = () => {};
function clearPrintContainers() {
  activePrintController?.destroy();
  activePrintController = null;
  for (const selector of ["#generated", "#activeVoucherPrint", "#customerVoucherPrint", "#voucherDetailPrint", "#voucherPrintTray", "#voucherPrintActions"]) {
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
  // The batch result is transient (canvas: AdminVouchers, #343; no Close codes):
  // leaving Vouchers for anything but its print screen clears it, so held app
  // updates can apply.
  if (lastBatch && !["vouchers", "voucher-create", "voucher-print"].includes(view)) { clearPrintContainers(); lastBatch = null; }
  const tray = $("#voucherPrintTray");
  if (!tray) return;
  if (view !== "voucher-print") {
    if (tray.childElementCount) { activePrintController?.destroy(); activePrintController = null; tray.replaceChildren(); $("#voucherPrintActions")?.replaceChildren(); }
    return;
  }
  if (!lastBatch) { location.replace("/dashboard#vouchers"); return; }
  const { vouchers, plan, reseller } = lastBatch, count = vouchers.length, batch = vouchers[0]?.batchReference;
  // Canvas: "Print batch B-1110-03" over "20 slips · [PLAN 2] · for [RESELLER] ·
  // …"; the slips stay thermal (owner, #208, #240), so the line ends with
  // the width chosen, and the batch reference is the server's (#392).
  const lede = (layout) => [count === 1 ? L("adminSlipsOne") : L("adminSlips", { count }), plan?.name, reseller ? L("adminForName", { name: reseller }) : "",
    L(layout === "thermal-80" ? "adminPrintWidth80" : "adminPrintWidth58")].filter(Boolean).join(" · ");
  setAdminHead({
    title: batch ? L("adminPrintBatchTitle", { batch }) : count === 1 ? L("adminPrintTitleOne", { code: vouchers[0].code }) : L("adminPrintTitle", { count }),
    lede: lede("thermal-58"),
  });
  // Accurate wording (owner, 25 Nov, #392): codes work as soon as they're made.
  const note = $(".admin-print__note");
  if (note) note.textContent = L(reseller ? "adminPrintNoteReseller" : "adminPrintNotePerson");
  tray.innerHTML = '<div id="voucherPrintPreview"></div>';
  activePrintController = mountGeneratedVoucherPrint({
    container: $("#voucherPrintPreview"),
    toolbar: $("#voucherPrintActions"),
    vouchers,
    plan,
    layout: "thermal-58",
    onLayout: (layout) => setAdminHead({ lede: lede(layout) }),
    labels: { region: L("adminPrintRegion"), format: L("adminPrintFormat"), thermal58: L("adminThermal58"), thermal80: L("adminThermal80"), print: count === 1 ? L("adminPrintOne") : L("adminPrintMany", { count }), openHere: L("adminPrintOpenHere"), sent: L("adminPrintSent") },
  });
}

window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  const message = document.querySelector("#actionMessage") || document.querySelector("#app");
  message.textContent = event.reason?.message || "The action could not be completed.";
});
async function call(path, { preservePageOnUnavailable = false, ...options } = {}) {
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
  if (r.status === 503 && !preservePageOnUnavailable && path !== "/api/admin/network/setup/purchase-access" && !path.startsWith("/api/admin/store")) {
    sessionStorage.setItem("ndahi-admin-login-notice", j.error || "Administration is temporarily unavailable while setup is completed.");
    location.replace("/login");
    throw Error("Service setup incomplete");
  }
  if (!r.ok) throw Object.assign(Error(j.error), { status: r.status, code: j.code, activeBundle: j.activeBundle });
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
// Router checks tables (#232): "sync_voucher" → "Sync voucher"; a long id
// shortened with the full one on hover; times as "10 Nov 17:25" in Douala.
const sentence = (value) => { const text = String(value || "").replaceAll("_", " ").trim(); return text ? text[0].toUpperCase() + text.slice(1) : ""; };
const shortId = (value) => { const id = String(value || ""); return id.length > 14 ? `<span title="${h(id)}">${h(id.slice(0, 8))}…</span>` : h(id || "—"); };
const stamp = (value) => {
  const at = new Date(value), loc = currentLanguage() === "fr" ? "fr-FR" : "en-GB";
  return Number.isFinite(+at) ? `${at.toLocaleDateString(loc, { day: "numeric", month: "short", timeZone: "Africa/Douala" })} ${at.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Douala" })}` : "—";
};
const commandStatus = (status) => (format(`adminCommandStatus_${status}`, {}, "en") !== `adminCommandStatus_${status}` ? L(`adminCommandStatus_${status}`) : sentence(status));


async function load() {
  const x = await call("/api/admin/dashboard");
  adminRole = x.profile.role;
  adminAuthenticatorRetired = x.profile.authenticatorRetired === true;
  wifiLive = x.wifi.live;
  activeAdminTab = activeAdminView(adminRole);
  if (adminRole === "reseller") { resellerHome ||= mountResellerHome({ call, logout: signOut }); resellerHome.setView(activeAdminTab); }
  csrfToken = x.csrfToken;
  mountNotifications({ apiUrl: api, path: "/api/admin/notifications", csrf: () => csrfToken, admin: true });
  const canManagePayments = ["owner", "operator"].includes(x.profile?.role),
    bundleOptions = rows(
      x.bundles,
      (b) => `<option value="${h(b.id)}">${h(b.name)} · ${h(voucherPlanDetail(b))}</option>`,
    );
  bundleIndex = new Map(x.bundles.map((bundle) => [bundle.id, bundle]));
  // Restricted dashboards include zero-valued record totals. Only the role's
  // actual capabilities permit contact/payment views; counts are not grants.
  const storeRole = canManagePayments, access = { contacts: canManagePayments, codes: canManagePayments || adminRole === "reseller" };
  $("#adminHeadActions").innerHTML = `${access.codes ? `<a class="nd-btn nd-btn--sm nd-btn--secondary" data-head-view="home" href="/dashboard#vouchers">${h(L("adminHomePrintVouchers"))}</a>` : ""}${storeRole ? `<a class="nd-btn nd-btn--sm" data-head-view="home" href="/dashboard#product/new">${h(L("adminHomeAddProduct"))}</a><a class="nd-btn nd-btn--sm admin-cat__add" data-head-view="bundles" href="/dashboard#bundle/new">${h(L("adminAddBundle"))}</a><span data-head-view="bundle" id="bundleStatusHost"></span>` : ""}<div class="nd-cluster" data-head-view="voucher-print" id="voucherPrintActions"></div><div class="nd-cluster" data-head-view="store" id="storeHeadOrders"></div><div class="nd-cluster" data-head-view="products" id="storeHeadProducts"></div><div class="nd-cluster" data-head-view="product" id="storeHeadProduct"></div>${access.contacts ? `<button type="button" class="nd-btn nd-btn--secondary" data-head-view="audit" id="auditExport">${h(L("adminExport"))}</button>` : ""}<div class="admin-devices__head" data-head-view="devices"><span class="admin-live" id="wifiLive"><span class="admin-live__dot" aria-hidden="true"></span><span id="wifiSummary" role="status" aria-live="polite"></span></span></div><div data-head-view="customers" id="customerSearchHost" class="admin-head-search"></div><div data-head-view="customer" id="customerStatusHost"></div><div data-head-view="voucher" id="voucherStatusHost" class="admin-voucher__head"></div>${access.contacts ? `<button type="button" class="nd-btn nd-btn--secondary" data-head-view="payments" data-payments-export>${h(L("adminExportCsv"))}</button>` : ""}${x.sales ? `<div class="admin-periods" role="group" aria-label="${h(L("adminCashPeriodLabel"))}" data-head-view="cash" id="cashPeriods"></div>` : ""}<span class="admin-resellers__split" data-head-view="resellers" id="resellerSplit"></span>${x.profile.role === "owner" ? `<div class="admin-periods" role="group" aria-label="${h(L("adminInsightsPeriod"))}" data-head-view="insights" id="insightsPeriods"></div>` : ""}`;
  const auditExport = $("#auditExport");
  if (auditExport) auditExport.onclick = () => runAction(auditExport, L("adminExporting"), () => exportAudit(call));
  const paymentsExport = $("[data-payments-export]");
  if (paymentsExport) paymentsExport.onclick = () => runAction(paymentsExport, L("adminExporting"), () => downloadPaymentsExport(api));
  $("#app").innerHTML = `<div id="actionMessage" class="error" role="alert" aria-live="assertive"></div>
${x.deployment?.mode === "setup" ? `<section class="setup-banner" role="status"><div><p class="section-kicker">Setup mode</p><h2>Finish connecting production services</h2><p>The dashboard and stored data are available. Customer purchases stay paused until every required service is connected and <code>BOOTSTRAP_MODE</code> is set to <code>false</code>.</p></div><div class="setup-services">${Object.entries(x.deployment.providers).map(([name, ready]) => `<span class="status-chip ${ready ? "status-good" : "status-warning"}">${h(name)}: ${h(ready === true ? "ready" : ready || "needs setup")}</span>`).join("")}</div></section>` : ""}
<section class="tab-panel admin-home" data-tab-panel="home" id="panel-home" aria-labelledby="adminTitle"><div class="nd-metrics admin-home__metrics">${homeMetricsMarkup(x, { contacts: access.contacts, storeRole })}</div><div class="admin-home__row"><section class="nd-panel admin-home__attention" aria-labelledby="homeAttentionTitle"><h2 class="nd-h2" id="homeAttentionTitle">${h(L("adminAttentionTitle"))}</h2><div id="homeAttention" aria-live="polite"></div></section>
${access.contacts ? `<section class="nd-panel admin-home__payments" aria-labelledby="homePaymentsTitle"><div class="nd-panel__head"><h2 class="nd-h2" id="homePaymentsTitle">${h(L("adminLatestPayments"))}</h2><a class="admin-link" href="/dashboard#payments">${h(L("adminAllPayments"))}</a></div><div class="nd-table-wrap" id="homePayments"></div></section>` : ""}</div></section>
${x.profile.role === "owner" ? `<section class="tab-panel admin-insights" data-tab-panel="insights" id="panel-insights" aria-labelledby="adminTitle" ${activeAdminTab === "insights" ? "" : "hidden"}><div id="insightsHost" aria-live="polite"></div></section>` : ""}
<section class="tab-panel admin-devices" data-tab-panel="devices" id="panel-devices" aria-labelledby="adminTitle" ${activeAdminTab === "devices" ? "" : "hidden"}><p id="wifiMessage" class="nd-meta" role="status" aria-live="polite"></p><div id="liveDevices"></div></section>
<section class="tab-panel admin-profile" id="panel-profile" aria-labelledby="adminTitle" data-tab-panel="profile" ${activeAdminTab === "profile" ? "" : "hidden"}><div class="admin-profile__grid">${profileMarkup(x)}</div></section><div class="tab-panels">
<section class="tab-panel admin-outages" id="panel-outages" aria-labelledby="adminTitle" data-tab-panel="outages" ${activeAdminTab === "outages" ? "" : "hidden"}><div id="outagesHost"></div></section>
${storeRole ? `<section class="tab-panel admin-promotions" id="panel-promotions" aria-labelledby="adminTitle" data-tab-panel="promotions" ${activeAdminTab === "promotions" ? "" : "hidden"}><div id="promotionsHost"></div></section>` : ""}
<section class="tab-panel admin-connections" id="panel-connections" aria-labelledby="adminTitle" data-tab-panel="connections" ${activeAdminTab === "connections" ? "" : "hidden"}><div class="admin-connections__grid" id="serviceCards">${serviceCards(x)}</div>
<section class="nd-panel admin-security" aria-labelledby="adminSecurityTitle"><h2 class="nd-h2" id="adminSecurityTitle">${h(L("adminSecurityTitle"))}</h2>${adminSecurity(x)}</section>
<details class="admin-options admin-legacy admin-connections__more" id="routerChecks"><summary>${h(L("adminMoreRouterChecks"))}</summary><section class="nd-panel admin-payments__checks" aria-labelledby="routerChecksTitle"><h2 class="nd-h2" id="routerChecksTitle">${h(L("adminRouterChecksTitle"))}</h2><div class="nd-cluster"><button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" id="syncUsage">${h(L("adminSyncUsage"))}</button></div><p id="integrationMessage" class="nd-meta" role="status" aria-live="polite"></p><h3 class="nd-h3">${h(L("adminNetworkChecks"))}</h3><p class="nd-meta">${h(L(x.networkReconciliation?.enabled ? "adminNetworkChecksOn" : "adminNetworkChecksOff"))}</p>${x.networkReconciliation?.issues?.length ? `<table class="nd-table"><thead><tr><th>${h(L("adminVoucher"))}</th><th>${h(L("adminColFinding"))}</th><th>${h(L("adminColLastChecked"))}</th></tr></thead><tbody>${rows(x.networkReconciliation.issues, (v) => `<tr><td>${shortId(v.voucherId)}</td><td>${h(sentence(v.issue))}</td><td>${h(stamp(v.checkedAt))}</td></tr>`)}</tbody></table>` : `<p>${h(L("adminNetworkChecksNone"))}</p>`}<h3 class="nd-h3">${h(L("adminRouterCommands"))}</h3><p class="nd-meta">${h(L("adminRouterCommandsCount", { pending: x.networkCommands?.pending || 0, review: x.networkCommands?.deadLetters || 0 }))}</p>${x.networkCommands?.commands?.length ? `<table class="nd-table"><thead><tr><th>${h(L("adminColCommand"))}</th><th>${h(L("adminColOn"))}</th><th>${h(L("adminColStatus"))}</th><th>${h(L("adminColTries"))}</th><th>${h(L("adminColReason"))}</th><th><span class="nd-visually-hidden">${h(L("adminColCommandActions"))}</span></th></tr></thead><tbody>${rows(x.networkCommands.commands, (c) => `<tr><td>${h(sentence(c.action))}</td><td>${shortId(c.targetId)}</td><td>${h(commandStatus(c.status))}</td><td>${h(c.totalAttempts)}</td><td>${h(sentence(c.lastError || ""))}</td><td>${["owner", "operator"].includes(x.profile?.role) ? `${c.canReplay ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-replay-command="${h(c.id)}">${h(L("adminReplay"))}</button>` : ""}${c.recoveryAction === "refresh_devices" ? `<a href="/dashboard#devices">${h(L("adminRefreshDevicesLink"))}</a>${c.canResolve ? ` <button type="button" class="nd-btn nd-btn--compact nd-btn--quiet" data-resolve-command="${h(c.id)}">${h(L("adminMarkObsolete"))}</button>` : ""}` : ""}` : ""}</td></tr>`)}</tbody></table>` : `<p>${h(L("adminRouterCommandsNone"))}</p>`}</section></details></section>
${x.profile.role === "owner" ? `<section class="tab-panel admin-setup" id="panel-network-setup" aria-labelledby="adminTitle" data-tab-panel="network-setup" ${activeAdminTab === "network-setup" ? "" : "hidden"}><div id="networkSetup"></div></section>` : ""}
<section class="tab-panel admin-bundles" id="panel-bundles" aria-labelledby="adminTitle" data-tab-panel="bundles" ${activeAdminTab === "bundles" ? "" : "hidden"}><div id="bundleCatalogue"></div></section>
<section class="tab-panel admin-bundle-edit" id="panel-bundle-edit" aria-labelledby="adminTitle" data-tab-panel="bundle-edit" ${activeAdminTab === "bundle" ? "" : "hidden"}><div id="bundleEditor"></div></section>
<section class="tab-panel admin-vouchers" id="panel-vouchers" aria-labelledby="adminTitle" data-tab-panel="vouchers" ${activeAdminTab === "vouchers" ? "" : "hidden"}><div class="admin-vouchers__row">
<section class="nd-panel admin-vouchers__create" aria-label="${h(L("adminGiveNew"))}">${canManagePayments ? `<div id="voucherModes" class="customer-voucher__modes" role="tablist" aria-label="${h(L("adminGiveModeLabel"))}"><button type="button" role="tab" id="voucherModeCustomer" data-voucher-mode="customer" aria-controls="customerVoucher" aria-selected="true">${h(L("adminGiveModeCustomer"))}</button><button type="button" role="tab" id="voucherModeBatch" data-voucher-mode="batch" aria-controls="voucherBatch" aria-selected="false" tabindex="-1">${h(L("adminGiveModeBatch"))}</button></div><div id="customerVoucher" role="tabpanel" aria-labelledby="voucherModeCustomer"></div>` : ""}<div id="voucherBatch" ${canManagePayments ? 'role="tabpanel" aria-labelledby="voucherModeBatch"' : ""}><h2 class="nd-h2 nd-visually-hidden" id="voucherCreateTitle">${h(L("adminVoucherCreateTitle"))}</h2><form id="generate" class="admin-form">
  <p class="nd-meta" id="voucherHelp"></p>
  <label class="nd-field" id="voucherExistingPlan"><span class="nd-label">${h(L("adminFieldBundle"))}</span><select class="nd-input" name="planId">${bundleOptions}</select></label>
  <div class="admin-form__pair">
    <label class="nd-field" id="voucherQuantity"><span class="nd-label">${h(L("adminFieldHowMany"))}</span><input class="nd-input" name="quantity" type="number" min="1" max="100" value="1"></label>
    <label class="nd-field" id="voucherResellerField" ${["owner", "operator"].includes(x.profile.role) && x.resellerLedger?.resellers?.some((r) => r.active && r.role === "reseller") ? "" : "hidden"}><span class="nd-label">${h(L("adminFieldForReseller"))}</span><select class="nd-input" name="assignedResellerId" id="voucherResellerSelect"><option value="">${h(L("adminFieldNone"))}</option>${rows((x.resellerLedger?.resellers || []).filter((r) => r.active && r.role === "reseller"), (r) => `<option value="${h(r.resellerId)}" data-name="${h(r.displayName || r.username)}">${h(r.displayName || r.username)} (@${h(r.username)})</option>`)}</select></label>
  </div>
  <button type="submit" class="nd-btn nd-btn--block"></button>
  <details class="admin-options" id="voucherOptions" hidden><summary>${h(L("adminMoreOptions"))}</summary><div class="admin-options__body">
    <label class="nd-field" hidden><span class="nd-label">${h(L("adminFieldPurpose"))}</span><select class="nd-input" name="purpose" id="voucherPurpose"><option value="resale">${h(L("adminPurposeResale"))}</option>${access.contacts ? `<option value="assigned">${h(L("adminPurposeAssigned"))}</option>` : ""}</select></label>
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
</form><div id="generated" data-sensitive-output role="status" aria-live="polite"></div></div></section>
<section class="nd-panel admin-vouchers__list" aria-labelledby="voucherRecordsTitle"><div id="activeVoucherPrint" data-sensitive-output role="status" aria-live="polite"></div><div id="voucherRecords"></div></section>
</div></section>
<section class="tab-panel admin-print" id="panel-voucher-print" aria-labelledby="adminTitle" data-tab-panel="voucher-print" ${activeAdminTab === "voucher-print" ? "" : "hidden"}><p class="nd-callout nd-callout--warning admin-print__note">${h(L("adminPrintNotePerson"))}</p><div class="admin-print__tray" id="voucherPrintTray" data-sensitive-output></div></section>
<section class="tab-panel admin-resellers" id="panel-resellers" aria-labelledby="adminTitle" data-tab-panel="resellers" ${activeAdminTab === "resellers" ? "" : "hidden"}><div id="resellerLedger"></div></section>
<section class="tab-panel admin-customers" id="panel-customers" aria-labelledby="adminTitle" data-tab-panel="customers" ${activeAdminTab === "customers" ? "" : "hidden"}><div id="customerFilters"></div><section class="nd-panel admin-customers__list" aria-label="${h(L("adminCustomerList"))}"><div id="customerRecords"></div><p class="nd-meta admin-customers__note" id="customerNote">${h(L("adminSuspendNote"))}</p></section><details class="admin-options admin-legacy"><summary>${h(L("adminLegacySessions"))}</summary><p class="nd-meta">${h(L("adminLegacySessionsNote"))}</p><div id="sessionRecords"></div></details></section>
<section class="tab-panel admin-voucher-page" id="panel-voucher" aria-labelledby="adminTitle" data-tab-panel="voucher" ${activeAdminTab === "voucher" ? "" : "hidden"}><div id="voucherDetail"></div></section>
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
<section class="tab-panel admin-audit" id="panel-audit" aria-labelledby="adminTitle" data-tab-panel="audit" ${activeAdminTab === "audit" ? "" : "hidden"}><section class="nd-panel admin-audit__list" aria-label="${h(L("adminAuditEntries"))}"><div id="auditRecords"></div></section><details class="admin-options admin-legacy admin-audit__tools"><summary>${h(L("adminAuditTools"))}</summary><div class="admin-options__body"><div class="admin-audit__search" id="auditSearchHost"></div><h3 class="nd-h3">${h(L("adminSecurityEvents"))}</h3><p class="nd-meta">${h(L("adminSecurityEventsNote"))}</p><div id="securityRecords"></div></div></details></section></div>`;
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
  // Voucher detail (canvas: AdminVoucherDetail) for #voucher/<id>.
  const openVoucher = () => showVoucherDetail($("#voucherDetail"), { call, id: adminViewParam(), canManage: canManagePayments, setHead: setAdminHead,
    statusHost: $("#voucherStatusHost"), printPreview: openSingleVoucherPrintPreview });
  let storeManagement;
  if (["owner", "operator"].includes(adminRole)) {
    const panel = document.createElement("section");
    panel.className = "tab-panel admin-store-panel";
    panel.dataset.tabPanel = "store";
    // v2 id: v1's #panel-store rules in styles.css would override the kit look.
    panel.id = "panel-store-v2";
    panel.setAttribute("aria-labelledby", "adminTitle");
    panel.hidden = !["store", "products", "product"].includes(activeAdminTab);
    $("#app").append(panel);
    storeManagement = mountStore(panel, { call, role: adminRole, csrf: () => csrfToken, setHead: setAdminHead,
      heads: { store: $("#storeHeadOrders"), products: $("#storeHeadProducts"), product: $("#storeHeadProduct") } });
  }
  // Cash and settlements (#379): opens on the last 7 days; the period buttons fetch the others.
  if (x.sales) mountCashCollectedReport(x.cashReport, { call });
  let customerVoucher;
  // Catalogue managers only (owners and operators; the API refuses others).
  const catalogue = storeRole && $("#bundleCatalogue") ? mountCatalogue($("#bundleCatalogue"), { call }) : null;
  const bundleEditor = storeRole && $("#bundleEditor") ? mountBundleEdit($("#bundleEditor"), { call, setHead: setAdminHead, statusHost: $("#bundleStatusHost"), speedLimitsOn: x.integrations?.speedLimits === "on" }) : null;
  // Insights (#382): owners only; loads when shown.
  const insights = x.profile.role === "owner" ? mountInsights($("#insightsHost"), $("#insightsPeriods"), { call }) : null;
  mountAdminNavigation(adminRole, (view) => { activeAdminTab = view; if (view === "insights") void insights?.show(); if (view === "bundles") void catalogue?.refresh(); resellerHome?.setView(view); if (view === "outages") void showOutages($("#outagesHost"), { call }); if (view === "promotions" && $("#promotionsHost")) void showPromotions($("#promotionsHost"), { call }); showBatchPrint(view); if (view === "vouchers" && location.hash === "#voucher-create") customerVoucher?.showMode("batch"); if (view === "customer") void openCustomer();
    if (view === "voucher") void openVoucher(); else { $("#adminTitle")?.classList.remove("admin-title--code"); $("#adminTitle")?.parentElement?.classList.remove("admin-head-title--inline"); } if (view !== "bundle") $("#adminTitle")?.classList.remove("admin-title--sub"); if (view === "bundle") void bundleEditor?.open(adminViewParam()).then((shown) => { if (!shown) location.replace("/dashboard#bundles"); }); if (["store", "products", "product"].includes(view)) void storeManagement?.activate(view, adminViewParam()); if (view === "devices") void refreshWifiSummary(); });
  if (["owner", "operator"].includes(adminRole)) void mountIncidentDetails(call);
  // Home and Payments both read the store's orders; fetch them once.
  const storeSnapshot = storeRole ? call("/api/admin/store").catch(() => null) : Promise.resolve(null);
  void loadHomeAttention(x, storeSnapshot, access.contacts);
  if (access.contacts) void loadHomePayments(call);
  void updateHomeRouterMenu(adminRole, api);
  if (access.contacts) showPaymentFigures(x, { storeRole });
  // No install card on Profile (canvas: AdminProfile, #389; owner 26 Nov): staff install from the browser menu.
  mountProfile({ call, runAction, reload: load });
  // Live devices (#381): the router is read automatically; the screen has no Refresh, as drawn.
  renderWifiSummary(x.wifi);
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
  $("#generate").hidden = !access.codes;
  $("#voucherPurpose").onchange = updateVoucherBuilder;
  // Opening a customer never grants consent to replace their active bundle.
  prefillAssignedVoucher = (id) => { customerVoucher?.open(id); location.hash = "vouchers"; };
  $("#generate").elements.quantity.oninput = updateVoucherBuilder;
  $("#voucherPlanMode").onchange = updateVoucherBuilder;
  updateVoucherBuilder();
  const resellerLedgerView = mountResellerLedger($("#resellerLedger"), {
    initialLedger: x.resellerLedger,
    scopeKey: x.scopeKey,
    role: adminRole,
    call,
    // "Recorded … · by Owner": the name of whoever is signed in (#390).
    staff: { username: x.profile?.username, label: x.profile?.displayName || x.profile?.username || "" },
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
      // The print screen names the reseller as the canvas does: "for Market kiosk".
      const resellerName = $("#voucherResellerSelect")?.selectedOptions[0]?.value ? $("#voucherResellerSelect").selectedOptions[0].dataset.name : "";
      lastBatch = { vouchers, plan: result.plan, reseller: resellerName };
      // As drawn (canvas: AdminVouchers, #343; owner 26 Nov): "Batch B-1110-03 ready · 20 codes"
      // and Print slips; the codes are on the print screen and in Recent vouchers.
      const reference = vouchers[0]?.batchReference || "";
      $("#generated").innerHTML = `<div class="admin-batch admin-batch--ready"><strong>${h(reference ? L("adminBatchReady", { batch: reference, count: vouchers.length }) : vouchers.length === 1 ? L("adminGeneratedOne") : L("adminGeneratedMany", { count: vouchers.length }))}</strong><a class="nd-btn nd-btn--dark nd-btn--block" href="/dashboard#voucher-print">${h(L("adminPrintSlips"))}</a></div>`;
      void voucherRecords?.refresh();
      await resellerLedgerView.refresh();
    });
  };
  customerVoucher = mountCustomerVoucher($("#customerVoucher"), {
    call, plans: x.bundles.filter(p => !p.resale && p.discontinued !== true), role: adminRole,
    // Switching to "For one customer" clears a batch result too.
    onMode: mode => { if (mode === "customer" && lastBatch) { clearPrintContainers(); lastBatch = null; } },
    onReady: result => {
      clearPrintContainers(); lastBatch = result ? { vouchers: result.vouchers || [result.voucher], plan: result.plan, reseller: "" } : null;
      // Voucher-list reads preserve this receipt during temporary outages.
      void voucherRecords?.refresh();
    },
  });
  void mountNetworkSetup($("#networkSetup"), call);
  mountRecordViews(canManagePayments, new Map((x.resellerLedger?.resellers || []).map((r) => [r.resellerId, r.displayName || r.username])));
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
  mountServiceTests($("#serviceCards"), call);
  // "N stuck" in Admin security opens the router checks below it.
  $("[data-open-router-checks]")?.addEventListener("click", (event) => {
    event.preventDefault();
    const more = $("#routerChecks");
    more.open = true;
    more.scrollIntoView({ block: "start" });
    more.querySelector("summary").focus({ preventScroll: true });
  });
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
      result = await call("/api/admin/profile/passkeys/verify", { method: "POST", body: JSON.stringify({ challengeId: result.challengeId, response: credential, label: deviceLabel() }) });
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
function mountRecordViews(canManagePayments, resellerNames = new Map()) {
  liveDevices = mountLiveDevices($("#liveDevices"), { call, canManage: canManagePayments, refresh: refreshWifiSummary });
  voucherRecords = mountVoucherRecords($("#voucherRecords"), { call, canManagePayments, resellerName: (id) => resellerNames.get(id) || "" });
  if (!canManagePayments) return;
  const date = (value) => (value ? h(new Date(value).toLocaleString()) : "");
  void mountCustomerRecords($("#customerRecords"), { call, searchHost: $("#customerSearchHost"), filtersHost: $("#customerFilters"), noteHost: $("#customerNote"), api, bundles: [...bundleIndex.values()] });
  void mountRecords($("#sessionRecords"), {
    call,
    collection: "sessions",
    title: "Legacy application sessions",
    headers: ["Device", "Device ID", "Status", "Last seen", "Actions"],
    row: (s) => `<tr><td>${h(s.label)}</td><td>${h(s.deviceId)}</td><td>${h(s.status)}</td><td>${date(s.lastSeenAt)}</td><td><a href="/dashboard#devices">Open live devices</a></td></tr>`,
  });
  void mountPaymentRecords($("#paymentRecords"), { call, canManagePayments });
  void mountAuditRecords($("#auditRecords"), { call, searchHost: $("#auditSearchHost") });
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
    prefillAssignedVoucher(button.dataset.replaceBundle);
    return;
  }
  if (!["resendEmail", "classify", "voucher", "printVoucher", "printCustomerVoucher", "resetAuthenticator", "removeCustomerPasskeys", "changeCustomerPhone", "customer", "wifiVoucher", "session", "replayWebhook", "replayCommand", "resolveCommand", "checkRefund", "refund", "verifyPayment", "verifyOrder"].some((key) => button.dataset[key])) return;
  await runAction(button, "Working…", async () => {
    if (button.dataset.printVoucher) {
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
    } else if (button.dataset.changeCustomerPhone) {
      openAuthenticatorRecovery({ customerId: button.dataset.changeCustomerPhone, call, opener: button, purpose: "phone" }); return;
    } else if (button.dataset.removeCustomerPasskeys) {
      openAuthenticatorRecovery({ customerId: button.dataset.removeCustomerPasskeys, call, opener: button, purpose: "passkeys" }); return;
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
      await refreshWifiSummary();
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
      // A check only asks the provider about this one payment, so it runs at once, as drawn (#386).
      await call("/api/admin/payments/verify", {
        method: "POST",
        body: JSON.stringify({ paymentId: button.dataset.verifyPayment }),
      });
    } else if (button.dataset.verifyOrder) {
      // A store order's payment, through the store's own check of that order (#386).
      await call("/api/admin/store/orders/update", {
        method: "POST",
        body: JSON.stringify({ id: button.dataset.verifyOrder, version: Number(button.dataset.orderVersion), action: "verify" }),
      });
    } else return;
    await load();
  });
};
// A reseller's Home is the ResellerHome phone screen (#261), mounted once.
let resellerHome;
async function signOut() {
  await call("/api/admin/logout", { method: "POST", body: "{}" });
  location.href = "/login";
}
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
  if (Array.isArray(summary.customers)) liveRows = summary.customers;
  target.textContent = liveSummaryText(summary, liveRows);
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
  if (metric && wifiLive) metric.textContent = summary.activeCount == null || summary.unreadVouchers && !summary.activeCount ? L("adminUnavailable") : String(summary.activeCount);
}
async function refreshWifiSummary() {
  if (wifiLoading || document.hidden || !$("#wifiSummary")) return;
  wifiLoading = true;
  try {
    // Live devices also takes its rows (one per customer, #381); Home needs only the counts.
    const result = await call(activeAdminTab === "devices" ? "/api/admin/wifi-devices?customers=1" : "/api/admin/wifi-devices");
    renderWifiSummary(result);
    if (result.customers) liveDevices?.update(result);
  }
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
