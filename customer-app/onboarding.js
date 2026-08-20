const api = window.NDAHI_CONFIG.apiUrl,
  $ = (selector) => document.querySelector(selector),
  money = (value) => new Intl.NumberFormat("en-CM").format(value) + " FCFA";
let selected, checkoutTrigger;
async function call(path, options = {}) {
  const response = await fetch(api + path, {
      credentials: "include",
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    }),
    result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
}
const { plans } = await call("/api/plans"), recommended = "monthly";
$("#plans").innerHTML = plans.map((plan) =>
  `<article class="plan" data-card="${plan.id}"><div class="plan-badge"></div><h3>${plan.name}</h3><div class="plan-price">${
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
  }</li><li>Reusable activation code</li></ul><button data-plan="${plan.id}">Choose plan</button></article>`
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
  $("#selected").textContent = `Buy ${selected.name} — ${money(selected.price)}`;
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
  const challenge = await call("/api/account/login/request-authenticator", {
    method: "POST",
    body: JSON.stringify({ phone, code: paid.access.code }),
  });
  sessionStorage.setItem("ndahi-login-challenge", JSON.stringify({
    ...challenge,
    phone,
    setup: true,
  }));
  location.href = "/verify.html?setup=1";
}
async function waitForPayment(paymentId, phone) {
  const started = Date.now();
  while (Date.now() - started < 10 * 60_000) {
    const status = await call(`/api/payments/${paymentId}/status`);
    if (status.payment.status === "paid" && status.access?.code) {
      return beginAccountSecurity(status, phone);
    }
    if (["failed", "refunded"].includes(status.payment.status)) {
      throw Error(`Payment ${status.payment.status}. Choose a plan to try again.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw Error("Payment confirmation is taking longer than expected. You can safely return and sign in after approval.");
}
$("#purchase").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const paymentWindow = window.open(
    "about:blank",
    "ndahi-flutterwave",
    "popup,width=520,height=760",
  );
  button.disabled = true;
  button.textContent = "Creating payment…";
  try {
    const purchaseInput = Object.fromEntries(new FormData(event.target)),
      created = await call("/api/purchase", {
      method: "POST",
      body: JSON.stringify({
        ...purchaseInput,
        planId: selected.id,
      }),
    });
    $("#message").innerHTML = `<div class="success">Payment request created.${
      created.checkout.mode === "mock"
        ? ' <button id="confirm">Simulate payment approval</button>'
        : created.checkout.url
        ? " Complete approval in the secure Flutterwave window."
        : " Approve the prompt sent to your phone."
    }<br><span id="paymentStatus">Waiting for verified confirmation…</span></div>`;
    if (created.checkout.url) {
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
          $("#message").innerHTML = `<p class="error">${error.message}</p>`;
          confirm.disabled = false;
        }
      };
    }
    if (created.checkout.mode !== "mock") {
      waitForPayment(created.payment.id, purchaseInput.phone).catch((error) => {
        $("#message").innerHTML = `<p class="error">${error.message}</p>`;
      });
    }
  } catch (error) {
    paymentWindow?.close();
    $("#message").innerHTML = `<p class="error">${error.message}</p>`;
  } finally {
    button.disabled = false;
    button.textContent = "Request payment";
  }
};
