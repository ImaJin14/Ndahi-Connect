import { runButton } from "/shared/pending.js";

const api = window.NDAHI_CONFIG.apiUrl,
  $ = (selector) => document.querySelector(selector);
let mfaChallengeId = "";
let authenticatorRetired = false;
const policy = fetch(api + "/api/authentication-policy", { credentials: "include", cache: "no-store" })
  .then(async (response) => {
    if (!response.ok) return null;
    const state = await response.json();
    if (state.authenticatorRetired === true) {
      authenticatorRetired = true; $("#mfaStep")?.remove();
    }
    return state;
  }).catch(() => null);
const runLogin = (button, text, task) => runButton(button, text, task, {
  controls: [$("#login button:not([type])"), $("#mfaLogin button:not([type])"), $("#backToCredentials"), $("#passkeyLogin")].filter(Boolean),
});
let loginNotice;
try { loginNotice = sessionStorage.getItem("ndahi-admin-login-notice"); } catch (_) { /* Optional storage. */ }
if (loginNotice) {
  $("#message").textContent = loginNotice;
  try { sessionStorage.removeItem("ndahi-admin-login-notice"); } catch (_) { /* Optional storage. */ }
}

async function showMfaStep(challengeId) {
  await policy;
  if (authenticatorRetired) { $("#message").textContent = "Authenticator sign-in has been retired. Refresh and use your administrator PIN or passkey."; return; }
  mfaChallengeId = challengeId;
  if ($("#credentialsStep")) $("#credentialsStep").hidden = true;
  if ($("#mfaStep")) {
    $("#mfaStep").hidden = false;
    $("#mfaStep input")?.focus();
  }
  $("#message").textContent = "";
}

function showCredentialsStep() {
  mfaChallengeId = "";
  $("#mfaLogin")?.reset();
  if ($("#mfaStep")) $("#mfaStep").hidden = true;
  if ($("#credentialsStep")) $("#credentialsStep").hidden = false;
  $("#message").textContent = "";
  document.querySelector('[name="username"]')?.focus();
}

$("#togglePassword").onclick = () => {
  const input = $("#adminPassword"), button = $("#togglePassword"),
    showing = input.type === "text";
  input.type = showing ? "password" : "text";
  button.textContent = showing ? "Show" : "Hide";
  button.setAttribute("aria-label", showing ? "Show PIN" : "Hide PIN");
  button.setAttribute("aria-pressed", String(!showing));
};

$("#login").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#login button:not([type])");
  try {
    await runLogin(button, "Checking…", async () => {
      $("#message").textContent = "";
      const data = Object.fromEntries(new FormData(event.target));
      const pin = data.pin || data.password;
      const payload = { ...data, pin, password: pin };
      const response = await fetch(api + "/api/admin/login", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
        result = await response.json();
      if (!response.ok) throw Error(result.error || "Unable to sign in");
      if (result.mfaRequired) return showMfaStep(result.challengeId);
      location.href = "/dashboard";
    });
  } catch (error) {
    $("#message").textContent = error.message;
  }
};

if ($("#mfaLogin")) {
  $("#mfaLogin").onsubmit = async (event) => {
    event.preventDefault();
    const button = $("#mfaLogin button:not([type])");
    try {
      await runLogin(button, "Verifying…", async () => {
        $("#message").textContent = "";
        const response = await fetch(api + "/api/admin/login/mfa", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              challengeId: mfaChallengeId,
              mfaCode: new FormData(event.target).get("mfaCode"),
            }),
          }),
          result = await response.json();
        if (!response.ok) {
          if (result.code === "AUTHENTICATOR_RETIRED") { authenticatorRetired = true; showCredentialsStep(); $("#mfaStep")?.remove(); }
          throw Error(result.error || "Verification failed. Use your PIN or passkey.");
        }
        location.href = "/dashboard";
      });
    } catch (error) {
      $("#message").textContent = error.message;
    }
  };
}

if ($("#backToCredentials")) {
  $("#backToCredentials").onclick = showCredentialsStep;
}

$("#passkeyLogin").onclick = async () => {
  const button = $("#passkeyLogin"),
    username = document.querySelector('[name="username"]').value;
  if (!username.trim()) {
    $("#message").textContent = "Enter your username before using a passkey.";
    document.querySelector('[name="username"]').focus();
    return;
  }
  try {
    await runLogin(button, "Waiting for device…", async () => {
      $("#message").textContent = "";
      let response = await fetch(api + "/api/admin/passkey/options", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username }),
        }),
        result = await response.json();
      if (!response.ok) throw Error(result.error);
      if (result.options.rpId && result.options.rpId !== location.hostname) {
        throw Error(`Open this page at https://${result.options.rpId} to use this passkey.`);
      }
      const credential = await SimpleWebAuthnBrowser.startAuthentication({
        optionsJSON: result.options,
      });
      response = await fetch(api + "/api/admin/passkey/verify", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId: result.challengeId, response: credential }),
      });
      result = await response.json();
      if (!response.ok) throw Error(result.error || "Passkey verification failed");
      location.href = "/dashboard";
    });
  } catch (error) {
    $("#message").textContent = error.name === "AbortError" ||
        /abort signal/i.test(error.message)
      ? "The browser cancelled the passkey prompt. Close any other passkey prompt, reload, and try once."
      : error.message;
  }
};
if (!window.PublicKeyCredential || !navigator.credentials) $("#passkeyLogin").hidden = true;
