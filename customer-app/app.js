import { responseError, saveReturnPath, showError } from "./errors.js";
import { applyNetworkStatus } from "./network-status.js";
import { escapeHtml as h } from "/shared/safe-html.js";

const api = window.NDAHI_CONFIG.apiUrl,
  $ = (selector) => document.querySelector(selector),
  deviceId = localStorage.getItem("ndahi-device") || crypto.randomUUID(),
  fmt = (value) => value === null ? "Unlimited" : `${(value / 1e9).toFixed(2)} GB`,
  securitySetup = new URLSearchParams(location.search).get("setup") === "passkey";
let csrfToken = "";
localStorage.setItem("ndahi-device", deviceId);

async function call(path, options = {}) {
  const response = await fetch(api + path, { credentials: "include", ...options, headers: { "content-type": "application/json", ...(options.method && options.method !== "GET" && csrfToken ? { "x-csrf-token": csrfToken } : {}), ...(options.headers || {}) } }),
    result = await response.json().catch(() => ({}));
  if (response.status === 401) {
    saveReturnPath();
    location.replace("/login");
    throw responseError(response, result);
  }
  if (!response.ok) throw responseError(response, result);
  return result;
}

async function runButton(button, pendingText, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = pendingText;
  try { return await task(); } finally { button.disabled = false; button.textContent = original; }
}

async function load() {
  const result = await call("/api/account/dashboard"), active = result.activeBundle,
    current = result.currentPlan, usage = active?.usagePercentage ?? 0,
    duration = current?.plan?.validityHours === 24 ? "24 hours" : current?.plan?.validityHours === 168 ? "7 days" : "30 days",
    remaining = active ? Math.max(0, new Date(active.expiresAt) - Date.now()) : 0,
    remainingText = active ? `${Math.floor(remaining / 36e5)}h ${Math.floor(remaining % 36e5 / 6e4)}m` : "Not active";
  csrfToken = result.csrfToken;
  applyNetworkStatus($(".network-state"), result.zone?.status);
  $("#differentCode").open = !active;
  const thisDeviceConnected = active?.sessions.some((session) => session.deviceId === deviceId),
    quickConnect = !active ? "" : thisDeviceConnected ? "" : active.activeDevices < active.deviceLimit
      ? `<form id="connectDevice"><label>Device name<input name="label" value="This device" placeholder="This device"></label><button>Connect this device</button></form><div id="connectMessage" role="status" aria-live="polite"></div>`
      : "<p>All device slots are in use. Disconnect a device to add this one.</p>";
  const pendingPayment = result.payments.find((payment) => ["pending", "processing"].includes(payment.status)),
    emptyBundleMessage = pendingPayment
      ? "A payment is awaiting confirmation. Recheck it in Payment history before paying again."
      : current?.status === "exhausted"
      ? "Your last bundle's data is used up. Renew below to reconnect."
      : current?.status === "expired"
      ? "Your last bundle expired. Renew or choose a new package below to reconnect."
      : current
      ? "This bundle is no longer active."
      : "Choose a package to get started.",
    provisioningNotice = active?.routerSyncStatus === "dead_letter"
      ? '<p class="error">We’re having trouble connecting this bundle to the network. Our systems are retrying automatically.</p>'
      : active?.routerSyncStatus === "pending"
      ? "<p>Finishing network setup for this bundle…</p>"
      : "";
  $("#dashboard").innerHTML = `<div class="dashboard-grid">
    <section class="surface"><p class="eyebrow">Active bundle</p><h2>${active ? h(active.plan.name) : "No active bundle"}</h2>${active ? `<progress class="usage-progress" max="100" value="${h(usage)}" aria-label="${h(usage.toFixed(1))}% of bundle used"></progress><div class="stats"><div class="stat"><b>${h(fmt(active.remainingBytes))}</b><small>Remaining</small></div><div class="stat"><b>${h(usage.toFixed(1))}%</b><small>Used</small></div><div class="stat"><b>${h(new Date(active.expiresAt).toLocaleDateString())}</b><small>Expires</small></div></div>${provisioningNotice}` : `<p>${h(emptyBundleMessage)}</p>`}</section>
    <section class="surface"><h2>Connected devices</h2>${active?.sessions.length ? active.sessions.map((session) => `<div class="device"><div><b>${h(session.label)}</b><br><small>${h(session.deviceId.slice(0, 14))}…</small></div><button type="button" data-session="${h(session.id)}">Disconnect</button></div>`).join("") : active ? "<p>No devices are currently connected.</p>" : "<p>Activate a bundle to connect a device.</p>"}${active ? `<p>${h(active.activeDevices)} of ${h(active.deviceLimit)} device slots in use</p>` : ""}${quickConnect}</section>
    <section class="surface full" id="managePlan"><p class="eyebrow">Manage plan</p><h2>${current?.plan?.name ? h(current.plan.name) : "No current plan"}</h2>${current ? `<div class="stats"><div class="stat"><b>${h(current.plan.price.toLocaleString())} FCFA</b><small>Price</small></div><div class="stat"><b>${h(current.status)}</b><small>Status</small></div><div class="stat"><b>${h(remainingText)}</b><small>Remaining validity</small></div></div><p><strong>Started:</strong> ${h(new Date(current.activatedAt).toLocaleString())} · <strong>Expires:</strong> ${h(new Date(current.expiresAt).toLocaleString())}</p><p>${current.plan.quotaGb === null ? "Unlimited data (fair use applies)" : `${h(current.plan.quotaGb)} GB data`} · ${h(duration)} · ${h(current.plan.deviceLimit)} device${current.plan.deviceLimit === 1 ? "" : "s"}</p><div class="plan-actions">${current.plan.discontinued ? '<p class="error">This historical plan is discontinued and cannot be renewed.</p>' : `<a class="button" href="/onboarding.html?action=renew&amp;plan=${h(current.plan.id)}">Renew plan</a>`}<a class="button secondary-action" href="/onboarding.html?action=switch">Change / switch plan</a></div>` : '<p>Choose a package to activate your connection.</p><div class="plan-actions"><a class="button" href="/onboarding.html">Browse packages</a></div>'}<p>${result.dailyAvailability.available ? "The 100 FCFA Daily bundle is available." : `Daily is available again ${h(new Date(result.dailyAvailability.nextEligibleAt).toLocaleString())}.`}</p></section>
    <section class="surface full${securitySetup ? " security-setup" : ""}" id="accountSecurity">${securitySetup ? '<div class="success"><strong>Security setup complete.</strong></div>' : ""}<p class="eyebrow">Account security</p><h2>PIN, authenticator & passkeys</h2><p>Your 4-digit PIN is configured. Authenticator 2FA is optional and currently <strong>${result.customer.authenticatorEnrolled ? "enabled" : "disabled"}</strong>.</p>${result.customer.authenticatorEnrolled ? "" : '<button type="button" id="enableCustomerMfa">Enable authenticator 2FA</button><div id="mfaSetup"></div>'}<p>Use your device lock, fingerprint, or security key for faster sign-in.</p><button type="button" id="addCustomerPasskey">Add a passkey</button><p>${result.customer.passkeys || 0} passkey${result.customer.passkeys === 1 ? "" : "s"} enrolled</p></section>
    <section class="surface full"><h2>Bundle history</h2><div class="table-scroll"><table><thead><tr><th>Bundle</th><th>Status</th><th>Activated</th><th>Expires</th></tr></thead><tbody>${result.vouchers.map((item) => `<tr><td>${h(item.plan.name)}</td><td>${h(item.status)}</td><td>${h(new Date(item.activatedAt).toLocaleDateString())}</td><td>${h(new Date(item.expiresAt).toLocaleDateString())}</td></tr>`).join("")}</tbody></table></div></section>
    <section class="surface full" id="billing"><h2>Payment history</h2><p><a href="/billing-terms.html">Payment, renewal, switching and cancellation rules</a></p><div id="billingMessage" role="status" aria-live="polite"></div>${result.payments.length ? `<div class="table-scroll"><table><thead><tr><th scope="col">Date / package</th><th scope="col">Amount / reference</th><th scope="col">Payment / refund status</th><th scope="col">Actions</th></tr></thead><tbody>${result.payments.map((payment) => `<tr><td>${h(new Date(payment.createdAt).toLocaleDateString())}<br>${h(payment.plan?.name || payment.planId)}</td><td>${h(payment.amount.toLocaleString())} ${h(payment.currency)}<br>${h(payment.provider)}<br><small>${h(payment.providerReference || "Awaiting provider reference")}</small></td><td>${h(payment.status)}${payment.fulfillmentStatus === "needs_review" ? '<p>Payment received. Activation needs support review; do not pay again.</p>' : ""}${payment.recoveryMessage ? `<p>${h(payment.recoveryMessage)}</p>` : ""}${payment.refund ? `<p><strong>Refund: ${h(payment.refund.status)}</strong><br>${h(payment.refund.message || "")}</p>` : ""}</td><td>${["pending", "processing", "failed", "expired", "cancelled"].includes(payment.status) || payment.refund?.status === "pending" ? `<button type="button" data-recheck-payment="${h(payment.id)}">Recheck payment / refund</button>` : ""}${payment.receiptAvailable ? `<a class="button secondary-action" href="${h(api)}/api/account/payments/${h(payment.id)}/receipt">Download receipt</a><button type="button" data-email-receipt="${h(payment.id)}">Email receipt</button><small>Receipt email: ${h(payment.receiptEmail?.status || "awaiting delivery")}</small>` : ""}${payment.status === "paid" && !payment.refund ? `<details><summary>Request a refund</summary><form data-refund-payment="${h(payment.id)}"><label>Reason<textarea name="reason" maxlength="500" required></textarea></label><p>Support will review your request. This does not confirm a refund.</p><button>Send refund request</button></form></details>` : ""}</td></tr>`).join("")}</tbody></table></div>` : "<p>Your confirmed and pending payments will appear here.</p>"}</section>
  </div>`;
  const planNotice = sessionStorage.getItem("ndahi-plan-notice");
  if (planNotice) {
    $("#dashboardMessage").innerHTML = `<div class="success">${h(planNotice)}</div>`;
    sessionStorage.removeItem("ndahi-plan-notice");
  }
  if (securitySetup) {
    $("#accountSecurity").scrollIntoView({ behavior: "smooth", block: "center" });
    $("#addCustomerPasskey").focus({ preventScroll: true });
  }
}

$("#redeem").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector("button");
  $("#redeemMessage").textContent = "";
  try {
    await runButton(button, "Connecting…", async () => {
      const result = await call("/api/vouchers/redeem", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.target)), deviceId }) });
      $("#redeemMessage").innerHTML = `<div class="success">Connected successfully. ${h(result.voucher.activeDevices)}/${h(result.voucher.deviceLimit)} slots are now in use.</div>`;
      await load();
    });
  } catch (error) { showError($("#redeemMessage"), error); }
};

$("#dashboard").onclick = async (event) => {
  const billingButton = event.target.closest("[data-recheck-payment], [data-email-receipt]");
  if (billingButton) {
    try {
      await runButton(billingButton, "Checking…", async () => {
        const id = billingButton.dataset.recheckPayment || billingButton.dataset.emailReceipt;
        const result = billingButton.dataset.emailReceipt
          ? await call("/api/account/payments/receipt-email", { method: "POST", body: JSON.stringify({ paymentId: id }) })
          : await call(`/api/account/payments/${id}/status`);
        await load();
        $("#billingMessage").textContent = billingButton.dataset.emailReceipt
          ? result.payment.receiptEmail?.status === "sent" ? "Receipt sent to your account email." : "Email delivery is pending or unavailable. You can download the receipt here."
          : result.payment.recoveryMessage || result.payment.refund?.message || `Payment status: ${result.payment.status}.`;
      });
    } catch (error) { showError($("#billingMessage"), error); }
    return;
  }
  const mfaButton = event.target.closest("#enableCustomerMfa");
  if (mfaButton) {
    try {
      const enrollment = await call("/api/account/security/mfa/enroll", { method: "POST", body: "{}" });
      $("#mfaSetup").innerHTML = `<div class="success"><p>Add this time-based key to your authenticator app:</p><code>${h(enrollment.secret)}</code><form id="confirmMfa"><input type="hidden" name="challengeId" value="${h(enrollment.challengeId)}"><label>Six-digit code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label><button>Confirm 2FA</button></form></div>`;
    } catch (error) { showError($("#dashboardMessage"), error); }
    return;
  }
  const mfaForm = event.target.closest("#confirmMfa");
  if (mfaForm && event.target.closest("button")) {
    event.preventDefault();
    try {
      await call("/api/account/security/mfa/confirm", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(mfaForm))) });
      $("#dashboardMessage").textContent = "Authenticator 2FA enabled.";
      await load();
    } catch (error) { showError($("#dashboardMessage"), error); }
    return;
  }
  const passkeyButton = event.target.closest("#addCustomerPasskey");
  if (passkeyButton) {
    try {
      await runButton(passkeyButton, "Opening passkey…", async () => {
        let result = await call("/api/account/passkeys/options", {
          method: "POST", body: "{}",
        });
        const credential = await SimpleWebAuthnBrowser.startRegistration({
          optionsJSON: result.options,
        });
        result = await call("/api/account/passkeys/verify", {
          method: "POST",
          body: JSON.stringify({
            challengeId: result.challengeId, response: credential,
          }),
        });
        $("#dashboardMessage").textContent = `Passkey added. ${result.passkeys} enrolled.`;
        history.replaceState({}, "", "/dashboard");
        await load();
      });
    } catch (error) {
      showError($("#dashboardMessage"), error, {
        context: "passkey",
        actions: [{ label: "Try passkey again", run: () => passkeyButton.click() }],
      });
    }
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
    });
  } catch (error) { showError($("#connectMessage"), error); }
};

$("#logout").onclick = async (event) => {
  try {
    await runButton(event.currentTarget, "Logging out…", () => call("/api/account/logout", { method: "POST", body: "{}" }));
    location.href = "/login";
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
