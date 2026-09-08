import { responseError, saveReturnPath, showError } from "./errors.js";

const api = window.NDAHI_CONFIG.apiUrl,
  $ = (selector) => document.querySelector(selector),
  money = (value) => new Intl.NumberFormat("en-CM").format(value) + " FCFA";
let selected, checkoutTrigger;
const pageParams = new URLSearchParams(location.search),
  accountAction = pageParams.get("action"),
  upgradePurchase = pageParams.get("upgrade") === "1" || accountAction === "switch";
async function call(path, options = {}) {
  const response = await fetch(api + path, {
      credentials: "include",
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    }),
    result = await response.json().catch(() => ({}));
  if (!response.ok) throw responseError(response, result);
  return result;
}
const catalogue = await call("/api/plans"), paymentProvider = catalogue.paymentProvider;
let plans = catalogue.plans, account;
if (accountAction) {
  try {
    account = await call("/api/account/dashboard");
    if (accountAction === "switch" && account.currentPlan) {
      plans = plans.filter((plan) => plan.id !== account.currentPlan.planId);
    }
  } catch (error) {
    if (error.status === 401) {
      saveReturnPath();
      location.replace("/login");
    } else {
      showError($("#plans"), error, {
        actions: [{ label: "Try again", run: () => location.reload() }],
      });
    }
    await new Promise(() => {});
  }
}
const requestedPlan = pageParams.get("plan"),
  dailyBlocked = (plan) => plan.id === "daily" && account && !account.dailyAvailability.available,
  recommended = plans.some((plan) => plan.id === requestedPlan && !dailyBlocked(plan))
    ? requestedPlan
    : plans.find((plan) => plan.id === "monthly" && !dailyBlocked(plan))?.id ||
      plans.find((plan) => !dailyBlocked(plan))?.id;
if (paymentProvider === "mesomb") {
  $("#purchase button").insertAdjacentHTML(
    "beforebegin",
    '<p class="trust">MeSomb\'s service fee is added separately to the package price and shown in your Mobile Money approval prompt.</p>',
  );
}
$("#plans").innerHTML = plans.map((plan) =>
  `<article class="plan" data-card="${plan.id}"><div class="plan-badge">${dailyBlocked(plan) ? "Available later" : plan.id === "daily" ? "Once every 7 days" : ""}</div><h3>${plan.name}</h3><div class="plan-price">${
    money(plan.price)
  } <small>/${
    plan.validityHours === 24
      ? "day"
      : plan.validityHours === 168
      ? "week"
      : "month"
  }</small></div><ul class="plan-details"><li>${
    plan.quotaGb === null ? "Unlimited data" : plan.quotaGb + " GB data"
  }</li><li>${
    plan.validityHours === 24
      ? "24 hours"
      : plan.validityHours === 168
      ? "7 days"
      : "30 days"
  } validity</li><li>${plan.deviceLimit} simultaneous device${
    plan.deviceLimit === 1 ? "" : "s"
  }</li><li>Reusable activation code</li>${dailyBlocked(plan) ? `<li>Next eligible: ${new Date(account.dailyAvailability.nextEligibleAt).toLocaleString()}</li>` : ""}</ul><button data-plan="${plan.id}" ${dailyBlocked(plan) ? "disabled" : ""}>${dailyBlocked(plan) ? "Unavailable" : accountAction === "renew" ? "Renew plan" : "Choose plan"}</button></article>`
).join("");
function choose(id) {
  selected = plans.find((plan) => plan.id === id);
  document.querySelectorAll(".plan").forEach((card) =>
    card.classList.toggle("selected", card.dataset.card === id)
  );
  $("#selectionBar").hidden = true;
  $("#selectionName").textContent = `${selected.name} — ${
    money(selected.price)
  }`;
  $("#selectionDetails").textContent = `${
    selected.quotaGb === null ? "Unlimited" : selected.quotaGb + " GB"
  } · ${selected.deviceLimit} device${
    selected.deviceLimit === 1 ? "" : "s"
  } · ${
    selected.validityHours === 24
      ? "24 hours"
      : selected.validityHours === 168
      ? "7 days"
      : "30 days"
  }`;
}
function openCheckout(trigger) {
  checkoutTrigger = trigger;
  const currentPlan = account?.currentPlan?.plan,
    direction = currentPlan && selected.price > currentPlan.price ? "Upgrade" :
      currentPlan && selected.price < currentPlan.price ? "Downgrade" : "Change";
  $("#selected").textContent = `${accountAction === "renew" ? "Renew" : accountAction === "switch" ? direction + " to" : upgradePurchase ? "Upgrade to" : "Buy"} ${selected.name} — ${money(selected.price)}${accountAction === "switch" && currentPlan ? ` (current: ${currentPlan.name}; full package price due now)` : ""}`;
  $("#checkout").hidden = false;
  document.body.classList.add("modal-open");
  $("#closeCheckout").focus();
}
$("#plans").onclick = (event) => {
  if (event.target.dataset.plan) {
    choose(event.target.dataset.plan);
    openCheckout(event.target);
  }
};
choose(recommended);
$("#continue").onclick = () => openCheckout($("#continue"));
function closeCheckout() {
  $("#checkout").hidden = true;
  document.body.classList.remove("modal-open");
  checkoutTrigger?.focus();
}
$("#closeCheckout").onclick = closeCheckout;
$("#checkout").onclick = (event) => {
  if (event.target.id === "checkout") closeCheckout();
};
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#checkout").hidden) closeCheckout();
});
async function beginAccountSecurity(paid, phone) {
  if (accountAction) {
    sessionStorage.setItem("ndahi-plan-notice", `${accountAction === "renew" ? "Plan renewed" : "Plan changed"} successfully. Payment was confirmed.`);
    location.href = "/dashboard";
    return;
  }
  const emailMessage = paid.email?.status === "sent"
    ? " A purchase confirmation has been sent to your email."
    : " Your voucher is ready; email delivery will continue automatically.";
  $("#message").innerHTML = `<div class="success"><strong>Payment confirmed.</strong>${emailMessage}<br>Preparing your secure account…</div>`;
  sessionStorage.setItem("ndahi-login-challenge", JSON.stringify({
    phone,
    code: paid.access.code,
    setupPin: true,
  }));
  await new Promise((resolve) => setTimeout(resolve, 900));
  location.href = "/verify.html?setup=pin";
}
async function waitForPayment(paymentId, phone) {
  const started = Date.now();
  while (Date.now() - started < 10 * 60_000) {
    const status = await call(`/api/payments/${paymentId}/status`);
    if (status.payment.status === "paid" && status.access?.code) {
      return beginAccountSecurity(status, phone);
    }
    if (["failed", "refunded"].includes(status.payment.status)) {
      throw Error(status.payment.failureReason || `Payment ${status.payment.status}. Choose a plan to try again.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw Error("Payment confirmation is taking longer than expected. You can safely return and sign in after approval.");
}
$("#purchase").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const paymentWindow = paymentProvider === "flutterwave"
    ? window.open(
      "about:blank",
      "ndahi-payment",
      "popup,width=520,height=760",
    )
    : null;
  button.disabled = true;
  button.textContent = "Creating payment…";
  try {
    const purchaseInput = Object.fromEntries(new FormData(event.target)),
      action = accountAction,
      requestKeyName = `ndahi-payment-${action || "purchase"}-${selected.id}`;
    let requestKey = sessionStorage.getItem(requestKeyName);
    if (!requestKey) {
      requestKey = crypto.randomUUID();
      sessionStorage.setItem(requestKeyName, requestKey);
    }
    const created = await call(action ? "/api/account/plan/purchase" : "/api/purchase", {
      method: "POST",
      body: JSON.stringify({
        ...purchaseInput,
        planId: selected.id,
        upgrade: upgradePurchase,
        action,
        requestKey,
      }),
    });
    if (created.payment.status === "paid") sessionStorage.removeItem(requestKeyName);
    $("#message").innerHTML = `<div class="success">Payment request created.${
      created.checkout.mode === "mock"
        ? ' <button id="confirm">Simulate payment approval</button>'
        : created.checkout.url
        ? " Complete approval in the secure payment window."
        : " Approve the prompt sent to your phone."
    }<br><span id="paymentStatus">Waiting for verified confirmation…</span></div>`;
    if (created.checkout.url && created.checkout.provider === "flutterwave") {
      const destination = new URL(created.checkout.url);
      if (destination.protocol !== "https:") throw Error("Payment URL must use HTTPS");
      if (paymentWindow) paymentWindow.location.replace(destination.href);
      else $("#message").innerHTML += `<p><a class="button" href="${destination.href}" target="_blank" rel="noopener">Open secure payment</a></p>`;
    } else paymentWindow?.close();
    const confirm = $("#confirm");
    if (confirm) {
      confirm.onclick = async () => {
        confirm.disabled = true;
        try {
          const paid = await call(`/api/payments/${created.payment.id}/confirm`, {
            method: "POST",
            body: "{}",
          });
          await beginAccountSecurity(paid, purchaseInput.phone);
        } catch (error) {
          showError($("#message"), error, {
            actions: [{ label: "Try again", run: () => location.reload() }],
          });
          confirm.disabled = false;
        }
      };
    }
    if (created.checkout.mode !== "mock") {
      waitForPayment(created.payment.id, purchaseInput.phone).catch((error) => {
        showError($("#message"), error, {
          actions: [{ label: "Check payment again", run: () => location.reload() }],
        });
      });
    }
  } catch (error) {
    paymentWindow?.close();
    showError($("#message"), error, {
      actions: [{ label: "Try again", run: () => event.target.requestSubmit() }],
    });
  } finally {
    button.disabled = false;
    button.textContent = "Request payment";
  }
};
