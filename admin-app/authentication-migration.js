import { escapeHtml as h } from "/shared/safe-html.js";
import { runButton } from "/shared/pending.js";

const root = "/api/admin/authentication-migration";
const blockers = {
  CUSTOMER_REPLACEMENT_MISSING: "Some customers have no configured PIN or passkey.",
  AUTHENTICATOR_REPLACEMENT_UNVERIFIED: "Some authenticator accounts still need a verified replacement.",
  ACTIVE_OWNER_REQUIRED: "An active owner is required.",
  ADMIN_REPLACEMENT_UNVERIFIED: "Some active administrators still need to verify password or passkey access.",
  RECOVERY_AND_PILOT_REVIEW_REQUIRED: "Recovery, authentication pilots and the compatible rollback revision still require review.",
};
export function mountAdminAuthenticationMigration({ container, call }) {
  if (!container) return {};
  container.setAttribute("data-admin-authentication-migration", "");
  container.innerHTML = `<h3>Prepare password &amp; passkey access</h3><p>Verify a supported sign-in method before authenticator retirement. This does not disable existing authentication.</p><form method="post" data-admin-migration-proof><label>Current administrator password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Verify administrator password</button>${window.PublicKeyCredential && navigator.credentials && window.isSecureContext ? '<button type="button" data-admin-migration-passkey>Verify administrator passkey</button>' : '<p>Passkeys are unavailable in this browser. Verify your existing password instead.</p>'}</form><p data-admin-migration-message role="status" aria-live="polite" tabindex="-1"></p><details data-admin-migration-report><summary>Authentication readiness report</summary><p>Aggregate counts only. Configured credentials and verified credentials are counted separately. This report never displays customer identities or credential material.</p><div data-admin-migration-counts>Checking readiness…</div><div data-admin-migration-review></div><button type="button" data-admin-migration-refresh>Refresh readiness report</button></details>`;
  const form = container.querySelector("form"), message = container.querySelector("[data-admin-migration-message]"), report = container.querySelector("[data-admin-migration-counts]");
  const post = (path, input) => call(root + path, { method: "POST", body: JSON.stringify(input) });
  const announce = (text) => { message.textContent = text; message.focus(); };
  const review = container.querySelector("[data-admin-migration-review]");
  function reviewForm(state) {
    if (state.retired) { review.innerHTML = ""; return; }
    const pending = (state.blockers || []).some((key) => key !== "RECOVERY_AND_PILOT_REVIEW_REQUIRED");
    review.innerHTML = `<h4>Record completed rollout checks</h4><ol><li>Each affected customer verifies a PIN or passkey under Account. Every active administrator verifies a password or passkey above.</li><li>Test customer and administrator sign-in, supported sensitive actions, cancelled passkeys and the fallback method on the intended devices.</li><li>Test account recovery and a compatible rollback in staging, preserving current account data. Save the results in a private operations record.</li></ol><p>Record evidence only after these checks are complete. Automated tests and a configured credential do not establish real account readiness.</p>${pending ? '<p>Verify the remaining account methods before recording rollout checks.</p>' : ''}<form method="post" data-readiness-review><fieldset ${pending ? 'disabled' : ''}><label>Tested compatible rollback commit<input name="rollbackRevision" pattern="[a-f0-9]{40}" minlength="40" maxlength="40" required autocomplete="off"></label><label>Private operations evidence reference<input name="evidenceReference" minlength="6" maxlength="160" pattern="[A-Za-z0-9][A-Za-z0-9 /_.:#-]{5,159}" required autocomplete="off"></label><label><input name="authenticationPilotVerified" type="checkbox" required>I completed real customer and administrator authentication and sensitive-action checks.</label><label><input name="supportRecoveryVerified" type="checkbox" required>I completed recovery and compatible rollback checks.</label><label>Owner password for this review<input name="reviewPassword" type="password" autocomplete="current-password"></label><button type="submit">Record completed checks with password</button>${window.PublicKeyCredential && navigator.credentials && window.isSecureContext ? '<button type="button" data-review-passkey>Record completed checks with passkey</button>' : ''}</fieldset></form><p>Recording this review does not retire authenticators. The separately authorized operator must still inspect readiness and run the guarded cutover.</p>`;
    const form = review.querySelector("form");
    async function save(passkey, button) {
      if (!form.reportValidity()) return;
      if (!passkey && !form.elements.reviewPassword.value) { announce("Enter your owner password or use your passkey to record the review."); return; }
      const input = { expectedDigest: state.digest, rollbackRevision: form.elements.rollbackRevision.value,
        evidenceReference: form.elements.evidenceReference.value, authenticationPilotVerified: form.elements.authenticationPilotVerified.checked,
        supportRecoveryVerified: form.elements.supportRecoveryVerified.checked };
      try {
        await runButton(button, "Recording…", async () => {
          if (passkey) {
            const browser = window.SimpleWebAuthnBrowser;
            if (!browser) throw Error("Passkeys could not load. Use your owner password instead.");
            const challenge = await post("/options", { ...input, action: "review" });
            input.challengeId = challenge.challengeId;
            input.response = await browser.startAuthentication({ optionsJSON: challenge.options });
          } else input.password = form.elements.reviewPassword.value;
          const result = await post("/review", input);
          form.reset(); await refresh();
          announce(result.ready ? "Completed checks recorded for the current inventory. Authenticator retirement still requires a separately authorized cutover." : "Review recorded. Remaining account readiness checks still need attention.");
        }, { controls: Array.from(container.querySelectorAll("input, button")) });
      } catch (error) {
        form.elements.reviewPassword.value = "";
        announce(["NotAllowedError", "AbortError"].includes(error.name) ? "Review passkey verification was cancelled. Try again or use your owner password." : error.message || "Review could not be recorded. Refresh readiness and try again.");
      }
    }
    form.onsubmit = (event) => { event.preventDefault(); event.stopPropagation(); void save(false, form.querySelector('[type="submit"]')); };
    const passkey = review.querySelector("[data-review-passkey]");
    if (passkey) passkey.onclick = () => { void save(true, passkey); };
  }
  async function refresh() {
    const state = await call(root + "/status"); if (!container.isConnected) return;
    if (state.aggregateRestricted) { review.innerHTML = ""; report.innerHTML = "<p>Only an active owner can view aggregate account readiness. You can still verify your own sign-in method above.</p>"; return; }
    const c = state.customers, a = state.administrators;
    const count = (label, value) => `<dt>${h(label)}</dt><dd>${h(Number(value) || 0)}</dd>`;
    report.innerHTML = `<p><strong>${state.retired ? "Authenticator retirement is recorded." : state.ready ? "Readiness checks are satisfied. Retirement still requires a separately reviewed rollout." : "Authenticator retirement is not ready."}</strong></p><h4>Customer accounts</h4><dl>${count("Total accounts", c.total)}${count("Suspended accounts", c.suspended)}${count("Authenticator accounts", c.authenticatorAccounts)}${count("PIN configured", c.pinConfigured)}${count("Passkey configured", c.passkeyConfigured)}${count("Replacement verified", c.replacementVerified)}${count("No configured replacement", c.missingReplacement)}${count("Authenticator replacement unverified", c.authenticatorUnverified)}</dl><h4>Active administrators</h4><dl>${count("Active administrators", a.active)}${count("Active owners", a.activeOwners)}${count("Password configured", a.passwordConfigured)}${count("Passkey configured", a.passkeyConfigured)}${count("Replacement verified", a.replacementVerified)}${count("Replacement unverified", a.unverified)}</dl>${state.blockers?.length ? `<h4>Remaining checks</h4><ul>${state.blockers.map((key) => `<li>${h(blockers[key] || "An additional readiness check is pending.")}</li>`).join("")}</ul>` : ""}<p>Real authentication and recovery acceptance must be recorded separately from automated tests.</p>`;
    reviewForm(state);
  }
  async function verify(passkey, button) {
    if (!passkey && !form.reportValidity()) return;
    const password = form.elements.password.value;
    try {
      await runButton(button, "Verifying…", async () => {
        let input = { password };
        if (passkey) {
          const browser = window.SimpleWebAuthnBrowser;
          if (!browser) throw Error("Passkeys could not load. Verify your administrator password instead.");
          const challenge = await post("/options", {});
          input = { challengeId: challenge.challengeId, response: await browser.startAuthentication({ optionsJSON: challenge.options }) };
        }
        await post("/confirm", input); form.reset();
        announce(passkey ? "Your administrator passkey was verified. Existing methods remain available." : "Your administrator password was verified. Existing methods remain available.");
        await refresh();
      }, { controls: Array.from(container.querySelectorAll("input, button")) });
    } catch (error) {
      form.reset();
      announce(["NotAllowedError", "AbortError"].includes(error.name) ? "Passkey verification was cancelled. Try again or verify your administrator password." : error.message || "Verification could not finish. Try again.");
    }
  }
  form.onsubmit = (event) => { event.preventDefault(); event.stopPropagation(); void verify(false, form.querySelector('[type="submit"]')); };
  const passkey = form.querySelector("[data-admin-migration-passkey]");
  if (passkey) passkey.onclick = () => { void verify(true, passkey); };
  const button = container.querySelector("[data-admin-migration-refresh]");
  button.onclick = async () => {
    try { await runButton(button, "Checking…", async () => { await refresh(); announce("Readiness report refreshed."); }, { controls: Array.from(container.querySelectorAll("input, button")) }); }
    catch (error) { announce(error.message || "Readiness report is unavailable. Try again."); }
  };
  window.addEventListener("pagehide", () => { form.reset(); const evidence = review.querySelector("form"); if (evidence) evidence.reset(); }, { once: true });
  void refresh().catch((error) => { report.textContent = error.message || "Readiness report is unavailable. Use Refresh to retry."; });
  return { refresh };
}
