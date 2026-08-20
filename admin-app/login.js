const api = window.NDAHI_CONFIG.apiUrl,
  $ = (selector) => document.querySelector(selector);
let passkeyLoginRunning = false;
let mfaChallengeId = "";
const loginNotice = sessionStorage.getItem("ndahi-admin-login-notice");
if (loginNotice) {
  $("#message").textContent = loginNotice;
  sessionStorage.removeItem("ndahi-admin-login-notice");
}

function showMfaStep(challengeId) {
  mfaChallengeId = challengeId;
  $("#credentialsStep").hidden = true;
  $("#mfaStep").hidden = false;
  $("#message").textContent = "";
  $("#mfaStep input").focus();
}

function showCredentialsStep() {
  mfaChallengeId = "";
  $("#mfaLogin").reset();
  $("#mfaStep").hidden = true;
  $("#credentialsStep").hidden = false;
  $("#message").textContent = "";
  document.querySelector('[name="username"]').focus();
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
  const button = event.submitter || event.target.querySelector("button"),
    original = button.textContent;
  button.disabled = true;
  button.textContent = "Checking…";
  $("#message").textContent = "";
  try {
    const response = await fetch(api + "/api/admin/login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(event.target))),
      }),
      result = await response.json();
    if (!response.ok) throw Error(result.error || "Unable to sign in");
    if (result.mfaRequired) return showMfaStep(result.challengeId);
    location.href = "/dashboard";
  } catch (error) {
    $("#message").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
};

$("#mfaLogin").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector("button"),
    original = button.textContent;
  button.disabled = true;
  button.textContent = "Verifying…";
  $("#message").textContent = "";
  try {
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
    if (!response.ok) throw Error(result.error || "MFA verification failed");
    location.href = "/dashboard";
  } catch (error) {
    $("#message").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
};

$("#backToCredentials").onclick = showCredentialsStep;

$("#passkeyLogin").onclick = async () => {
  if (passkeyLoginRunning) return;
  const button = $("#passkeyLogin"),
    username = document.querySelector('[name="username"]').value;
  if (!username.trim()) {
    $("#message").textContent = "Enter your username before using a passkey.";
    document.querySelector('[name="username"]').focus();
    return;
  }
  passkeyLoginRunning = true;
  button.disabled = true;
  $("#message").textContent = "";
  try {
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
  } catch (error) {
    $("#message").textContent = error.name === "AbortError" ||
        /abort signal/i.test(error.message)
      ? "The browser cancelled the passkey prompt. Close any other passkey prompt, reload, and try once."
      : error.message;
  } finally {
    passkeyLoginRunning = false;
    button.disabled = false;
  }
};
