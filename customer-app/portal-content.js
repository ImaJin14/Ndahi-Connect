import { escapeHtml as h } from "/shared/safe-html.js";
import { showError, responseError } from "./errors.js";
import { runButton } from "/shared/pending.js";
import { durationLabel } from "./plan-presentation.js";

export function nameCard(customer) {
  return `<section class="surface full" data-portal-view="account"><h2>Your name</h2><form id="changeName"><label>Display name<input name="name" maxlength="100" value="${h(customer.name || "")}" autocomplete="name" required></label><p>Shown in your welcome message. Previous payment receipts keep their recorded name.</p><button type="submit">Save name</button><div id="nameChangeMessage" role="status" aria-live="polite"></div></form><p><a href="/help">Help, FAQs and support</a></p></section>`;
}
export function profileCard(customer) {
  return `<section class="surface full" data-portal-view="account"><p class="eyebrow">Profile</p><h2>Your account number</h2><p><strong>${h(customer.phone)}</strong></p><p>This is your login number and the default for new payments. A different payment number applies only to that transaction.</p><details><summary>Change account number</summary><form id="changePhone"><label>New account number<input name="phone" type="tel" inputmode="tel" autocomplete="off" placeholder="6XXXXXXXX" required maxlength="16"></label><label ${customer.pinConfigured === false ? "hidden" : ""}>Current PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password" ${customer.pinConfigured === false ? "disabled" : "required"}></label>${!customer.authenticatorRetired && customer.authenticatorEnrolled ? '<label>Authenticator code<input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>' : ""}<label class="acknowledgement"><input type="checkbox" name="confirmChange" required><span>Use this number to sign in and as my payment default. Sign out my other portal sessions.</span></label><p>No SMS is sent. Check the new number carefully.</p><button type="submit" ${customer.pinConfigured === false ? "hidden" : ""}>Confirm with PIN</button>${customer.passkeys ? '<button type="button" id="changePhonePasskey" class="secondary-action">Confirm with passkey</button>' : ""}<div id="phoneChangeMessage" role="status" aria-live="polite"></div></form></details></section>`;
}
export function emailCard(customer) {
  const pending = customer.pendingEmail && Date.parse(customer.pendingEmail.expiresAt) > Date.now() ? customer.pendingEmail : null;
  return `<section class="surface full" data-portal-view="account" id="emailAccount"><p class="eyebrow">Email updates</p><h2>Your email</h2><p>${customer.emailLinked ? `Linked: <strong>${h(customer.email)}</strong>. Email updates, receipts, security notices and PIN recovery are enabled.` : 'Email is optional. Link and confirm an address to receive email updates, receipts, security notices and PIN recovery.'}</p><p>App updates and your voucher downloads are available without email.</p>${pending ? `<form id="confirmEmail"><p>Enter the code sent to <strong>${h(pending.email)}</strong>. It expires ${h(new Date(pending.expiresAt).toLocaleTimeString())}.${pending.status === "unconfirmed" ? ' Delivery is uncertain; you can use the code if it arrives, or request another after one minute.' : ""}</p><label>Email confirmation code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><button type="submit">Confirm email</button><div id="emailConfirmMessage" role="status" aria-live="polite"></div></form>` : ""}<details${!customer.emailLinked && !pending ? " open" : ""}><summary>${pending ? "Request another code or use another email" : customer.emailLinked ? "Change email" : "Link email"}</summary><form id="linkEmail"><label>Email address<input name="email" type="email" autocomplete="email" maxlength="254" value="${h(pending?.email || customer.email || "")}" required></label><label ${customer.pinConfigured === false ? "hidden" : ""}>Current PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password" ${customer.pinConfigured === false ? "disabled" : "required"}></label>${!customer.authenticatorRetired && customer.authenticatorEnrolled ? '<label>Authenticator code<input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>' : ""}<p>We’ll send an email code to confirm this address. Confirming signs out your other portal sessions.</p><button type="submit" ${customer.pinConfigured === false ? "hidden" : ""}>Send code with PIN</button>${customer.passkeys ? '<button type="button" id="linkEmailPasskey" class="secondary-action">Send code with passkey</button>' : ""}<div id="emailLinkMessage" role="status" aria-live="polite"></div></form></details></section>`;
}
export { vouchersCard } from "./voucher-history.js";
export function bundleCatalogue(result) {
  const current = result.currentPlan;
  return `<section class="surface full" data-portal-view="bundles"><h2>Available packages</h2><div class="voucher-grid">${(result.availablePlans || []).filter((plan) => !plan.discontinued).map((plan) => {
    const renew = current && current.planId === plan.id;
    return `<article class="voucher-card"><h3>${h(plan.name)}</h3><p><strong>${h(plan.price.toLocaleString())} FCFA</strong><br>${plan.quotaGb === null ? "Unlimited data (fair use applies)" : `${h(plan.quotaGb)} GB data`} · ${h(durationLabel(plan.validityHours))}<br>${h(plan.deviceLimit)} simultaneous device${plan.deviceLimit === 1 ? "" : "s"}</p><a class="button secondary-action" href="/onboarding.html?action=${renew ? "renew" : "switch"}&amp;plan=${h(encodeURIComponent(plan.id))}">${renew ? "Review renewal" : "Review package"}</a></article>`;
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
        const response = await fetch(window.NDAHI_CONFIG.apiUrl + `/api/account/vouchers/${encodeURIComponent(button.dataset.downloadVoucher)}/download`, { credentials: "include", cache: "no-store" });
        if (!response.ok) throw responseError(response, await response.json().catch(() => ({})));
        if (!(response.headers.get("content-type") || "").startsWith("application/pdf")) throw Error("The voucher download is unavailable. Please try again.");
        const url = URL.createObjectURL(await response.blob()), link = document.createElement("a");
        link.href = url;
        link.download = `ndahi-voucher-${button.dataset.downloadVoucher.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        message.textContent = "Voucher PDF downloaded.";
      }
    });
  } catch (error) { showError(message, error); }
  return true;
}
