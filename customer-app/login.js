import { responseError, showError } from "./errors.js";
import { afterSignInPath } from "./hotspot-path.js";
import { applyNetworkStatus, fetchNetworkStatus } from "./network-status.js";
import { runButton } from "/shared/pending.js";

const api = window.NDAHI_CONFIG.apiUrl, $ = (selector) => document.querySelector(selector);
let accessToken = "", accessMode = "";
const runLogin = (button, text, task) => runButton(button, text, task, {
  controls: [$("#loginSubmit"), $("#changeDetails"), $("#customerPasskeyLogin"), $("#authenticatorLogin")],
});
fetchNetworkStatus(api).then((status) => {
  applyNetworkStatus($(".network-state"), status);
  applyNetworkStatus($(".panel-network"), status);
});
const loginNotice = sessionStorage.getItem("ndahi-login-notice");
if (loginNotice) {
  $("#message").textContent = loginNotice;
  sessionStorage.removeItem("ndahi-login-notice");
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
  const response = await fetch(api + path, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }),
    result = await response.json();
  if (!response.ok) throw responseError(response, result);
  return result;
}
$("#login").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#loginSubmit");
  try {
    await runLogin(button, accessToken ? "Signing in…" : "Checking…", async () => {
      $("#message").textContent = "";
      const input = Object.fromEntries(new FormData(event.target));
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
      await call("/api/account/access/complete", {
        token: accessToken, pin: input.pin,
        ...(accessMode === "setup" ? { confirmPin: input.confirmPin } : {}),
      });
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
      sessionStorage.setItem("ndahi-login-challenge", JSON.stringify({ ...result, phone }));
      location.href = "/verify.html";
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
      let response = await fetch(api + "/api/account/passkey/options", {
          method: "POST", credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ phone }),
        }), result = await response.json();
      if (!response.ok) throw responseError(response, result);
      const credential = await SimpleWebAuthnBrowser.startAuthentication({
        optionsJSON: result.options,
      });
      response = await fetch(api + "/api/account/passkey/verify", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId: result.challengeId, response: credential }),
      });
      result = await response.json();
      if (!response.ok) throw responseError(response, result);
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
