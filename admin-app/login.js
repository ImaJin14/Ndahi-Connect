const api = window.NDAHI_CONFIG.apiUrl, $ = (selector) => document.querySelector(selector);
let passkeyLoginRunning = false;
$("#login").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector("button"), original = button.textContent;
  button.disabled = true;
  button.textContent = "Signing in…";
  $("#message").textContent = "";
  try {
    const response = await fetch(api + "/api/admin/login", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }),
      result = await response.json();
    if (!response.ok) throw Error(result.error || "Unable to sign in");
    location.href = "/";
  } catch (error) {
    $("#message").textContent = error.message;
    button.disabled = false;
    button.textContent = original;
  }
};
$("#passkeyLogin").onclick = async () => {
  if (passkeyLoginRunning) return;
  const button = $("#passkeyLogin"), username = document.querySelector('[name="username"]').value;
  passkeyLoginRunning = true;
  button.disabled = true;
  $("#message").textContent = "";
  try {
    let response = await fetch(api + "/api/admin/passkey/options", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }) }),
      result = await response.json();
    if (!response.ok) throw Error(result.error);
    if (result.options.rpId && result.options.rpId !== location.hostname) throw Error(`Open this page at http://${result.options.rpId}:8081 to use this passkey.`);
    const credential = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: result.options });
    response = await fetch(api + "/api/admin/passkey/verify", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: result.challengeId, response: credential }) });
    result = await response.json();
    if (!response.ok) throw Error(result.error || "Passkey verification failed");
    location.href = "/";
  } catch (error) {
    $("#message").textContent = error.name === "AbortError" || /abort signal/i.test(error.message)
      ? "The browser cancelled the passkey prompt. Close any other passkey prompt, reload, and try once."
      : error.message;
  } finally {
    passkeyLoginRunning = false;
    button.disabled = false;
  }
};
