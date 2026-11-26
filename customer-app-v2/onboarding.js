import { groupBundles, chosenPeriod, PERIOD_LABELS } from "../shared-app/bundle-period.js";
import { speedText } from "../shared-app/bundle-speed.js";
import { funnelStep } from "./funnel.js";
import { redirectLegacyVoucherScan } from "./voucher-qr-context.js";
redirectLegacyVoucherScan();
import { purchaseVoucherDestination } from "./voucher-delivery.js";
import { ApiError, responseError, saveReturnPath, showError } from "./errors.js";
import { applyNetworkStatus, fetchNetworkStatus } from "./network-status.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { durationLabel, dataLabel, classifyPlanChange, comparePlans, planValue, planHighlightBadge, renewalEligibility } from "./plan-presentation.js";
import { runButton } from "/shared/pending.js";
import { formValues, sessionStore, randomId, requestJson } from "./compat.js";
import { checkoutStore, configureCheckoutStore, migrateLegacyCheckout, savedCheckout, savedCheckoutKey } from "./checkout-store.js";
import { paymentClock, mountPaymentTimers, ussdInstructions } from "./payment-timing.js";
import { startUpdates } from "./updates.js";
import { configurePairingLink } from "./wifi-pairing.js";
import { mountPrivateMacAdvisory } from "./private-mac-advisory.js";
import { withWifiHint } from "./hotspot-path.js";
import { mountThemeToggle } from "./portal-nav.js";
import { didntGoThroughButton, hidePaymentFailed, maskedNumber, paymentFailedOpen, showPaymentFailed } from "./payment-failed.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { unlimitedCatalogue, deskCatalogue, deskChoiceCard, deskNetworks, deskCost, deskNotice, deskHeader, setDeskNetwork, xaf } from "./buy-desktop.js";

mountThemeToggle();
mountPrivateMacAdvisory();

void configurePairingLink(document.getElementById("assistedConnectionLink"));

migrateLegacyCheckout();
const api = window.NDAHI_CONFIG.apiUrl,
  $ = (selector) => document.querySelector(selector),
  money = (value) => new Intl.NumberFormat("en-CM").format(value) + " FCFA",
  date = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not scheduled",
  pageParams = new URLSearchParams(location.search),
  accountAction = pageParams.get("action"),
  upgradePurchase = pageParams.get("upgrade") === "1";
let selected, checkoutTrigger, csrfToken = "", account, plans = [], cataloguePlans = [],
  paymentProvider, renewal, paymentInProgress, activeRequestKey, polling = false, creatingPayment = false,
  purchaseAccess = { allowed: false }, accessReady = false, checkingAccess = null, coverageError = false;
let subscriptionAccess = { allowed: true };
// Desktop Buy a bundle (#431, buy-desktop.js): signed-in, wide screen, Unlimited catalogue on sale.
const deskQuery = typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 1024px)") : null;
let deskHeaderEl = null, networkState = "unknown", deskReady = false;
const deskFits = () => Boolean(deskQuery?.matches) && Boolean(account) && !accountAction && unlimitedCatalogue(plans);
// Once set up, the layout stays until the page reloads: the checkout is part of
// the page here and a dialog on phones. Crossing the width reloads into the
// other layout, unless a payment is under way.
const deskMode = () => deskReady || deskFits();
deskQuery?.addEventListener?.("change", () => {
  if (accessReady && !paymentInProgress && !creatingPayment && deskReady !== deskFits()) location.reload();
});
// Price, Mobile Money fee and total (#297, canvas: PhoneBuyBundle). The fee and the
// total always come from the server: each plan's paymentQuotes for the chosen
// network, then the payment record. Without them the page says the fee is in the
// prompt; it never works one out.
const L = (key, values) => format(key, values || {}, currentLanguage()),
  fcfa = (value) => new Intl.NumberFormat(currentLanguage() === "fr" ? "fr-CM" : "en-CM").format(value) + " FCFA",
  WALLETS = { mtn: { method: "MTN MoMo", balance: "MoMo" }, orange: { method: "Orange Money", balance: "Orange Money" } },
  quoteFor = (plan, network) => (Number.isFinite(plan?.paymentQuotes?.[network]?.total) ? plan.paymentQuotes[network] : null);
const chosenNetwork = () => $("#purchase").elements.network.value;
function payLabel() {
  if (deskMode()) return L("deskBuyPayNow");
  const quote = quoteFor(selected, chosenNetwork());
  return quote ? L("buyPay", { total: fcfa(quote.total) }) : L("buyPayNoFee", { price: fcfa(selected.price) });
}
function costSection() {
  const network = chosenNetwork(), wallet = WALLETS[network], quote = quoteFor(selected, network);
  const speed = speedText(selected, { devices: selected.deviceLimit });
  const detail = `${dataLabel(selected.quotaGb)} data · ${durationLabel(selected.validityHours)} · ${selected.deviceLimit} device${selected.deviceLimit === 1 ? "" : "s"}${speed ? ` · ${speed}` : ""}`;
  return `<section class="buy-cost" id="checkoutCost" aria-label="${h(L("buyCostLabel"))}">
    <div class="buy-cost__row buy-cost__plan"><span><strong>${h(selected.name)}</strong><span>${h(detail)}</span></span><span>${h(fcfa(selected.price))}</span></div>
    ${wallet ? `<div class="buy-cost__row buy-cost__fee"><span>${h(L("buyFee", { method: wallet.method }))}</span><span>${h(quote ? fcfa(quote.fee) : L("buyFeeInPrompt"))}</span></div>` : ""}
    ${quote ? `<div class="buy-cost__row buy-cost__total"><strong>${h(L("buyTotal"))}</strong><strong>${h(fcfa(quote.total))}</strong></div>`
      : wallet ? `<p class="buy-cost__plus">${h(L("buyPlusFee", { price: fcfa(selected.price) }))}</p>` : ""}
  </section>`;
}
// The breakdown, the balance note and the Pay button follow the chosen network.
function renderCost() {
  if (!selected) return;
  if (deskMode()) return renderDeskCost();
  const cost = $("#checkoutCost"), network = chosenNetwork(), wallet = WALLETS[network], quote = quoteFor(selected, network);
  if (cost) cost.outerHTML = costSection();
  const note = $("#balanceNote");
  note.querySelector("span").textContent = !wallet ? L("buyChooseNetwork")
    : quote ? L("buyBalanceNote", { balance: wallet.balance, total: fcfa(quote.total) })
    : L("buyBalanceNoteNoFee", { balance: wallet.balance, price: fcfa(selected.price) });
  note.hidden = false;
  if (!paymentInProgress && !creatingPayment && purchaseAccess.allowed) $("#requestPayment").textContent = payLabel();
}
// The request that was sent, with the amounts recorded on the payment.
function waitingText(payment) {
  const wallet = WALLETS[payment.network] || { method: "Mobile Money" }, number = payment.payerPhoneMasked || payment.payerPhone || "";
  const known = Number.isFinite(payment.fee) && Number.isFinite(payment.total), values = known
    ? { method: wallet.method, total: fcfa(payment.total), price: fcfa(payment.amount), fee: fcfa(payment.fee), number }
    : { method: wallet.method, price: fcfa(payment.amount), number };
  // The total is bold, as on the canvas; everything else is text.
  const body = h(L(known ? "buyWaitBody" : "buyWaitBodyNoFee", { ...values, [known ? "total" : "price"]: "\u0000" }))
    .replace("\u0000", `<strong>${h(known ? values.total : values.price)}</strong>`);
  return `<p class="buy-wait" id="paymentRequestSummary">${body}</p><p class="buy-wait__check">${h(L(known ? "buyWaitCheck" : "buyWaitCheckNoFee", values))}</p>`;
}
function showSubscriptionProtection() {
  notice(subscriptionAccess.message || "Use your existing bundle. You can buy again after expiry or data exhaustion.", false);
  $("#planNotice").firstElementChild.insertAdjacentHTML("beforeend", subscriptionAccess.code === "ACCOUNT_SUSPENDED"
    ? '<a href="/help">Contact support</a>'
    : `<a href="${h(withWifiHint("/dashboard"))}">Connect using existing bundle</a>`);
}

fetchNetworkStatus(api).then((status) => { networkState = status; applyNetworkStatus($(".network-state"), status); setDeskNetwork(deskHeaderEl, status); });
async function call(path, options = {}) {
  const { response, body: result } = await requestJson(api + path, {
    credentials: "include", ...options,
    headers: {
      "content-type": "application/json",
      ...(options.method && options.method !== "GET" && csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...(options.headers || {}),
    },
  }, 30000);
  if (!response.ok) throw responseError(response, result);
  return result;
}
function setPurchaseAccess(access) {
  purchaseAccess = access && typeof access.allowed === "boolean" ? access : { allowed: false, message: "Connect to NDAHI Wi-Fi, then check again to purchase a bundle." };
  $("#purchaseAccessNotice").hidden = purchaseAccess.allowed;
  $("#purchaseAccessMessage").textContent = purchaseAccess.message || "";
}
// A phone can stay on mobile data until the user accepts Wi-Fi without internet.
// Recheck that request's route in place: a reload would discard the checkout form.
async function recheckPurchaseAccess() {
  if (!accessReady) return;
  if (checkingAccess) return checkingAccess;
  checkingAccess = (async () => {
    try {
      setPurchaseAccess(await call("/api/purchase/access", { cache: "no-store" }));
      if (purchaseAccess.allowed && coverageError && !paymentInProgress) {
        coverageError = false;
        $("#message").textContent = "Wi-Fi purchase access confirmed. Review your details, then request payment.";
      }
    }
    catch { setPurchaseAccess({ allowed: false, message: "Could not check Wi-Fi access. Stay connected to NDAHI Wi-Fi and check again." }); }
    finally {
      renderPlans();
      if (selected && !paymentInProgress && !creatingPayment) {
        $("#requestPayment").disabled = !purchaseAccess.allowed || !subscriptionAccess.allowed;
        $("#requestPayment").textContent = purchaseAccess.allowed ? payLabel() : "Connect to NDAHI Wi-Fi";
      }
    }
  })();
  try { await checkingAccess; } finally { checkingAccess = null; }
}
$("#recheckPurchaseAccess").onclick = (event) => runButton(event.currentTarget, "Checking…", recheckPurchaseAccess);
const recheckWhenVisible = () => { if (document.visibilityState !== "hidden") void recheckPurchaseAccess(); };
window.addEventListener("online", recheckWhenVisible);
window.addEventListener("focus", recheckWhenVisible);
window.addEventListener("pageshow", recheckWhenVisible);
document.addEventListener("visibilitychange", recheckWhenVisible);
setInterval(() => { if (!purchaseAccess.allowed) recheckWhenVisible(); }, 15000);
function comparison(plan) {
  const current = account?.currentPlan?.plan;
  if (!current) return "";
  return `<table class="comparison"><caption class="visually-hidden">Current and proposed package</caption><thead><tr><th scope="col">Plan</th><th scope="col">Current<br>${h(current.name)}</th><th scope="col">New<br>${h(plan.name)}</th></tr></thead><tbody>${comparePlans(current, plan).map((row) =>
    `<tr><th scope="row" aria-label="${h(row.label)}">${h(row.key === "devices" ? "Devices" : row.key === "price" ? "Price" : row.label)}</th><td>${h(row.current)}</td><td>${h(row.next)}<small>${h(row.change)}</small></td></tr>`
  ).join("")}</tbody></table>`;
}
function changeLabel(plan) {
  const type = classifyPlanChange(account?.currentPlan?.plan, plan);
  return type === "upgrade" ? "Upgrade - higher package price"
    : type === "downgrade" ? "Downgrade - lower package price"
    : type === "lateral" ? "Lateral change - same package price" : "New package";
}
function policy(plan) {
  const active = account?.activeBundle?.status === "active",
    eligibility = plan.id === "daily" ? " Buy Daily again after expiry or data exhaustion, including on the same day." : "";
  if (accountAction || upgradePurchase) {
    return `${active ? "Your current bundle must expire or use up its data before another purchase. " : "Your previous package is not active. "}${plan.name} starts on payment confirmation with ${durationLabel(plan.validityHours)} of validity. The full ${money(plan.price)} package price is due; no prorated credit is applied. Reconnect devices with the new activation code.${eligibility}`;
  }
  return `Your package starts on payment confirmation and lasts ${durationLabel(plan.validityHours)}. An activation code is created after verified payment. The full ${money(plan.price)} package price is due.${eligibility}`;
}
function notice(message, links = true) {
  $("#planNotice").innerHTML = `<div class="plan-notice"><p>${h(message)}</p>${links ? '<a href="/dashboard">Back to dashboard</a><a href="/onboarding.html?action=switch">Change plan</a>' : ""}</div>`;
}
// Bundles under Daily, Weekly and Monthly with filters (owner, 21 Nov), when
// they span more than one period; a renewal shows its one plan as before.
// The filter can start from a link (?period=weekly); a link to one plan
// (?plan=) starts on All so that plan is in view.
let planPeriod = pageParams.get("plan") ? "all" : pageParams.get("period") || "all";
function showPlanPeriod(value) {
  planPeriod = value;
  document.querySelectorAll("#plans [data-plan-period]").forEach((chip) => chip.setAttribute("aria-pressed", String(chip.dataset.planPeriod === planPeriod)));
  document.querySelectorAll("#plans [data-plan-group]").forEach((group) => { group.hidden = planPeriod !== "all" && group.dataset.planGroup !== planPeriod; });
}
function renderPlans() {
  if (deskMode()) return renderDesk();
  const card = (plan) => {
    const blocked = !subscriptionAccess.allowed || (accountAction === "renew" && (!renewal || !renewal.eligible));
    const eligibility = !subscriptionAccess.allowed ? "Your existing bundle is protected from replacement." : blocked
      ? renewal?.reason || "This package cannot be renewed."
      : accountAction === "renew" ? "Eligible to renew now." : "";
    const highlight = planHighlightBadge(plan);
    const badge = accountAction === "switch" ? changeLabel(plan) : accountAction === "renew" ? "Your renewal" : highlight;
    const badgeClass = highlight === "Popular" ? " plan-badge-popular" : highlight === "Best Value" ? " plan-badge-best-value" : "";
    const val = planValue(plan);
    const unitRate = (val && val.pricePerGb !== null && plan.quotaGb !== null)
      ? `<div class="plan-unit-rate">${h(val.perGbLabel)}</div>`
      : (plan.quotaGb === null && val && val.perGbLabel ? `<div class="plan-unit-rate">${h(val.perGbLabel)}</div>` : "");
    return `<article class="plan" data-card="${h(plan.id)}" aria-labelledby="plan-title-${h(plan.id)}">${badge ? `<div class="plan-badge${badgeClass}">${h(badge)}</div>` : ""}
      <h3 id="plan-title-${h(plan.id)}">${h(plan.name)}</h3><div class="plan-price">${h(money(plan.price))}</div>
      ${unitRate}
      ${accountAction === "switch" && account && account.currentPlan && account.currentPlan.plan ? comparison(plan) : `<ul class="plan-details"><li>${h(dataLabel(plan.quotaGb))} data${plan.quotaGb === null ? " (fair use applies)" : ""}</li><li>${h(durationLabel(plan.validityHours))} validity</li><li>${h(plan.deviceLimit)} simultaneous device${plan.deviceLimit === 1 ? "" : "s"}</li>${speedText(plan, { devices: plan.deviceLimit }) ? `<li class="plan-speed">${h(speedText(plan, { devices: plan.deviceLimit }))}</li>` : ""}</ul>`}
      ${accountAction === "switch" && (plan.quotaGb === null || (account && account.currentPlan && account.currentPlan.plan && account.currentPlan.plan.quotaGb === null)) ? '<p class="trust">Unlimited data is subject to fair use.</p>' : ""}
      ${accountAction ? `<p class="plan-policy">${h(policy(plan))}</p>` : ""}
      ${eligibility ? `<p class="eligibility">${h(eligibility)}</p>` : ""}
      <button data-plan="${h(plan.id)}" aria-describedby="plan-title-${h(plan.id)}${purchaseAccess.allowed ? "" : " purchaseAccessMessage"}" ${!accessReady || blocked || !purchaseAccess.allowed || paymentInProgress || creatingPayment ? "disabled" : ""}>${!purchaseAccess.allowed ? "Connect to NDAHI Wi-Fi" : blocked ? "Currently unavailable" : accountAction === "renew" ? "Review renewal" : accountAction === "switch" ? "Switch to this plan" : "Choose plan"}</button>
    </article>`;
  };
  const groups = accountAction === "renew" ? [] : groupBundles(plans);
  if (groups.length < 2) {
    $("#plans").innerHTML = plans.map(card).join("");
  } else {
    planPeriod = chosenPeriod(planPeriod, groups);
    const label = (period) => L(PERIOD_LABELS[period]);
    $("#plans").innerHTML = `<div class="nd-chips plan-filters" role="group" aria-label="${h(L("bundlePeriodFilter"))}">${["all", ...groups.map((group) => group.period)].map((period) =>
      `<button type="button" class="nd-chip" data-plan-period="${period}" aria-pressed="${period === planPeriod}">${h(label(period))}</button>`).join("")}</div>
      ${groups.map((group) => `<section class="plan-group" data-plan-group="${group.period}" aria-labelledby="planGroup-${group.period}"${planPeriod !== "all" && planPeriod !== group.period ? " hidden" : ""}>
        <h2 class="nd-eyebrow plan-group__title" id="planGroup-${group.period}">${h(label(group.period))}</h2>${group.plans.map(card).join("")}</section>`).join("")}`;
  }
  $("#plans").setAttribute("aria-busy", "false");
}
function renderAccount() {
  const current = account.currentPlan;
  document.body.classList.add(`account-${accountAction}`);
  $("#accountIntro").hidden = false;
  $("#accountTitle").textContent = accountAction === "renew" ? "Renew your plan" : "Change your plan";
  document.title = `${$("#accountTitle").textContent} - NDAHI Connect`;
  $("#packagesTitle").textContent = accountAction === "renew" ? "Review your renewal" : "Compare alternatives";
  $("#packagesDescription").textContent = accountAction === "renew"
    ? "One payment. A new validity period from payment confirmation."
    : "Upgrade and downgrade describe package price. Compare each allowance before changing.";
  $("#currentPlan").innerHTML = current
    ? `<p class="current-plan-name">${h(current.plan?.name || "Previous package")}</p><dl class="current-facts"><div><dt>Status</dt><dd>${h(current.status)}</dd></div><div><dt>Current expiry</dt><dd>${h(date(current.expiresAt))}</dd></div><div><dt>Package price</dt><dd>${h(money(current.plan?.price))}</dd></div><div><dt>New start date</dt><dd>On payment confirmation</dd></div></dl>`
    : '<p>No current plan.</p>';
  if (accountAction === "renew") {
    renewal = renewalEligibility(current, cataloguePlans, account.dailyAvailability);
    plans = cataloguePlans.filter((plan) => plan.id === account.currentPlan?.planId && !plan.discontinued);
    if (!renewal.eligible) {
      notice(renewal.reason + (renewal.nextEligibleAt ? ` Next eligible: ${date(renewal.nextEligibleAt)}.` : ""));
    }
  } else {
    plans = cataloguePlans.filter((plan) => plan.id !== current?.planId);
  }
}
// The account's payment number. Buy again on Home (#252) names the payment the
// last bundle was bought with, so its number and network are offered again;
// the network counts as the customer's own choice, as it was then.
function fillAccountPayer() {
  const form = $("#purchase"), id = pageParams.get("payer");
  const repeat = id && (account.payments || []).find((payment) => payment.id === id && payment.payerPhone);
  form.elements.payerPhone.value = repeat ? repeat.payerPhone.replace(/^\+?237(?=\d{9}$)/, "") : account.customer.phone;
  if (repeat && ["mtn", "orange"].includes(repeat.network) && form.elements.network.value !== repeat.network) {
    form.elements.network.value = repeat.network;
    form.elements.network.dispatchEvent(new Event("change", { bubbles: true }));
  }
}
function renderAccountContact() {
  const form = $("#purchase");
  for (const name of ["name", "phone", "email"]) form.elements[name].value = account.customer[name] || "";
  form.elements.name.readOnly = true;
  form.elements.phone.readOnly = true;
  const needsPaymentEmail = paymentProvider === "flutterwave" && !account.customer.email;
  form.elements.email.readOnly = !needsPaymentEmail;
  form.elements.name.required = false;
  form.elements.phone.required = false;
  form.elements.email.required = needsPaymentEmail;
  $("#purchase .form-row").hidden = true;
  form.elements.email.closest("label").hidden = !needsPaymentEmail;
  $("#accountContact").hidden = false;
  $("#accountContact").innerHTML = `<div><dt>Account name</dt><dd>${h(account.customer.name)}</dd></div><div><dt>Account number</dt><dd>${h(account.customer.phone)}</dd></div><div><dt>Email notifications</dt><dd>${account.customer.emailLinked ? h(account.customer.email) : 'Link an email in Account to receive updates and receipts.'}</dd></div>`;
  $("#accountPayer").hidden = false;
  form.elements.payerPhone.disabled = false;
  form.elements.payerPhone.required = true;
  fillAccountPayer();
  $("#acknowledgement").hidden = false;
  form.elements.acknowledge.required = true;
}
async function initialize() {
  if (accountAction && !["renew", "switch"].includes(accountAction)) throw Error("This plan action is unavailable. Return to your dashboard to choose a plan.");
  let catalogue;
  try {
    catalogue = await call("/api/plans");
    try { localStorage.setItem("ndahi-cached-plans", JSON.stringify(catalogue)); } catch (_) {}
  } catch (error) {
    let cached = null;
    try { cached = localStorage.getItem("ndahi-cached-plans"); } catch (_) {}
    if (cached) {
      try { catalogue = JSON.parse(cached); } catch (_) {}
    }
    if (!catalogue) throw error;
  }
  configureCheckoutStore(catalogue.checkoutWindowSeconds);
  setPurchaseAccess(catalogue.purchaseAccess);
  cataloguePlans = catalogue.plans.filter((plan) => !plan.discontinued);
  plans = cataloguePlans;
  paymentProvider = catalogue.paymentProvider;
  // On a wide screen the Unlimited catalogue waits for the account (the desktop
  // layout is for signed-in customers), so the phone list doesn't flash first.
  if (!accountAction && !(deskQuery?.matches && unlimitedCatalogue(plans))) renderPlans();
  $("#purchase").elements.email.required = paymentProvider === "flutterwave";
  if (paymentProvider === "flutterwave") {
    $("#emailLabel").textContent = "Payment contact email";
    $("#emailHint").textContent = "Flutterwave requires an email for this payment. Confirm an address in Account to enable email notifications.";
  }
  try {
    account = await call("/api/account/dashboard");
    subscriptionAccess = account.subscriptionPurchaseAccess || { allowed: !account.activeBundle && account.customer.status !== "suspended" && !account.customer.suspended };
    csrfToken = account.csrfToken;
    const accountLink = $(".header-link");
    accountLink.textContent = "My dashboard";
    accountLink.href = "/dashboard";
  } catch (error) {
    if (accountAction) {
      if (error.status === 401) {
        saveReturnPath();
        location.replace(withWifiHint("/login"));
        return;
      }
      throw error;
    }
    if (error.status !== 401) {
      renderPlans();
      notice("Packages are available, but your account could not load. Try again before starting a payment for your existing account.", false);
      $("#planNotice").firstElementChild.insertAdjacentHTML("beforeend", '<button id="retryAccount">Try again</button>');
      $("#retryAccount").onclick = () => location.reload();
      return;
    }
  }
  if (accountAction) renderAccount();
  if (account) renderAccountContact();
  for (const payment of account?.payments || []) {
    const key = `ndahi-payment-${payment.action || "purchase"}-${payment.planId}`;
    if (["paid", "failed", "refunded", "expired"].includes(payment.status) && payment.requestKey &&
      checkoutStore.get(key) === payment.requestKey) checkoutStore.remove(key);
  }
  accessReady = true;
  renderPlans();
  if (!plans.length && !(accountAction === "renew" && !renewal?.eligible)) {
    notice(accountAction === "switch" ? "There are no alternative packages available right now." : "No packages are available right now.", Boolean(accountAction));
  }
  const pending = account?.payments?.find((payment) => payment.blocksNewCheckout === true);
  if (pending) {
    paymentInProgress = pending;
    showPaymentDeadline(pending);
    activeRequestKey = `ndahi-payment-${pending.action || "purchase"}-${pending.planId}`;
    const eligibilityReason = accountAction === "renew" && !renewal.eligible
      ? `${renewal.reason}${renewal.nextEligibleAt ? ` Next eligible: ${date(renewal.nextEligibleAt)}.` : ""} ` : "";
    notice(eligibilityReason + `A payment is already awaiting confirmation${pending.payerPhone ? ` on ${pending.payerPhone}` : ""}. Check its status before starting another payment.`, false);
    $("#planNotice").firstElementChild.insertAdjacentHTML("beforeend", '<button id="checkExisting">Check payment status</button> <a href="/dashboard">Back to dashboard</a>' + ussdInstructions(pending.payerPhone));
    $("#checkExisting").onclick = async (event) => {
      try {
        await runButton(event.currentTarget, "Checking…", async () => {
          const result = await call(`/api/account/payments/${pending.id}/status`);
          if (result.payment.status === "paid") return beginAccountSecurity(result);
          // A closed (expired) checkout no longer blocks a new payment.
          if (["failed", "refunded", "expired"].includes(result.payment.status)) {
            checkoutStore.remove(`ndahi-payment-${pending.action || "purchase"}-${pending.planId}`);
            if (result.payment.failureCode) {
              paymentInProgress = undefined;
              $("#planNotice").textContent = "";
              renderPlans();
              showFailure(result.payment, undefined, result);
            } else location.reload();
          } else $("#planNotice p").textContent = result.payment.recoveryMessage || "This payment is still awaiting approval. Approve the existing Mobile Money prompt, then check its status again.";
        });
      } catch (error) {
        showError($("#planNotice"), error, { actions: [{ label: "Check again", run: () => location.reload() }] });
      }
    };
    renderPlans();
  }
  if (!pending && !account) {
    const setup = await availableSetup();
    if (setup) {
      clearRequestKey(); paymentInProgress = { id: setup.paymentId, status: "paid" }; renderPlans();
      notice("Payment confirmed. Finish creating your PIN to open your account.", false);
      $("#planNotice").firstElementChild.insertAdjacentHTML("beforeend", `<a href="${h(withWifiHint("/verify.html?setup=checkout"))}">Continue PIN setup</a>`);
      return;
    }
    await restoreSavedCheckout();
  }
  if (!subscriptionAccess.allowed && !paymentInProgress) showSubscriptionProtection();

  const preferred = pageParams.get("plan");
  if (preferred && choose(preferred)) {
    const btn = Array.from(document.querySelectorAll("#plans button[data-plan]")).find((button) => button.dataset.plan === preferred);
    if (deskMode()) renderCheckoutReview();
    else if (btn) openCheckout(btn);
    if (pageParams.get("quick") === "1") {
      setTimeout(() => {
        const reqBtn = $("#requestPayment");
        if (reqBtn) {
          reqBtn.focus();
          reqBtn.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 50);
    }
  }
}
function fillSavedDetails(details) {
  for (const field of ["name", "phone", "email", "network"]) {
    if (details?.[field] && $("#purchase").elements[field]) $("#purchase").elements[field].value = details[field];
  }
}
function bindCheckoutDeadline(payment) {
  if (!payment || account) return;
  const remaining = Date.parse(payment.guestAccessExpiresAt) - Date.parse(payment.serverTime);
  if (!Number.isFinite(remaining)) return;
  const options = { expiresAt: Date.now() + Math.max(0, remaining) };
  if (activeRequestKey && payment.requestKey) checkoutStore.set(activeRequestKey, payment.requestKey, options);
  if (payment.requestKey) checkoutStore.set(savedCheckoutKey, JSON.stringify({ requestKey: payment.requestKey, planId: payment.planId, paymentId: payment.id }), options);
}
async function availableSetup(paymentId) {
  try {
    const setup = await call("/api/account/setup/checkout");
    return setup.mode === "setup" && (!paymentId || setup.paymentId === paymentId) ? setup : null;
  } catch { return null; }
}
async function exchangeSetup(paymentId, requestKey) {
  try { return await call("/api/account/setup/checkout", { method: "POST", body: JSON.stringify({ paymentId, requestKey }) }); }
  catch (error) {
    const recovered = await availableSetup(paymentId);
    if (recovered) return recovered;
    throw error;
  }
}
// Recovery reads the saved reservation and never starts a charge. A key the API no
// longer recognises cannot resume anything, so the device forgets it.
async function recoverSavedCheckout(saved) {
  try {
    const recovered = await call("/api/purchase/recover", { method: "POST", body: JSON.stringify({ requestKey: saved.requestKey }) });
    bindCheckoutDeadline(recovered.payment);
    return recovered;
  } catch (error) {
    if (error.status !== 404) throw error;
    if (saved.paymentId && saved.requestKey) {
      try {
        const setup = await exchangeSetup(saved.paymentId, saved.requestKey);
        clearRequestKey();
        location.href = withWifiHint(setup.mode === "login" ? "/login?account=1&payment=confirmed&next=" + encodeURIComponent(purchaseVoucherDestination(saved.paymentId)) : "/verify.html?setup=checkout");
        return null;
      } catch { /* Expired/unknown requests retain neutral payment guidance below. */ }
    }
    clearRequestKey();
    paymentInProgress = undefined;
    notice("We can no longer access the checkout saved on this device. This does not confirm whether money was deducted. Sign in to review your payments or contact support before paying again." +
      (saved.paymentId ? ` Saved payment reference: ${saved.paymentId}.` : ""), false);
    $("#planNotice").firstElementChild.insertAdjacentHTML("beforeend", '<a href="/dashboard#payments">Check payments</a><a href="/help#payment">Payment help</a>');
    renderPlans();
    return null;
  }
}
// Checked on every visit, so a payment that closed while this device was away releases
// the packages without the guest having to ask.
async function restoreSavedCheckout() {
  const saved = savedCheckout();
  if (!saved) return;
  activeRequestKey = `ndahi-payment-purchase-${saved.planId}`;
  paymentInProgress = { id: saved.paymentId };
  notice("Checking a payment saved on this device…", false);
  renderPlans();
  let recovered;
  try { recovered = await recoverSavedCheckout(saved); }
  catch { /* Offline or unavailable: keep the key so the payment can still be resumed. */ }
  if (recovered === null) return;
  if (recovered && ["failed", "refunded", "expired"].includes(recovered.payment.status)) {
    if (recovered.payment.failureCode === "timeout") keepUnresolved(recovered.payment.id, saved.requestKey);
    clearRequestKey();
    paymentInProgress = undefined;
    fillSavedDetails(recovered.details);
    notice(recovered.payment.failureReason || "Your previous payment did not complete. You can choose a package again.", false);
    renderPlans();
    showFailure(recovered.payment, undefined, recovered);
    return;
  }
  notice(recovered?.payment.status === "paid"
    ? "A payment saved on this device was confirmed. Resume it to finish setting up your account."
    : "An interrupted checkout is saved on this device. Resume it before starting another payment.", false);
  $("#planNotice").firstElementChild.insertAdjacentHTML("beforeend", '<button id="resumeCheckout">Resume saved payment</button>');
  $("#resumeCheckout").onclick = (event) => {
    // The first resume reuses this visit's check; any retry asks the API again.
    const checked = recovered;
    recovered = undefined;
    return resumeSavedCheckout(event.currentTarget, saved, checked);
  };
}
async function resumeSavedCheckout(button, saved, checked) {
  try {
    await runButton(button, "Resuming…", async () => {
      const created = checked || await recoverSavedCheckout(saved);
      if (!created) return;
      const phone = created.details?.phone;
      paymentInProgress = created.payment;
      showPaymentDeadline(created.payment);
      selected = cataloguePlans.find((p) => p.id === created.payment.planId) || created.payment.plan;
      activeRequestKey = `ndahi-payment-purchase-${created.payment.planId}`;
      checkoutTrigger = button;
      showCheckout();
      $("#selected").textContent = "Resume your payment";
      // Prefilled so a closed checkout can be started again with one click.
      fillSavedDetails(created.details);
      $("#purchaseFields").disabled = true;
      $("#message").textContent = "Checking your existing payment…";
      if (!await checkPayment(created.payment.id, phone)) {
        $("#message").innerHTML = '<p>Approve the existing phone prompt, then recheck. Do not start another payment.</p><button type="button" id="resumeRecheck">Recheck payment</button>' + didntGoThrough;
        $("#resumeRecheck").onclick = (event) => runButton(event.currentTarget, "Checking…", () => waitForPayment(created.payment.id, phone));
        if (created.checkout.mode === "mock") {
          $("#message").insertAdjacentHTML("beforeend", '<button type="button" id="resumeMock">Simulate payment approval</button>');
          $("#resumeMock").onclick = async (event) => {
            try {
              await runButton(event.currentTarget, "Confirming…", async () => {
                const paid = await call(`/api/payments/${created.payment.id}/confirm`, { method: "POST", body: "{}" });
                await beginAccountSecurity(paid, phone);
              }, { controls: [$("#resumeRecheck")] });
            } catch (error) { showError($("#message"), error, { actions: [{ label: "Check payment again", run: () => waitForPayment(created.payment.id, phone) }] }); }
          };
        } else if (/^https:\/\//i.test(created.checkout.url || "")) {
          $("#message").insertAdjacentHTML("beforeend", `<a href="${h(created.checkout.url)}" target="_blank" rel="noopener">Resume secure payment</a>`);
        }
      }
    });
  } catch (error) {
    showError($("#checkout").hidden ? $("#planNotice") : $("#message"), error, {
      actions: paymentInProgress ? [{ label: "Resume saved payment", run: () => button.click() }] : [],
    });
  }
}
function choose(id) {
  const plan = plans.find((item) => item.id === id);
  if (!plan || !purchaseAccess.allowed || !subscriptionAccess.allowed || paymentInProgress || creatingPayment || (accountAction === "renew" && !renewal?.eligible)) return false;
  selected = plan;
  document.querySelectorAll(".plan").forEach((card) => card.classList.toggle("selected", card.dataset.card === id));
  document.querySelectorAll("#plans [data-plan][aria-pressed]").forEach((cell) => cell.setAttribute("aria-pressed", String(cell.dataset.plan === id)));
  return true;
}
const checkoutTitle = () =>
  `${accountAction === "renew" ? "Renew" : accountAction === "switch" ? "Switch to" : upgradePurchase ? "Upgrade to" : "Buy"} ${selected.name}`;
function renderCheckoutReview() {
  if (!selected) {
    $("#selected").textContent = "Choose another package";
    $("#checkoutSummary").textContent = "The saved package is unavailable. Return to packages to choose an eligible package.";
    $("#checkoutPolicy").textContent = "";
    $("#requestPayment").textContent = "Choose another package";
    $("#requestPayment").disabled = true;
    return;
  }
  $("#selected").textContent = deskMode() ? L("deskBuyYourChoice") : checkoutTitle();
  $("#checkoutSummary").innerHTML = deskMode() ? deskChoiceCard(selected) : (accountAction === "switch" && account.currentPlan?.plan ? comparison(selected) : "") + costSection();
  $("#checkoutPolicy").textContent = policy(selected) + " There is no automatic renewal. Closing this page does not cancel a submitted payment. Refund requests require support review; no automatic prorated refund applies.";
  $("#acknowledgementText").textContent = "I understand that the new package starts when payment is confirmed, provided no other bundle is active.";
  $("#purchase").elements.acknowledge.checked = false;
  $("#requestPayment").textContent = purchaseAccess.allowed ? payLabel() : "Connect to NDAHI Wi-Fi";
  $("#requestPayment").disabled = !purchaseAccess.allowed || !subscriptionAccess.allowed;
  renderCost();
}
for (const type of ["change", "networkchange"]) $("#purchase").elements.network.addEventListener(type, renderCost);
// Desktop layout (#431): the table and Home WISP card, and the checkout shown
// inline as "Your choice". The form, its submit and the payment flow are the
// phone's; only their arrangement and words differ.
function renderDesk() {
  document.body.classList.add("buy-desk");
  if (!deskHeaderEl) {
    deskHeaderEl = deskHeader();
    document.body.prepend(deskHeaderEl);
    setDeskNetwork(deskHeaderEl, networkState);
  }
  if (!$("#deskBack")) $("#packagesTitle").insertAdjacentHTML("beforebegin", `<a id="deskBack" class="buy-desk__back" href="/dashboard#internet">${h(L("deskBuyBack"))}</a>`);
  $("#packagesTitle").textContent = L("deskBuyTitle");
  $("#packagesDescription").textContent = L("deskBuySub");
  if (!selected || !plans.some((plan) => plan.id === selected.id)) selected = plans.find((plan) => plan.id === pageParams.get("plan")) || plans[0];
  const disabled = !accessReady || !purchaseAccess.allowed || !subscriptionAccess.allowed || Boolean(paymentInProgress) || creatingPayment;
  $("#plans").innerHTML = deskCatalogue(plans, selected?.id, disabled);
  $("#plans").setAttribute("aria-busy", "false");
  if (deskReady) return;
  deskReady = true;
  const checkout = $("#checkout"), form = $("#purchase");
  $("#packages").append(checkout);
  checkout.hidden = false;
  checkout.classList.add("buy-desk__aside");
  checkout.removeAttribute("role");
  checkout.removeAttribute("aria-modal");
  checkout.removeAttribute("aria-describedby");
  // No acknowledgement checkbox here (owner, #431); the rule line below says when buying is possible.
  form.elements.acknowledge.required = false;
  $("#acknowledgement").hidden = true;
  $("#purchaseFields").insertAdjacentHTML("afterbegin", `<div id="deskNetworks">${deskNetworks(chosenNetwork())}</div>`);
  $("#accountPayer").insertAdjacentHTML("afterend", '<div id="deskCostHost"></div>');
  $("#requestPayment").insertAdjacentHTML("afterend", `<p class="buy-desk__rule">${h(L("deskBuyRule"))}</p>`);
  const label = [...$("#accountPayer").childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  if (label) label.textContent = L("deskBuyNumber");
  // The number shows masked, as drawn ("6•• •• 12 45"), until the field is used.
  const payer = form.elements.payerPhone, wrap = document.createElement("span");
  wrap.className = "buy-desk__payer";
  payer.before(wrap);
  wrap.append(payer);
  wrap.insertAdjacentHTML("beforeend", '<span class="buy-desk__mask" id="deskPayerMask" aria-hidden="true"></span>');
  for (const type of ["focus", "blur", "input", "change"]) payer.addEventListener(type, maskDeskPayer);
  $("#deskNetworks").onclick = (event) => {
    const button = event.target.closest("[data-desk-network]");
    if (!button || button.disabled) return;
    form.elements.network.value = button.dataset.deskNetwork;
    form.elements.network.dispatchEvent(new Event("change", { bubbles: true }));
  };
  // A radio group: one tab stop, and the arrow keys move the choice.
  $("#deskNetworks").onkeydown = (event) => {
    const radios = [...$("#deskNetworks").querySelectorAll("[data-desk-network]")], at = radios.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (at < 0 || !step) return;
    event.preventDefault();
    const next = radios[(at + step + radios.length) % radios.length];
    next.focus();
    next.click();
  };
  renderCheckoutReview();
}
function maskDeskPayer() {
  const payer = $("#purchase").elements.payerPhone, mask = $("#deskPayerMask");
  if (!mask) return;
  const masked = document.activeElement === payer ? "" : maskedNumber(payer.value);
  mask.textContent = masked;
  payer.classList.toggle("buy-desk__payer--masked", Boolean(masked));
}
function renderDeskCost() {
  maskDeskPayer();
  const network = chosenNetwork(), quote = quoteFor(selected, network);
  $("#deskNetworks")?.querySelectorAll("[data-desk-network]").forEach((button, i) => {
    button.setAttribute("aria-checked", String(button.dataset.deskNetwork === network));
    button.tabIndex = button.dataset.deskNetwork === network || (!WALLETS[network] && i === 0) ? 0 : -1;
  });
  const host = $("#deskCostHost");
  if (host) host.innerHTML = deskCost(selected, quote);
  const note = $("#balanceNote");
  note.querySelector("span").innerHTML = deskNotice(selected, network, quote);
  note.hidden = false;
  if (!paymentInProgress && !creatingPayment && purchaseAccess.allowed) $("#requestPayment").textContent = payLabel();
}
function openCheckout(trigger) {
  checkoutTrigger = trigger;
  if (account && !paymentInProgress) fillAccountPayer();
  renderCheckoutReview();
  $("#message").textContent = "";
  showCheckout();
}
function showCheckout() {
  $("#checkout").hidden = false;
  if (deskMode()) return;
  document.body.classList.add("modal-open");
  $("#pageContent").inert = true;
  $("header").inert = true;
  $("footer").inert = true;
  $("#closeCheckout").focus();
}
$("#plans").onclick = (event) => {
  const chip = event.target.closest("button[data-plan-period]");
  if (chip) return showPlanPeriod(chip.dataset.planPeriod);
  const button = event.target.closest("button[data-plan]");
  if (button && !button.disabled && choose(button.dataset.plan)) {
    // On the desktop layout "Your choice" is beside the table, not a dialog.
    if (deskMode()) { renderCheckoutReview(); return; }
    openCheckout(button);
  }
};
function isAvailableControl(element) {
  if (!element || !element.isConnected || typeof element.getAttribute !== "function") return false;
  if (element.disabled || element.hasAttribute("disabled") || element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") {
    return false;
  }
  if (element.tabIndex < 0) return false;
  if (element.hidden || element.closest("[hidden]") || element.closest("[inert]")) return false;
  if (typeof element.checkVisibility === "function") return element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const style = getComputedStyle(element);
  if (style.visibility !== "visible" || style.opacity === "0") return false;
  return Boolean(element.getClientRects().length);
}
function restoreCheckoutFocus() {
  if (isAvailableControl(checkoutTrigger)) {
    checkoutTrigger.focus();
    return;
  }
  const planId = selected?.id || checkoutTrigger?.dataset?.plan;
  if (planId) {
    const matchingPlan = [...document.querySelectorAll("#plans button[data-plan]")].find((button) => button.dataset.plan === planId);
    if (isAvailableControl(matchingPlan)) {
      checkoutTrigger = matchingPlan;
      matchingPlan.focus();
      return;
    }
  }
  const fallbackPlan = [...document.querySelectorAll("#plans button[data-plan]")].find(isAvailableControl);
  if (fallbackPlan) {
    checkoutTrigger = fallbackPlan;
    fallbackPlan.focus();
    return;
  }
  const fallbackAction = [
    ...document.querySelectorAll("#planNotice button, #planNotice a[href], #accountIntro a[href], #pageContent button, #pageContent a[href]")
  ].find(isAvailableControl);
  if (fallbackAction) {
    checkoutTrigger = fallbackAction;
    fallbackAction.focus();
    return;
  }
  const pageAction = [...document.querySelectorAll('a[href], button, [tabindex="0"]')].find((el) => !el.closest("#checkout") && isAvailableControl(el));
  if (pageAction) {
    checkoutTrigger = pageAction;
    pageAction.focus();
  }
}
function closeCheckout() {
  if (deskMode()) return;
  $("#checkout").hidden = true;
  document.body.classList.remove("modal-open");
  $("#pageContent").inert = false;
  $("header").inert = false;
  $("footer").inert = false;
  if (paymentInProgress || creatingPayment) {
    notice("A payment is in progress. Return to it before starting another.", false);
    $("#planNotice").firstElementChild.insertAdjacentHTML("beforeend", '<button id="viewPayment">Return to payment</button>');
    $("#viewPayment").onclick = () => { checkoutTrigger = $("#viewPayment"); showCheckout(); };
    $("#viewPayment").focus();
  } else {
    restoreCheckoutFocus();
  }
}
$("#closeCheckout").onclick = closeCheckout;
$("#checkout").onclick = (event) => { if (event.target.id === "checkout") closeCheckout(); };
document.addEventListener("keydown", (event) => {
  if ($("#checkout").hidden || deskMode()) return;
  if (event.key === "Escape") closeCheckout();
  if (event.key === "Tab") {
    const controls = [...$("#checkout").querySelectorAll('a[href], button, input, select, [tabindex="0"]')]
      .filter((element) => !element.matches(":disabled") && element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
function clearRequestKey() {
  checkoutStore.remove(savedCheckoutKey);
  if (activeRequestKey) checkoutStore.remove(activeRequestKey);
}
function releaseFailedPayment() {
  clearRequestKey();
  paymentInProgress = undefined;
  $("#purchase").elements.acknowledge.checked = false;
  showPaymentDeadline(null);
  $("#purchaseFields").disabled = false;
  if (account) $("#purchase").elements.payerPhone.value = account.customer.phone;
  // A recovered snapshot remains valid for the original payment, but only a current,
  // eligible package can be offered for a new charge after that payment closes.
  selected = plans.find((plan) => plan.id === selected?.id);
  if (accountAction === "renew" && !renewal?.eligible) selected = undefined;
  renderCheckoutReview();
  if ($("#viewPayment") || $("#resumeCheckout")) notice("The previous payment is no longer pending. You can choose a package again.", false);
  renderPlans();
}
// "Payment didn't go through" (canvas: PhonePaymentFailed). Shown for the reason the
// API gives; while a request is still open the customer can ask for it, which shows
// the timeout state. A timed-out request keeps its key so "Check again" can still
// read it, and is never charged again from here.
const didntGoThrough = didntGoThroughButton();
let unresolvedCheckout, failedPaymentChecks = 0, failedPayment;
function keepUnresolved(id, key) { if (key) unresolvedCheckout = { id, key }; }
// A payment the provider answered (#409): its failure code, or the server's
// state for a request that ended without one. `status` carries the cheaper
// bundle and the short codes from the payment's status.
function showFailure(payment, reason = payment.failureCode || (["expired", "cancelled_or_pin", "invalid_subscriber", "insufficient_funds"].includes(payment.state) ? payment.state : undefined), status = {}) {
  if (!reason) return false;
  const same = failedPayment?.id === payment.id;
  if (!same) failedPaymentChecks = 0;
  failedPayment = same ? { ...failedPayment, ...payment } : { ...payment };
  if (status.cheaperBundle !== undefined || status.shortCodes !== undefined) failedExtra = { cheaperBundle: status.cheaperBundle || null, shortCodes: status.shortCodes || null };
  else if (!same) failedExtra = {};
  // Amounts in XAF, as the board and the 24 Nov brief write them.
  return showPaymentFailed(failedPayment, reason, paymentFailedActions, { money: xaf, checks: Math.max(1, failedPaymentChecks), ...failedExtra });
}
let failedExtra = {};
function retryCheckout(payment, change) {
  hidePaymentFailed();
  failedPayment = undefined;
  if (!choose(payment.planId)) { $("#packages").scrollIntoView({ block: "start" }); return; }
  openCheckout($(`#plans button[data-plan="${CSS.escape(payment.planId)}"]`) || $("#plans"));
  const form = $("#purchase"), number = account ? form.elements.payerPhone : form.elements.phone;
  if (account && payment.payerPhone) number.value = String(payment.payerPhone).replace(/^\+?237(?=6)/, "");
  if (change === "network") {
    form.dataset.requestedNetwork = payment.network === "orange" ? "mtn" : "orange";
    form.elements.network.dispatchEvent(new Event("change", { bubbles: true }));
    if (!number.value) { number.focus(); return; }
  }
  if (change === "number") { number.value = ""; number.focus(); return; }
  // A number corrected on the failure screen (#409).
  if (change && typeof change === "object" && change.number) number.value = String(change.number).replace(/^\+?237(?=6)/, "");
  $("#requestPayment").focus();
}
const paymentFailedActions = {
  retry: (payment, content) => retryCheckout(payment, content.number ? { number: content.number } : undefined),
  // The cheaper bundle after insufficient funds: its confirmation opens, and
  // the customer still taps Pay Now (24 Nov brief).
  switchBundle: (payment, content) => retryCheckout({ ...payment, planId: content.switchTo.planId }),
  otherNetwork: (payment) => retryCheckout(payment, "network"),
  differentNumber: (payment) => retryCheckout(payment, "number"),
  smallerBundle: () => {
    hidePaymentFailed();
    failedPayment = undefined;
    $("#packages").scrollIntoView({ block: "start" });
    $("#plans button[data-plan]:not([disabled])")?.focus();
  },
  checkAgain: (payment) => runButton($("#paymentFailedCheck"), "Checking…", async () => {
    failedPaymentChecks = Math.max(1, failedPaymentChecks) + 1;
    if (!await checkPayment(payment.id, payment.payerPhone)) showFailure(failedPayment, "timeout");
  }).catch((error) => showError($("#paymentFailedChecks"), error)),
};
document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-payment-failed]") || !paymentInProgress?.id) return;
  failedPaymentChecks = Math.max(1, failedPaymentChecks);
  showFailure(paymentInProgress, paymentInProgress.failureCode || "timeout");
});
async function beginAccountSecurity(paid, phone) {
  // Money received counts as paid, even when activation needs review.
  funnelStep("paid");
  if (paid.payment?.fulfillmentStatus === "needs_review") throw new ApiError(409, "Payment received. Activation needs support review; do not pay again.");
  if (account) {
    clearRequestKey();
    sessionStore.set("ndahi-plan-notice", "Payment confirmed. Your new package is active.");
    location.href = withWifiHint(purchaseVoucherDestination(paid.payment.id));
    return;
  }
  const emailMessage = paid.email?.status === "sent"
    ? " A purchase confirmation has been sent to your email."
    : paid.email?.status === "needs_email" ? " Your voucher is ready. Link an email in Account to receive email updates."
    : " Your voucher is ready; email delivery will continue automatically.";
  $("#message").innerHTML = `<div class="success"><strong>Payment confirmed.</strong>${emailMessage}<br>Preparing your secure account...</div>`;
  const saved = savedCheckout(), requestKey = paid.payment.requestKey || paymentInProgress?.requestKey || saved?.requestKey;
  const setup = await exchangeSetup(paid.payment.id, requestKey);
  clearRequestKey();
  sessionStore.remove("ndahi-login-challenge");
  location.href = withWifiHint(setup.mode === "login" ? "/login?account=1&payment=confirmed&next=" + encodeURIComponent(purchaseVoucherDestination(paid.payment.id)) : "/verify.html?setup=checkout");
}
async function checkPayment(paymentId, phone) {
  if (!account && paymentInProgress?.id === paymentId && paymentInProgress.status === "paid") {
    await beginAccountSecurity({ payment: paymentInProgress }, phone);
    return true;
  }
  let checkoutKey;
  if (!account) {
    checkoutKey = paymentInProgress?.id === paymentId ? paymentInProgress.requestKey : undefined;
    if (!checkoutKey) {
      // The owner session or an in-memory checkout key may still permit recovery.
      checkoutKey = activeRequestKey && checkoutStore.get(activeRequestKey);
      const saved = savedCheckout();
      if (!checkoutKey && (!saved?.paymentId || saved.paymentId === paymentId)) checkoutKey = saved?.requestKey;
      if (!checkoutKey && unresolvedCheckout?.id === paymentId) checkoutKey = unresolvedCheckout.key;
    }
  }
  let status;
  try {
    status = await call(`${account ? "/api/account" : "/api"}/payments/${paymentId}/status`, {
      headers: checkoutKey ? { "x-checkout-key": checkoutKey } : {},
    });
  } catch (error) {
    if (!account && error.status === 404) {
      releaseFailedPayment();
      notice("Checkout access expired. Check your payments or contact support before paying again.", false);
      throw new ApiError(404, `Checkout access has expired or is unavailable. This does not confirm whether money was deducted. Check your payments or contact support before paying again. Payment reference: ${paymentId}.`, "CHECKOUT_ACCESS_EXPIRED");
    }
    throw error;
  }
  if (paymentInProgress?.id === paymentId) Object.assign(paymentInProgress, status.payment);
  showPaymentDeadline(status.payment);
  if (status.payment.status === "paid" && status.payment.fulfillmentStatus === "needs_review") {
    releaseFailedPayment();
    showError($("#message"), new ApiError(409, "Payment received. Bundle activation needs support review. This payment remains in your history.", "ACTIVATION_REVIEW"), {
      actions: [{ label: "Review payments", run: () => location.assign("/dashboard#payments") },
        { label: "Payment help", run: () => location.assign("/help#payment") }],
    });
    return true;
  }
  if (status.payment.status === "paid" && (account || status.access?.code)) {
    await beginAccountSecurity(status, phone);
    return true;
  }
  if (["failed", "refunded", "expired"].includes(status.payment.status)) {
    if (status.payment.failureCode === "timeout") keepUnresolved(status.payment.id, checkoutKey);
    releaseFailedPayment();
    if (showFailure(status.payment, undefined, status)) return true;
    throw new ApiError(409, status.payment.failureReason || `Payment ${status.payment.status}. Return to packages to try again.`);
  }
  // Still open but the provider could not confirm it: the timeout view keeps counting.
  if (paymentFailedOpen()) showFailure(status.payment, "timeout", status);
  return false;
}
async function waitForPayment(paymentId, phone) {
  if (polling) return;
  polling = true;
  try {
    const started = Date.now();
    while (Date.now() - started < 10 * 60_000) {
      if (await checkPayment(paymentId, phone)) return;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new ApiError(408, "Payment confirmation is taking longer than expected. Check this payment again before starting another.");
  } catch (error) {
    showError($("#message"), error, {
      actions: [{ label: paymentInProgress ? "Check payment again" : "Check payments",
        run: () => paymentInProgress ? waitForPayment(paymentId, phone) : location.assign("/dashboard#payments") },
        { label: "Back to packages", run: () => location.reload() }],
    });
  } finally { polling = false; }
}
$("#purchase").onsubmit = async (event) => {
  event.preventDefault();
  if (!selected || !purchaseAccess.allowed || !subscriptionAccess.allowed || paymentInProgress || creatingPayment) return;
  const purchaseInput = formValues(event.target), previousSavedCheckout = savedCheckout();
  const paymentWindow = paymentProvider === "flutterwave"
    ? window.open("about:blank", "ndahi-payment", "popup,width=520,height=760") : null;
  $("#purchaseFields").disabled = true;
  creatingPayment = true;
  renderPlans();
  $("#requestPayment").textContent = "Creating payment...";
  try {
    const action = account ? accountAction || (account.currentPlan?.planId === selected.id ? "renew" : "switch") : null;
    activeRequestKey = `ndahi-payment-${action || "purchase"}-${selected.id}`;
    let requestKey = checkoutStore.get(activeRequestKey);
    if (!requestKey) { requestKey = randomId(); checkoutStore.set(activeRequestKey, requestKey); }
    const input = { ...(action ? { network: purchaseInput.network, payerPhone: purchaseInput.payerPhone, email: purchaseInput.email } : purchaseInput), planId: selected.id, upgrade: upgradePurchase, action, requestKey };
    // Saved before sending so a lost response can be resumed. Only the random key is kept;
    // contact details stay in this page and the API returns them on recovery.
    if (!action) checkoutStore.set(savedCheckoutKey, JSON.stringify({ requestKey, planId: selected.id }));
    const created = await call(action ? "/api/account/plan/purchase" : "/api/purchase", {
      method: "POST",
      body: JSON.stringify(input),
    });
    paymentInProgress = created.payment;
    funnelStep("payment_started");
    showPaymentDeadline(created.payment);
    if (!action) bindCheckoutDeadline(created.payment);
    renderPlans();
    if (created.payment.status === "paid") {
      paymentWindow?.close();
      return await checkPayment(created.payment.id, purchaseInput.phone);
    }
    if (["failed", "refunded", "expired"].includes(created.payment.status)) {
      releaseFailedPayment();
      if (showFailure(created.payment)) return;
      throw new ApiError(409, "This payment did not complete. You can try again.");
    }
    $("#message").innerHTML = `<div class="success">${h(created.payment.recoveryMessage || "Payment request created.")}${created.checkout.mode === "mock"
      ? ' <button id="confirm" type="button">Simulate payment approval</button>'
      : created.checkout.url ? " Complete approval in the secure payment window." : " Approve the prompt sent to your phone."
    }${created.payment.payerPhone ? `<br>Payment number: ${h(created.payment.payerPhone)}` : ""}<br><span id="paymentStatus">Waiting for verified confirmation...</span></div>${created.checkout.url ? "" : waitingText(created.payment)}${created.checkout.url ? "" : ussdInstructions(created.payment.payerPhone || purchaseInput.phone)}${account ? '<a class="payment-return" href="/dashboard#payments">Back to payments</a>' : ""}${didntGoThrough}`;
    if (created.checkout.url && created.checkout.provider === "flutterwave") {
      const destination = new URL(created.checkout.url);
      if (destination.protocol !== "https:") throw Error("Payment URL must use HTTPS");
      if (paymentWindow) paymentWindow.location.replace(destination.href);
      else $("#message").innerHTML += `<p><a class="button" href="${h(destination.href)}" target="_blank" rel="noopener">Open secure payment</a></p>`;
    } else paymentWindow?.close();
    const confirm = $("#confirm");
    if (confirm) confirm.onclick = async () => {
      try {
        await runButton(confirm, "Confirming…", async () => {
          const paid = await call(`/api/payments/${created.payment.id}/confirm`, { method: "POST", body: "{}" });
          await beginAccountSecurity(paid, purchaseInput.phone);
        });
      } catch (error) {
        showError($("#message"), error, { actions: [{ label: "Check payment again", run: () => waitForPayment(created.payment.id, purchaseInput.phone) }] });
      }
    };
    else void waitForPayment(created.payment.id, purchaseInput.phone);
  } catch (error) {
    paymentWindow?.close();
    if (account && !paymentInProgress && (["TimeoutError", "TypeError", "SyntaxError"].includes(error.name) || error.status >= 500)) {
      try {
        const refreshed = await call("/api/account/dashboard"), requestKey = activeRequestKey && checkoutStore.get(activeRequestKey);
        const recorded = requestKey && refreshed.payments.find((payment) => payment.requestKey === requestKey);
        if (recorded) {
          paymentInProgress = recorded;
          if (recorded.payerPhone) $("#purchase").elements.payerPhone.value = recorded.payerPhone;
          $("#purchaseFields").disabled = true;
          if (recorded.status === "paid") return await checkPayment(recorded.id, account.customer.phone);
        }
      } catch (_) { /* Keep the original error and checkout key for recovery. */ }
    }
    // The API answered and turned the request down, so there is nothing to resume later.
    if (!account && !paymentInProgress && error.status >= 400 && error.status < 500) clearRequestKey();
    if (error.code === "PAYMENT_IN_PROGRESS") {
      if (error.payment) {
        paymentInProgress = error.payment;
        showPaymentDeadline(error.payment);
      }
      const saved = previousSavedCheckout;
      const actions = [];
      if (paymentInProgress) actions.push({ label: "Check existing payment", run: () => waitForPayment(paymentInProgress.id, account.customer.phone) });
      else if (saved) actions.push({ label: "Resume saved payment", run: () => resumeSavedCheckout($("#requestPayment"), saved) });
      actions.push({ label: "Sign in to Payments", run: () => location.assign(withWifiHint("/dashboard#payments")) },
        { label: "Payment help", run: () => location.assign("/help#payment") });
      showError($("#message"), error, { actions });
      // Enable an explicit new request at expiry; never submit a charge on a timer.
      const seconds = error.retryAfterSeconds;
      if (Number.isFinite(seconds) && seconds > 0 && seconds <= 3600 && !paymentInProgress) {
        const currentMessage = $("#message").firstElementChild;
        setTimeout(() => {
          if (!$("#message").contains(currentMessage) || paymentInProgress || creatingPayment) return;
          $("#message").innerHTML = '<p role="status">The previous request window has ended. You can request a new payment. Any late confirmation will still be recorded.</p>';
          $("#requestPayment").disabled = false;
          $("#requestPayment").textContent = payLabel();
        }, seconds * 1000);
      }
      return;
    }
    coverageError = error.code === "OUTSIDE_COVERAGE";
    if (coverageError) setPurchaseAccess({ allowed: false, message: error.message });
    if (error.code === "ACTIVE_BUNDLE_EXISTS") subscriptionAccess = { allowed: false, code: error.code, message: error.message };
    const accountSignInActions = error.code === "ACCOUNT_SIGN_IN_REQUIRED" ? [
      { label: "Sign in to existing account", run: () => {
        const next = "/onboarding.html?plan=" + encodeURIComponent(selected.id);
        saveReturnPath(next);
        location.assign(withWifiHint("/login?account=1&next=" + encodeURIComponent(next)));
      } },
      { label: "Recover account", run: () => location.assign("/forgot-pin") },
    ] : null;
    const activeBundleActions = error.code === "ACTIVE_BUNDLE_EXISTS" ? [
      { label: account ? "Use existing bundle" : "Sign in to connect", run: () => {
        sessionStore.set("ndahi-return-to", "/dashboard");
        location.assign(withWifiHint(account ? "/dashboard" : "/login"));
      } },
      { label: "Back to packages", run: () => { location.reload(); } },
    ] : null;
    showError($("#message"), error, {
      actions: accountSignInActions || activeBundleActions || [{ label: paymentInProgress ? "Check payment again" : purchaseAccess.allowed ? "Try again" : "I've connected — check again",
        run: () => paymentInProgress ? waitForPayment(paymentInProgress.id, purchaseInput.phone) : purchaseAccess.allowed ? event.target.requestSubmit() : recheckPurchaseAccess() }],
    });
  } finally {
    creatingPayment = false;
    renderPlans();
    if (!paymentInProgress) {
      $("#purchaseFields").disabled = false;
      if (selected) {
        $("#requestPayment").textContent = purchaseAccess.allowed ? payLabel() : "Connect to NDAHI Wi-Fi";
        $("#requestPayment").disabled = !purchaseAccess.allowed || !subscriptionAccess.allowed;
      }
    } else $("#requestPayment").textContent = "Payment requested";
  }
};
initialize().catch((error) => {
  $("#plans").textContent = "";
  $("#plans").setAttribute("aria-busy", "false");
  showError($("#planNotice"), error, {
    actions: [{ label: "Try again", run: () => location.reload() }, { label: "Back to dashboard", run: () => { location.href = "/dashboard"; } }],
  });
});

function showPaymentDeadline(payment) {
  const target = $("#checkoutPaymentTimer");
  target.innerHTML = payment ? paymentClock(payment) : "";
  target.hidden = !target.innerHTML;
}
mountPaymentTimers({ onExpired: async () => {
  if (polling || creatingPayment) return;
  if (paymentInProgress?.id) await waitForPayment(paymentInProgress.id, account?.customer.phone || $("#purchase").elements.phone.value);
  else if ($("#checkExisting")) $("#checkExisting").click();
} });
startUpdates({ isBusy: () => creatingPayment || Boolean(paymentInProgress) || !$("#checkout").hidden });
