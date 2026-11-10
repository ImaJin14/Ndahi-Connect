import { runButton } from "/shared/pending.js";

// Proof stays in memory for one exact operation and is never a reusable grant.
export function requestAdminActionProof({ call, purpose, input = {} }) {
  return new Promise((resolve, reject) => {
    const opener = document.activeElement, dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "Verify administrator action");
    dialog.innerHTML = '<form><h3>Verify this action</h3><label>Current administrator password<input name="currentPassword" type="password" autocomplete="current-password" required></label><button type="submit">Verify password</button><button type="button" data-admin-proof-passkey>Verify with passkey</button><button type="button" data-admin-proof-cancel>Cancel</button><p role="status" aria-live="polite"></p></form>';
    const form = dialog.querySelector("form"), message = dialog.querySelector('[role="status"]'), passkey = dialog.querySelector("[data-admin-proof-passkey]");
    let settled = false;
    const finish = (proof, error) => {
      if (settled) return; settled = true; form.reset(); dialog.close(); dialog.remove();
      if (opener?.isConnected) opener.focus();
      if (error) reject(error); else resolve(proof);
    };
    const cancel = () => finish(null, new DOMException("Action cancelled. No change was made.", "AbortError"));
    passkey.hidden = !(window.PublicKeyCredential && navigator.credentials && window.isSecureContext && window.SimpleWebAuthnBrowser);
    form.onsubmit = event => {
      event.preventDefault(); event.stopPropagation();
      if (form.reportValidity()) {
        const pin = (form.elements.currentPin || form.elements.currentPassword).value;
        finish({ currentPassword: pin });
      }
    };
    passkey.onclick = async () => {
      try {
        await runButton(passkey, "Waiting for device…", async () => {
          const result = await call("/api/admin/profile/proof/options", { method: "POST", body: JSON.stringify({ ...input, purpose }) });
          const response = await window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: result.options });
          finish({ challengeId: result.challengeId, response });
        }, { controls: Array.from(form.elements) });
      } catch (error) { if (!settled) message.textContent = ["NotAllowedError", "AbortError"].includes(error.name) ? "Passkey verification was cancelled. Try again or use your password." : error.message; }
    };
    dialog.querySelector("[data-admin-proof-cancel]").onclick = cancel;
    dialog.addEventListener("cancel", event => { event.preventDefault(); cancel(); });
    const onHide = () => cancel(); window.addEventListener("pagehide", onHide, { once: true });
    dialog.addEventListener("close", () => window.removeEventListener("pagehide", onHide), { once: true });
    document.body.append(dialog); dialog.showModal();
    const field = form.elements.currentPin || form.elements.currentPassword;
    field?.focus();
  });
}
