import { openVoucherPrintPreview } from "/shared/voucher-print-preview.js";
import { downloadVoucherPdf } from "./voucher-delivery.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { showError, responseError } from "./errors.js";
import { runButton } from "/shared/pending.js";
import { durationLabel } from "./plan-presentation.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { ICONS } from "/shared/ui/icons.js";

// ---------- Redesigned Home (kit markup; see docs/redesign/screens/PhoneHome and Main) ----------
const L = (key, values) => format(key, values || {}, currentLanguage());
const svg = (name) => `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[name]}"/></svg>`;

// Phone: two tiles. Desktop: a card of four links.
export function homeQuickActions() {
  const links = [["/dashboard#redeem", "homeQuickVoucherLong"], ["/dashboard#devices", "connectDevice"], ["/dashboard#devices", "homeQuickAnotherDevice"], ["/help", "homeQuickHelp"]];
  return `<section class="home-quick" aria-labelledby="homeQuickTitle"><h2 id="homeQuickTitle" class="nd-h3 nd-wide-only">${h(L("homeQuickTitle"))}</h2>`
    + `<div class="nd-grid-2 nd-narrow-only"><a class="nd-tile" href="/dashboard#redeem">${svg("voucher")}${h(L("homeQuickVoucher"))}</a><a class="nd-tile" href="/dashboard#devices">${svg("internet")}${h(L("homeQuickAddDevice"))}</a></div>`
    + `<ul class="home-quick__list nd-wide-only">${links.map(([href, key]) => `<li><a class="home-quick__link" href="${href}">${h(L(key))}<span aria-hidden="true">→</span></a></li>`).join("")}</ul></section>`;
}

const ACTIVITY = { paid: ["homeActivityPaid", "success"], pending: ["homeActivityWaiting", "warning"], processing: ["homeActivityWaiting", "warning"], refunded: ["homeActivityRefunded", ""], "refund-pending": ["homeActivityRefundPending", ""] };

// Desktop only: the three latest payments. Shop orders join in Phase 4.
export function homeRecentActivity(payments) {
  if (!payments || !payments.length) return "";
  const rows = payments.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 3).map((payment) => {
    const [key, tone] = ACTIVITY[payment.status] || ["homeActivityFailed", "danger"];
    const date = new Date(payment.createdAt).toLocaleDateString(currentLanguage(), { day: "numeric", month: "short" });
    return `<div class="nd-row"><span class="nd-row__main"><span class="nd-row__title">${h(L("homeActivityBundle", { plan: (payment.plan && payment.plan.name) || payment.planId }))}</span><span class="nd-meta">${h(date)} · ${h(payment.methodLabel || "Mobile Money")}</span></span><span class="nd-pill${tone ? " nd-pill--" + tone : ""}">${h(L(key))}</span></div>`;
  }).join("");
  return `<section class="home-activity nd-card nd-wide-only" aria-labelledby="homeActivityTitle"><div class="nd-section-head"><h2 id="homeActivityTitle" class="nd-h3">${h(L("homeActivityTitle"))}</h2><a class="nd-section-head__link" href="/dashboard#activity">${h(L("homeActivitySeeAll"))}</a></div>${rows}</section>`;
}

// Up to three products in stock from the store catalogue (phones show the first).
// Prices and names come from the catalogue; nothing is hard-coded.
export function homeShopItems(catalogue) {
  const lang = currentLanguage();
  const name = (value) => (value && typeof value === "object" ? value[lang] || value.en || "" : value || "");
  return (catalogue.products || []).filter((product) => product.available > 0).slice(0, 3).map((product) => {
    const price = product.price == null ? L("homePriceTbc") : `${Number(product.price).toLocaleString(lang === "fr" ? "fr-CM" : "en-CM")} FCFA`;
    const image = product.images && product.images[0] && /^data:image\//.test(product.images[0].data) ? `<img src="${h(product.images[0].data)}" alt="" loading="lazy">` : svg("shop");
    return `<a class="nd-media-row home-shop__item" href="/dashboard#product/${encodeURIComponent(product.id)}"><span class="nd-thumb">${image}</span><span class="nd-media-row__body"><span class="nd-media-row__title">${h(name(product.name))}</span><span class="nd-meta nd-narrow-only">${h(L("homeShopMeta", { price }))}</span><span class="nd-meta nd-wide-only${product.available <= 2 ? " home-shop__few" : ""}">${h(L(product.available <= 2 ? "homeShopFew" : "homeShopStock", { price, count: product.available }))}</span></span><span class="nd-chevron" aria-hidden="true">›</span></a>`;
  }).join("");
}

export function profileCard(customer) {
  const pending = customer.pendingEmail && Date.parse(customer.pendingEmail.expiresAt)>Date.now() ? customer.pendingEmail : null;
  const draft = customer.pendingProfile || customer;
  return `<section class="surface full portal-profile" data-portal-view="account" id="emailAccount"><a class="portal-sub__back" href="/dashboard#account" aria-label="${h(L("portalBackAccount"))}">${svg("back")}</a><p class="eyebrow">Profile</p><h2>Your profile</h2><dl class="profile-facts"><dt>Full name</dt><dd>${h(customer.name || "Not set")}</dd><dt>Account number</dt><dd>${h(customer.phoneE164 || customer.phone)}</dd><dt>Email</dt><dd>${h(customer.email || "Not provided")}${customer.email ? customer.emailLinked ? " (confirmed)" : " (not confirmed)" : ""}</dd></dl><p>Your account number is your sign-in number and default for new payments. Existing receipts retain their recorded details.</p>
  ${pending ? `<form id="confirmEmail"><p>Enter the confirmation code for <strong>${h(pending.email)}</strong>. It expires ${h(new Date(pending.expiresAt).toLocaleTimeString())}.${customer.pendingProfile ? " Your staged profile changes are applied together after confirmation." : ""}${["pending","sending"].includes(pending.status) ? " Your confirmation email is queued. Delivery may take a moment." : pending.status === "unconfirmed" ? " Delivery is uncertain; use the code if it arrives or request another after one minute." : ""}</p><label>Email confirmation code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><button type="submit">Confirm email</button><button type="button" id="cancelProfileConfirmation" class="secondary-action">Cancel pending changes</button><div id="emailConfirmMessage" role="status" aria-live="polite"></div></form>` : ""}
  <details id="editProfile"><summary id="editProfileTitle">Edit profile</summary><form id="profileEdit"><label>Full name<input name="name" autocomplete="name" maxlength="100" value="${h(draft.name || "")}" required></label><label>Account number<input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="16" value="${h(draft.phone ? "+237" + String(draft.phone).replace(/^\+237/,"") : customer.phoneE164 || customer.phone)}" required aria-describedby="profilePhoneGuidance"></label><p id="profilePhoneProvider" role="status" aria-live="polite"></p><p id="profilePhoneGuidance">The likely payment provider appears as you type. You can choose a different provider at checkout.</p><label>Email (optional)<input name="email" type="email" autocomplete="email" maxlength="254" value="${h(draft.email || "")}"></label>${customer.email && !customer.emailLinked ? '<label><input name="verifyEmail" type="checkbox">Confirm this email for account updates and PIN recovery</label>' : ""}<label id="profileEmailRemoval" hidden><input name="removeEmail" type="checkbox">Remove my email and email PIN recovery</label><label ${customer.pinConfigured === false ? "hidden" : ""}>Current PIN (for number or email changes)<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password" ${customer.pinConfigured === false ? "disabled" : ""}></label><p>Your current email stays trusted until a replacement is confirmed. Confirming a change signs out your other portal sessions.</p><button type="submit" class="nd-btn nd-btn--block">Save profile</button>${customer.passkeys ? '<button type="button" id="profileEditPasskey" class="secondary-action nd-btn nd-btn--secondary nd-btn--block">Save with passkey</button>' : ""}<div id="profileEditMessage" role="status" aria-live="polite"></div></form></details></section>`;
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
      <p style="color: var(--muted); font-size: 13px; margin: 0;">Scan on the device you want to connect, then authorize with your account PIN or passkey.</p>
    </div>
    ${data.canRotate ? '<details><summary>Replace this QR</summary><p>Copies of the QR shown here will stop working. Download or print its replacement after updating it.</p><form id="rotateVoucherQr"><label>Current account PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password" required></label><label><input name="confirm" type="checkbox" required> Replace old QR copies</label><button type="submit">Replace QR</button><p data-rotate-qr-message role="status" aria-live="polite"></p></form></details>' : ""}
  `;
  const rotate = dialog.querySelector("#rotateVoucherQr");
  if (rotate) rotate.onsubmit = async event => {
    event.preventDefault(); const output = rotate.querySelector("[data-rotate-qr-message]");
    try { await runButton(rotate.querySelector("button"), "Replacing…", async () => {
      const api = window.NDAHI_CONFIG.apiUrl;
      const account = await fetch(api + "/api/account/dashboard", { credentials: "include", cache: "no-store" });
      if (!account.ok) throw Error("Sign in again before replacing the QR.");
      const value = await account.json();
      const response = await fetch(api + "/api/account/qr-connect/rotate", { method: "POST", credentials: "include", cache: "no-store", headers: { "content-type": "application/json", "x-csrf-token": value.csrfToken }, body: JSON.stringify({ voucherId: data.voucherId, pin: rotate.elements.pin.value }) });
      if (!response.ok) throw responseError(response, await response.json().catch(() => ({})));
      const refreshed = await fetch(api + "/api/account/vouchers/" + encodeURIComponent(data.voucherId) + "/qr", { credentials: "include", cache: "no-store" });
      if (!refreshed.ok) throw Error("The QR was replaced. Reopen it from Vouchers to view the new copy.");
      dialog.querySelector(".voucher-qr-image").src = (await refreshed.json()).qrCode;
      rotate.reset(); output.textContent = "Account QR replaced. Download or print a new voucher for the updated QR.";
    }, { controls: Array.from(rotate.elements) }); } catch (error) { showError(output, error); } finally { rotate.elements.pin.value = ""; }
  };
  dialog.onclose = () => { if (rotate) rotate.elements.pin.value = ""; };
  dialog.querySelector("#voucherQrClose").onclick = () => dialog.close();
  dialog.showModal();
}

export async function voucherAction(event) {
  const button = event.target.closest("[data-copy-voucher], [data-download-voucher], [data-show-qr], [data-print-voucher]");
  if (!button) return false;
  const card = button.closest(".voucher-card"), message = card.querySelector("[data-voucher-message]");
  if (button.hasAttribute("data-print-voucher")) {
    const { url } = openVoucherPrintPreview({ voucherIds: [button.dataset.printVoucher] });
    message.replaceChildren(); const link = document.createElement("a"); link.href = url; link.textContent = "Open print preview in this tab"; message.appendChild(link); return true;
  }
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
