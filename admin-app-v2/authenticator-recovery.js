import { escapeHtml as h } from "/shared/safe-html.js";
import { runButton } from "/shared/pending.js";
import { requestAdminActionProof } from "/action-proof.js";

// purpose "pin" issues a support code for PIN recovery; "passkeys" removes a
// customer's lost passkeys (Phase 6); "phone" changes the number they sign in
// with (#398). All need the same case and identity check.
const PHONE = {
  title: "Change number",
  lede: "Verify the customer's identity in person or through an existing verified channel. This changes the number they sign in with. They keep their PIN, bundles, vouchers and history; their portal sessions are signed out and their linked email is told.",
  submit: "Verify and change number", doing: "changing the number",
  cancelled: "Verification was cancelled. The number was not changed.", done: "Number changed",
};
export function openAuthenticatorRecovery({ customerId, call, opener, retired = false, purpose = "pin" }) {
  const passkeys = purpose === "passkeys", phone = purpose === "phone";
  document.querySelector("[data-authenticator-recovery]")?.remove();
  const host = document.createElement("section"); host.className = "surface nd-panel admin-recovery"; host.dataset.authenticatorRecovery = "true";
  host.innerHTML = `<h3>${phone ? PHONE.title : passkeys ? "Remove lost passkeys" : "Verified account recovery"}</h3><p>${phone ? PHONE.lede : passkeys
    ? "Verify the customer's identity in person or through an existing verified channel. This removes every passkey saved on the account and signs out its portal sessions. The customer then signs in with their PIN and adds a new passkey."
    : "Verify the customer's identity in person or through an existing verified channel. This issues a time-limited support code for PIN recovery. The customer chooses their new PIN; support never sees it. Portal sessions and previous account backup codes will be revoked."}</p>
    <form><input type="hidden" name="customerId" value="${h(customerId)}">${phone ? `<label>New number<input name="phone" type="tel" inputmode="tel" autocomplete="off" maxlength="20" required></label>` : ""}<label>Support case reference<input name="caseReference" minlength="3" maxlength="80" required></label><label>Reason and verification notes<textarea name="reason" minlength="12" maxlength="500" required></textarea></label>
    <label>Identity verification<select name="verificationMethod"><option value="in_person">Verified in person</option><option value="existing_verified_channel">Existing verified channel</option></select></label><label><input type="checkbox" name="confirmedIdentity" required> I verified this customer's identity.</label>
    <p>Your fresh administrator PIN or passkey will be requested before ${phone ? PHONE.doing : passkeys ? "removing the passkeys" : "issuing a code"}.</p>
    <button type="submit">${phone ? PHONE.submit : passkeys ? "Verify and remove passkeys" : "Verify and issue support code"}</button><button type="button" data-close-authenticator-recovery>Cancel</button><p data-recovery-message role="status" aria-live="polite"></p></form>`;
  // v2: opened from a customer's support actions, the form appears under them.
  const overview = opener && opener.closest(".admin-customer__overview");
  (overview || document.getElementById("customerRecords")).after(host);
  if (overview) host.scrollIntoView({ block: "nearest" });
  const form = host.querySelector("form"), message = host.querySelector("[data-recovery-message]");
  form.onsubmit = async (event) => {
    event.preventDefault(); event.stopPropagation();
    const payload = Object.fromEntries(new FormData(form)); payload.confirmedIdentity = form.elements.confirmedIdentity.checked; payload.purpose = purpose;
    try {
      await runButton(form.querySelector('[type="submit"]'), "Verifying…", async () => {
        Object.assign(payload, await requestAdminActionProof({ call, purpose: "support_recovery", input: { ...payload, recoveryPurpose: purpose } }));
        const result = await call("/api/admin/customers/recovery", { method: "POST", body: JSON.stringify(payload) });
        form.reset();
        if (phone) { host.innerHTML = `<h3>${PHONE.done}</h3><p role="status">${h(result.message)}</p><button type="button" data-close-authenticator-recovery>Close</button>`; return; }
        if (passkeys) { host.innerHTML = `<h3>Passkeys removed</h3><p role="status">${h(result.message)}</p><button type="button" data-close-authenticator-recovery>Close</button>`; return; }
        host.setAttribute("data-sensitive-output", "");
        host.innerHTML = `<h3>Support code issued</h3><p>Shown once. Share only in person or through the verified channel. Expires ${h(new Date(result.expiresAt).toLocaleTimeString())}.</p><code>${h(result.recoveryCode)}</code><p>${h(result.message)}</p><button type="button" data-close-authenticator-recovery>Close support code</button>`;
      }, { controls: Array.from(form.elements) });
    } catch (error) { message.textContent = error.name === "AbortError" ? (phone ? PHONE.cancelled : passkeys ? "Verification was cancelled. No passkey was removed." : "Recovery verification was cancelled. No code was issued.") : error.message || "Recovery could not be approved."; }
  };
  host.onclick = (event) => { if (event.target.closest("[data-close-authenticator-recovery]")) { host.textContent = ""; host.remove(); if (opener.isConnected) opener.focus(); } };
  (phone ? form.elements.phone : form.elements.caseReference).focus(); host.scrollIntoView({ block: "nearest" });
}
