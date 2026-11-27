// Help as drawn (#361, canvas PhoneHelp; owner 27 Nov): five questions, a
// connection check that answers in three rows, and Call or WhatsApp. Answers
// other pages link to (#connect, #scan-qr, #recovery) stay hidden until the
// address points at them. The page follows the customer's language choice.
import { requestJson } from "./compat.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { format, getPreferredLanguage } from "/shared/i18n.js";
import { localize, setDocumentLanguage } from "/shared/ui/dom.js";
import { unlimitedLeft, isUnlimited, compactBytes } from "./active-bundle.js";

const lang = setDocumentLanguage(getPreferredLanguage());
localize(document, lang);
const L = (key, values) => format(key, values || {}, lang);
const config = window.NDAHI_CONFIG || {}, api = config.apiUrl || "";

// Still need help?: Call and WhatsApp with the configured support number.
const phone = String(config.supportPhone || "").trim(), digits = phone.replace(/[^0-9]/g, "");
if (digits) {
  document.getElementById("supportContacts").innerHTML = `<a class="portal-faq__contact" href="tel:${h(phone.replace(/[^+0-9]/g, ""))}">${h(L("helpCall", { phone }))}</a>`
    + `<a class="portal-faq__contact" href="https://wa.me/${h(digits)}?text=${h(encodeURIComponent(L("helpWhatsAppText")))}" target="_blank" rel="noopener">${h(L("helpWhatsApp"))}</a>`;
}

// "Bring your order code to [PICKUP LOCATION]": the shop's pickup place, when set.
fetch(api + "/api/store/catalogue", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((data) => {
  const pickup = data && data.settings && data.settings.pickup;
  const place = String((pickup && typeof pickup === "object" ? pickup[lang] || pickup.en : pickup) || "").trim().replace(/[\s.]+$/, "");
  if (place) document.getElementById("orderAnswer").textContent = L("helpAOrder", { place });
}).catch(() => { /* The answer without the place still holds. */ });

// A link to an answer opens it, including the ones kept for links.
function openAnswer() {
  const target = location.hash.length > 1 && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (!target || target.tagName !== "DETAILS") return;
  target.hidden = false; target.open = true;
  target.scrollIntoView({ block: "start" });
}
window.addEventListener("hashchange", openAnswer); openAnswer();

// Check my connection: NDAHI Wi-Fi, the bundle, and this device's private address.
const button = document.getElementById("runCheck"), results = document.getElementById("checkResults");
const row = (ok, text) => `<li><span class="portal-faq__dot portal-faq__dot--${ok ? "ok" : "warn"}" aria-hidden="true"></span>${h(text)}</li>`;
const get = (path) => requestJson(api + path, { credentials: "include", cache: "no-store" }, 6000).then(({ response, body }) => (response.ok ? body : null)).catch(() => null);
function bundleRow(connectivity, status) {
  if (!connectivity || connectivity.account?.state !== "authenticated") return row(false, L("helpBundleSignIn"));
  const v = status && status.bundle;
  if (connectivity.subscription?.state !== "active" || !v || v.status !== "active") return row(false, L("helpBundleNone"));
  const left = isUnlimited(v) ? unlimitedLeft(Date.parse(v.expiresAt) - Date.now()) : Number.isFinite(v.remainingBytes) ? compactBytes(v.remainingBytes) : "";
  return row(true, left ? L("helpBundleLeft", { left }) : L("helpBundleActive"));
}
button.addEventListener("click", async () => {
  if (button.getAttribute("aria-busy") === "true") return;
  button.setAttribute("aria-busy", "true"); button.textContent = L("helpChecking");
  try {
    const [connectivity, status] = await Promise.all([get("/api/account/connectivity"), get("/api/account/bundle-status")]);
    const wifi = !connectivity ? row(false, L("helpWifiUnknown")) : connectivity.network?.state === "confirmed" ? row(true, L("helpWifiYes")) : row(false, L("helpWifiNo"));
    const privateAddress = connectivity && connectivity.device ? connectivity.device.privateAddress : null;
    results.innerHTML = wifi + bundleRow(connectivity, status) + (privateAddress === true ? row(false, L("helpPrivateOn")) : privateAddress === false ? row(true, L("helpPrivateOff")) : "");
    results.hidden = false;
  } finally { button.removeAttribute("aria-busy"); button.textContent = L("helpRunAgain"); }
});
