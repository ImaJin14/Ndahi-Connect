import { escapeHtml as h } from "/shared/safe-html.js";
import { runButton } from "/shared/pending.js";

export function openAuthenticatorRecovery({ customerId, call, opener }) {
  document.querySelector("[data-authenticator-recovery]")?.remove();
  const host = document.createElement("section"); host.className = "surface"; host.dataset.authenticatorRecovery = "true";
  host.innerHTML = `<h3>Verified authenticator recovery</h3><p>Verify the customer's identity in person or through an existing verified channel. This issues a short-lived replacement code; the current authenticator stays enabled until the customer confirms a new app. Portal sessions and previous account backup codes will be revoked.</p>
    <form><input type="hidden" name="customerId" value="${h(customerId)}"><label>Support case reference<input name="caseReference" minlength="3" maxlength="80" required></label><label>Reason and verification notes<textarea name="reason" minlength="12" maxlength="500" required></textarea></label>
    <label>Identity verification<select name="verificationMethod"><option value="in_person">Verified in person</option><option value="existing_verified_channel">Existing verified channel</option></select></label><label><input type="checkbox" name="confirmedIdentity" required> I verified this customer's identity.</label>
    <label>Your administrator password<input name="password" type="password" autocomplete="current-password" required></label><label>Your administrator authenticator code, if enabled<input name="mfaCode" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"></label>
    <button type="submit">Verify and issue support code</button><button type="button" data-close-authenticator-recovery>Cancel</button><p data-recovery-message role="status" aria-live="polite"></p></form>`;
  document.getElementById("customerRecords").after(host);
  const form = host.querySelector("form"), message = host.querySelector("[data-recovery-message]");
  form.onsubmit = async (event) => {
    event.preventDefault(); event.stopPropagation();
    const payload = Object.fromEntries(new FormData(form)); payload.confirmedIdentity = form.elements.confirmedIdentity.checked; payload.purpose = "authenticator";
    try {
      await runButton(form.querySelector('[type="submit"]'), "Verifying…", async () => {
        const result = await call("/api/admin/customers/recovery", { method: "POST", body: JSON.stringify(payload) });
        form.reset(); host.setAttribute("data-sensitive-output", "");
        host.innerHTML = `<h3>Support code issued</h3><p>Shown once. Share only in person or through the verified channel. Expires ${h(new Date(result.expiresAt).toLocaleTimeString())}.</p><code>${h(result.recoveryCode)}</code><p>${h(result.message)}</p><button type="button" data-close-authenticator-recovery>Close support code</button>`;
      }, { controls: Array.from(form.elements) });
    } catch (error) { message.textContent = error.message || "Recovery could not be approved."; }
  };
  host.onclick = (event) => { if (event.target.closest("[data-close-authenticator-recovery]")) { host.textContent = ""; host.remove(); if (opener.isConnected) opener.focus(); } };
  form.elements.caseReference.focus(); host.scrollIntoView({ block: "nearest" });
}
