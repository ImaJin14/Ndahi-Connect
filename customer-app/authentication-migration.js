import { escapeHtml as h } from "/shared/safe-html.js";
import { runButton, isPending } from "/shared/pending.js";
import { formValues, loadPasskeys, requestJson } from "./compat.js";
import { showError } from "./errors.js";

const root = "/api/account/authentication-migration";
const passkeysAvailable = () => Boolean(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);

// Read the effective server policy each time; never persist a retirement guess
// in app storage. Unsupported policy reads leave PIN/passkey usable.
export async function loadAuthenticationPolicy() {
  const { response, body } = await requestJson(window.NDAHI_CONFIG.apiUrl + "/api/authentication-policy", { credentials: "include", cache: "no-store" });
  if (!response.ok || typeof body.authenticatorRetired !== "boolean") throw Error("Sign-in policy could not be checked. Use PIN or passkey, or refresh to try again.");
  return body;
}

// Preparation only: this component never turns off an existing sign-in method.
// PINs, old-factor proofs and the pending intent stay in this page's memory.
export function mountAuthenticationMigration({ container, call, retired = false }) {
  if (!container) return {};
  if (retired) { container.textContent = ""; return {}; }
  let state, intent;
  container.setAttribute("data-authentication-migration", "");
  container.innerHTML = `<h3>Prepare PIN &amp; passkey access</h3><p>Verify a PIN or passkey before authenticator sign-in is retired. Your existing sign-in methods stay available during preparation.</p><div data-migration-content><p>Checking your sign-in methods…</p></div><p data-migration-message role="status" aria-live="polite" tabindex="-1"></p><button type="button" data-migration-refresh>Refresh sign-in readiness</button>`;
  const content = container.querySelector("[data-migration-content]"), message = container.querySelector("[data-migration-message]"), refresh = container.querySelector("[data-migration-refresh]");
  const post = (path, input) => call(root + path, { method: "POST", body: JSON.stringify(input) });
  const controls = () => Array.from(container.querySelectorAll("input, select, button"));
  const announce = (text, focus = true) => { message.textContent = text; if (focus) message.focus(); };
  const failed = (error, passkey = false) => {
    if (passkey && ["NotAllowedError", "AbortError", "NotSupportedError"].includes(error.name)) {
      announce("Passkey verification was not completed. Try again or use your PIN, current authenticator, or audited support recovery.");
    } else { showError(message, error); message.focus(); }
  };
  async function perform(button, work, passkey = false) {
    try { await runButton(button, "Verifying…", work, { controls: controls() }); }
    catch (error) { failed(error, passkey); }
  }
  async function assertion(input = {}) {
    const browser = await loadPasskeys(), challenge = await post("/options", input);
    return { challengeId: challenge.challengeId, response: await browser.startAuthentication({ optionsJSON: challenge.options }) };
  }
  function render() {
    if (!state) return;
    if (intent) { renderConfirmation(); return; }
    const verified = [state.verified.pin && "PIN", state.verified.passkey && "passkey"].filter(Boolean);
    const summary = verified.length ? `<p><strong>Verified replacement: ${h(verified.join(" and "))}.</strong> Keep a working sign-in method available. Your existing sign-in methods remain available.</p>` : "<p>No replacement sign-in method has been verified yet.</p>";
    const passkey = state.configured.passkey && passkeysAvailable();
    content.innerHTML = summary + (state.pinEnrollmentRequired
      ? `<form method="post" data-migration-enroll><h4>Create a verified PIN</h4><label>New four-digit PIN<input name="newPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label><label>Confirm new PIN<input name="confirmPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label>${state.authenticatorEnabled ? '<label>Verify existing access using<select name="factor"><option value="otp">Current authenticator code</option><option value="recoveryCode">Unused authenticator recovery code</option></select></label><label data-migration-factor>Current authenticator code<input name="otp" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><button type="submit">Verify existing access and prepare PIN</button>' : ""}${passkey ? '<button type="button" data-migration-enroll-passkey>Prepare PIN with passkey</button>' : ""}<p>You will enter the new PIN again to finish. Your authenticator stays available.</p></form>`
      : '<form method="post" data-migration-pin><label>Current four-digit PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password" required></label><button type="submit">Verify PIN for future sign-in</button></form>') +
      (passkey ? '<p><button type="button" data-migration-passkey>Verify passkey for future sign-in</button></p>' : state.configured.passkey ? '<p>Passkeys are unavailable in this browser. Use a PIN or open this account on a device with a working passkey.</p>' : '<p>You can also add a passkey from Account security, then verify it here.</p>') +
      (state.pendingPin ? '<p>A PIN setup was started in this session. Start again if the confirmation page was closed.</p><button type="button" data-migration-cancel>Cancel pending PIN setup</button>' : "") +
      '<p><a href="/help#recovery">Lost your current authenticator or passkey? Get audited support recovery</a></p>';
    const pinForm = content.querySelector("[data-migration-pin]");
    if (pinForm) pinForm.onsubmit = (event) => {
      event.preventDefault(); event.stopPropagation();
      if (!pinForm.reportValidity()) return;
      const input = formValues(pinForm);
      void perform(pinForm.querySelector("button"), async () => {
        state = await post("/confirm", { pin: input.pin }); pinForm.reset(); render(); announce("Your PIN was verified for future sign-in. Existing methods remain available.");
      });
    };
    const verifyPasskey = content.querySelector("[data-migration-passkey]");
    if (verifyPasskey) verifyPasskey.onclick = () => { void perform(verifyPasskey, async () => {
      state = await post("/confirm", await assertion()); render(); announce("Your passkey was verified for future sign-in. Existing methods remain available.");
    }, true); };
    const enroll = content.querySelector("[data-migration-enroll]");
    if (enroll) {
      const factor = enroll.elements.factor;
      if (factor) factor.onchange = () => {
        const recovery = factor.value === "recoveryCode";
        enroll.querySelector("[data-migration-factor]").innerHTML = recovery
          ? 'Unused authenticator recovery code<input name="recoveryCode" type="password" maxlength="128" autocomplete="off" required>'
          : 'Current authenticator code<input name="otp" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>';
      };
      async function start(passkey, button) {
        if (!enroll.elements.newPin.reportValidity() || !enroll.elements.confirmPin.reportValidity()) return;
        if (enroll.elements.newPin.value !== enroll.elements.confirmPin.value) { announce("Enter the same new PIN twice."); enroll.elements.confirmPin.focus(); return; }
        if (!passkey && !enroll.reportValidity()) return;
        const input = formValues(enroll);
        void perform(button, async () => {
          const payload = { newPin: input.newPin, confirmPin: input.confirmPin };
          if (passkey) Object.assign(payload, await assertion({ action: "pin", ...payload }));
          else if (input.recoveryCode) payload.recoveryCode = input.recoveryCode;
          else payload.otp = input.otp;
          intent = await post("/pin/start", payload); enroll.reset(); renderConfirmation();
          announce("Existing access verified. Enter your new PIN once more to finish.", false);
          content.querySelector('[name="pin"]').focus();
        }, passkey);
      }
      enroll.onsubmit = (event) => { event.preventDefault(); event.stopPropagation(); const button = enroll.querySelector('[type="submit"]'); if (button) void start(false, button); };
      const prepare = enroll.querySelector("[data-migration-enroll-passkey]");
      if (prepare) prepare.onclick = () => { void start(true, prepare); };
    }
    const cancel = content.querySelector("[data-migration-cancel]");
    if (cancel) cancel.onclick = () => { void cancelSetup(cancel); };
  }
  async function cancelSetup(button) {
    await perform(button, async () => {
      await post("/pin/cancel", {}); intent = undefined; state.pendingPin = false;
      render(); announce("PIN setup cancelled. Your existing sign-in methods remain available.");
    });
  }
  function renderConfirmation() {
    content.innerHTML = `<form method="post" data-migration-confirm><h4>Confirm your new PIN</h4><p>Re-enter the PIN you just chose. Finish before ${h(new Date(intent.expiresAt).toLocaleTimeString())}. It is not saved to your account until confirmation.</p><label>Re-enter new four-digit PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label><button type="submit">Confirm and verify new PIN</button><button type="button" data-migration-cancel>Cancel PIN setup</button></form>`;
    const form = content.querySelector("form");
    form.onsubmit = (event) => {
      event.preventDefault(); event.stopPropagation(); if (!form.reportValidity()) return;
      const input = { intentId: intent.intentId, pin: form.elements.pin.value };
      void perform(form.querySelector('[type="submit"]'), async () => {
        try {
          state = await post("/pin/confirm", input); intent = undefined; form.reset(); render();
          announce("Your new PIN is verified and ready for sign-in. Your authenticator remains available during preparation.");
        } catch (error) {
          form.reset();
          if (["TypeError", "TimeoutError", "SyntaxError"].includes(error.name)) {
            // A lost reply can follow a committed confirmation. Never resend a
            // secret automatically or claim the PIN failed without checking.
            const recovered = await call(root + "/status").catch(() => null);
            if (recovered?.configured.pin && recovered.verified.pin && !recovered.pendingPin) {
              state = recovered; intent = undefined; render();
              announce("A verified PIN is now configured. Existing methods remain available. Sign in with your current PIN to check access.");
              return;
            }
          }
          if (error.code === "MIGRATION_INTENT_EXPIRED") {
            intent = undefined; state.pendingPin = true; render();
            announce("PIN setup expired or your credentials changed. Cancel the pending setup, then verify existing access again.");
          } else throw error;
        }
      });
    };
    form.querySelector("[data-migration-cancel]").onclick = (event) => { void cancelSetup(event.currentTarget); };
  }
  async function refreshStatus(focus = false) {
    try {
      state = await call(root + "/status"); if (!container.isConnected) return;
      render(); if (focus) announce("Sign-in readiness refreshed.");
    } catch (error) { failed(error); }
  }
  refresh.onclick = () => {
    if (controls().some(isPending)) return;
    if (intent) { announce("Finish or cancel your pending PIN confirmation first."); return; }
    void runButton(refresh, "Checking…", () => refreshStatus(true), { controls: controls() });
  };
  const clear = () => { intent = undefined; container.querySelectorAll("form").forEach((form) => form.reset()); };
  window.addEventListener("pagehide", clear, { once: true });
  window.addEventListener("pageshow", (event) => { if (event.persisted && container.isConnected) void refreshStatus(); });
  void refreshStatus();
  return { refresh: refreshStatus, clear };
}
