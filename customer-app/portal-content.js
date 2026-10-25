import { downloadVoucherPdf } from "./voucher-delivery.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { showError, responseError } from "./errors.js";
import { runButton } from "/shared/pending.js";
import { durationLabel } from "./plan-presentation.js";

export function profileCard(customer) {
  const pending = customer.pendingEmail && Date.parse(customer.pendingEmail.expiresAt)>Date.now() ? customer.pendingEmail : null;
  const draft = customer.pendingProfile || customer;
  return `<section class="surface full" data-portal-view="account" id="emailAccount"><p class="eyebrow">Profile</p><h2>Your profile</h2><dl class="profile-facts"><dt>Full name</dt><dd>${h(customer.name || "Not set")}</dd><dt>Account number</dt><dd>${h(customer.phoneE164 || customer.phone)}</dd><dt>Email</dt><dd>${h(customer.email || "Not provided")}${customer.email ? customer.emailLinked ? " (confirmed)" : " (not confirmed)" : ""}</dd></dl><p>Your account number is your sign-in number and default for new payments. Existing receipts retain their recorded details.</p>
  ${pending ? `<form id="confirmEmail"><p>Enter the confirmation code for <strong>${h(pending.email)}</strong>. It expires ${h(new Date(pending.expiresAt).toLocaleTimeString())}.${customer.pendingProfile ? " Your staged profile changes are applied together after confirmation." : ""}${["pending","sending"].includes(pending.status) ? " Your confirmation email is queued. Delivery may take a moment." : pending.status === "unconfirmed" ? " Delivery is uncertain; use the code if it arrives or request another after one minute." : ""}</p><label>Email confirmation code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><button type="submit">Confirm email</button><button type="button" id="cancelProfileConfirmation" class="secondary-action">Cancel pending changes</button><div id="emailConfirmMessage" role="status" aria-live="polite"></div></form>` : ""}
  <details id="editProfile"><summary>Edit profile</summary><form id="profileEdit"><label>Full name<input name="name" autocomplete="name" maxlength="100" value="${h(draft.name || "")}" required></label><label>Account number<input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="16" value="${h(draft.phone ? "+237" + String(draft.phone).replace(/^\+237/,"") : customer.phoneE164 || customer.phone)}" required aria-describedby="profilePhoneGuidance"></label><p id="profilePhoneProvider" role="status" aria-live="polite"></p><p id="profilePhoneGuidance">The likely payment provider appears as you type. You can choose a different provider at checkout.</p><label>Email (optional)<input name="email" type="email" autocomplete="email" maxlength="254" value="${h(draft.email || "")}"></label>${customer.email && !customer.emailLinked ? '<label><input name="verifyEmail" type="checkbox">Confirm this email for account updates and PIN recovery</label>' : ""}<label id="profileEmailRemoval" hidden><input name="removeEmail" type="checkbox">Remove my email and email PIN recovery</label><label ${customer.pinConfigured === false ? "hidden" : ""}>Current PIN (for number or email changes)<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password" ${customer.pinConfigured === false ? "disabled" : ""}></label><p>Your current email stays trusted until a replacement is confirmed. Confirming a change signs out your other portal sessions.</p><button type="submit">Save profile</button>${customer.passkeys ? '<button type="button" id="profileEditPasskey" class="secondary-action">Save with passkey</button>' : ""}<div id="profileEditMessage" role="status" aria-live="polite"></div></form></details></section>`;
}
export { vouchersCard } from "./voucher-history.js";
export function bundleCatalogue(result) {
  const current = result.currentPlan, blocked = Boolean(result.activeBundle) || result.subscriptionPurchaseAccess?.allowed === false;
  return `<section class="surface full" data-portal-view="bundles"><h2>Available packages</h2>${blocked ? `<p role="status">${h(result.subscriptionPurchaseAccess?.message || "Use your existing bundle. You can buy again after expiry or data exhaustion.")}</p>` : ""}<div class="voucher-grid">${(result.availablePlans || []).filter((plan) => !plan.discontinued).map((plan) => {
    const renew = current && current.planId === plan.id;
    return `<article class="voucher-card"><h3>${h(plan.name)}</h3><p><strong>${h(plan.price.toLocaleString())} FCFA</strong><br>${plan.quotaGb === null ? "Unlimited data (fair use applies)" : `${h(plan.quotaGb)} GB data`} · ${h(durationLabel(plan.validityHours))}<br>${h(plan.deviceLimit)} simultaneous device${plan.deviceLimit === 1 ? "" : "s"}</p>${blocked ? "" : `<a class="button secondary-action" href="/onboarding.html?action=${renew ? "renew" : "switch"}&amp;plan=${h(encodeURIComponent(plan.id))}">${renew ? "Review renewal" : "Review package"}</a>`}</article>`;
  }).join("")}</div></section>`;
}
function showQrModal(data) {
  let dialog = document.getElementById("voucherQrDialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "voucherQrDialog";
    dialog.className = "receipt-dialog qr-dialog";
    dialog.setAttribute("aria-labelledby", "voucherQrTitle");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
  }
  dialog.innerHTML = `
    <div class="receipt-dialog-header">
      <h2 id="voucherQrTitle">Voucher QR Code</h2>
      <button type="button" id="voucherQrClose" class="secondary-action" autofocus>Close</button>
    </div>
    <div class="qr-preview" style="text-align: center; padding: 12px 0;">
      <p style="margin: 0 0 10px; font-weight: 700; font-size: 17px;">${h(data.planName || "")}</p>
      <img src="${h(data.qrCode)}" alt="QR Code for voucher ${h(data.code)}" class="voucher-qr-image">
      <p class="voucher-qr-code" style="font-family: monospace; font-size: 20px; font-weight: 700; letter-spacing: 0.1em; margin: 10px 0 6px;">${h(data.code)}</p>
      <p style="color: var(--muted); font-size: 13px; margin: 0;">Scan with camera on another device to activate automatically.</p>
    </div>
  `;
  dialog.querySelector("#voucherQrClose").onclick = () => dialog.close();
  dialog.showModal();
}

export async function voucherAction(event) {
  const button = event.target.closest("[data-copy-voucher], [data-download-voucher], [data-show-qr]");
  if (!button) return false;
  const card = button.closest(".voucher-card"), message = card.querySelector("[data-voucher-message]");
  try {
    const actionLabel = button.hasAttribute("data-copy-voucher") ? "Copying…" : button.hasAttribute("data-show-qr") ? "Loading QR…" : "Downloading…";
    await runButton(button, actionLabel, async () => {
      if (button.hasAttribute("data-show-qr")) {
        const voucherId = button.dataset.showQr;
        const response = await fetch(window.NDAHI_CONFIG.apiUrl + "/api/account/vouchers/" + encodeURIComponent(voucherId) + "/qr", { credentials: "include", cache: "no-store" });
        if (!response.ok) throw responseError(response, await response.json().catch(() => ({})));
        const data = await response.json();
        showQrModal(data);
      } else if (button.hasAttribute("data-copy-voucher")) {
        const input = card.querySelector("[data-voucher-code]");
        let copied = false;
        try { if (navigator.clipboard) { await navigator.clipboard.writeText(input.value); copied = true; } } catch (_) {}
        if (!copied) { input.focus(); input.select(); copied = document.execCommand("copy"); }
        message.textContent = copied ? "Voucher code copied." : "Select the code above and copy it.";
      } else {
        message.textContent = await downloadVoucherPdf({ api: window.NDAHI_CONFIG.apiUrl, id: button.dataset.downloadVoucher });
      }
    });
  } catch (error) { showError(message, error); }
  return true;
}
