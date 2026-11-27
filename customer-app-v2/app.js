import { mountConnectivityBanner } from "./connectivity.js";
import { ApiError, responseError, saveReturnPath, showError } from "./errors.js";
import { applyNetworkStatus, networkBannerState } from "./network-status.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { sessionStore, loadPasskeys, requestJson } from "./compat.js";
import { runButton } from "/shared/pending.js";
import { hotspotPath } from "./hotspot-path.js";
import { deviceIcon, wifiDeviceList } from "./wifi-devices.js";
import { devicesAdd, devicesHead, devicesTip, mountDevicesAdd, updateDevicesCount } from "./portal-devices.js";
import { mountShop, showHomePromo } from "./portal-shop.js";
import { freeMonthCard, bindFreeMonth } from "./promo.js";
import { mountDeviceControls } from "./device-controls.js";
import { mountInstallCard } from "./install.js";
import { activePortalView, mountPortalNavigation } from "./portal-nav.js";
import { profileCard, vouchersCard, bundleCatalogue, voucherAction, homeQuickActions, homeRecentActivity, homeShopItems } from "./portal-content.js";
import { currentLanguage, localize } from "/shared/ui/dom.js";
import { mountProfileEdit, mountEmailLink } from "./profile.js";
import { paymentClock, mountPaymentTimers, ussdInstructions } from "./payment-timing.js";
import { startUpdates } from "./updates.js";
import { migrateLegacyCheckout } from "./checkout-store.js";
import { mountNotifications } from "/shared/notifications.js";
import { t } from "/shared/i18n.js";
import { activeBundleContent, bundlePurchaseContent } from "./active-bundle.js";
import { mountDataBalance } from "./data-balance.js";
import { renewalExtras, showRenewal } from "./renewal.js";
import { mountVoucherHistory } from "./voucher-history.js";
import { outageBanner, outageLine } from "./outage.js";
import { setOutage } from "./active-bundle.js";
import { internetBundle, internetSwitch } from "./portal-internet.js";
import { activityColumns, activityDay, activityFilters, activityIcon, activityMethod, activityOpen, mountActivity, paymentMeta, paymentPill, voucherRows, waitingBanner } from "./portal-activity.js";
import { accountHub, mountAccountHub } from "./portal-account.js";
import { mountCurrentWifi } from "./current-wifi.js";
import { accountSecurityCard, accountSessionsCard, mountAccountSecurity, securityViewState, openSecurityManager } from "./account-security.js";

migrateLegacyCheckout();
const api = window.NDAHI_CONFIG.apiUrl,
  $ = (selector) => document.querySelector(selector),
  deviceId = (() => {
    try { const saved = localStorage.getItem("ndahi-device"); if (saved) return saved; } catch (_) {}
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  })(),
  securitySetup = new URLSearchParams(location.search).get("setup") === "passkey";
let stopConnectivity = () => {};
let csrfToken = "", latestDashboard = null, refreshingPayments = false, stopCurrentWifi = () => {};
let receiptRequest = 0, currentReceipt = null, receiptOpener = null, receiptController = null;
try { localStorage.setItem("ndahi-device", deviceId); } catch (_) { /* Optional browser storage. */ }

async function call(path, options = {}) {
  const { response, body: result } = await requestJson(api + path, { credentials: "include", ...options, headers: { "content-type": "application/json", ...(options.method && options.method !== "GET" && csrfToken ? { "x-csrf-token": csrfToken } : {}), ...(options.headers || {}) } });
  if (response.status === 401 && result.code !== "VERIFICATION_FAILED") {
    saveReturnPath();
    location.replace("/onboarding.html");
    throw responseError(response, result);
  }
  if (!response.ok) throw responseError(response, result);
  return result;
}

function paymentActions(payment, emailLinked) {
  const confirmed = Boolean(payment.confirmedAt) || ["paid", "refunded", "refund-pending"].includes(payment.status),
    receiptAvailable = confirmed && payment.receiptAvailable,
    recheckLabel = ["paid", "refund-pending"].includes(payment.status) && payment.refund?.status === "pending" ? "Check refund status"
      : ["pending", "processing"].includes(payment.status) ? "Check payment status" : "";
  return `${recheckLabel ? `<button type="button" data-recheck-payment="${h(payment.id)}">${recheckLabel}</button>` : ""}${receiptAvailable ? `<button type="button" class="secondary-action" data-view-receipt="${h(payment.id)}">View receipt</button>${emailLinked ? `<button type="button" data-email-receipt="${h(payment.id)}">Email receipt</button><small>Receipt email: ${h(payment.receiptEmail?.status || "awaiting delivery")}</small>` : '<a href="#account">Link an email to receive receipts</a>'}` : ""}<button type="button" class="secondary-action" data-copy-payment="${h(payment.providerReference || payment.id)}">Copy reference</button><a class="payment-help" href="/help#payment">Payment help</a>${confirmed && payment.status === "paid" && !payment.refund ? `<details><summary>Request a refund</summary><form data-refund-payment="${h(payment.id)}"><label>Reason<textarea name="reason" maxlength="500" required></textarea></label><p>Support will review your request. This does not confirm a refund.</p><button>Send refund request</button></form></details>` : ""}`;
}


// Activity row (canvas: PhoneActivity, DesktopActivity): collapsed, the
// canvas row — icon, "Bundle · plan", date and method, status (desktop adds
// amount). Expanded, v1's amount, reference, messages and actions. Rows keep
// their open state across redraws.
const openPayments = new Set();
function paymentRow(payment, customer) {
  const lang = currentLanguage();
  const title = t("adminForBundle", lang).replace("{plan}", payment.plan?.name || payment.planId);
  return `<details class="portal-activity__item" data-payment-row="${h(payment.id)}" data-activity-kind="internet" data-activity-at="${h(payment.createdAt || "")}"${["pending", "processing"].includes(payment.status) ? " data-waiting" : ""}${openPayments.has(payment.id) ? " open" : ""}><summary class="portal-activity__summary">${activityIcon("wifi")}<span class="portal-activity__date nd-wide-only">${h(activityDay(payment.createdAt))}</span><span class="portal-activity__main"><strong>${h(title)}</strong><span class="nd-meta nd-narrow-only">${h(paymentMeta(payment))}</span></span><span class="portal-activity__method nd-wide-only">${h(payment.provider === "mock" ? payment.methodLabel : activityMethod(payment.network))}</span><span class="portal-activity__amount nd-wide-only">${h(payment.amount.toLocaleString())} FCFA</span><span class="portal-activity__status">${paymentPill(payment.status)}</span>${activityOpen(["pending", "processing"].includes(payment.status) ? "portalActivityCheck" : payment.receiptAvailable ? "portalActivityReceipt" : "portalActivityView")}</summary><div class="portal-activity__body"><span class="nd-meta">${h(payment.amount.toLocaleString())} ${h(payment.currency)} · ${h(payment.providerReference || "Awaiting provider reference")}</span><small>Payment number: ${h(payment.payerPhone || "Not recorded")}</small>${paymentClock(payment)}${payment.attention ? `<p role="status">${payment.attention === "refund_overdue" ? "Refund delayed—support review needed." : "Payment received—activation needs support review."}</p>` : ""}${payment.fulfillmentStatus === "needs_review" ? '<p>Payment received. Activation needs support review; do not pay again.</p>' : ""}${payment.recoveryMessage ? `<p>${h(payment.recoveryMessage)}</p>` : ""}${payment.refund ? `<p><strong>Refund: ${h(payment.refund.status)}</strong><br>${h(payment.refund.message || "")}</p>` : ""}<div class="portal-activity__actions">${paymentActions(payment, customer.emailLinked)}</div></div></details>`;
}

// Receipt (canvas: PhoneReceipt, 24 Nov; #369): the brand card, a Payment
// tile and a Wi-Fi tile, the receipt number, the total debited as the provider
// confirmed it (or "Total paid" with the quoted amounts), the rows, and the
// provider reference (or the NDAHI payment ID) with Copy. Each value stays its
// own element for support and tests. Every term comes from the receipt.
const DOUALA = "Africa/Douala";
const receiptXaf = (value, lang) => `${Number(value).toLocaleString(lang === "fr" ? "fr-FR" : "en-US").replace(/[\u202f\u00a0]/g, " ")} XAF`;
const receiptDay = (at, lang) => new Date(at).toLocaleDateString(lang === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short", timeZone: DOUALA });
const receiptTime = (at, lang) => new Date(at).toLocaleTimeString(lang === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: DOUALA });
const receiptWhen = (at, lang) => `${receiptDay(at, lang)}, ${receiptTime(at, lang)}`;
const WALLETS = { mtn: "MTN MoMo", orange: "Orange Money" }, NETWORKS = { mtn: "MTN", orange: "Orange" };
function receiptBundle(receipt, L) {
  const terms = receipt.terms || {}, hours = Number(terms.validityHours), days = hours / 24, name = receipt.plan?.name || L("portalNotRecorded");
  const length = !Number.isFinite(hours) || hours <= 0 ? "" : Number.isInteger(days) ? L(days === 1 ? "portalReceiptOneDay" : "portalReceiptDays").replace("{count}", days) : L(hours === 1 ? "portalReceiptOneHour" : "portalReceiptHours").replace("{count}", hours);
  const devices = (count) => L(count === 1 ? "portalReceiptOneDevice" : "portalReceiptDevicesCount").replace("{count}", count);
  if (terms.accessType === "personal_unlimited") return { bundle: [name, length, Number.isInteger(terms.deviceSlots) ? devices(terms.deviceSlots) : ""].filter(Boolean).join(" · "), validity: length ? L("portalReceiptFromFirst").replace("{length}", length) : L("portalNotRecorded") };
  if (terms.accessType === "home_wisp_unlimited") return { bundle: [name, length].filter(Boolean).join(" · "), validity: length ? L("portalReceiptFromFirst").replace("{length}", length) : L("portalNotRecorded") };
  // A fixed-data bundle keeps its own terms: its data and device rule.
  return { bundle: [name, receipt.dataLabel, Number.isInteger(terms.deviceLimit) ? devices(terms.deviceLimit) : ""].filter(Boolean).join(" · "), validity: length || receipt.validityLabel || L("portalNotRecorded") };
}
function receiptPreview(receipt) {
  const lang = currentLanguage(), L = (key) => t(key, lang), a = receipt.amounts || {}, fee = Number.isFinite(a.fee) && Number.isFinite(a.total);
  const total = receiptXaf(fee ? a.total : a.price, lang), { bundle, validity } = receiptBundle(receipt, L);
  const confirmed = fee && a.confirmed && NETWORKS[receipt.network];
  const act = receipt.activation || {}, actLine = act.state === "active"
    ? L("portalReceiptActiveSince").replace("{time}", receipt.paidAt && receiptDay(act.at, lang) === receiptDay(receipt.paidAt, lang) ? receiptTime(act.at, lang) : receiptWhen(act.at, lang))
    : L({ activating: "portalReceiptActivating", waiting: "portalReceiptStarts", none: "portalReceiptNotActive" }[act.state] || "portalReceiptActivating");
  const actTone = act.state === "active" ? "done" : act.state === "activating" ? "busy" : "idle", actIcon = { done: "✓", busy: "…", idle: "○" }[actTone];
  const wallet = receipt.test ? receipt.methodLabel : WALLETS[receipt.network] || "Mobile Money";
  const ref = receipt.providerRef || receipt.paymentNumber || receipt.paymentId, provider = Boolean(receipt.providerRef);
  const rows = [
    ["portalReceiptBundle", h(bundle)],
    ["portalReceiptPrice", h(receiptXaf(a.price, lang))],
    ...(fee ? [["portalReceiptFee", h(receiptXaf(a.fee, lang))], [confirmed ? "portalReceiptDebited" : "portalReceiptTotal", h(total)]] : []),
    ["portalReceiptValidity", h(validity)],
    ["portalReceiptPaidWith", h([wallet, receipt.payerPhoneMasked].filter(Boolean).join(" · "))],
    ...(receipt.refundStatus ? [["portalReceiptRefund", h(receipt.refundStatus)]] : []),
  ];
  return `<div class="portal-receipt__brand nd-on-forest"><span class="nd-brand__mark" aria-hidden="true">NC</span><span><strong>NDAHI Connect</strong><small>${h(L("portalReceiptWord"))}</small></span></div>
<div class="portal-receipt__tiles"><p class="portal-receipt__tile portal-receipt__tile--done" data-receipt-payment><span aria-hidden="true">✓</span><span><strong>${h(L("portalReceiptPayment"))}</strong>${h(L("portalReceiptConfirmed").replace("{when}", receipt.paidAt ? receiptWhen(receipt.paidAt, lang) : L("portalNotRecorded")))}</span></p><p class="portal-receipt__tile portal-receipt__tile--${actTone}" data-receipt-wifi data-state="${h(act.state || "activating")}"><span aria-hidden="true">${actIcon}</span><span><strong>${h(L("portalReceiptWifi"))}</strong>${h(actLine)}</span></p></div>
<div class="portal-receipt__head"><p class="portal-receipt__meta">${h(L("portalReceiptNo").replace("{number}", receipt.number))}</p><p class="portal-receipt__debited">${h(confirmed ? L("portalReceiptDebitedBy").replace("{network}", NETWORKS[receipt.network]) : L("portalReceiptTotal"))}</p><p class="portal-receipt__amount">${h(total)}</p></div>
<dl class="portal-receipt__details">${rows.map(([key, value]) => `<div><dt>${h(L(key))}</dt><dd>${value}</dd></div>`).join("")}<div class="portal-receipt__ref"><dt>${h(L(provider ? "portalReceiptReference" : "portalReceiptNdahiId"))}</dt><dd><span data-receipt-ref>${h(ref)}</span><button type="button" class="portal-receipt__copy" data-copy-receipt-ref="${h(ref)}">${h(L("portalReceiptCopy"))}</button></dd></div></dl>
${receipt.refundMessage ? `<p class="portal-receipt__help">${h(receipt.refundMessage)}</p>` : ""}
<p class="portal-receipt__help">${h(L("portalReceiptHelp"))} <a href="/help.html">${h(L("portalReceiptContact"))}</a>.</p>`;
}
// Copy puts the exact reference on the clipboard.
$("#receiptPreview").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-receipt-ref]");
  if (!button) return;
  const lang = currentLanguage();
  try { await navigator.clipboard.writeText(button.dataset.copyReceiptRef); button.textContent = t("portalReceiptCopied", lang); }
  catch (_) { button.textContent = t("portalReceiptCopyFailed", lang); }
});

async function openReceipt(button) {
  const request = ++receiptRequest;
  receiptController?.abort();
  receiptController = new AbortController();
  const signal = receiptController.signal;
  currentReceipt = null;
  receiptOpener = button;
  $("#receiptDownload").hidden = true;
  $("#receiptDownload").disabled = false;
  $("#receiptShare").hidden = true;
  { const lang = currentLanguage();
    $("#receiptShare").textContent = t("portalReceiptShare", lang);
    $("#receiptDownload").textContent = t("portalReceiptDownload", lang);
    $("#receiptTitle").textContent = t("portalReceiptTitle", lang);
    $("#receiptClose").setAttribute("aria-label", t("portalReceiptBack", lang)); }
  $("#receiptMessage").replaceChildren();
  $("#receiptPreview").textContent = "Loading your receipt…";
  $("#receiptPreview").setAttribute("aria-busy", "true");
  $("#receiptDialog").showModal();
  document.body.classList.add("modal-open");
  try {
    const { receipt } = await call(`/api/account/payments/${encodeURIComponent(button.dataset.viewReceipt)}/receipt?format=json`, { signal });
    if (request !== receiptRequest || !$("#receiptDialog").open) return;
    currentReceipt = receipt;
    $("#receiptPreview").innerHTML = receiptPreview(receipt);
    $("#receiptDownload").hidden = false;
    $("#receiptShare").hidden = false;
  } catch (error) {
    if (request === receiptRequest && $("#receiptDialog").open) {
      $("#receiptPreview").replaceChildren();
      showError($("#receiptMessage"), error);
    }
  } finally {
    if (request === receiptRequest) $("#receiptPreview").removeAttribute("aria-busy");
  }
}

$("#receiptClose").onclick = () => $("#receiptDialog").close();
$("#receiptDialog").addEventListener("close", () => {
  receiptRequest++;
  receiptController?.abort();
  receiptController = null;
  currentReceipt = null;
  document.body.classList.remove("modal-open");
  if (receiptOpener?.isConnected) receiptOpener.focus();
});
// Share (canvas: PhoneReceipt): the receipt's summary through the phone's
// share sheet, or copied where sharing isn't available. There is no public link.
$("#receiptShare").onclick = async () => {
  const r = currentReceipt; if (!r) return;
  const text = [`NDAHI Connect receipt ${r.number}`, `${r.plan?.name || "Bundle"} · ${r.amountLabel}`, `Paid ${r.paidAtLabel || ""}`, `Paid with ${r.methodLabel || "Mobile Money"}${r.providerReference ? ` · ${r.providerReference}` : ""}`].join("\n");
  try {
    if (navigator.share) await navigator.share({ title: `Receipt ${r.number}`, text });
    else { await navigator.clipboard.writeText(text); $("#receiptShare").textContent = t("portalReceiptShared", currentLanguage()); }
  } catch (_) { /* Sharing was cancelled or isn't allowed; Download PDF still works. */ }
};
$("#receiptDownload").onclick = async (event) => {
  const receipt = currentReceipt, request = receiptRequest, signal = receiptController?.signal, button = event.currentTarget;
  if (!receipt) return;
  $("#receiptMessage").replaceChildren();
  button.disabled = true;
  button.textContent = "Preparing PDF…";
  try {
    const response = await fetch(`${api}/api/account/payments/${encodeURIComponent(receipt.paymentId)}/receipt`, {
      credentials: "include", headers: { accept: "application/pdf" }, signal,
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) { saveReturnPath(); location.replace("/login"); }
      throw responseError(response, result);
    }
    const file = await response.blob();
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/pdf") || await file.slice(0, 5).text() !== "%PDF-") {
      throw responseError({ status: 409 }, { error: "The PDF receipt is unavailable. Please try again." });
    }
    if (request !== receiptRequest || !$("#receiptDialog").open) return;
    const url = URL.createObjectURL(file), link = document.createElement("a");
    link.href = url;
    link.download = `ndahi-receipt-${String(receipt.paymentId).replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    $("#receiptMessage").textContent = "Your PDF receipt is ready to save.";
  } catch (error) {
    if (request === receiptRequest && $("#receiptDialog").open) showError($("#receiptMessage"), error);
  } finally {
    if (request === receiptRequest) { button.disabled = false; button.textContent = t("portalReceiptDownload", currentLanguage()); }
  }
};

// Keep router-reported presence current while this view is open.
let devicePoll;
function watchWifiDevices() {
  clearTimeout(devicePoll);
  const tick = async () => {
    const target = $("#wifiDeviceList");
    if (!target || target.closest("[hidden]") || !$("#manageDevices")?.open) return;
    if (!document.hidden) {
      try { const list = await call("/api/account/wifi-devices"); target.innerHTML = wifiDeviceList(list); updateDevicesCount(list); }
      catch (_) {
        const stale = target.querySelector("[data-refresh-error]") || document.createElement("p");
        stale.dataset.refreshError = "true";
        stale.textContent = "Device updates are unavailable. The last device list may be out of date.";
        if (!stale.isConnected) target.appendChild(stale);
      }
    }
    devicePoll = setTimeout(tick, 5000);
  };
  void tick();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && $("#wifiDeviceList")) watchWifiDevices(); });
window.addEventListener("hashchange", () => {
  if (activePortalView() === "home" && $("#wifiDeviceList")) setTimeout(watchWifiDevices, 0);
  else clearTimeout(devicePoll);
});

// Home shop suggestion from the public catalogue. Hidden when the store is
// closed, empty or unreachable; the request is made once per page.
let shopRequest;
function loadHomeShop() {
  const section = $("#homeShop"), list = $("#homeShopItems");
  if (!section || !list) return;
  shopRequest = shopRequest || fetch(api + "/api/store/catalogue", { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  shopRequest.then((catalogue) => {
    if (!catalogue || (catalogue.settings && catalogue.settings.open === false) || !section.isConnected) return;
    const markup = homeShopItems(catalogue);
    if (!markup) return;
    list.innerHTML = markup;
    section.hidden = false;
  });
}

function pendingPaymentContent(payment) {
  if (!payment) return "";
  const lang = currentLanguage();
  return `<p class="home-pending__line"><strong id="pendingPaymentTitle">${h(t("homePaymentWaiting", lang))}</strong> ${h(t("homePaymentApprove", lang))}</p>${paymentClock(payment)}<details class="home-pending__help"><summary>${h(t("homePaymentNoPrompt", lang))}</summary>${ussdInstructions(payment.payerPhone)}</details><p class="home-pending__links"><a href="#payments">${h(t("homePaymentView", lang))}</a> · <a href="/help#payment">${h(t("homePaymentHelp", lang))}</a></p>`;
}

async function load() {
  const securityView = securityViewState();
  const [result, security] = await Promise.all([
    call("/api/account/dashboard"), call("/api/account/security"),
  ]);
  const active = result.activeBundle,
    current = result.currentPlan,
    dailyPlan = result.availablePlans.find((plan) => plan.id === "daily"),
    dailyNotice = `${dailyPlan ? `The ${dailyPlan.price.toLocaleString()} FCFA Daily bundle` : "Daily"} can be purchased again after expiry or data exhaustion, including on the same day.`,
    canPurchase = !active && result.subscriptionPurchaseAccess?.allowed !== false &&
      result.customer.status !== "suspended" && !result.customer.suspended,
    duration = current?.plan?.validityHours === 24 ? "24 hours" : current?.plan?.validityHours === 168 ? "7 days" : "30 days",
    remaining = active ? Math.max(0, new Date(active.expiresAt) - Date.now()) : 0,
    remainingText = active ? `${Math.floor(remaining / 36e5)}h ${Math.floor(remaining % 36e5 / 6e4)}m` : "Not active",
    // Codes the customer entered, among the payments in Activity (#395).
    redeemed = voucherRows(result.vouchers, result.payments);
  csrfToken = result.csrfToken;
  applyNetworkStatus($(".network-state"), result.zone?.status);
  $("#differentCode").open = !active;
  // With a HotSpot, devices and their slots come from the router itself.
  const hotspot = Boolean(window.NDAHI_CONFIG.hotspotLoginUrl) && active?.accessMode !== "home" && !active?.accessTransitionId,
    wifiConnect = active && hotspot ? '<section class="surface full" id="currentWifi" aria-label="This device connection"></section>' : "",
    thisDeviceConnected = active?.sessions.some((session) => session.deviceId === deviceId),
    quickConnect = !active || hotspot ? "" : thisDeviceConnected ? "" : active.activeDevices < active.deviceLimit
      ? `<form id="connectDevice"><label>Device name<input name="label" value="This device" placeholder="This device"></label><button>Connect this device</button></form><div id="connectMessage" role="status" aria-live="polite"></div>`
      : "<p>All device slots are in use. Disconnect a device to add this one.</p>";
  const pendingPayment = result.payments.find((payment) => ["pending", "processing"].includes(payment.status));
  const purchaseNotice = result.purchaseAccess?.allowed === false
    ? `<p role="status">${h(result.purchaseAccess.message)} Your balance and payment history are available here.</p>` : "";
  const netBanner = networkBannerState({ purchaseAccess: result.purchaseAccess, active, zone: result.zone });
  const netBannerMarkup = `<aside class="network-state-banner network-state-banner-${netBanner.status}" role="status" aria-label="${h(t("homeNetworkStatus", document.documentElement.lang))}"><div class="network-banner-indicator" aria-hidden="true"></div><div class="network-banner-text"><span class="network-banner-badge">${h(netBanner.badge)}</span><span class="network-banner-message">${h(netBanner.message)}</span></div>${netBanner.actionText && netBanner.actionHref ? `<a class="network-banner-action" href="${h(netBanner.actionHref)}">${h(netBanner.actionText)}</a>` : ""}</aside>`;
  stopConnectivity();
  const lang = currentLanguage();
  // Redesign: network notices sit in the page head (the Home hero on phones).
  // During an outage (#259) the hero's network line names it instead.
  $("#portalNotices").innerHTML = `${result.outage?.state === "down" ? outageLine(result.outage) : netBannerMarkup}${purchaseNotice}`;
  setOutage(result.outage);
  const bundleLinks = active ? `<div class="home-bundle__actions"><a class="nd-btn nd-btn--block" href="/dashboard#internet">${h(t("homeBundleDetails", lang))}</a><a class="nd-btn nd-btn--secondary nd-btn--block" href="/dashboard#devices"><span class="nd-narrow-only">${h(t("homeDevices", lang))}</span><span class="nd-wide-only">${h(t("homeManageDevices", lang))}</span></a></div>` : "";
  $("#dashboard").innerHTML = `<div class="dashboard-grid"><div class="home-view full" data-portal-view="home">
    ${outageBanner(result.outage)}
    <div class="full home-promo" id="homeFreeMonth" hidden></div>
    <div class="full home-promo" id="homePromo" hidden></div>
    <section class="home-bundle" aria-label="${h(t("activeBundle", lang))}"><div id="dataBalance">${activeBundleContent(result.bundleStatus)}</div>${bundleLinks}<div class="home-renew__actions" id="renewActions"></div></section>
    <section class="full home-pending" id="pendingPayment" aria-labelledby="pendingPaymentTitle" ${pendingPayment ? "" : "hidden"}>${pendingPaymentContent(pendingPayment)}</section>
    ${wifiConnect}
    ${renewalExtras()}
    ${homeQuickActions()}
    <div class="plan-actions full home-purchase" id="bundlePurchaseActions">${bundlePurchaseContent(result.bundleStatus)}</div>
    <section class="home-shop" id="homeShop" aria-labelledby="homeShopTitle" hidden><div class="nd-section-head"><h2 id="homeShopTitle" class="nd-h3"><span class="nd-narrow-only">${h(t("portalShopTitle", lang))}</span><span class="nd-wide-only">${h(t("homeShopTitleWide", lang))}</span></h2><a class="nd-section-head__link" href="/dashboard#shop"><span class="nd-narrow-only">${h(t("uiTabShop", lang))}</span><span class="nd-wide-only">${h(t("homeOpenShop", lang))}</span></a></div><div class="home-shop__items" id="homeShopItems"></div></section>
    ${homeRecentActivity(result.payments)}
    ${active ? '<div class="full" id="installApp" hidden></div>' : ""}
    <details class="surface full portal-devices" id="manageDevices"><summary>Manage devices</summary><section aria-labelledby="devicesTitle">${devicesHead({ used: hotspot ? (active?.wifiDevices || []).length : active?.activeDevices, limit: active?.deviceLimit })}${hotspot && active ? `<div id="wifiDeviceList">${wifiDeviceList({ devices: active.wifiDevices || [], deviceLimit: active.deviceLimit, syncedAt: active.wifiDevicesAt })}</div>` : active?.sessions.length ? active.sessions.map((session) => `<div class="device portal-device">${deviceIcon}<div class="portal-device__main"><b>${h(session.label)}</b><br><small>${h(session.deviceId.slice(0, 14))}…</small></div><div class="device-actions"><button type="button" data-session="${h(session.id)}">Disconnect</button></div></div>`).join("") : active ? "<p>No devices are currently connected.</p>" : "<p>Activate a bundle to connect a device.</p>"}${active && !hotspot ? `<p class="portal-devices__slots">${h(active.activeDevices)} of ${h(active.deviceLimit)} device slots in use</p>` : ""}${quickConnect}${devicesTip({ hotspot, active })}${hotspot ? '<div id="deviceManagement"></div>' : ""}${devicesAdd({ hotspot, active })}</section></details>
</div>
    ${internetSwitch()}
    ${internetBundle({ result, active, current, canPurchase })}
    ${active?.accessMode === "home" ? "" : `<details class="portal-catalogue full" data-portal-view="bundles" data-internet-group="bundles" id="bundlesCatalogue"><summary>${h(t("portalBundlesAndPrices", currentLanguage()))}</summary>${bundleCatalogue(result)}</details>`}
    <div class="account-layout full" data-portal-view="account">
      ${accountHub(result.customer, security, { homeRegistered: result.homeRouter?.registered === true })}
      ${profileCard(result.customer)}
      <section class="surface full" data-portal-view="account" id="notificationSettings"><p class="eyebrow">Preferences</p><h2>Notification settings</h2><p>Manage data warnings, bundle expiry updates and delivery preferences across your devices.</p><button type="button" id="manageNotificationSettings">Manage notification settings</button></section>
      ${accountSecurityCard(result.customer, security, securitySetup)}
      ${accountSessionsCard(security)}
    </div>
    ${vouchersCard(result.vouchers)}
    ${activityFilters()}${waitingBanner(result.payments)}<section class="portal-activity full" data-portal-view="payments" id="billing" aria-labelledby="billingTitle"><h2 class="portal-activity__h" id="billingTitle">${h(t("portalActivityPayments", currentLanguage()))}</h2><div id="billingMessage" role="status" aria-live="polite"></div>${result.payments.length || redeemed ? `<div class="portal-activity__list"><div class="portal-activity__columns nd-wide-only" aria-hidden="true">${activityColumns()}</div>${result.payments.map((payment) => paymentRow(payment, result.customer)).join("")}${redeemed}</div>` : `<div class="portal-activity__list" data-activity-empty></div><p class="nd-meta portal-activity__empty" data-activity-kind="internet">${h(t("portalNoPayments", currentLanguage()))}</p>`}<div id="activityOrders" data-activity-kind="orders" aria-live="polite"></div></section>
  </div>`;
  if (active?.accessMode === "home" || active?.accessTransitionId) {
    const controls = document.getElementById("manageDevices");
    if (controls) { controls.textContent=""; const link=document.createElement("a"); link.href="/home-router.html"; link.textContent="Manage your Home router · All home devices share this allowance"; controls.replaceWith(link); }
  }
  stopConnectivity = mountConnectivityBanner({ container: $(".network-state-banner"), api });
  latestDashboard = result;
  mountPortalNavigation(result.payments.filter((p) => ["pending", "processing"].includes(p.status)).length, result.customer.name);
  mountProfileEdit({call,customer:result.customer,onChanged:async pending=>{
    await load();
    // A link request shows "Saved. Check … to confirm it." (canvas); an older
    // code request still focuses its code form.
    if(pending){const saved=$("#profileEditSaved");if(saved)saved.focus();else{$("#confirmEmail")?.scrollIntoView({block:"center"});$("#confirmEmail input")?.focus();}}
    else {const saved=$("#profileEditMessage");if(saved){saved.textContent=t("profileSaved",currentLanguage());saved.tabIndex=-1;saved.focus();}else $("#dashboardMessage").textContent="Your profile was updated.";}
  }});
  mountAccountSecurity({ call, customer: result.customer, restore: securityView, setup: securitySetup, onChanged: async view => {
    await load();
    openSecurityManager(view);
  } });
  // The PIN and passkey pages open the manager on their panel once its buttons work.
  const securityPage = { pin: "pin", passkeys: "passkeys" }[document.body.getAttribute("data-portal-sub")];
  if (securityPage) document.querySelector(`[data-security-panel="${securityPage}"]`)?.click();
  mountEmailLink({ call, customer: result.customer, onChanged: async (confirmed) => {
    await load();
    if (confirmed) {$("#dashboardMessage").innerHTML = '<div class="success">Email linked. Email updates are enabled. Your other portal sessions were signed out.</div>';$("#editProfile summary")?.focus();}
    else $("#confirmEmail")?.scrollIntoView({ block: "center" });
  } });
  const notifications = mountNotifications({ apiUrl: api, path: "/api/account/notifications", csrf: () => csrfToken });
  // Security history lives in Notifications (Security, All); Signed-in devices has no button for it (canvas: PhoneSessions, #413).
  if (active) mountInstallCard($("#installApp"));
  loadHomeShop();
  showRenewal(result.bundleStatus, { payments: result.payments, plans: result.availablePlans, call });
  mountDataBalance({ call, initial: result.bundleStatus, onSnapshot: snapshot => {
    showRenewal(snapshot, { payments: result.payments, plans: result.availablePlans, call });
    const actions = $("#bundlePurchaseActions");
    const markup = bundlePurchaseContent(snapshot);
    if (actions && actions.innerHTML !== markup) actions.innerHTML = markup;
    const eligible = Boolean(snapshot && snapshot.purchase.allowed === true && !snapshot.activeId);
    $("#managePlan").querySelectorAll('a[href^="/onboarding"]').forEach(link => { link.hidden = !eligible; });
    if (latestDashboard) {
      latestDashboard.subscriptionPurchaseAccess = snapshot ? snapshot.purchase : { allowed: false };
      if (snapshot) latestDashboard.activeBundle = snapshot.activeId ? snapshot.bundle : null;
    }
  } });
  mountVoucherHistory({ vouchers: result.vouchers, activeId: active?.id });
  mountActivity({ call });
  document.querySelectorAll("details[data-payment-row]").forEach((row) => { row.ontoggle = () => { if (row.open) openPayments.add(row.dataset.paymentRow); else openPayments.delete(row.dataset.paymentRow); }; });
  mountAccountHub(call);
  mountDevicesAdd(call);
  mountShop({ call, api });
  // A promotion's free month waiting to be started (#423), then the store
  // promotion and its countdown on Home (#302).
  const freeMonth = document.getElementById("homeFreeMonth");
  freeMonth.innerHTML = freeMonthCard(result.vouchers, active);
  freeMonth.hidden = !freeMonth.innerHTML;
  bindFreeMonth(freeMonth, call, () => void load());
  void showHomePromo(document.getElementById("homePromo"));
  const quickRedeem = $("[data-quick-redeem]");
  if (quickRedeem) quickRedeem.onsubmit = (event) => { event.preventDefault(); void redeemCode(quickRedeem, quickRedeem.querySelector("[data-quick-redeem-message]")); };
  const redeemPhone = $("#redeem [name=phone]");
  if (redeemPhone && !redeemPhone.value) redeemPhone.value = result.customer.phone || "";  const openCatalogue = $("[data-open-catalogue]"), catalogue = $("#bundlesCatalogue");
  if (openCatalogue && catalogue) openCatalogue.onclick = (event) => { event.preventDefault(); catalogue.open = true; catalogue.scrollIntoView({ block: "start" }); catalogue.querySelector("summary")?.focus(); };
  else if (openCatalogue) openCatalogue.hidden = true;
  $("#manageNotificationSettings").onclick = () => notifications.open({ category: "usage", settings: true });
  if ($("#manageDevices")) $("#manageDevices").ontoggle = () => { if ($("#manageDevices").open) watchWifiDevices(); else clearTimeout(devicePoll); };
  if (hotspot && active) watchWifiDevices();
  else clearTimeout(devicePoll);
  stopCurrentWifi();
  if (hotspot) {
    const controls = mountDeviceControls({ container: $("#deviceManagement"), call, onChanged: load });
    stopCurrentWifi = mountCurrentWifi({ container: $("#currentWifi"), call, onMainDisconnect: async (mac) => { $("#manageDevices").open = true; return (await controls)?.disconnect(mac); } });
  }
  const planNotice = sessionStore.get("ndahi-plan-notice");
  if (planNotice) {
    $("#dashboardMessage").innerHTML = `<div class="success">${h(planNotice)}</div>`;
    sessionStore.remove("ndahi-plan-notice");
  }
  if (securitySetup) {
    // Passkey setup opens the Passkey sign-in page (Account is a hub, canvas).
    if (location.hash !== "#passkeys") {
      history.replaceState(null, "", location.pathname + location.search + "#passkeys");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
    $("#addCustomerPasskey").focus({ preventScroll: true });
  }
}

// A voucher code connects this device. The code page and the desktop "Got a
// voucher?" card ask only for the code (canvas), so the account's number goes with it.
async function redeemCode(form, message) {
  const button = form.querySelector('[type="submit"], button');
  message.textContent = "";
  try {
    await runButton(button, "Connecting…", async () => {
      const input = { phone: latestDashboard?.customer?.phone || "", ...Object.fromEntries(new FormData(form)), deviceId };
      if (!input.phone) input.phone = latestDashboard?.customer?.phone || "";
      const result = await call("/api/vouchers/redeem", { method: "POST", body: JSON.stringify(input) });
      redeemDone(input.code, result.voucher);
      await load();
    });
  } catch (error) { showError(message, error); }
}
$("#redeem").onsubmit = (event) => { event.preventDefault(); void redeemCode(event.target, $("#redeemMessage")); };

// After a code works (#366, canvas: PhoneVoucher "done"): the tick, "You're
// connected", the voucher's own terms and Start browsing, which signs this
// device in to the Wi-Fi when the portal runs on it. Signed in, so the board's
// save-to-account card is left out (owner).
const redeemCodeLabel = (code) => {
  const compact = String(code || "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^NC(?=[0-9A-Z]{8}$)/, "");
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : String(code || "").trim().toUpperCase();
};
function redeemTerms(voucher, L) {
  const plan = voucher.plan || {}, hours = Number(plan.validityHours ?? voucher.validityHours), days = hours / 24;
  const duration = Number.isInteger(days) ? L(days === 1 ? "portalRedeemOneDay" : "portalRedeemDays", { count: days }) : L(hours === 1 ? "portalRedeemOneHour" : "portalRedeemHours", { count: hours });
  const count = Number(voucher.deviceSlots ?? voucher.deviceLimit ?? plan.deviceLimit) || 1;
  const devices = L(count === 1 ? "portalRedeemOneDevice" : "portalRedeemDevices", { count });
  if (voucher.accessType === "personal_unlimited" || voucher.quotaBytes === null) return L("portalRedeemUnlimited", { duration, devices });
  return L("portalRedeemData", { data: `${+(voucher.quotaBytes / 1e9).toFixed(1)} GB`, duration, devices });
}
function redeemDone(code, voucher) {
  const lang = currentLanguage(), L = (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), t(key, lang));
  const [before, after] = L("portalRedeemDoneLine", { terms: redeemTerms(voucher, L) }).split("{code}");
  const done = $("#redeemDone");
  done.innerHTML = `<div class="portal-redeem__tick" aria-hidden="true"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#345000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="m5 12 5 5 9-10"></path></svg></div>
<h1 class="portal-redeem__done-title" tabindex="-1">${h(L("portalRedeemDone"))}</h1>
<p class="portal-redeem__done-line">${h(before)}<strong>${h(redeemCodeLabel(code))}</strong>${h(after ?? "")}</p>
<a class="nd-btn portal-redeem__browse" href="${h(window.NDAHI_CONFIG.hotspotLoginUrl ? hotspotPath() : "/dashboard#home")}">${h(L("portalRedeemBrowse"))}</a>`;
  $("#differentCode").hidden = true;
  done.hidden = false;
  document.body.dataset.redeemDone = "true";
  done.querySelector("h1").focus();
}
// Coming back to the voucher page shows the empty form again.
window.addEventListener("hashchange", () => {
  if (location.hash !== "#redeem" || $("#redeemDone").hidden) return;
  $("#redeemDone").hidden = true; $("#redeemDone").replaceChildren();
  $("#differentCode").hidden = false; delete document.body.dataset.redeemDone;
  $("#redeem").reset(); $("#redeemMessage").replaceChildren();
});

$("#dashboard").onclick = async (event) => {
  const quickRenew = event.target.closest("[data-quick-renew]");
  if (quickRenew && !latestDashboard?.activeBundle && latestDashboard?.subscriptionPurchaseAccess?.allowed !== false) {
    // Buy again (#252) names the payment whose number and network to offer again.
    location.assign("/onboarding.html?action=renew&plan=" + encodeURIComponent(quickRenew.dataset.quickRenew) + "&quick=1" +
      (quickRenew.dataset.renewPayer ? "&payer=" + encodeURIComponent(quickRenew.dataset.renewPayer) : ""));
    return;
  }
  if (await voucherAction(event)) return;
  const copy = event.target.closest("[data-copy-payment]");
  if (copy) {
    try {
      await runButton(copy, "Copying…", async () => {
        let copied = false;
        try { if (navigator.clipboard) { await navigator.clipboard.writeText(copy.dataset.copyPayment); copied = true; } } catch (_) {}
        if (!copied) {
          const input = document.createElement("textarea"); input.value = copy.dataset.copyPayment;
          document.body.appendChild(input); input.select(); copied = document.execCommand("copy"); input.remove(); copy.focus();
        }
        $("#billingMessage").textContent = copied ? "Payment reference copied." : `Payment reference: ${copy.dataset.copyPayment}`;
      });
    } catch (error) { showError($("#billingMessage"), error); }
    return;
  }
  const receiptButton = event.target.closest("[data-view-receipt]");
  if (receiptButton) { await openReceipt(receiptButton); return; }
  const billingButton = event.target.closest("[data-recheck-payment], [data-email-receipt]");
  if (billingButton) {
    try {
      await runButton(billingButton, billingButton.dataset.emailReceipt ? "Sending…" : "Checking…", async () => {
        const id = billingButton.dataset.recheckPayment || billingButton.dataset.emailReceipt;
        const result = billingButton.dataset.emailReceipt
          ? await call("/api/account/payments/receipt-email", { method: "POST", body: JSON.stringify({ paymentId: id }) })
          : await call(`/api/account/payments/${encodeURIComponent(id)}/status`);
        await load();
        $("#billingMessage").textContent = billingButton.dataset.emailReceipt
          ? result.payment.receiptEmail?.status === "sent" ? "Receipt sent to your account email." : "Email delivery is pending or unavailable. You can download the receipt here."
          : result.payment.recoveryMessage || result.payment.refund?.message || `Payment status: ${result.payment.status}.`;
      });
    } catch (error) { showError($("#billingMessage"), error); }
    return;
  }
  // Signed-in devices (canvas: PhoneSessions, #413): Sign out ends that one
  // device; "Sign out all other devices" keeps this one. No confirmations, as drawn.
  const revokeSessionButton = event.target.closest("[data-revoke-session]");
  if (revokeSessionButton) {
    try {
      await runButton(revokeSessionButton, "Signing out…", async () => {
        const result = await call("/api/account/security/sessions/revoke", { method: "POST", body: JSON.stringify({ sessionId: revokeSessionButton.dataset.revokeSession }) });
        if (result.loggedOut) { location.href = "/login"; return; }
        await load();
        // The row goes; screen readers hear it, and the last one shows the drawn note.
        const none = document.querySelector("#sessionActivity .account-sessions__none");
        if (none) none.focus();
        else setTimeout(() => { const say = document.getElementById("sessionsAnnounce"); if (say) say.textContent = t("sessionsSignedOutOne", currentLanguage()); }, 50);
      });
    } catch (error) { showError($("#dashboardMessage"), error); }
    return;
  }
  const logoutEverywhereButton = event.target.closest("#logoutEverywhere");
  if (logoutEverywhereButton) {
    try {
      await runButton(logoutEverywhereButton, "Signing out…", async () => {
        await call("/api/account/security/logout-everywhere", { method: "POST", body: JSON.stringify({ keepCurrent: true }) });
        await load();
        document.querySelector("#sessionActivity .account-sessions__none")?.focus();
      });
    } catch (error) { showError($("#dashboardMessage"), error); }
    return;
  }
  if (event.target.closest("[data-refresh-wifi]")) { watchWifiDevices(); return; }
  const wifiDevice = event.target.closest("button[data-wifi-device]");
  if (wifiDevice) {
    try {
      await runButton(wifiDevice, "Disconnecting…", async () => {
        await call("/api/account/wifi-devices/disconnect", { method: "POST", body: JSON.stringify({ mac: wifiDevice.dataset.wifiDevice, sessionId: wifiDevice.dataset.wifiSession, startedAt: wifiDevice.dataset.wifiStarted, retainApproval: true }) });
        watchWifiDevices();
      });
    } catch (error) { showError($("#dashboardMessage"), error); }
    return;
  }
  const button = event.target.closest("button[data-session]");
  if (!button) return;
  try {
    await runButton(button, "Disconnecting…", async () => {
      await call("/api/account/devices/disconnect", { method: "POST", body: JSON.stringify({ sessionId: button.dataset.session }) });
      await load();
    });
  } catch (error) { showError($("#dashboardMessage"), error); }
};

$("#dashboard").onsubmit = async (event) => {
  const renameDeviceForm = event.target.closest("[data-rename-device]");
  if (renameDeviceForm) {
    event.preventDefault();
    try {
      await runButton(renameDeviceForm.querySelector("button"), "Saving…", async () => {
        const mac = renameDeviceForm.dataset.renameDevice;
        const nickname = new FormData(renameDeviceForm).get("nickname");
        await call("/api/account/device-management/nickname", { method: "POST", body: JSON.stringify({ mac, nickname }) });
        watchWifiDevices();
        await load();
        $("#dashboardMessage").textContent = "Device nickname saved.";
      });
    } catch (error) { showError($("#dashboardMessage"), error); }
    return;
  }
  const refundForm = event.target.closest("[data-refund-payment]");
  if (refundForm) {
    event.preventDefault();
    try {
      await runButton(refundForm.querySelector("button"), "Sending…", async () => {
        await call("/api/account/payments/refund", { method: "POST", body: JSON.stringify({ paymentId: refundForm.dataset.refundPayment, reason: new FormData(refundForm).get("reason") }) });
        await load();
        $("#billingMessage").textContent = "Refund requested. Support will review it; you can track its status here.";
      });
    } catch (error) { showError($("#billingMessage"), error); }
    return;
  }
  const form = event.target.closest("#connectDevice");
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector("button");
  try {
    await runButton(button, "Connecting…", async () => {
      const result = await call("/api/account/devices/connect", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(form)), deviceId }) });
      $("#dashboardMessage").innerHTML = `<div class="success">Connected successfully. ${h(result.voucher.activeDevices)}/${h(result.voucher.deviceLimit)} slots are now in use.</div>`;
      await load();
      if (window.NDAHI_CONFIG.hotspotLoginUrl) location.href = hotspotPath();
    });
  } catch (error) { showError($("#connectMessage"), error); }
};

function applyLanguage(lang) {
  document.documentElement.lang = lang;
  ["header", "#shopPanel", "#portalHead", "#activateDevice"].forEach(selector => { const root = document.querySelector(selector); if (root) localize(root, lang); });
  const brandSmall = document.querySelector(".brand small");
  if (brandSmall) brandSmall.textContent = t("brandSmall", lang);
  const portalTitle = document.getElementById("portalTitle");
  if (portalTitle) portalTitle.textContent = t("portalTitle", lang);
  const eyebrow = document.querySelector(".welcome .eyebrow");
  if (eyebrow) eyebrow.textContent = t("eyebrowDashboard", lang);
  const logout = document.getElementById("logout");
  if (logout) logout.textContent = t("logout", lang);
}

function mountLanguagePreference() {
  // English remains the default. French is an explicit Account preference,
  // rather than an automatic change based on the browser's language.
  let selected = "en";
  try { if (localStorage.getItem("ndahi-lang") === "fr") selected = "fr"; } catch (_) {}
  applyLanguage(selected);
}

mountLanguagePreference();
window.addEventListener("ndahi:language", async (event) => {
  const selected = event.detail === "fr" ? "fr" : "en";
  // The focused language control keeps focus through the translated refresh: the
  // phone's English | Français button (#357), or on desktop the Language row's
  // link, which then names the other language (#358).
  const focused = document.activeElement?.matches('[data-account-lang]') ? document.activeElement.dataset.accountLang : null;
  const restoreFocus = focused && (() => {
    const shown = [...document.querySelectorAll('[data-account-lang]')].filter((el) => el.getClientRects().length);
    (shown.find((el) => el.dataset.accountLang === focused) || shown[0])?.focus();
  });
  applyLanguage(selected);
  try {
    await load();
    if (restoreFocus && activePortalView() === "account") restoreFocus();
  } catch (error) {
    // Keep the existing view and picker usable when a translated data refresh fails.
    const message = $("#dashboardMessage");
    message.textContent = t("homeLanguageRefreshFailed", selected);
    if (restoreFocus) restoreFocus();
  }
});

$("#logout").onclick = async (event) => {
  try {
    await runButton(event.currentTarget, "Logging out…", async () => {
      await call("/api/account/logout", { method: "POST", body: "{}" });
      location.href = "/login";
    });
  } catch (error) { showError($("#dashboardMessage"), error); }
};

load().catch((error) => {
  if (error.status !== 401) {
    applyNetworkStatus($(".network-state"), "unavailable");
    showError($("#dashboard"), error, {
      actions: [{ label: "Try again", run: () => location.reload() }],
    });
  }
});

async function refreshPaymentRecords() {
  if (refreshingPayments || document.hidden || !latestDashboard || !["home", "payments"].includes(activePortalView())) return;
  refreshingPayments = true;
  try {
    const result = await call("/api/account/dashboard");
    const rows = document.querySelectorAll("[data-payment-row]");
    rows.forEach((row) => {
      // A row the customer only opened (focus on its summary, as a tap leaves
      // it) still updates; one they are working in (a button, a refund reason)
      // waits. The redrawn row keeps the focus.
      const opened = row.contains(document.activeElement) && document.activeElement.matches("summary");
      if ((row.contains(document.activeElement) && !opened) || row.querySelector("textarea")?.value) return;
      const payment = result.payments.find((p) => p.id === row.dataset.paymentRow);
      if (!payment) return;
      row.outerHTML = paymentRow(payment, result.customer);
      if (opened) document.querySelector(`[data-payment-row="${CSS.escape(payment.id)}"] > summary`)?.focus({ preventScroll: true });
    });
    const pending = result.payments.find((p) => ["pending", "processing"].includes(p.status)), card = $("#pendingPayment");
    if (card) { card.hidden = !pending; card.innerHTML = pendingPaymentContent(pending); }
    stopConnectivity();
    stopConnectivity = mountConnectivityBanner({ container: $(".network-state-banner"), api });
    latestDashboard = result;
    mountPortalNavigation(result.payments.filter((p) => ["pending", "processing"].includes(p.status)).length, result.customer.name);
  } finally { refreshingPayments = false; }
}
mountPaymentTimers({ onExpired: refreshPaymentRecords });
setInterval(() => {
  if (latestDashboard?.payments.some((p) => ["pending", "processing"].includes(p.status))) void refreshPaymentRecords().catch(() => {});
}, 15000);
window.addEventListener("online", () => { void refreshPaymentRecords().catch(() => {}); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshPaymentRecords().catch(() => {}); });
startUpdates({ isBusy: () => Boolean(document.querySelector("[data-sensitive-output]")) });
