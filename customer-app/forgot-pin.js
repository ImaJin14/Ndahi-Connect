const api = window.NDAHI_CONFIG.apiUrl,
  $ = (selector) => document.querySelector(selector),
  token = new URLSearchParams(location.search).get("token");

async function call(path, data) {
  const response = await fetch(api + path, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }), result = await response.json();
  if (!response.ok) throw Error(result.error || "Request failed");
  return result;
}

if (token) {
  $("#requestReset").hidden = true;
  $("#confirmReset").hidden = false;
}

document.querySelectorAll(".pin-toggle").forEach((button) => {
  button.onclick = () => {
    const input = document.getElementById(button.dataset.toggle), show = input.type === "password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "Hide" : "Show";
    button.setAttribute("aria-pressed", String(show));
  };
});

$("#resetRequest").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const result = await call("/api/account/pin-reset/request", Object.fromEntries(new FormData(event.target)));
    $("#message").innerHTML = `<div class="success">${result.message}</div>`;
    event.target.reset();
  } catch (error) { $("#message").innerHTML = `<p class="error">${error.message}</p>`; }
  finally { button.disabled = false; }
};

$("#resetConfirm").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter, input = Object.fromEntries(new FormData(event.target));
  if (input.pin !== input.confirmPin) {
    $("#message").innerHTML = '<p class="error">PIN entries do not match.</p>';
    return;
  }
  button.disabled = true;
  try {
    const result = await call("/api/account/pin-reset/confirm", { ...input, token });
    $("#message").innerHTML = `<div class="success">${result.message} <a href="/login">Sign in</a></div>`;
    event.target.hidden = true;
  } catch (error) { $("#message").innerHTML = `<p class="error">${error.message}</p>`; }
  finally { button.disabled = false; }
};
