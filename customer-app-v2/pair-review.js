// Device request (#370, canvas: PhonePairReview): the requesting device's
// reference ("PR-7Q4") to compare, what it is, when it asked and, for Personal
// Unlimited, the slots used once approved; Deny or Approve; then "Laptop
// approved" or "Request denied" with Back to devices. Only the registered main
// device can approve, and the server checks the reference.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format, getPreferredLanguage } from "/shared/i18n.js";
import { requestJson, markReady } from "./compat.js";
import { responseError, showError } from "./errors.js";
import { runButton } from "/shared/pending.js";
import { matchingCodeText } from "./pairing-review.js";
const lang = getPreferredLanguage();
document.documentElement.lang = lang;
const L = (key, values) => format(key, values || {}, lang);
const host = document.getElementById("pairingReview"), message = document.getElementById("pairingReviewMessage"), refreshButton = document.getElementById("pairingReviewRefresh"),
  api = window.NDAHI_CONFIG.apiUrl, id = new URLSearchParams(location.search).get("request");
let csrf, timer, version, generation = 0, busy = false;
const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || "");
async function call(path, options = {}) {
  const result = await requestJson(api + path, { credentials: "include", cache: "no-store", ...options, headers: { "content-type": "application/json", "x-csrf-token": csrf || "" } });
  if (!result.response.ok) throw responseError(result.response, result.body);
  return result.body;
}
// "Laptop · Windows" and, for the result, "Laptop"; from what the browser reported.
const KINDS = { iphone: "Iphone", ipad: "Ipad", android_phone: "AndroidPhone", android_tablet: "AndroidTablet", chromebook: "Chromebook", windows: "Windows", mac: "Mac", linux: "Linux" };
const SHORT = { iphone: "Phone", android_phone: "Phone", ipad: "Tablet", android_tablet: "Tablet", chromebook: "Laptop", windows: "Laptop", mac: "Laptop", linux: "Computer" };
const deviceLabel = (r) => KINDS[r.deviceKind] ? L("pairReviewKind" + KINDS[r.deviceKind]) : (r.name || L("pairReviewUnnamed"));
const deviceShort = (r) => L("pairReviewShort" + (SHORT[r.deviceKind] || "Device"));
function asked(at) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60000)), rtf = new Intl.RelativeTimeFormat(lang === "fr" ? "fr" : "en", { numeric: "auto" });
  return minutes < 1 ? L("pairReviewJustNow") : minutes < 60 ? rtf.format(-minutes, "minute") : rtf.format(-Math.round(minutes / 60), "hour");
}
const title = (text) => `<h1 class="preview__h1" tabindex="-1">${h(text)}</h1>`;
function open(request) {
  const rows = [["pairReviewDevice", deviceLabel(request)], ...(request.requestedAt ? [["pairReviewAsked", asked(request.requestedAt)]] : []),
    ...(request.slotsAfterApproving ? [["pairReviewAfter", L("pairReviewSlots", request.slotsAfterApproving)]] : [])];
  return title(L("pairReviewTitle")) + `<div class="preview__ref"><p class="preview__ref-label">${h(L("pairReviewReference"))}</p><p class="preview__ref-code" data-reference>${h(matchingCodeText(request.comparisonCode))}</p><p class="preview__ref-note">${h(L("pairReviewRefNote"))}</p></div>`
    + `<dl class="preview__facts">${rows.map(([key, value]) => `<div><dt>${h(L(key))}</dt><dd>${h(value)}</dd></div>`).join("")}</dl>`
    + `<form class="preview__actions"><button type="button" class="preview__btn2 preview__deny" data-pairing-decline>${h(L("pairReviewDeny"))}</button><button type="submit" class="preview__btn">${h(L("pairReviewApprove"))}</button></form><p class="preview__msg" data-pairing-error role="alert"></p>`;
}
function decided(request, ok) {
  host.classList.add("preview__main--done");
  return `<div class="preview__icon preview__icon--${ok ? "ok" : "no"}"><svg width="38" height="38" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${ok ? "m5 12 5 5 9-10" : "M6 6l12 12M18 6 6 18"}"></path></svg></div>`
    + title(ok ? L("pairReviewApproved", { device: deviceShort(request) }) : L("pairReviewDenied"))
    + `<p class="preview__text">${h(ok ? L("pairReviewApprovedBody") : L("pairReviewDeniedBody", { device: deviceShort(request).toLocaleLowerCase(lang) }))}</p><a class="preview__btn" href="/dashboard#devices">${h(L("pairReviewBack"))}</a>`;
}
function info(text) { return title(L("pairReviewTitle")) + `<p class="preview__text" role="status">${h(text)}</p>`; }

async function act(form, request, decline) {
  const output = form.parentElement.querySelector("[data-pairing-error]");
  output.textContent = "";
  busy = true;
  try {
    await runButton(form.querySelector(decline ? "[data-pairing-decline]" : '[type="submit"]'), L(decline ? "pairReviewDenying" : "pairReviewApproving"), async () => {
      await call("/api/account/device-management/pairing/" + (decline ? "decline" : "approve"), { method: "POST", body: JSON.stringify({ id: request.id, ...(!decline ? { comparisonCode: request.comparisonCode, confirmMatch: true } : {}) }) });
    }, { controls: Array.from(form.elements) });
    version = undefined; await refresh(); host.querySelector("h1")?.focus();
  } catch (error) { showError(output, error); }
  finally { busy = false; }
}
async function refresh() {
  clearTimeout(timer); if (!validId) return; if (busy) { timer = setTimeout(refresh, 5000); return; }
  const ticket = generation;
  try {
    const result = await call("/api/account/device-management/pairing?request=" + encodeURIComponent(id));
    if (ticket !== generation) return;
    const request = result.requests[0];
    refreshButton.hidden = true;
    if (result.deviceCapabilities?.mainDeviceSupported === false) { host.innerHTML = info(L("pairReviewNoApprovals")); message.textContent = ""; return; }
    // serverTime changes on every poll; only visible state replaces the page.
    const stable = JSON.stringify([request.status, request.comparisonCode, request.referenceUnavailable, request.deviceKind, request.name, request.slotsAfterApproving, request.message, result.isMainController, result.enabled]);
    if (version !== stable) {
      const focused = host.contains(document.activeElement); version = stable;
      host.classList.remove("preview__main--done");
      if (request.status === "awaiting_confirmation") {
        if (!result.isMainController) host.innerHTML = info(L("pairReviewMainOnly"));
        else if (!result.enabled || request.referenceUnavailable) host.innerHTML = info(L("pairReviewUnavailable"));
        else {
          host.innerHTML = open(request);
          const form = host.querySelector("form");
          form.onsubmit = (event) => { event.preventDefault(); void act(form, request, false); };
          form.querySelector("[data-pairing-decline]").onclick = () => void act(form, request, true);
        }
      } else if (["connecting", "connected"].includes(request.status)) host.innerHTML = decided(request, true);
      else if (request.status === "declined") host.innerHTML = decided(request, false);
      else host.innerHTML = info(request.status === "expired" ? L("pairReviewExpired") : request.message || L("pairReviewEnded"));
      if (focused && !host.contains(document.activeElement)) host.querySelector("h1")?.focus();
    }
    message.textContent = "";
    if (["awaiting_confirmation", "connecting"].includes(request.status)) timer = setTimeout(() => { if (!document.hidden) void refresh(); else timer = setTimeout(refresh, 5000); }, 5000);
  } catch (error) {
    if (ticket !== generation) return;
    if ([401, 403, 404].includes(error.status)) { host.innerHTML = title(L("pairReviewTitle")); version = undefined; } else timer = setTimeout(refresh, 5000);
    refreshButton.hidden = false; showError(message, error);
  }
}
document.getElementById("reviewTitle").textContent = L("pairReviewBar");
document.getElementById("reviewBack").setAttribute("aria-label", L("pairReviewBack"));
host.innerHTML = title(L("pairReviewTitle"));
message.textContent = L("pairReviewLoading"); refreshButton.textContent = L("pairReviewRefresh");
refreshButton.onclick = () => { void refresh(); };
markReady();
void (async () => {
  if (!validId) { message.textContent = L("pairReviewBadLink"); return; }
  try { const account = await call("/api/account/dashboard"); csrf = account.csrfToken; await refresh(); }
  catch (error) {
    if (error.status === 401) {
      message.textContent = L("pairReviewSignIn") + " ";
      const link = document.createElement("a"); link.href = "/login?account=1&next=" + encodeURIComponent("/pair-review.html?request=" + id); link.textContent = L("pairReviewSignInLink"); message.append(link);
    } else showError(message, error);
  }
})();
document.addEventListener("visibilitychange", () => { if (!document.hidden && csrf) void refresh(); });
window.addEventListener("pagehide", () => { generation++; clearTimeout(timer); version = undefined; });
window.addEventListener("pageshow", event => { if (event.persisted && csrf) { generation++; void refresh(); } });
