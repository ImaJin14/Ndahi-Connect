import { responseError, showError } from "./errors.js";
import { afterSignInPath } from "./hotspot-path.js";
import { applyNetworkStatus, fetchNetworkStatus } from "./network-status.js";
import { runButton } from "/shared/pending.js";
import { formValues, sessionStore, requestJson, loadPasskeys, markReady } from "./compat.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { completeSignIn } from "./sign-in-request.js";

const api = window.NDAHI_CONFIG.apiUrl, $ = (selector) => document.querySelector(selector);
let accessToken = "", accessMode = "";
const runLogin = (button, text, task) => runButton(button, text, task, {
  controls: [$("#loginSubmit"), $("#changeDetails"), $("#customerPasskeyLogin"), $("#authenticatorLogin"), $("#inlineBack"), $("#inlineSubmit")],
});
fetchNetworkStatus(api).then((status) => {
  applyNetworkStatus($(".network-state"), status);
  applyNetworkStatus($(".panel-network"), status);
});
const loginNotice = sessionStore.get("ndahi-login-notice");
if (loginNotice) {
  $("#message").textContent = loginNotice;
  sessionStore.remove("ndahi-login-notice");
}
function toggleSecret(inputSelector, buttonSelector) {
  const input = $(inputSelector), button = $(buttonSelector),
    show = input.type === "password";
  input.type = show ? "text" : "password";
  button.textContent = show ? "Hide" : "Show";
  button.setAttribute("aria-pressed", String(show));
  input.focus();
}
$("#togglePin").onclick = () => toggleSecret("#customerPin", "#togglePin");
$("#toggleConfirmPin").onclick = () => toggleSecret("#confirmPin", "#toggleConfirmPin");
async function call(path, data) {
  const { response, body: result } = await requestJson(api + path, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  if (!response.ok) throw responseError(response, result);
  return result;
}
$("#login").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#loginSubmit");
  try {
    await runLogin(button, accessToken ? "Signing in…" : "Checking…", async () => {
      $("#message").textContent = "";
      const input = formValues(event.target);
      if (!accessToken) {
        const result = await call("/api/account/access/begin", {
          phone: input.phone, code: input.code,
        });
        accessToken = result.token;
        accessMode = result.mode;
        event.target.phone.readOnly = true;
        event.target.code.readOnly = true;
        $("#credentialStep").hidden = false;
        $("#customerPin").required = true;
        $("#pinLabel").textContent = accessMode === "setup"
          ? "Create a 4-digit PIN" : "4-digit PIN";
        $("#customerPin").autocomplete = accessMode === "setup"
          ? "new-password" : "current-password";
        $("#forgotPin").hidden = accessMode === "setup";
        $("#confirmPinLabel").hidden = accessMode !== "setup";
        $("#confirmPin").required = accessMode === "setup";
        $("#customerPin").focus();
        return;
      }
      await completeSignIn(api, "/api/account/access/complete", {
        token: accessToken, pin: input.pin,
        ...(accessMode === "setup" ? { confirmPin: input.confirmPin } : {}),
      }, input.phone);
      location.href = afterSignInPath();
    });
  } catch (error) {
    showError($("#message"), error);
  } finally {
    if (!button.disabled) button.textContent = accessToken
      ? accessMode === "setup" ? "Get Started" : "Sign in" : "Continue";
  }
};
$("#changeDetails").onclick = () => {
  accessToken = "";
  accessMode = "";
  const form = $("#login");
  form.phone.readOnly = false;
  form.code.readOnly = false;
  $("#credentialStep").hidden = true;
  $("#customerPin").required = false;
  $("#confirmPin").required = false;
  $("#customerPin").value = "";
  $("#confirmPin").value = "";
  $("#loginSubmit").textContent = "Continue";
  $("#message").textContent = "";
  form.phone.focus();
};
$("#authenticatorLogin").onclick = async () => {
  const phone = document.querySelector('[name="phone"]').value;
  if (!phone.trim()) return document.querySelector('[name="phone"]').focus();
  try {
    await runLogin($("#authenticatorLogin"), "Checking…", async () => {
      $("#message").textContent = "";
      const result = await call("/api/account/login/request-authenticator", { phone });
      if (sessionStore.set("ndahi-login-challenge", JSON.stringify({ ...result, phone }))) location.href = "/verify.html";
      else inlineAuthenticator(result, phone);
    });
  } catch (error) { showError($("#message"), error); }
};
$("#customerPasskeyLogin").onclick = async () => {
  const button = $("#customerPasskeyLogin"),
    phone = document.querySelector('[name="phone"]').value;
  if (!phone.trim()) {
    $("#message").textContent = "Enter your phone number before using a passkey.";
    document.querySelector('[name="phone"]').focus();
    return;
  }
  try {
    await runLogin(button, "Waiting for device…", async () => {
      $("#message").textContent = "";
      const passkeyBrowser = await loadPasskeys();
      const result = await call("/api/account/passkey/options", { phone });
      const credential = await passkeyBrowser.startAuthentication({
        optionsJSON: result.options,
      });
      await completeSignIn(api, "/api/account/passkey/verify", { challengeId: result.challengeId, response: credential }, phone);
      location.href = afterSignInPath();
    });
  } catch (error) {
    showError($("#message"), error, {
      context: "passkey",
      actions: [
        { label: "Try passkey again", run: () => $("#customerPasskeyLogin").click() },
        { label: "Use voucher and PIN", run: () => document.querySelector('[name="code"]').focus() },
      ],
    });
  }
};
// The button ships disabled so a slow captive-portal connection cannot submit
// the form natively (credentials in a GET URL) before this module has loaded.
$("#loginSubmit").disabled = false;
if (!window.PublicKeyCredential || !navigator.credentials) $("#customerPasskeyLogin").hidden = true;
markReady();

function inlineAuthenticator(challenge, phone) {
  $("#login").hidden = true;
  $("#inlineVerification").hidden = false;
  $("#inlineEnrollment").innerHTML = challenge.enrollmentRequired
    ? `<p>Add this time-based key to your authenticator app:</p><code>${h(challenge.secret)}</code>` : "";
  $("#inlineBack").onclick = () => {
    sessionStore.remove("ndahi-login-challenge");
    $("#inlineVerification").hidden = true;
    $("#login").hidden = false;
    $("#inlineCode").value = "";
  };
  $("#inlineVerify").onsubmit = async (event) => {
    event.preventDefault();
    try {
      await runLogin($("#inlineSubmit"), "Verifying…", async () => {
        const code = $("#inlineCode").value.trim();
        await completeSignIn(api, "/api/account/login/verify-authenticator", {
          challengeId: challenge.challengeId,
          ...(/^\d{6}$/.test(code) ? { otp: code } : { recoveryCode: code }),
        }, phone);
        sessionStore.remove("ndahi-login-challenge");
        location.href = afterSignInPath();
      });
    } catch (error) { showError($("#message"), error); }
  };
  $("#inlineCode").focus();
}
