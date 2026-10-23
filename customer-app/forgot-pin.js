import { formValues, requestJson } from "./compat.js";
import { ApiError, responseError, showError } from "./errors.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { runButton } from "/shared/pending.js";

const api = window.NDAHI_CONFIG.apiUrl,
  $ = (selector) => document.querySelector(selector),
  token = new URLSearchParams(location.search).get("token");

async function call(path, data) {
  const { response, body: result } = await requestJson(api + path, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  if (!response.ok) throw responseError(response, result);
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
  const button = event.target.querySelector("button:not([type]), button[type=submit]");
  try {
    await runButton(button, "Sending…", async () => {
      $("#message").textContent = "";
      const result = await call("/api/account/pin-reset/request", formValues(event.target));
      $("#message").innerHTML = `<div class="success">${h(result.message)}</div>`;
      event.target.reset();
    });
  } catch (error) { showError($("#message"), error); }
};

$("#resetConfirm").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button:not([type]), button[type=submit]"), input = formValues(event.target);
  if (input.pin !== input.confirmPin) {
    showError($("#message"), new ApiError(400, "PIN entries do not match."));
    return;
  }
  try {
    await runButton(button, "Resetting…", async () => {
      $("#message").textContent = "";
      const result = await call("/api/account/pin-reset/confirm", { ...input, token });
      $("#message").innerHTML = `<div class="success">${h(result.message)} <a href="/login">Sign in</a></div>`;
      event.target.hidden = true;
    });
  } catch (error) { showError($("#message"), error); }
};

if (token) document.getElementById("otherRecovery").hidden = true;
for (const id of ["backupReset", "supportReset"]) {
  const form = document.getElementById(id);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const input = formValues(form), message = form.querySelector("[data-recovery-message]");
    try {
      await runButton(form.querySelector('[type="submit"]'), "Recovering…", async () => {
        const result = await call(id === "backupReset" ? "/api/account/pin-reset/backup" : "/api/account/pin-reset/confirm", input);
        form.reset(); message.textContent = result.message;
        const link = document.createElement("a"); link.href = "/login"; link.textContent = " Sign in"; message.appendChild(link);
      }, { controls: Array.from(form.elements) });
    } catch (error) { showError(message, error); }
  };
}
