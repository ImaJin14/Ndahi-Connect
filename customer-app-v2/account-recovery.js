import { escapeHtml as h } from "/shared/safe-html.js";
import { credentialRequest, mountVerifiedForm, proofFields, proofButtons } from "./security-actions.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const L = (key, values) => format(key, values || {}, currentLanguage());

// Change PIN (canvas: PhoneChangePin, #396; owner 26 Nov): Current PIN, New
// PIN, Type the new PIN again, the hint, then "Save new PIN" at the foot. The
// customer's other devices stay signed in; after saving, a link offers to sign
// them out. An account with no PIN yet sets one with its passkey (not drawn).
const PIN_INPUT = 'type="password" inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6"';
export function pinControls(customer) {
  const noPin = customer.pinConfigured === false;
  return `<h3>${h(L("portalChangePin"))}</h3>${noPin ? `<p>${h(L("pinChangeSetPin"))}</p>` : ""}<form id="changePin">${noPin ? "" : `<label>${h(L("pinChangeCurrent"))}<input name="currentPin" ${PIN_INPUT} autocomplete="current-password" required></label>`}<label>${h(L("pinChangeNew"))}<input name="newPin" ${PIN_INPUT} autocomplete="new-password" required></label><label>${h(L("pinChangeAgain"))}<input name="confirmPin" ${PIN_INPUT} autocomplete="new-password" required></label><p class="change-pin__hint">${h(L("pinChangeHint"))}</p><div class="change-pin__done" id="changePinDone" tabindex="-1" hidden><p role="status">${h(L("pinChangeDone"))}</p><a href="/dashboard#sessions">${h(L("pinChangeSignOutOthers"))}</a></div><div class="security-actions">${noPin ? (customer.passkeys ? `<button type="button" data-proof-passkey>${h(L("pinChangeSaveWithPasskey"))}</button>` : "") : `<button type="submit">${h(L("pinChangeSave"))}</button>`}<button type="button" class="secondary-action" data-cancel-security>Cancel</button></div><div data-proof-message role="status" aria-live="polite"></div></form>`;
}

export function recoveryControls(customer) {
  return `<h3>Recover account access</h3><p>Forgotten PIN or unavailable passkey? Use your verified email, an account backup code, or an identity check with support.</p><p>${customer.emailLinked ? "Your verified email is available for PIN recovery." : "No verified email is linked. Add and confirm an email in Account, or keep account backup codes offline."}</p><p><a href="/forgot-pin">Recover a forgotten PIN</a> · <a href="/help#recovery">Get account recovery help</a></p><details id="backupCodeSettings"><summary>Account backup codes · ${h(customer.accountBackupCodesRemaining || 0)} available</summary><p>Keep codes private and offline. Using one resets your PIN and invalidates the whole set. Generate a fresh set afterwards.</p><form id="accountBackup" tabindex="-1">${proofFields(customer)}<p>Generating a new set replaces previous account backup codes. Codes are shown once.</p><div class="security-actions">${proofButtons(customer, "Generate codes")}<button type="button" class="secondary-action" data-cancel-security>Cancel</button></div><div data-proof-message role="status" aria-live="polite"></div></form><div id="accountBackupOutput"></div></details>`;
}

export function mountAccountRecovery({ root, call, customer, onChanged }) {
  // The two new PINs must match: the browser says so before anything is sent.
  const pinForm = root.querySelector("#changePin");
  pinForm?.addEventListener("input", () => {
    const next = pinForm.querySelector('[name="newPin"]'), again = pinForm.querySelector('[name="confirmPin"]');
    again.setCustomValidity(again.value && next.value !== again.value ? L("pinChangeMismatch") : "");
  });
  for (const id of ["changePin", "accountBackup"]) {
    const form = root.querySelector("#" + id), change = id === "changePin",
      path = change ? "/api/account/security/pin" : "/api/account/security/account-backup";
    mountVerifiedForm({ root, form, customer, call,
      options: (input) => call(path + "/options", { method: "POST", body: JSON.stringify(input) }),
      perform: (input) => {
        // v2 keeps the customer's other devices signed in (owner, 26 Nov).
        return credentialRequest(call, path + (change ? "" : "/generate"), change ? { ...input, keepOtherSessions: true } : input, change ? "pin_change" : "backup_generate");
      },
      onSuccess: async (result) => {
        if (change) {
          await onChanged({ panel: "pin", message: "" });
          const done = document.getElementById("changePinDone");
          if (done) { done.hidden = false; done.focus(); }
          return;
        }
        if (result.confirmedByStatus) return onChanged({ panel: "recovery", message: "Backup codes changed, but the response was lost. Wait one minute, then generate a fresh set to save. Earlier codes are invalid." });
        const output = root.querySelector("#accountBackupOutput");
        output.innerHTML = `<section class="success" data-sensitive-output tabindex="-1"><h4>Save your account backup codes</h4><p>Shown once. Save privately before closing security.</p><ul>${result.codes.map((code) => `<li><code>${h(code)}</code></li>`).join("")}</ul><button type="button" data-download-backup>Download codes</button> <button type="button" class="secondary-action" data-hide-backup>I saved my codes</button></section>`;
        output.querySelector("[data-sensitive-output]").focus();
        const hide = () => { result.codes = []; output.textContent = "Your codes are hidden. Generate another set if you did not save them."; root.querySelector("#accountBackup").focus(); };
        output.querySelector("[data-hide-backup]").onclick = hide;
        root.addEventListener("security-clear", () => { result.codes = []; output.textContent = ""; }, { once: true });
        output.querySelector("[data-download-backup]").onclick = () => {
          const contents = `NDAHI Connect account backup codes\nAccount: ${customer.id}\nGenerated: ${result.generatedAt}\nKeep private. Use with your CURRENT account number on /forgot-pin. Using one revokes the whole set.\n\n${result.codes.join("\n")}\n`;
          const url = URL.createObjectURL(new Blob([contents], { type: "text/plain;charset=utf-8" })), link = document.createElement("a");
          link.href = url; link.download = "ndahi-account-backup-codes.txt"; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
        };
      },
    });
  }
}
