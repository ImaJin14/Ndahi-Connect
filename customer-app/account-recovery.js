import { escapeHtml as h } from "/shared/safe-html.js";
import { formValues, loadPasskeys, requestJson } from "./compat.js";
import { runButton } from "/shared/pending.js";
import { showError } from "./errors.js";

function proofFields(customer) {
  return `<label ${customer.pinConfigured === false ? "hidden" : ""}>Current PIN<input name="currentPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password" ${customer.pinConfigured === false ? "disabled" : "required"}></label>${!customer.authenticatorRetired && customer.authenticatorEnrolled ? '<label>Authenticator code<input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>' : ""}`;
}
function buttons(customer, purpose) {
  return `<button type="submit" ${customer.pinConfigured === false ? "hidden" : ""}>${purpose} with PIN</button>${customer.passkeys ? `<button type="button" data-proof-passkey>${purpose} with passkey</button>` : ""}`;
}
export function recoveryCard(customer) {
  return `<section class="surface full" data-portal-view="account" id="accountRecovery"><h2>PIN and account recovery</h2><details><summary>Change PIN</summary><form id="changePin">${proofFields(customer)}<label>New four-digit PIN<input name="newPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label><label>Confirm new PIN<input name="confirmPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label><p>Changing your PIN signs out other portal sessions and invalidates saved account backup codes. Your Wi-Fi devices and bundles stay connected.</p>${buttons(customer, "Change PIN")}<div data-proof-message role="status" aria-live="polite"></div></form></details><details><summary>Account backup codes</summary><p>Recover a forgotten PIN without email. Keep the codes private and offline. ${customer.authenticatorRetired ? "" : "Enrolled authenticator verification is still required."} Using one resets your PIN and invalidates the whole set; generate a fresh set afterwards.</p><p>${h(customer.accountBackupCodesRemaining || 0)} account backup codes available. ${customer.authenticatorRetired ? "Use these only for account recovery." : "These are separate from authenticator recovery codes."}</p><form id="accountBackup">${proofFields(customer)}<p>Generating a new set replaces all previous account backup codes. Codes are shown once.</p>${buttons(customer, "Generate codes")}<div data-proof-message role="status" aria-live="polite"></div></form><div id="accountBackupOutput"></div></details><p><a href="/help#recovery">Lost access? Read recovery options</a></p></section>`;
}

export function mountAccountRecovery({ call, customer, onChanged }) {
  for (const id of ["changePin", "accountBackup"]) {
    const form = document.getElementById(id), passkey = form.querySelector("[data-proof-passkey]"), change = id === "changePin";
    if (passkey && (!window.PublicKeyCredential || !navigator.credentials)) passkey.hidden = true;
    async function submit(usePasskey) {
      const input = formValues(form), message = form.querySelector("[data-proof-message]");
      if (change && (!form.elements.newPin.reportValidity() || !form.elements.confirmPin.reportValidity())) return;
      if (!customer.authenticatorRetired && customer.authenticatorEnrolled && !form.elements.otp.reportValidity()) return;
      try {
        await runButton(usePasskey ? passkey : form.querySelector('[type="submit"]'), "Verifying…", async () => {
          const path = change ? "/api/account/security/pin" : "/api/account/security/account-backup";
          let payload = input;
          if (usePasskey) {
            const browser = await loadPasskeys(), options = await call(path + "/options", { method: "POST", body: JSON.stringify(input) });
            payload = { ...input, currentPin: undefined, challengeId: options.challengeId, response: await browser.startAuthentication({ optionsJSON: options.options }) };
          }
          let result;
          try { result = await call(path + (change ? "" : "/generate"), { method: "POST", body: JSON.stringify(payload) }); }
          catch (error) {
            if (!change || !["TimeoutError", "TypeError", "SyntaxError"].includes(error.name)) throw error;
            const recovered = await requestJson(window.NDAHI_CONFIG.apiUrl + "/api/account/dashboard", { credentials: "include", cache: "no-store" });
            if (!recovered.response.ok || recovered.body.customer.id !== customer.id || !recovered.body.customer.pinUpdatedAt || recovered.body.customer.pinUpdatedAt === customer.pinUpdatedAt) throw error;
          }
          form.reset();
          if (change) { await onChanged(); return; }
          const output = document.getElementById("accountBackupOutput");
          output.innerHTML = `<section class="success" data-sensitive-output><h3>Save your account backup codes</h3><p>Each set is shown once. Save privately before leaving this page. App refresh is deferred until you hide these codes.</p><ul>${result.codes.map((code) => `<li><code>${h(code)}</code></li>`).join("")}</ul><button type="button" data-download-backup>Download codes</button> <button type="button" data-hide-backup>I saved my codes</button></section>`;
          output.querySelector("[data-hide-backup]").onclick = () => { output.textContent = "Your codes are hidden. Generate another set if you did not save them."; result.codes = []; };
          output.querySelector("[data-download-backup]").onclick = () => {
            const contents = `NDAHI Connect account backup codes\nAccount: ${customer.id}\nGenerated: ${result.generatedAt}\nKeep private. Use with your CURRENT account number on /forgot-pin. ${customer.authenticatorRetired ? "" : "Authenticator verification remains required if enrolled."} Using one revokes the whole set.\n\n${result.codes.join("\n")}\n`;
            const url = URL.createObjectURL(new Blob([contents], { type: "text/plain;charset=utf-8" })), link = document.createElement("a");
            link.href = url; link.download = "ndahi-account-backup-codes.txt"; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
          };
          output.scrollIntoView({ block: "center" });
        }, { controls: Array.from(form.elements) });
      } catch (error) { showError(message, error); }
    }
    form.onsubmit = (event) => { event.preventDefault(); void submit(false); };
    if (passkey) passkey.onclick = () => { void submit(true); };
  }
}
