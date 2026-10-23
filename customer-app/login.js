import { responseError, showError } from "./errors.js";
import { afterSignInPath } from "./hotspot-path.js";
import { applyNetworkStatus, fetchNetworkStatus } from "./network-status.js";
import { runButton } from "/shared/pending.js";
import { formValues, sessionStore, requestJson, loadPasskeys, markReady } from "./compat.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { completeSignIn } from "./sign-in-request.js";
import { migrateLegacyCheckout } from "./checkout-store.js";
import { wifiHint, startWifiRequest } from "./wifi-pairing.js";
import { randomId } from "./compat.js";
import { mountThemeToggle } from "./portal-nav.js";

mountThemeToggle();

migrateLegacyCheckout();
const api = window.NDAHI_CONFIG.apiUrl, $ = (selector) => document.querySelector(selector);
let accessToken = "", accessMode = "", accountOnly = new URLSearchParams(location.search).get("account") === "1";
const runLogin = (button, text, task) => runButton(button, text, task, {
  controls: [$("#loginSubmit"), $("#changeDetails"), $("#customerPasskeyLogin")],
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
function showAccountCredentials() {
  $("#credentialStep").hidden = false;
  $("#customerPin").required = true;
  $("#pinLabel").textContent = accessMode === "setup" ? "Create a 4-digit PIN" : "4-digit PIN";
  $("#customerPin").autocomplete = accessMode === "setup" ? "new-password" : "current-password";
  $("#forgotPin").hidden = accessMode === "setup";
  $("#confirmPinLabel").hidden = accessMode !== "setup";
  $("#confirmPin").required = accessMode === "setup";
  $("#customerPin").focus();
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
        if (result.deviceApprovalRequired && !accountOnly) {
          const hint = wifiHint(), gate = document.createElement("section");
          gate.id = "deviceAccessGate"; gate.className = "card";
          gate.innerHTML = '<h2>Request access from your main device</h2><p>This device will stay offline until your main device approves it and supplies a code.</p><button type="button" data-request-access>Request access</button><button type="button" data-account-signin>Sign in to account settings</button><p data-access-message role="status"></p>';
          event.target.hidden = true; event.target.after(gate);
          document.querySelectorAll(".alternative-actions,.login-alternatives").forEach((element) => { element.hidden = true; });
          const requestButton = gate.querySelector("[data-request-access]"); let key;
          requestButton.hidden = !hint;
          requestButton.onclick = async () => {
            try { await runButton(requestButton, "Requesting…", async () => {
              if (!key) key = randomId();
              const reply = await startWifiRequest((payload) => call("/api/wifi/pairing/request", payload), { phone: input.phone, code: input.code, key, mac: hint.mac, address: hint.address }, (next) => { key = next; });
              location.href = "/pair?mac=" + encodeURIComponent(hint.mac) + "&address=" + encodeURIComponent(hint.address) + "#key=" + key + "&request=" + encodeURIComponent(reply.request.id);
            }, { controls: Array.from(gate.querySelectorAll("button")) }); } catch (error) { showError(gate.querySelector("[data-access-message]"), error); }
          };
          gate.querySelector("[data-account-signin]").onclick = () => {
            accountOnly = true;
            try { const url = new URL(location.href); url.searchParams.set("account", "1"); history.replaceState(null, "", url.href); } catch (_) {}
            gate.remove(); event.target.hidden = false;
            document.querySelectorAll(".alternative-actions,.login-alternatives").forEach((element) => { element.hidden = false; });
            showAccountCredentials();
          };
          if (!hint) {
            gate.querySelector("[data-access-message]").textContent = "The Wi-Fi sign-in page did not identify this device. Open Wi-Fi sign-in again to request access. You do not need the account owner's PIN to request Wi-Fi access.";
            try {
              const target = new URL(window.NDAHI_CONFIG.hotspotLoginUrl);
              if (target.protocol === "https:" && !target.username && !target.password) {
                const link = document.createElement("a"); link.href = target.href; link.textContent = "Open Wi-Fi sign-in";
                gate.appendChild(link); link.focus();
              }
            } catch (_) { gate.querySelector("[data-account-signin]").focus(); }
          } else requestButton.focus();
        } else showAccountCredentials();
        return;
      }
      await completeSignIn(api, "/api/account/access/complete", {
        token: accessToken, pin: input.pin,
        ...(accessMode === "setup" ? { confirmPin: input.confirmPin } : {}),
      }, input.phone);
      location.href = afterSignInPath(accountOnly);
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
      location.href = afterSignInPath(accountOnly);
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

if (new URLSearchParams(location.search).get("payment") === "confirmed") {
  document.querySelector("#message").textContent = "Payment confirmed. Sign in with your account PIN to view your voucher and bundle.";
}
