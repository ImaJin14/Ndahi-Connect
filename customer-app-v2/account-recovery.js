import { escapeHtml as h } from "/shared/safe-html.js";
import { credentialRequest, mountVerifiedForm, proofFields, proofButtons } from "./security-actions.js";

export function pinControls(customer) {
  return `<h3>Change PIN</h3><p>${customer.pinConfigured === false ? "Set a PIN by verifying your existing passkey, or use account recovery." : "Verify your current PIN or passkey to choose a new PIN."}</p><form id="changePin">${proofFields(customer)}<label>New four-digit PIN<input name="newPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label><label>Confirm new PIN<input name="confirmPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label><p>Changing your PIN signs out other portal sessions and invalidates saved account backup codes. Your Wi-Fi devices and bundles stay connected.</p><div class="security-actions">${proofButtons(customer, "Change PIN")}<button type="button" class="secondary-action" data-cancel-security>Cancel</button></div><div data-proof-message role="status" aria-live="polite"></div></form>`;
}

export function recoveryControls(customer) {
  return `<h3>Recover account access</h3><p>Forgotten PIN or unavailable passkey? Use your verified email, an account backup code, or an identity check with support.</p><p>${customer.emailLinked ? "Your verified email is available for PIN recovery." : "No verified email is linked. Add and confirm an email in Account, or keep account backup codes offline."}</p><p><a href="/forgot-pin">Recover a forgotten PIN</a> · <a href="/help#recovery">Get account recovery help</a></p><details id="backupCodeSettings"><summary>Account backup codes · ${h(customer.accountBackupCodesRemaining || 0)} available</summary><p>Keep codes private and offline. Using one resets your PIN and invalidates the whole set. Generate a fresh set afterwards.</p><form id="accountBackup" tabindex="-1">${proofFields(customer)}<p>Generating a new set replaces previous account backup codes. Codes are shown once.</p><div class="security-actions">${proofButtons(customer, "Generate codes")}<button type="button" class="secondary-action" data-cancel-security>Cancel</button></div><div data-proof-message role="status" aria-live="polite"></div></form><div id="accountBackupOutput"></div></details>`;
}

export function mountAccountRecovery({ root, call, customer, onChanged }) {
  for (const id of ["changePin", "accountBackup"]) {
    const form = root.querySelector("#" + id), change = id === "changePin",
      path = change ? "/api/account/security/pin" : "/api/account/security/account-backup";
    mountVerifiedForm({ root, form, customer, call,
      options: (input) => call(path + "/options", { method: "POST", body: JSON.stringify(input) }),
      perform: (input) => credentialRequest(call, path + (change ? "" : "/generate"), input, change ? "pin_change" : "backup_generate"),
      onSuccess: async (result) => {
        if (change) return onChanged({ panel: "pin", message: "PIN changed. Other portal sessions and previous account backup codes were revoked." });
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
