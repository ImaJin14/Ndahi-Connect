import { ApiError, consumeReturnPath, responseError, showError } from "./errors.js";

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
  if (challenge.enrollmentRequired) $("#development").innerHTML = `<div class="success"><strong>First-time setup</strong><p>In Google Authenticator, tap +, choose Enter a setup key, use account <code>${challenge.phone}</code>, and enter this time-based key:</p><code>${challenge.secret}</code></div>`;
}
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
    const response = await fetch(api + (challenge.setupPin ? "/api/account/setup/pin" : "/api/account/login/verify-authenticator"), { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(challenge.setupPin ? { phone: challenge.phone, code: challenge.code, pin: form.pin, confirmPin: form.confirmPin } : { challengeId: challenge.challengeId, otp: form.otp }) }),
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
