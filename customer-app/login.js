const api = window.NDAHI_CONFIG.apiUrl, $ = (selector) => document.querySelector(selector);
let passkeyLoginRunning = false;
const loginNotice = sessionStorage.getItem("ndahi-login-notice");
if (loginNotice) {
  $("#message").textContent = loginNotice;
  sessionStorage.removeItem("ndahi-login-notice");
}
async function call(path, data) {
  const response = await fetch(api + path, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }),
    result = await response.json();
  if (!response.ok) throw Error(result.error || "Request failed");
  return result;
}
$("#login").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector("button"), original = button.textContent;
  button.disabled = true;
  button.textContent = "Continue…";
  $("#message").textContent = "";
  try {
    const input = Object.fromEntries(new FormData(event.target)), result = await call("/api/account/login/request-authenticator", input);
    sessionStorage.setItem("ndahi-login-challenge", JSON.stringify({ ...result, phone: input.phone }));
    location.href = "/verify.html";
  } catch (error) {
    $("#message").textContent = error.message;
    button.disabled = false;
    button.textContent = original;
  }
};
$("#customerPasskeyLogin").onclick = async () => {
  if (passkeyLoginRunning) return;
  const button = $("#customerPasskeyLogin"),
    phone = document.querySelector('[name="phone"]').value;
  if (!phone.trim()) {
    $("#message").textContent = "Enter your phone number before using a passkey.";
    document.querySelector('[name="phone"]').focus();
    return;
  }
  passkeyLoginRunning = true;
  button.disabled = true;
  $("#message").textContent = "";
  try {
    let response = await fetch(api + "/api/account/passkey/options", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      }), result = await response.json();
    if (!response.ok) throw Error(result.error || "Passkey sign-in unavailable");
    const credential = await SimpleWebAuthnBrowser.startAuthentication({
      optionsJSON: result.options,
    });
    response = await fetch(api + "/api/account/passkey/verify", {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: result.challengeId, response: credential }),
    });
    result = await response.json();
    if (!response.ok) throw Error(result.error || "Passkey verification failed");
    location.href = "/dashboard";
  } catch (error) {
    $("#message").textContent = error.name === "AbortError" ||
        /abort signal/i.test(error.message)
      ? "The browser cancelled the passkey prompt. Reload and try once."
      : error.message;
  } finally {
    passkeyLoginRunning = false;
    button.disabled = false;
  }
};
