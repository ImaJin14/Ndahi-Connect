import { ApiError, responseError, saveReturnPath, showError } from "./errors.js";
import { applyNetworkStatus, fetchNetworkStatus } from "./network-status.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { durationLabel, dataLabel, classifyPlanChange, comparePlans, renewalEligibility } from "./plan-presentation.js";

const savedCheckoutKey = "ndahi-interrupted-checkout";
const api = window.NDAHI_CONFIG.apiUrl,
  $ = (selector) => document.querySelector(selector),
  money = (value) => new Intl.NumberFormat("en-CM").format(value) + " FCFA",
  date = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not scheduled",
  pageParams = new URLSearchParams(location.search),
  accountAction = pageParams.get("action"),
  upgradePurchase = pageParams.get("upgrade") === "1";
let selected, checkoutTrigger, csrfToken = "", account, plans = [], cataloguePlans = [],
  paymentProvider, renewal, paymentInProgress, activeRequestKey, polling = false, creatingPayment = false;

fetchNetworkStatus(api).then((status) => applyNetworkStatus($(".network-state"), status));
async function call(path, options = {}) {
  const response = await fetch(api + path, {
    credentials: "include", ...options,
    headers: {
      "content-type": "application/json",
      ...(options.method && options.method !== "GET" && csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...(options.headers || {}),
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw responseError(response, result);
  return result;
}
const dailyBlocked = (plan) => plan.id === "daily" && account && account.dailyAvailability?.available !== true;
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
      <button data-plan="${h(plan.id)}" aria-describedby="plan-title-${h(plan.id)}" ${blocked || paymentInProgress || creatingPayment ? "disabled" : ""}>${blocked ? "Currently unavailable" : accountAction === "renew" ? "Review renewal" : accountAction === "switch" ? "Switch to this plan" : "Choose plan"}</button>
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
  form.elements.email.readOnly = true;
  form.elements.name.required = false;
  form.elements.phone.required = false;
  form.elements.email.required = false;
  $("#purchase .form-row").hidden = true;
  form.elements.email.closest("label").hidden = true;
  $("#accountContact").hidden = false;
  $("#accountContact").innerHTML = `<div><dt>Payment phone</dt><dd>${h(account.customer.phone)}</dd></div><div><dt>Receipt email</dt><dd>${h(account.customer.email || "No email on account")}</dd></div>`;
  $("#acknowledgement").hidden = false;
  form.elements.acknowledge.required = true;
}
async function initialize() {
  if (accountAction && !["renew", "switch"].includes(accountAction)) throw Error("This plan action is unavailable. Return to your dashboard to choose a plan.");
  const catalogue = await call("/api/plans");
  cataloguePlans = catalogue.plans.filter((plan) => !plan.discontinued);
  plans = cataloguePlans;
  paymentProvider = catalogue.paymentProvider;
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
        location.replace("/login");
        return;
      }
      throw error;
    }
    if (error.status !== 401) throw error;
  }
  if (accountAction) renderAccount();
  else $(".hero").hidden = false;
  for (const payment of account?.payments || []) {
    const key = `ndahi-payment-${payment.action || "purchase"}-${payment.planId}`;
    if (["paid", "failed", "refunded"].includes(payment.status) && payment.requestKey &&
      localStorage.getItem(key) === payment.requestKey) localStorage.removeItem(key);
  }
  renderPlans();
  if (!plans.length && !(accountAction === "renew" && !renewal?.eligible)) {
    notice(accountAction === "switch" ? "There are no alternative packages available right now." : "No packages are available right now.", Boolean(accountAction));
  }
  const pending = account?.payments?.find((payment) => ["pending", "processing"].includes(payment.status));
  if (pending) {
    paymentInProgress = pending;
    activeRequestKey = `ndahi-payment-${pending.action || "purchase"}-${pending.planId}`;
    const eligibilityReason = accountAction === "renew" && !renewal.eligible
      ? `${renewal.reason}${renewal.nextEligibleAt ? ` Next eligible: ${date(renewal.nextEligibleAt)}.` : ""} ` : "";
    notice(eligibilityReason + "A payment is already awaiting confirmation. Check its status before starting another payment.", false);
    $("#planNotice").firstElementChild.insertAdjacentHTML("beforeend", '<button id="checkExisting">Check payment status</button> <a href="/dashboard">Back to dashboard</a>');
    $("#checkExisting").onclick = async () => {
      $("#checkExisting").disabled = true;
      try {
        const result = await call(`/api/account/payments/${pending.id}/status`);
        if (result.payment.status === "paid") return beginAccountSecurity(result);
        if (["failed", "refunded"].includes(result.payment.status)) {
          localStorage.removeItem(`ndahi-payment-${pending.action || "purchase"}-${pending.planId}`);
          location.reload();
        } else $("#planNotice p").textContent = result.payment.recoveryMessage || "This payment is still awaiting approval. Approve the existing Mobile Money prompt, then check its status again.";
      } catch (error) {
        showError($("#planNotice"), error, { actions: [{ label: "Check again", run: () => location.reload() }] });
      } finally {
        if ($("#checkExisting")) $("#checkExisting").disabled = false;
      }
    };
    renderPlans();
  }
  if (!pending && !accountAction) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(savedCheckoutKey)); } catch { /* no saved checkout */ }
    if (saved?.input?.requestKey) {
      notice("An interrupted checkout is saved on this browser. Resume it before starting another payment.", false);
      $("#planNotice").firstElementChild.insertAdjacentHTML("beforeend", '<button id="resumeCheckout">Resume saved payment</button>');
      paymentInProgress = { id: saved.paymentId };
      renderPlans();
      $("#resumeCheckout").onclick = async () => {
        const button = $("#resumeCheckout"); button.disabled = true;
        try {
          let created;
          try { created = await call("/api/purchase/recover", { method: "POST", body: JSON.stringify(saved.input) }); }
          catch (error) {
            if (error.status !== 404) throw error;
            // No durable reservation exists, so this original request has not reached the provider.
            created = await call("/api/purchase", { method: "POST", body: JSON.stringify(saved.input) });
          }
          paymentInProgress = created.payment;
          selected = cataloguePlans.find((p) => p.id === created.payment.planId) || created.payment.plan;
          activeRequestKey = `ndahi-payment-purchase-${created.payment.planId}`;
          showCheckout();
          $("#selected").textContent = "Resume your payment";
          $("#purchaseFields").disabled = true;
          $("#message").textContent = "Checking your existing payment…";
          if (!await checkPayment(created.payment.id, saved.input.phone)) {
            $("#message").innerHTML = '<p>Approve the existing phone prompt, then recheck. Do not start another payment.</p><button type="button" id="resumeRecheck">Recheck payment</button>';
            $("#resumeRecheck").onclick = () => waitForPayment(created.payment.id, saved.input.phone);
            if (created.checkout.mode === "mock") {
              $("#message").insertAdjacentHTML("beforeend", '<button type="button" id="resumeMock">Simulate payment approval</button>');
              $("#resumeMock").onclick = async () => {
                const paid = await call(`/api/payments/${created.payment.id}/confirm`, { method: "POST", body: "{}" });
                await beginAccountSecurity(paid, saved.input.phone);
              };
            } else if (/^https:\/\//i.test(created.checkout.url || "")) {
              $("#message").insertAdjacentHTML("beforeend", `<a href="${h(created.checkout.url)}" target="_blank" rel="noopener">Resume secure payment</a>`);
            }
          }
        } catch (error) { showError($("#message"), error); } finally { button.disabled = false; }
      };
    }
  }

}
function choose(id) {
  const plan = plans.find((item) => item.id === id);
  if (!plan || dailyBlocked(plan) || paymentInProgress || creatingPayment || (accountAction === "renew" && !renewal?.eligible)) return false;
  selected = plan;
  document.querySelectorAll(".plan").forEach((card) => card.classList.toggle("selected", card.dataset.card === id));
  return true;
}
function openCheckout(trigger) {
  checkoutTrigger = trigger;
  const verb = accountAction === "renew" ? "Renew" : accountAction === "switch" ? "Switch to" : upgradePurchase ? "Upgrade to" : "Buy";
  $("#selected").textContent = `${verb} ${selected.name}`;
  $("#checkoutSummary").innerHTML = accountAction === "switch" && account.currentPlan?.plan ? comparison(selected)
    : `<p><strong>${h(money(selected.price))}</strong> / ${h(durationLabel(selected.validityHours))}</p><p>${h(dataLabel(selected.quotaGb))} data${selected.quotaGb === null ? " (fair use applies)" : ""} · ${h(selected.deviceLimit)} device${selected.deviceLimit === 1 ? "" : "s"}</p>`;
  $("#checkoutPolicy").textContent = policy(selected) + " There is no automatic renewal. Closing this page does not cancel a submitted payment. Refund requests require support review; no automatic prorated refund applies.";
  $("#acknowledgementText").textContent = account?.activeBundle?.status === "active"
    ? "I understand that payment replaces my current package immediately, without carrying over unused data or time."
    : "I understand that the new package starts when payment is confirmed.";
  $("#purchase").elements.acknowledge.checked = false;
  $("#requestPayment").textContent = `Request payment - ${money(selected.price)}`;
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
function closeCheckout() {
  $("#checkout").hidden = true;
  document.body.classList.remove("modal-open");
  $("#pageContent").inert = false;
  $("header").inert = false;
  $("footer").inert = false;
  checkoutTrigger?.focus();
  if (paymentInProgress || creatingPayment) {
    notice("A payment is in progress. Return to it before starting another.", false);
    $("#planNotice").firstElementChild.insertAdjacentHTML("beforeend", '<button id="viewPayment">Return to payment</button>');
    $("#viewPayment").onclick = showCheckout;
    $("#viewPayment").focus();
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
  localStorage.removeItem(savedCheckoutKey);
  if (activeRequestKey) localStorage.removeItem(activeRequestKey);
}
function releaseFailedPayment() {
  clearRequestKey();
  paymentInProgress = undefined;
  $("#purchaseFields").disabled = false;
  $("#requestPayment").textContent = `Request payment - ${money(selected.price)}`;
  if ($("#viewPayment")) notice("The previous payment is no longer pending. You can choose a package again.", false);
  renderPlans();
}
async function beginAccountSecurity(paid, phone) {
  clearRequestKey();
  if (paid.payment?.fulfillmentStatus === "needs_review") throw new ApiError(409, "Payment received. Activation needs support review; do not pay again.");
  if (account) {
    sessionStorage.setItem("ndahi-plan-notice", "Payment confirmed. Your new package is active.");
    location.href = "/dashboard";
    return;
  }
  const emailMessage = paid.email?.status === "sent"
    ? " A purchase confirmation has been sent to your email."
    : " Your voucher is ready; email delivery will continue automatically.";
  $("#message").innerHTML = `<div class="success"><strong>Payment confirmed.</strong>${emailMessage}<br>Preparing your secure account...</div>`;
  sessionStorage.setItem("ndahi-login-challenge", JSON.stringify({ phone, code: paid.access.code, setupPin: true }));
  location.href = "/verify.html?setup=pin";
}
async function checkPayment(paymentId, phone) {
  const status = await call(`${accountAction ? "/api/account" : "/api"}/payments/${paymentId}/status`);
  if (status.payment.status === "paid" && (accountAction || status.access?.code)) {
    await beginAccountSecurity(status, phone);
    return true;
  }
  if (["failed", "refunded"].includes(status.payment.status)) {
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
      actions: [{ label: paymentInProgress ? "Check payment again" : "Try again",
        run: () => paymentInProgress ? waitForPayment(paymentId, phone) : $("#purchase").requestSubmit() },
        { label: "Back to packages", run: () => location.reload() }],
    });
  } finally { polling = false; }
}
$("#purchase").onsubmit = async (event) => {
  event.preventDefault();
  if (!selected || paymentInProgress || creatingPayment) return;
  const purchaseInput = Object.fromEntries(new FormData(event.target));
  const paymentWindow = paymentProvider === "flutterwave"
    ? window.open("about:blank", "ndahi-payment", "popup,width=520,height=760") : null;
  $("#purchaseFields").disabled = true;
  creatingPayment = true;
  renderPlans();
  $("#requestPayment").textContent = "Creating payment...";
  try {
    const action = accountAction;
    activeRequestKey = `ndahi-payment-${action || "purchase"}-${selected.id}`;
    let requestKey = localStorage.getItem(activeRequestKey);
    if (!requestKey) { requestKey = crypto.randomUUID(); localStorage.setItem(activeRequestKey, requestKey); }
    const input = { ...(action ? { network: purchaseInput.network } : purchaseInput), planId: selected.id, upgrade: upgradePurchase, action, requestKey };
    if (!action) localStorage.setItem(savedCheckoutKey, JSON.stringify({ input }));
    const created = await call(action ? "/api/account/plan/purchase" : "/api/purchase", {
      method: "POST",
      body: JSON.stringify(input),
    });
    paymentInProgress = created.payment;
    if (!action) localStorage.setItem(savedCheckoutKey, JSON.stringify({ input, paymentId: created.payment.id }));
    renderPlans();
    if (created.payment.status === "paid") {
      paymentWindow?.close();
      return await checkPayment(created.payment.id, purchaseInput.phone);
    }
    if (["failed", "refunded"].includes(created.payment.status)) {
      releaseFailedPayment();
      throw new ApiError(409, "This payment did not complete. You can try again.");
    }
    $("#message").innerHTML = `<div class="success">${h(created.payment.recoveryMessage || "Payment request created.")}${created.checkout.mode === "mock"
      ? ' <button id="confirm" type="button">Simulate payment approval</button>'
      : created.checkout.url ? " Complete approval in the secure payment window." : " Approve the prompt sent to your phone."
    }<br><span id="paymentStatus">Waiting for verified confirmation...</span></div>${accountAction ? '<a class="payment-return" href="/dashboard">Back to dashboard</a>' : ""}`;
    if (created.checkout.url && created.checkout.provider === "flutterwave") {
      const destination = new URL(created.checkout.url);
      if (destination.protocol !== "https:") throw Error("Payment URL must use HTTPS");
      if (paymentWindow) paymentWindow.location.replace(destination.href);
      else $("#message").innerHTML += `<p><a class="button" href="${h(destination.href)}" target="_blank" rel="noopener">Open secure payment</a></p>`;
    } else paymentWindow?.close();
    const confirm = $("#confirm");
    if (confirm) confirm.onclick = async () => {
      confirm.disabled = true;
      try {
        const paid = await call(`/api/payments/${created.payment.id}/confirm`, { method: "POST", body: "{}" });
        await beginAccountSecurity(paid, purchaseInput.phone);
      } catch (error) {
        showError($("#message"), error, { actions: [{ label: "Check payment again", run: () => waitForPayment(created.payment.id, purchaseInput.phone) }] });
      }
    };
    else void waitForPayment(created.payment.id, purchaseInput.phone);
  } catch (error) {
    paymentWindow?.close();
    showError($("#message"), error, {
      actions: [{ label: paymentInProgress ? "Check payment again" : "Try again",
        run: () => paymentInProgress ? waitForPayment(paymentInProgress.id, purchaseInput.phone) : event.target.requestSubmit() }],
    });
  } finally {
    creatingPayment = false;
    renderPlans();
    if (!paymentInProgress) {
      $("#purchaseFields").disabled = false;
      $("#requestPayment").textContent = `Request payment - ${money(selected.price)}`;
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
