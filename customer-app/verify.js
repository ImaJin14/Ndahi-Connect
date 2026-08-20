const api = window.NDAHI_CONFIG.apiUrl, $ = (selector) => document.querySelector(selector),
  saved = sessionStorage.getItem("ndahi-login-challenge");
if (!saved) location.replace("/login");
const challenge = saved ? JSON.parse(saved) : null;
if (challenge) {
  $("#instructions").textContent = challenge.message;
  if (challenge.enrollmentRequired) $("#development").innerHTML = `<div class="success"><strong>First-time setup</strong><p>In Google Authenticator, tap +, choose Enter a setup key, use account <code>${challenge.phone}</code>, and enter this time-based key:</p><code>${challenge.secret}</code></div>`;
}
$("#verify").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector("button"), original = button.textContent;
  button.disabled = true;
  button.textContent = "Verifying…";
  $("#message").textContent = "";
  try {
    const response = await fetch(api + "/api/account/login/verify-authenticator", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: challenge.challengeId, otp: new FormData(event.target).get("otp") }) }),
      result = await response.json();
    if (!response.ok) throw Error(result.error || "Verification failed");
    sessionStorage.removeItem("ndahi-login-challenge");
    location.href = "/dashboard";
  } catch (error) {
    $("#message").textContent = error.message;
    button.disabled = false;
    button.textContent = original;
  }
};
