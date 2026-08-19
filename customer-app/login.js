const api = window.NDAHI_CONFIG.apiUrl, $ = (selector) => document.querySelector(selector);
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
  button.textContent = "Sending code…";
  $("#message").textContent = "";
  try {
    const input = Object.fromEntries(new FormData(event.target)), result = await call("/api/account/login/request-otp", input);
    sessionStorage.setItem("ndahi-login-challenge", JSON.stringify({ challengeId: result.challengeId, phone: input.phone, developmentOtp: result.developmentOtp || null, message: result.message }));
    location.href = "/verify.html";
  } catch (error) {
    $("#message").textContent = error.message;
    button.disabled = false;
    button.textContent = original;
  }
};
