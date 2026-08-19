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
  $("#selectionBar").hidden = false;
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
$("#plans").onclick = (event) => {
  if (event.target.dataset.plan) choose(event.target.dataset.plan);
};
choose(recommended);
$("#continue").onclick = () => {
  checkoutTrigger = document.activeElement;
  $("#selected").textContent = `Buy ${selected.name} — ${
    money(selected.price)
  }`;
  $("#checkout").hidden = false;
  document.body.classList.add("modal-open");
  $("#closeCheckout").focus();
};
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
$("#purchase").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  button.textContent = "Creating payment…";
  try {
    const created = await call("/api/purchase", {
      method: "POST",
      body: JSON.stringify({
        ...Object.fromEntries(new FormData(event.target)),
        planId: selected.id,
      }),
    });
    $("#message").innerHTML = `<div class="success">Payment request created.${
      created.checkout.mode === "mock"
        ? ' <button id="confirm">Simulate payment approval</button>'
        : created.checkout.url
        ? ' <button id="openProvider">Continue to secure payment</button>'
        : " Approve it on your phone."
    }</div>`;
    const openProvider = $("#openProvider");
    if (openProvider) openProvider.onclick = () => {
      const destination = new URL(created.checkout.url);
      if (destination.protocol !== "https:") throw Error("Payment URL must use HTTPS");
      location.assign(destination.href);
    };
    const confirm = $("#confirm");
    if (confirm) {
      confirm.onclick = async () => {
        confirm.disabled = true;
        try {
          const paid = await call(`/api/payments/${created.payment.id}/confirm`, {
            method: "POST",
            body: "{}",
          });
          $("#message").innerHTML =
            `<div class="success"><b>Payment confirmed</b><br>Your activation code: <code>${paid.access.code}</code><br>Save it privately, then <a href="/login">sign in to your dashboard</a>.</div>`;
        } catch (error) {
          $("#message").innerHTML = `<p class="error">${error.message}</p>`;
          confirm.disabled = false;
        }
      };
    }
  } catch (error) {
    $("#message").innerHTML = `<p class="error">${error.message}</p>`;
  } finally {
    button.disabled = false;
    button.textContent = "Request payment";
  }
};
