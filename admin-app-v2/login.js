import { runButton } from "/shared/pending.js";
import { currentLanguage, localize } from "/shared/ui/dom.js";
import { format } from "/shared/i18n.js";

// v2 sign-in (canvas: AdminLogin), Phase 6: email + PIN, then the passkey.
// An administrator without a passkey adds one here to finish (required after
// the sign-in cutover). The username still works in the email field.
localize(document.body, currentLanguage());

const api = window.NDAHI_CONFIG.apiUrl,
  $ = (selector) => document.querySelector(selector),
  L = (key) => format(key, {}, currentLanguage());
const runLogin = (button, text, task) => runButton(button, text, task, {
  controls: [$("#login button:not([type])"), $("#usePasskey"), $("#differentAccount")].filter(Boolean),
});
let step = null;
let loginNotice;
try { loginNotice = sessionStorage.getItem("ndahi-admin-login-notice"); } catch (_) { /* Optional storage. */ }
if (loginNotice) {
  $("#message").textContent = loginNotice;
  try { sessionStorage.removeItem("ndahi-admin-login-notice"); } catch (_) { /* Optional storage. */ }
}

$("#togglePassword").onclick = () => {
  const input = $("#adminPassword"), button = $("#togglePassword"),
    showing = input.type === "text";
  input.type = showing ? "password" : "text";
  button.textContent = showing ? "Show" : "Hide";
  button.setAttribute("aria-label", showing ? "Show PIN" : "Hide PIN");
  button.setAttribute("aria-pressed", String(!showing));
};

async function post(path, payload) {
  const response = await fetch(api + path, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(Error(result.error || "Unable to sign in"), { status: response.status });
  return result;
}

// Step 2: confirm with the passkey, or add one (canvas: AdminLogin, second state).
function showStep(result) {
  step = result;
  const setup = result.step === "passkey_setup";
  $("#credentialsStep").hidden = true;
  $("#passkeyStep").hidden = false;
  $("#passkeyStepTitle").textContent = L(setup ? "adminSetupStepTitle" : "adminPasskeyStepTitle");
  $("#passkeyStepLede").textContent = L(setup ? "adminSetupStepLede" : "adminPasskeyStepLede");
  $("#usePasskey").textContent = L(setup ? "adminAddPasskeyButton" : "adminUsePasskey");
  $("#passkeyStepTitle").focus();
}
function showCredentials() {
  step = null;
  $("#passkeyStep").hidden = true;
  $("#credentialsStep").hidden = false;
  $("#login").reset();
  $("#adminEmail").focus();
}

$("#login").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#login button:not([type])");
  try {
    await runLogin(button, "Checking…", async () => {
      $("#message").textContent = "";
      const data = Object.fromEntries(new FormData(event.target));
      const result = await post("/api/admin/login", { email: data.email, pin: data.pin });
      $("#adminPassword").value = "";
      if (result.authenticated) { location.href = "/dashboard"; return; }
      if (result.step === "passkey" || result.step === "passkey_setup") showStep(result);
      else throw Error("Unable to sign in");
    });
  } catch (error) {
    $("#message").textContent = error.message;
  }
};

$("#usePasskey").onclick = async () => {
  const button = $("#usePasskey");
  if (!step) return showCredentials();
  if (!window.PublicKeyCredential || !navigator.credentials) {
    $("#message").textContent = "This browser cannot use passkeys. Open the admin in a browser with fingerprint, face or screen-lock support.";
    return;
  }
  try {
    await runLogin(button, "Waiting for device…", async () => {
      $("#message").textContent = "";
      if (step.options.rpId && step.options.rpId !== location.hostname)
        throw Error(`Open this page at https://${step.options.rpId} to use this passkey.`);
      const setup = step.step === "passkey_setup";
      const response = setup
        ? await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: step.options })
        : await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: step.options });
      await post(setup ? "/api/admin/login/passkey-setup" : "/api/admin/login/passkey", { challengeId: step.challengeId, stepToken: step.stepToken, response });
      location.href = "/dashboard";
    });
  } catch (error) {
    const cancelled = error.name === "AbortError" || error.name === "NotAllowedError" || /abort signal/i.test(error.message);
    // A finished or expired step can't be retried: start again from the PIN.
    if (error.status) showCredentials();
    $("#message").textContent = cancelled
      ? "The passkey prompt was cancelled. Try again, or use a different account."
      : error.message;
  }
};
$("#differentAccount").onclick = () => { $("#message").textContent = ""; showCredentials(); };
