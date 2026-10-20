import { ApiError, responseError, saveReturnPath, showError } from "./errors.js";
import { applyNetworkStatus, fetchNetworkStatus } from "./network-status.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { durationLabel, dataLabel, classifyPlanChange, comparePlans, renewalEligibility } from "./plan-presentation.js";
import { runButton } from "/shared/pending.js";
import { formValues, sessionStore, randomId, requestJson } from "./compat.js";
import { checkoutStore, configureCheckoutStore, migrateLegacyCheckout, savedCheckout, savedCheckoutKey } from "./checkout-store.js";
import { paymentClock, mountPaymentTimers } from "./payment-timing.js";
import { startUpdates } from "./updates.js";
import { configurePairingLink } from "./wifi-pairing.js";
import { withWifiHint } from "./hotspot-path.js";

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

fetchNetworkStatus(api).then((status) => applyNetworkStatus($(".network-state"), status));
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
const dailyBlocked = (plan) => plan.id === "daily" && account && account.dailyAvailability?.available !== true;
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
        $("#requestPayment").disabled = !purchaseAccess.allowed;
        $("#requestPayment").textContent = purchaseAccess.allowed ? `Request payment - ${money(selected.price)}` : "Connect to NDAHI Wi-Fi";
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
    eligibility = plan.id === "daily" ? " Daily can be purchased once every 7 days." : "";
  if (accountAction || upgradePurchase) {
    return `${active || upgradePurchase ? "When payment is confirmed, your current package ends immediately. Unused data and remaining time do not carry over. " : "Your previous package is not active. "}${plan.name} starts on payment confirmation with ${durationLabel(plan.validityHours)} of validity. The full ${money(plan.price)} package price is due; no prorated credit is applied. Reconnect devices with the new activation code.${eligibility}`;
  }
  return `Your package starts on payment confirmation and lasts ${durationLabel(plan.validityHours)}. An activation code is created after verified payment. The full ${money(plan.price)} package price is due.${eligibility}`;
}
function notice(message, links = true) {
  $("#planNotice").innerHTML = `<div class="plan-notice"><p>${h(message)}</p>${links ? '<a href="/dashboard">Back to dashboard</a><a href="/onboarding.html?action=switch">Change plan</a>' : ""}</div>`;
}
function renderPlans() {
  $("#plans").innerHTML = plans.map((plan) => {
    const blocked = dailyBlocked(plan) || (accountAction === "renew" && !renewal?.eligible);
    const eligibility = blocked
      ? `Daily is available again ${date(account?.dailyAvailability?.nextEligibleAt)}.`
      : accountAction === "renew" ? "Eligible to renew now." : "";
    const badge = accountAction === "switch" ? changeLabel(plan) : accountAction === "renew" ? "Your renewal" : "";
    return `<article class="plan" data-card="${h(plan.id)}" aria-labelledby="plan-title-${h(plan.id)}">${badge ? `<div class="plan-badge">${h(badge)}</div>` : ""}
      <h3 id="plan-title-${h(plan.id)}">${h(plan.name)}</h3><div class="plan-price">${h(money(plan.price))}</div>
      ${accountAction === "switch" && account.currentPlan?.plan ? comparison(plan) : `<ul class="plan-details"><li>${h(dataLabel(plan.quotaGb))} data${plan.quotaGb === null ? " (fair use applies)" : ""}</li><li>${h(durationLabel(plan.validityHours))} validity</li><li>${h(plan.deviceLimit)} simultaneous device${plan.deviceLimit === 1 ? "" : "s"}</li></ul>`}
      ${accountAction === "switch" && (plan.quotaGb === null || account.currentPlan?.plan?.quotaGb === null) ? '<p class="trust">Unlimited data is subject to fair use.</p>' : ""}
      ${accountAction ? `<p class="plan-policy">${h(policy(plan))}</p>` : ""}
      ${eligibility ? `<p class="eligibility">${h(eligibility)}</p>` : ""}
      <button data-plan="${h(plan.id)}" aria-describedby="plan-title-${h(plan.id)}${purchaseAccess.allowed ? "" : " purchaseAccessMessage"}" ${!accessReady || blocked || !purchaseAccess.allowed || paymentInProgress || creatingPayment ? "disabled" : ""}>${!purchaseAccess.allowed ? "Connect to NDAHI Wi-Fi" : blocked ? "Currently unavailable" : accountAction === "renew" ? "Review renewal" : accountAction === "switch" ? "Switch to this plan" : "Choose plan"}</button>
    </article>`;
  }).join("");
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
  $("#accountContact").innerHTML = `<div><dt>Account number</dt><dd>${h(account.customer.phone)}</dd></div><div><dt>Email notifications</dt><dd>${account.customer.emailLinked ? h(account.customer.email) : 'Link an email in Account to receive updates and receipts.'}</dd></div>`;
  $("#accountPayer").hidden = false;
  form.elements.payerPhone.disabled = false;
  form.elements.payerPhone.required = true;
  form.elements.payerPhone.value = account.customer.phone;
  $("#acknowledgement").hidden = false;
  form.elements.acknowledge.required = true;
}
async function initialize() {
  if (accountAction && !["renew", "switch"].includes(accountAction)) throw Error("This plan action is unavailable. Return to your dashboard to choose a plan.");
  const catalogue = await call("/api/plans");
  configureCheckoutStore(catalogue.checkoutWindowSeconds);
  setPurchaseAccess(catalogue.purchaseAccess);
  cataloguePlans = catalogue.plans.filter((plan) => !plan.discontinued);
  plans = cataloguePlans;
  paymentProvider = catalogue.paymentProvider;
  if (!accountAction) renderPlans();
  $("#purchase").elements.email.required = paymentProvider === "flutterwave";
  if (paymentProvider === "flutterwave") {
    $("#emailLabel").textContent = "Payment contact email";
    $("#emailHint").textContent = "Flutterwave requires an email for this payment. Confirm an address in Account to enable email notifications.";
  }
  $("#providerFee").hidden = paymentProvider !== "mesomb";
  try {
    account = await call("/api/account/dashboard");
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
      notice("Packages are available, but your account could not load. Try again before starting a payment for your existing account.", false);
      $("#planNotice").firstElementChild.insertAdjacentHTML("beforeend", '<button id="retryAccount">Try again</button>');
      $("#retryAccount").onclick = () => location.reload();
      return;
    }
  }
  if (accountAction) renderAccount();
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
  const pending = account?.payments?.find((payment) => ["pending", "processing"].includes(payment.status));
  if (pending) {
    paymentInProgress = pending;
    showPaymentDeadline(pending);
    activeRequestKey = `ndahi-payment-${pending.action || "purchase"}-${pending.planId}`;
    const eligibilityReason = accountAction === "renew" && !renewal.eligible
      ? `${renewal.reason}${renewal.nextEligibleAt ? ` Next eligible: ${date(renewal.nextEligibleAt)}.` : ""} ` : "";
    notice(eligibilityReason + `A payment is already awaiting confirmation${pending.payerPhone ? ` on ${pending.payerPhone}` : ""}. Check its status before starting another payment.`, false);
    $("#planNotice").firstElementChild.insertAdjacentHTML("beforeend", '<button id="checkExisting">Check payment status</button> <a href="/dashboard">Back to dashboard</a>');
    $("#checkExisting").onclick = async (event) => {
      try {
        await runButton(event.currentTarget, "Checking…", async () => {
          const result = await call(`/api/account/payments/${pending.id}/status`);
          if (result.payment.status === "paid") return beginAccountSecurity(result);
          // A closed (expired) checkout no longer blocks a new payment.
          if (["failed", "refunded", "expired"].includes(result.payment.status)) {
            checkoutStore.remove(`ndahi-payment-${pending.action || "purchase"}-${pending.planId}`);
            location.reload();
          } else $("#planNotice p").textContent = result.payment.recoveryMessage || "This payment is still awaiting approval. Approve the existing Mobile Money prompt, then check its status again.";
        });
      } catch (error) {
        showError($("#planNotice"), error, { actions: [{ label: "Check again", run: () => location.reload() }] });
      }
    };
    renderPlans();
  }
  if (!pending && !accountAction) {
    const setup = await availableSetup();
    if (setup) {
      clearRequestKey(); paymentInProgress = { id: setup.paymentId, status: "paid" }; renderPlans();
      notice("Payment confirmed. Finish creating your PIN to open your account.", false);
      $("#planNotice").firstElementChild.insertAdjacentHTML("beforeend", `<a href="${h(withWifiHint("/verify.html?setup=checkout"))}">Continue PIN setup</a>`);
      return;
    }
    await restoreSavedCheckout();
  }

  const preferred = pageParams.get("plan");
  if (preferred && choose(preferred)) openCheckout(Array.from(document.querySelectorAll("#plans button[data-plan]")).find((button) => button.dataset.plan === preferred));
}
function fillSavedDetails(details) {
  for (const field of ["name", "phone", "email", "network"]) {
    if (details?.[field] && $("#purchase").elements[field]) $("#purchase").elements[field].value = details[field];
  }
}
function bindCheckoutDeadline(payment) {
  if (!payment || accountAction) return;
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
        location.href = withWifiHint(setup.mode === "login" ? "/login?payment=confirmed" : "/verify.html?setup=checkout");
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
    clearRequestKey();
    paymentInProgress = undefined;
    fillSavedDetails(recovered.details);
    notice(recovered.payment.failureReason || "Your previous payment did not complete. You can choose a package again.", false);
    renderPlans();
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
        $("#message").innerHTML = '<p>Approve the existing phone prompt, then recheck. Do not start another payment.</p><button type="button" id="resumeRecheck">Recheck payment</button>';
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
  if (!plan || !purchaseAccess.allowed || dailyBlocked(plan) || paymentInProgress || creatingPayment || (accountAction === "renew" && !renewal?.eligible)) return false;
  selected = plan;
  document.querySelectorAll(".plan").forEach((card) => card.classList.toggle("selected", card.dataset.card === id));
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
  $("#selected").textContent = checkoutTitle();
  $("#checkoutSummary").innerHTML = accountAction === "switch" && account.currentPlan?.plan ? comparison(selected)
    : `<p><strong>${h(money(selected.price))}</strong> / ${h(durationLabel(selected.validityHours))}</p><p>${h(dataLabel(selected.quotaGb))} data${selected.quotaGb === null ? " (fair use applies)" : ""} · ${h(selected.deviceLimit)} device${selected.deviceLimit === 1 ? "" : "s"}</p>`;
  $("#checkoutPolicy").textContent = policy(selected) + " There is no automatic renewal. Closing this page does not cancel a submitted payment. Refund requests require support review; no automatic prorated refund applies.";
  $("#acknowledgementText").textContent = account?.activeBundle?.status === "active"
    ? "I understand that payment replaces my current package immediately, without carrying over unused data or time."
    : "I understand that the new package starts when payment is confirmed.";
  $("#purchase").elements.acknowledge.checked = false;
  $("#requestPayment").textContent = purchaseAccess.allowed ? `Request payment - ${money(selected.price)}` : "Connect to NDAHI Wi-Fi";
  $("#requestPayment").disabled = !purchaseAccess.allowed;
}
function openCheckout(trigger) {
  checkoutTrigger = trigger;
  if (accountAction && !paymentInProgress) $("#purchase").elements.payerPhone.value = account.customer.phone;
  renderCheckoutReview();
  $("#message").textContent = "";
  showCheckout();
}
function showCheckout() {
  $("#checkout").hidden = false;
  document.body.classList.add("modal-open");
  $("#pageContent").inert = true;
  $("header").inert = true;
  $("footer").inert = true;
  $("#closeCheckout").focus();
}
$("#plans").onclick = (event) => {
  const button = event.target.closest("button[data-plan]");
  if (button && !button.disabled && choose(button.dataset.plan)) openCheckout(button);
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
  if ($("#checkout").hidden) return;
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
  showPaymentDeadline(null);
  $("#purchaseFields").disabled = false;
  if (accountAction) $("#purchase").elements.payerPhone.value = account.customer.phone;
  // A recovered snapshot remains valid for the original payment, but only a current,
  // eligible package can be offered for a new charge after that payment closes.
  selected = plans.find((plan) => plan.id === selected?.id && !dailyBlocked(plan));
  if (accountAction === "renew" && !renewal?.eligible) selected = undefined;
  renderCheckoutReview();
  if ($("#viewPayment") || $("#resumeCheckout")) notice("The previous payment is no longer pending. You can choose a package again.", false);
  renderPlans();
}
async function beginAccountSecurity(paid, phone) {
  if (paid.payment?.fulfillmentStatus === "needs_review") throw new ApiError(409, "Payment received. Activation needs support review; do not pay again.");
  if (accountAction) {
    clearRequestKey();
    sessionStore.set("ndahi-plan-notice", "Payment confirmed. Your new package is active.");
    location.href = window.NDAHI_CONFIG.hotspotLoginUrl ? withWifiHint("/hotspot") : "/dashboard";
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
  location.href = withWifiHint(setup.mode === "login" ? "/login?payment=confirmed" : "/verify.html?setup=checkout");
}
async function checkPayment(paymentId, phone) {
  if (!accountAction && paymentInProgress?.id === paymentId && paymentInProgress.status === "paid") {
    await beginAccountSecurity({ payment: paymentInProgress }, phone);
    return true;
  }
  let checkoutKey;
  if (!accountAction) {
    checkoutKey = paymentInProgress?.id === paymentId ? paymentInProgress.requestKey : undefined;
    if (!checkoutKey) {
      // The owner session or an in-memory checkout key may still permit recovery.
      checkoutKey = activeRequestKey && checkoutStore.get(activeRequestKey);
      const saved = savedCheckout();
      if (!checkoutKey && (!saved?.paymentId || saved.paymentId === paymentId)) checkoutKey = saved?.requestKey;
    }
  }
  let status;
  try {
    status = await call(`${accountAction ? "/api/account" : "/api"}/payments/${paymentId}/status`, {
      headers: checkoutKey ? { "x-checkout-key": checkoutKey } : {},
    });
  } catch (error) {
    if (!accountAction && error.status === 404) {
      releaseFailedPayment();
      notice("Checkout access expired. Check your payments or contact support before paying again.", false);
      throw new ApiError(404, `Checkout access has expired or is unavailable. This does not confirm whether money was deducted. Check your payments or contact support before paying again. Payment reference: ${paymentId}.`, "CHECKOUT_ACCESS_EXPIRED");
    }
    throw error;
  }
  if (paymentInProgress?.id === paymentId) Object.assign(paymentInProgress, status.payment);
  showPaymentDeadline(status.payment);
  if (status.payment.status === "paid" && (accountAction || status.access?.code)) {
    await beginAccountSecurity(status, phone);
    return true;
  }
  if (["failed", "refunded", "expired"].includes(status.payment.status)) {
    releaseFailedPayment();
    throw new ApiError(409, status.payment.failureReason || `Payment ${status.payment.status}. Return to packages to try again.`);
  }
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
  if (!selected || !purchaseAccess.allowed || paymentInProgress || creatingPayment) return;
  const purchaseInput = formValues(event.target);
  const paymentWindow = paymentProvider === "flutterwave"
    ? window.open("about:blank", "ndahi-payment", "popup,width=520,height=760") : null;
  $("#purchaseFields").disabled = true;
  creatingPayment = true;
  renderPlans();
  $("#requestPayment").textContent = "Creating payment...";
  try {
    const action = accountAction;
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
    showPaymentDeadline(created.payment);
    if (!action) bindCheckoutDeadline(created.payment);
    renderPlans();
    if (created.payment.status === "paid") {
      paymentWindow?.close();
      return await checkPayment(created.payment.id, purchaseInput.phone);
    }
    if (["failed", "refunded", "expired"].includes(created.payment.status)) {
      releaseFailedPayment();
      throw new ApiError(409, "This payment did not complete. You can try again.");
    }
    $("#message").innerHTML = `<div class="success">${h(created.payment.recoveryMessage || "Payment request created.")}${created.checkout.mode === "mock"
      ? ' <button id="confirm" type="button">Simulate payment approval</button>'
      : created.checkout.url ? " Complete approval in the secure payment window." : " Approve the prompt sent to your phone."
    }${created.payment.payerPhone ? `<br>Payment number: ${h(created.payment.payerPhone)}` : ""}<br><span id="paymentStatus">Waiting for verified confirmation...</span></div>${accountAction ? '<a class="payment-return" href="/dashboard#payments">Back to payments</a>' : ""}`;
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
    if (accountAction && !paymentInProgress && (["TimeoutError", "TypeError", "SyntaxError"].includes(error.name) || error.status >= 500)) {
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
    if (!accountAction && !paymentInProgress && error.status >= 400 && error.status < 500) clearRequestKey();
    coverageError = error.code === "OUTSIDE_COVERAGE";
    if (coverageError) setPurchaseAccess({ allowed: false, message: error.message });
    showError($("#message"), error, {
      actions: [{ label: paymentInProgress ? "Check payment again" : purchaseAccess.allowed ? "Try again" : "I've connected — check again",
        run: () => paymentInProgress ? waitForPayment(paymentInProgress.id, purchaseInput.phone) : purchaseAccess.allowed ? event.target.requestSubmit() : recheckPurchaseAccess() }],
    });
  } finally {
    creatingPayment = false;
    renderPlans();
    if (!paymentInProgress) {
      $("#purchaseFields").disabled = false;
      if (selected) {
        $("#requestPayment").textContent = purchaseAccess.allowed ? `Request payment - ${money(selected.price)}` : "Connect to NDAHI Wi-Fi";
        $("#requestPayment").disabled = !purchaseAccess.allowed;
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
