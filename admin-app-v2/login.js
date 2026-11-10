import { runButton } from "/shared/pending.js";

const api = window.NDAHI_CONFIG.apiUrl,
  $ = (selector) => document.querySelector(selector);
const runLogin = (button, text, task) => runButton(button, text, task, {
  controls: [$("#login button:not([type])"), $("#passkeyLogin")].filter(Boolean),
});
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
  button.setAttribute("aria-label", showing ? "Show password" : "Hide password");
  button.setAttribute("aria-pressed", String(!showing));
};

$("#login").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#login button:not([type])");
  try {
    await runLogin(button, "Checking…", async () => {
      $("#message").textContent = "";
      const data = Object.fromEntries(new FormData(event.target));
      const payload = data;
      const response = await fetch(api + "/api/admin/login", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
        result = await response.json();
      if (!response.ok) throw Error(result.error || "Unable to sign in");

      location.href = "/dashboard";
    });
  } catch (error) {
    $("#message").textContent = error.message;
  }
};

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
