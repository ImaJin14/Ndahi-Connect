// Forgot PIN (canvas: PhoneForgotPin, #399; owner 26 Nov): ask for the number,
// "Check your email", "Reset your PIN" from the emailed link (15 minutes, once)
// and "PIN changed". PINs are 4 to 6 digits. Below the request, a code from
// NDAHI support (Admin's "Recover PIN with a support code", after an ID check)
// resets the PIN too; account backup codes are retired.
import { formValues, requestJson } from "./compat.js";
import { ApiError, responseError, showError } from "./errors.js";
import { runButton } from "/shared/pending.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const api = window.NDAHI_CONFIG.apiUrl,
  $ = (selector) => document.querySelector(selector),
  L = (key, values) => format(key, values || {}, currentLanguage()),
  token = new URLSearchParams(location.search).get("token");
// The emailed link carries the token; it leaves the address bar once read.
if (token) history.replaceState(null, "", location.pathname);

document.documentElement.lang = currentLanguage();
document.querySelectorAll("[data-l]").forEach((node) => {
  if (node.matches("a[aria-label]") && !node.textContent.trim()) node.setAttribute("aria-label", L(node.dataset.l));
  else node.textContent = L(node.dataset.l);
});

async function call(path, data) {
  const { response, body: result } = await requestJson(api + path, {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw responseError(response, result);
  return result;
}
const steps = ["requestReset", "resetSent", "confirmReset", "resetDone"];
function show(step) {
  for (const id of steps) document.getElementById(id).hidden = id !== step;
  $("#message").textContent = "";
  document.querySelector(`#${step} h1`).focus();
}

// "No email on your account? Visit <the shop> with your ID, or contact support."
function note(place) {
  $("#forgotNote").innerHTML = `<strong>${h(L("forgotNoEmail"))}</strong> ${h(L("forgotNoEmailVisit", { place: place || L("forgotOffice") })).replace("{support}", `<a href="/help#support">${h(L("forgotContactSupport"))}</a>`)}`;
}
note("");
requestJson(api + "/api/store/catalogue", { credentials: "omit" }).then(({ response, body }) => { if (response.ok && body?.settings?.pickup) note(body.settings.pickup); }).catch(() => {});

// The number typed on Sign in comes along when "Forgot PIN?" is chosen there.
try {
  const phone = sessionStorage.getItem("ndahi-forgot-phone");
  if (phone && /^[0-9 +]{9,16}$/.test(phone)) $('#resetRequest [name="phone"]').value = phone;
  sessionStorage.removeItem("ndahi-forgot-phone");
} catch {}

if (token) show("confirmReset");

$("#resetRequest").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button:not([type]), button[type=submit]");
  try {
    await runButton(button, L("forgotSending"), async () => {
      $("#message").textContent = "";
      await call("/api/account/pin-reset/request", formValues(event.target));
      show("resetSent");
    });
  } catch (error) { showError($("#message"), error); }
};
$("#sendAgain").onclick = () => show("requestReset");

$("#resetConfirm").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button:not([type]), button[type=submit]"), input = formValues(event.target);
  if (input.pin !== input.confirmPin) {
    showError($("#message"), new ApiError(400, L("forgotMismatch")));
    return;
  }
  try {
    await runButton(button, L("forgotSaving"), async () => {
      $("#message").textContent = "";
      await call("/api/account/pin-reset/confirm", { ...input, token });
      event.target.reset();
      show("resetDone");
    });
  } catch (error) { showError($("#message"), error); }
};

const support = $("#supportReset");
support.onsubmit = async (event) => {
  event.preventDefault();
  const input = formValues(support), message = support.querySelector("[data-recovery-message]");
  if (input.pin !== input.confirmPin) { showError(message, new ApiError(400, L("forgotMismatch"))); return; }
  try {
    await runButton(support.querySelector('[type="submit"]'), L("forgotRecovering"), async () => {
      await call("/api/account/pin-reset/confirm", input);
      support.reset();
      show("resetDone");
    }, { controls: Array.from(support.elements) });
  } catch (error) { showError(message, error); }
};
