import { ApiError, consumeReturnPath, responseError, showError } from "./errors.js";
import { escapeHtml as h } from "/shared/safe-html.js";

const api = window.NDAHI_CONFIG.apiUrl, $ = (selector) => document.querySelector(selector),
  saved = sessionStorage.getItem("ndahi-login-challenge");
if (!saved) location.replace("/login");
const challenge = saved ? JSON.parse(saved) : null;
if (challenge) {
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
  const button = event.submitter || event.target.querySelector("button"), original = button.textContent;
  button.disabled = true;
  button.textContent = "Verifying…";
  $("#message").textContent = "";
  try {
    const form = Object.fromEntries(new FormData(event.target));
    if (challenge.setupPin && form.pin !== form.confirmPin) {
      throw new ApiError(400, "PIN entries do not match.");
    }
    const response = await fetch(api + (challenge.setupPin ? "/api/account/setup/pin" : "/api/account/login/verify-authenticator"), { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(challenge.setupPin ? { phone: challenge.phone, code: challenge.code, pin: form.pin, confirmPin: form.confirmPin } : usingRecoveryCode ? { challengeId: challenge.challengeId, recoveryCode: form.recoveryCode } : { challengeId: challenge.challengeId, otp: form.otp }) }),
      result = await response.json();
    if (!response.ok) throw responseError(response, result);
    sessionStorage.removeItem("ndahi-login-challenge");
    location.href = consumeReturnPath();
  } catch (error) {
    showError($("#message"), error);
    button.disabled = false;
    button.textContent = original;
  }
};
