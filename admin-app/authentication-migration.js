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
  container.innerHTML = `<h3>Prepare password &amp; passkey access</h3><p>Verify a supported sign-in method before authenticator retirement. This does not disable existing authentication.</p><form method="post" data-admin-migration-proof><label>Current administrator password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Verify administrator password</button>${window.PublicKeyCredential && navigator.credentials && window.isSecureContext ? '<button type="button" data-admin-migration-passkey>Verify administrator passkey</button>' : '<p>Passkeys are unavailable in this browser. Verify your existing password instead.</p>'}</form><p data-admin-migration-message role="status" aria-live="polite" tabindex="-1"></p><details data-admin-migration-report><summary>Authentication readiness report</summary><p>Aggregate counts only. Configured credentials and verified credentials are counted separately. This report never displays customer identities or credential material.</p><div data-admin-migration-counts>Checking readiness…</div><button type="button" data-admin-migration-refresh>Refresh readiness report</button></details>`;
  const form = container.querySelector("form"), message = container.querySelector("[data-admin-migration-message]"), report = container.querySelector("[data-admin-migration-counts]");
  const post = (path, input) => call(root + path, { method: "POST", body: JSON.stringify(input) });
  const announce = (text) => { message.textContent = text; message.focus(); };
  async function refresh() {
    const state = await call(root + "/status"); if (!container.isConnected) return;
    if (state.aggregateRestricted) { report.innerHTML = "<p>Only an active owner can view aggregate account readiness. You can still verify your own sign-in method above.</p>"; return; }
    const c = state.customers, a = state.administrators;
    const count = (label, value) => `<dt>${h(label)}</dt><dd>${h(Number(value) || 0)}</dd>`;
    report.innerHTML = `<p><strong>${state.retired ? "Authenticator retirement is recorded." : state.ready ? "Readiness checks are satisfied. Retirement still requires a separately reviewed rollout." : "Authenticator retirement is not ready."}</strong></p><h4>Customer accounts</h4><dl>${count("Total accounts", c.total)}${count("Suspended accounts", c.suspended)}${count("Authenticator accounts", c.authenticatorAccounts)}${count("PIN configured", c.pinConfigured)}${count("Passkey configured", c.passkeyConfigured)}${count("Replacement verified", c.replacementVerified)}${count("No configured replacement", c.missingReplacement)}${count("Authenticator replacement unverified", c.authenticatorUnverified)}</dl><h4>Active administrators</h4><dl>${count("Active administrators", a.active)}${count("Active owners", a.activeOwners)}${count("Password configured", a.passwordConfigured)}${count("Passkey configured", a.passkeyConfigured)}${count("Replacement verified", a.replacementVerified)}${count("Replacement unverified", a.unverified)}</dl>${state.blockers?.length ? `<h4>Remaining checks</h4><ul>${state.blockers.map((key) => `<li>${h(blockers[key] || "An additional readiness check is pending.")}</li>`).join("")}</ul>` : ""}<p>Real authentication and recovery acceptance must be recorded separately from automated tests.</p>`;
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
  window.addEventListener("pagehide", () => form.reset(), { once: true });
  void refresh().catch((error) => { report.textContent = error.message || "Readiness report is unavailable. Use Refresh to retry."; });
  return { refresh };
}
