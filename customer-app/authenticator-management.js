import { escapeHtml as h } from "/shared/safe-html.js";
import { formValues, randomId, loadPasskeys } from "./compat.js";
import { runButton } from "/shared/pending.js";
import { showError } from "./errors.js";
import { mountAuthenticationMigration } from "./authentication-migration.js";

export function renderAuthenticatorSetup(host, enrollment, phone) {
  host.innerHTML = `<div class="success authenticator-setup" data-sensitive-output><h3>${enrollment.replacement ? "Confirm your replacement authenticator" : "Link your authenticator app"}</h3><p>Use Google Authenticator, Microsoft Authenticator or another app that creates time-based codes.</p>
    ${typeof enrollment.qrCode === "string" && enrollment.qrCode.startsWith("data:image/png;base64,") ? `<img class="authenticator-qr" src="${h(enrollment.qrCode)}" width="240" height="240" alt="Scan this QR code with your authenticator app">` : ""}
    <p>On another device, scan the QR code. On this device, copy the setup key, open your authenticator app, choose Add account → Enter setup key, and select <strong>Time based</strong>.</p>
    <p>Account: <strong>NDAHI Connect · ${h(phone)}</strong></p><code id="mfaSetupKey">${h(enrollment.secret)}</code><button type="button" id="copyMfaKey" class="secondary-action">Copy setup key</button>
    <p>Return here and enter the current six-digit code from the app. ${enrollment.replacement ? "Your old authenticator stays active until you confirm the new one. Confirmation invalidates the old app and its recovery codes." : "Setup is only enabled after confirmation."}${enrollment.expiresAt ? ` Finish before ${h(new Date(enrollment.expiresAt).toLocaleTimeString())}.` : ""}</p>
    <form id="confirmMfa"><input type="hidden" name="challengeId" value="${h(enrollment.challengeId)}"><label>Six-digit code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><button>${enrollment.replacement ? "Confirm replacement" : "Confirm 2FA"}</button></form>
    <button type="button" id="cancelMfaSetup" class="secondary-action">Cancel setup</button><p id="mfaSetupMessage" role="status" aria-live="polite"></p></div>`;
  host.querySelector('[name="code"]').focus(); host.scrollIntoView({ block: "nearest" });
}

export function mountAuthenticatorManagement({ container, enabled, hasPasskeys, call, showSetup }) {
  if (!container) return {};
  let pending;
  container.innerHTML = `${enabled ? '<button type="button" data-manage-authenticator>Manage authenticator</button><p>Enabled means an app was linked. Verify a code to check that you can still use it.</p>' : ""}<div data-mfa-pending></div><section data-authenticator-panel hidden><h3>Manage authenticator</h3><button type="button" data-mfa-check>Verify a code</button><button type="button" data-mfa-replace>Replace authenticator</button><button type="button" data-mfa-lost>I have lost access</button><div data-mfa-management-form></div></section><p data-mfa-management-message role="status" aria-live="polite"></p>`;
  const panel = container.querySelector("[data-authenticator-panel]"), host = container.querySelector("[data-mfa-management-form]"), message = container.querySelector("[data-mfa-management-message]");
  async function refreshPending() {
    try {
      const state = await call("/api/account/security/mfa/status");
      if (!container.isConnected) return;
      pending = state.pending;
      container.querySelector("[data-mfa-pending]").innerHTML = pending ? `<p>Authenticator ${pending.replacement ? "replacement" : "setup"} is pending until ${h(new Date(pending.expiresAt).toLocaleTimeString())}. ${pending.replacement ? "Your existing app is still active." : "It is not enabled yet."}</p><button type="button" data-mfa-resume>Resume pending setup</button><button type="button" data-mfa-cancel-pending>Cancel pending setup</button>` : "";
    } catch (_) { /* Existing account controls remain usable if status is unavailable. */ }
  }
  function openForm(action, lost = false) {
    panel.hidden = false; message.textContent = "";
    const ownerProof = ["replace", "resume"].includes(action), factor = action !== "resume";
    host.innerHTML = `<form data-mfa-owner-form><h3>${action === "check" ? "Verify your authenticator" : action === "recovery" ? "Generate new recovery codes" : action === "resume" ? "Resume pending setup" : lost ? "Recover your authenticator app" : "Replace your authenticator"}</h3>
      ${ownerProof ? '<label>Account PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password"></label>' : ""}
      ${factor ? `<label>Verify using<select name="factor"><option value="otp">Current authenticator code</option>${action === "check" ? "" : '<option value="recoveryCode">Unused authenticator recovery code</option>'}${action === "replace" ? '<option value="supportCode">Verified support code</option>' : ""}</select></label><label data-mfa-factor-label>Current authenticator code<input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>` : ""}
      ${action === "replace" ? '<p>Replacement requires your PIN or passkey plus your current authenticator, an unused recovery code or a verified support code. A recovery/support code is used when replacement starts, even if you later cancel. You can resume a pending setup with your PIN or passkey.</p>' : ""}
      ${lost ? '<p>No app or recovery codes? Contact support for an identity check. An account owner must approve a time-limited support code. Your current authenticator stays enabled until the replacement is confirmed.</p><a href="/help#recovery">Account recovery help</a>' : ""}
      <button type="submit">${action === "check" ? "Verify code" : action === "recovery" ? "Generate recovery codes" : action === "resume" ? "Resume setup" : "Verify and start replacement"}</button>
      ${ownerProof && hasPasskeys && window.PublicKeyCredential && navigator.credentials ? '<button type="button" data-mfa-proof-passkey>Verify with passkey</button>' : ""}
      <button type="button" data-mfa-close>Cancel</button><p data-mfa-proof-message role="status" aria-live="polite"></p></form>`;
    const form = host.querySelector("form"), output = form.querySelector("[data-mfa-proof-message]"), requestKey = randomId();
    function selectFactor() {
      const type = form.elements.factor.value, label = form.querySelector("[data-mfa-factor-label]");
      const caption = type === "otp" ? "Current authenticator code" : type === "recoveryCode" ? "Unused authenticator recovery code" : "Verified support code";
      label.innerHTML = `${caption}<input name="${type}" ${type === "otp" ? 'inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"' : 'type="password" maxlength="128" autocomplete="off"'} required>`;
    }
    if (factor) { form.elements.factor.onchange = selectFactor; if (lost) { form.elements.factor.value = "recoveryCode"; selectFactor(); } }
    async function submit(passkey) {
      if (!form.reportValidity()) return;
      const input = formValues(form);
      if (ownerProof && !passkey && !/^\d{4}$/.test(input.pin || "")) { output.textContent = "Enter your four-digit PIN."; return; }
      try {
        await runButton(form.querySelector(passkey ? "[data-mfa-proof-passkey]" : '[type="submit"]'), "Verifying…", async () => {
          const payload = { ...input, requestKey, ...(action === "resume" ? { challengeId: pending.challengeId } : {}) };
          if (passkey) {
            const options = await call("/api/account/security/mfa/options", { method: "POST", body: JSON.stringify({ action, challengeId: payload.challengeId }) });
            const browser = await loadPasskeys(); delete payload.pin;
            payload.challengeId = options.challengeId; payload.response = await browser.startAuthentication({ optionsJSON: options.options });
            if (action === "resume") payload.setupId = pending.challengeId;
          }
          const path = action === "recovery" ? "/api/account/security/recovery-codes/generate" : "/api/account/security/mfa/" + action;
          const response = await call(path, { method: "POST", body: JSON.stringify(payload) });
          form.reset(); host.textContent = "";
          if (action === "check") message.textContent = "Your authenticator app is working. Its current code was verified.";
          else if (action === "recovery") {
            const target = document.getElementById("recoveryCodesOutput");
            target.innerHTML = `<div class="success" data-sensitive-output><p>Save these codes now. Each works once; previous codes no longer work.</p><ul>${response.codes.map((code) => `<li><code>${h(code)}</code></li>`).join("")}</ul></div>`;
          } else { showSetup(response); await refreshPending(); }
        }, { controls: Array.from(form.elements) });
      } catch (error) { showError(output, error); }
    }
    form.onsubmit = (event) => { event.preventDefault(); event.stopPropagation(); void submit(false); };
    const passkey = form.querySelector("[data-mfa-proof-passkey]");
    if (passkey) passkey.onclick = () => { void submit(true); };
    form.querySelector("[data-mfa-close]").onclick = () => { form.reset(); host.textContent = ""; };
    (form.querySelector('input:not([type="hidden"])') || form.querySelector("button")).focus();
  }
  container.onclick = async (event) => {
    const button = event.target.closest("button");
    if (!button || !container.contains(button)) return;
    if (button.hasAttribute("data-manage-authenticator")) { panel.hidden = !panel.hidden; if (!panel.hidden) { await refreshPending(); container.querySelector("[data-mfa-check]").focus(); } }
    else if (button.hasAttribute("data-mfa-check")) openForm("check");
    else if (button.hasAttribute("data-mfa-replace")) openForm("replace");
    else if (button.hasAttribute("data-mfa-lost")) openForm("replace", true);
    else if (button.hasAttribute("data-mfa-resume") && pending) openForm("resume");
    else if (button.hasAttribute("data-mfa-cancel-pending") && pending) {
      try { await runButton(button, "Cancelling…", async () => { await call("/api/account/security/mfa/cancel", { method: "POST", body: JSON.stringify({ challengeId: pending.challengeId }) }); document.getElementById("mfaSetup").textContent = ""; await refreshPending(); message.textContent = "Pending setup cancelled. Your existing sign-in methods remain available."; }); }
      catch (error) { showError(message, error); }
    }
  };
  const preparation = document.createElement("section");
  container.appendChild(preparation);
  mountAuthenticationMigration({ container: preparation, call });
  void refreshPending();
  return { recovery: () => openForm("recovery"), refresh: refreshPending };
}

window.addEventListener("pagehide", () => {
  document.querySelectorAll("#mfaSetup, [data-mfa-management-form], #recoveryCodesOutput").forEach((node) => { node.textContent = ""; });
});
