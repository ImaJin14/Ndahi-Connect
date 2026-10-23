import { ApiError, showError } from "./errors.js";
import { afterSignInPath } from "./hotspot-path.js";
import { formValues, sessionStore, markReady, requestJson } from "./compat.js";
import { runButton } from "/shared/pending.js";
import { completeSignIn } from "./sign-in-request.js";

const api = window.NDAHI_CONFIG.apiUrl, $ = selector => document.querySelector(selector),
  checkoutSetup = new URLSearchParams(location.search).get("setup") === "checkout";
let challenge = null;
try { const saved = JSON.parse(sessionStore.get("ndahi-login-challenge") || "null"); if (saved && saved.setupPin === true) challenge = saved; }
catch (_) { /* Unusable saved setup never authorizes account access. */ }
if (!challenge) sessionStore.remove("ndahi-login-challenge");
function showSetup() {
  $("#step").textContent = "Account setup";
  $("#title").textContent = "Create your PIN.";
  $("#instructions").textContent = "Choose exactly four numeric digits. You will use this PIN to sign in.";
  $("#verify").hidden = false;
  $("#confirmLabel").hidden = false;
  $("#confirm").required = true;
  $("#submitLabel").disabled = false;
  markReady();
}
function showSignIn() {
  challenge = null; $("#verify").hidden = true;
  $("#title").textContent = "Sign in with PIN or passkey";
  $("#instructions").textContent = "Return to sign-in and use your PIN or passkey. If you have lost access, use account recovery or contact support. Do not pay again to recover your account.";
  markReady();
}
$("#verify").onsubmit = async event => {
  event.preventDefault();
  try {
    await runButton($("#submitLabel"), "Creating PIN…", async () => {
      if (!challenge || !challenge.setupPin) throw new ApiError(401, "Setup access is unavailable. Sign in or recover your account.");
      const form = formValues(event.target);
      if (form.pin !== form.confirmPin) throw new ApiError(400, "PIN entries do not match.");
      const input = challenge.checkoutSetup ? { checkoutSetup: true, pin: form.pin, confirmPin: form.confirmPin }
        : { phone: challenge.phone, code: challenge.code, pin: form.pin, confirmPin: form.confirmPin };
      await completeSignIn(api, "/api/account/setup/pin", input, challenge.phone);
      sessionStore.remove("ndahi-login-challenge");
      location.href = afterSignInPath();
    });
  } catch (error) { showError($("#message"), error); }
};
if (checkoutSetup) {
  sessionStore.remove("ndahi-login-challenge"); challenge = null;
  requestJson(api + "/api/account/setup/checkout", { credentials: "include", cache: "no-store" }).then(result => {
    if (!result.response.ok) throw new ApiError(result.response.status, result.body.error || "Setup access has expired.");
    challenge = { checkoutSetup: true, setupPin: true, phone: result.body.phone, expiresAt: result.body.expiresAt }; showSetup();
  }).catch(error => { showSignIn(); showError($("#message"), error); });
} else if (challenge) showSetup();
else showSignIn();
