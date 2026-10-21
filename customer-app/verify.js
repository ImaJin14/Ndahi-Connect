import { ApiError, showError } from "./errors.js";
import { afterSignInPath, withWifiHint } from "./hotspot-path.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { formValues, sessionStore, markReady, requestJson } from "./compat.js";
import { runButton } from "/shared/pending.js";
import { completeSignIn } from "./sign-in-request.js";
import { loadAuthenticationPolicy } from "./authentication-migration.js";

const api = window.NDAHI_CONFIG.apiUrl, $ = (selector) => document.querySelector(selector),
  saved = sessionStore.get("ndahi-login-challenge"),
  checkoutSetup = new URLSearchParams(location.search).get("setup") === "checkout";
let challenge = null;
let retired = false;
const policy = loadAuthenticationPolicy().catch(() => null);
function retiredChallenge(unavailable = false) {
  retired = true; challenge = null; sessionStore.remove("ndahi-login-challenge");
  $("#verify").reset(); $("#verify").hidden = true; $("#useRecoveryCode").hidden = true; $("#development").textContent = "";
  $("#title").textContent = "Sign in with PIN or passkey";
  $("#instructions").textContent = unavailable ? "Sign-in policy could not be checked. Return to sign-in and use your PIN or passkey, or refresh to try again. Contact support if you need account recovery." : "This sign-in method has been retired. Return to sign-in and use your PIN or passkey. Contact support if you need account recovery.";
  markReady();
}
try { challenge = saved ? JSON.parse(saved) : null; }
catch (_) { sessionStore.remove("ndahi-login-challenge"); }
if (!challenge || typeof challenge !== "object") {
  challenge = null;
  if (!checkoutSetup) location.replace(withWifiHint("/login"));
}
function configureChallenge() {
  if (!challenge) return;
  $("#verify").hidden = false;
  $("#useRecoveryCode").hidden = Boolean(challenge.setupPin);
  if (challenge.setupPin) {
    $("#step").textContent = "Account setup";
    $("#title").textContent = "Create your PIN.";
    $("#instructions").textContent = "Choose exactly four numeric digits. You will use this PIN to sign in.";
    $("#primaryLabel").firstChild.textContent = "Create PIN";
    $("#primary").name = "pin";
    $("#primary").type = "password";
    $("#primary").pattern = "[0-9]{4}";
    $("#primary").maxLength = 4;
    $("#primary").placeholder = "••••";
    $("#primary").autocomplete = "new-password";
    $("#confirmLabel").hidden = false;
    $("#confirm").required = true;
    $("#submitLabel").textContent = "Create PIN and continue";
  } else $("#instructions").textContent = challenge.message;
  if (challenge.enrollmentRequired) $("#development").innerHTML = `<div class="success"><strong>First-time setup</strong><p>In Google Authenticator, tap +, choose Enter a setup key, use account <code>${h(challenge.phone)}</code>, and enter this time-based key:</p><code>${h(challenge.secret)}</code></div>`;
}
let usingRecoveryCode = false;
if (challenge && !challenge.setupPin) {
  $("#useRecoveryCode").onclick = () => {
    usingRecoveryCode = !usingRecoveryCode;
    $("#primary").name = usingRecoveryCode ? "recoveryCode" : "otp";
    $("#primary").pattern = usingRecoveryCode ? "[0-9A-Za-z-]{8,9}" : "[0-9]{6}";
    $("#primary").maxLength = usingRecoveryCode ? 9 : 6;
    $("#primary").placeholder = usingRecoveryCode ? "XXXX-XXXX" : "000000";
    $("#primary").inputMode = usingRecoveryCode ? "text" : "numeric";
    $("#primary").autocomplete = usingRecoveryCode ? "off" : "one-time-code";
    $("#primary").value = "";
    $("#useRecoveryCode").textContent = usingRecoveryCode ? "Use my authenticator code instead" : "Use a recovery code instead";
    $("#primaryLabel").firstChild.textContent = usingRecoveryCode ? "Recovery code" : "Verification code";
    $("#primary").focus();
  };
} else $("#useRecoveryCode").hidden = true;
$("#verify").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#submitLabel");
  try {
    await runButton(button, "Verifying…", async () => {
      $("#message").textContent = "";
      if (retired) throw new ApiError(410, "This sign-in method has been retired. Use PIN or passkey.");
      if (!challenge) throw new ApiError(401, "Setup access is unavailable. Sign in again or contact support.");
      const form = formValues(event.target);
      if (challenge.setupPin && form.pin !== form.confirmPin) {
        throw new ApiError(400, "PIN entries do not match.");
      }
      await completeSignIn(api, challenge.setupPin ? "/api/account/setup/pin" : "/api/account/login/verify-authenticator",
        challenge.setupPin ? (challenge.checkoutSetup ? { checkoutSetup: true, pin: form.pin, confirmPin: form.confirmPin } : { phone: challenge.phone, code: challenge.code, pin: form.pin, confirmPin: form.confirmPin })
          : usingRecoveryCode ? { challengeId: challenge.challengeId, recoveryCode: form.recoveryCode }
            : { challengeId: challenge.challengeId, otp: form.otp }, challenge.phone);
      sessionStore.remove("ndahi-login-challenge");
      location.href = afterSignInPath();
    }, { controls: [$("#useRecoveryCode")] });
  } catch (error) {
    if (error.code === "AUTHENTICATOR_RETIRED") retiredChallenge();
    showError($("#message"), error);
  }
};

if (checkoutSetup) {
  sessionStore.remove("ndahi-login-challenge");
  challenge = null;
  $("#useRecoveryCode").hidden = true;
  requestJson(api + "/api/account/setup/checkout", { credentials: "include", cache: "no-store" }).then(function (result) {
    if (!result.response.ok) throw new ApiError(result.response.status, result.body.error || "Setup access has expired.");
    challenge = { checkoutSetup: true, setupPin: true, phone: result.body.phone, expiresAt: result.body.expiresAt };
    configureChallenge(); $("#submitLabel").disabled = false; markReady();
  }).catch(function (error) {
    $("#title").textContent = "Finish account setup";
    $("#instructions").textContent = "Sign in with your PIN or voucher, or contact support if setup access expired. Do not pay again.";
    showError($("#message"), error);
  });
} else {
  if (challenge?.setupPin) { configureChallenge(); $("#submitLabel").disabled = false; markReady(); }
  else policy.then((state) => {
    if (!state || state.authenticatorRetired) { retiredChallenge(!state); return; }
    configureChallenge();
    if (challenge) { $("#submitLabel").disabled = false; markReady(); }
  });
}
