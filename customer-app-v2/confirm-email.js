// The link a new email address gets (PhoneEditProfile, #398; owner 26 Nov).
// The token is in the fragment, so it never reaches a server log; the page
// asks for a tap before confirming, so a mail scanner opening the link does
// not confirm it. Confirming ends every portal session: the customer signs in.
import { requestJson } from "./compat.js";
import { responseError, showError } from "./errors.js";
import { runButton } from "/shared/pending.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const L = (key, values) => format(key, values || {}, currentLanguage()), $ = (id) => document.getElementById(id);
const token = decodeURIComponent(location.hash.slice(1));
// Keep the token out of the address bar and history once read.
if (location.hash) history.replaceState(null, "", location.pathname);

const title = $("confirmEmailTitle"), text = $("confirmEmailText"), button = $("confirmEmailButton"), signIn = $("confirmEmailSignIn"), message = $("message");
document.documentElement.lang = currentLanguage();
document.title = `${L("confirmEmailTitle")} — NDAHI Connect`;
function show(titleKey, body) {
  title.textContent = L(titleKey); text.textContent = body;
  button.hidden = true; signIn.hidden = false; title.focus();
}
title.textContent = L("confirmEmailTitle"); text.textContent = L("confirmEmailLede");
button.textContent = L("confirmEmailButton"); signIn.textContent = L("confirmEmailSignIn");
if (!/^[0-9a-f-]{36}\.[0-9a-f]{40}$/.test(token)) show("confirmEmailExpiredTitle", L("confirmEmailExpired"));
else button.onclick = async () => {
  try {
    await runButton(button, L("confirmEmailBusy"), async () => {
      message.textContent = "";
      const { response, body } = await requestJson(window.NDAHI_CONFIG.apiUrl + "/api/account/profile/email/confirm-link", {
        method: "POST", credentials: "omit", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
      });
      if (body?.code === "LINK_EXPIRED") return show("confirmEmailExpiredTitle", L("confirmEmailExpired"));
      if (!response.ok) throw responseError(response, body);
      show("confirmEmailDoneTitle", L("confirmEmailDone", { email: body.email }));
    });
  } catch (error) { showError(message, error); }
};
