import { formValues, markReady, randomId, requestJson, sessionStore } from "./compat.js";
import { wifiHint, startWifiRequest } from "./wifi-pairing.js";
import { responseError, showError } from "./errors.js";
import { runButton } from "/shared/pending.js";
import { wifiCompletionUrl } from "./wifi-completion.js";
import { matchingCodeText } from "./pairing-review.js";
import { format, getPreferredLanguage } from "/shared/i18n.js";
// Use a bundle from another phone (#407, canvas: PhonePairRequest; owner 27 Nov):
// type the owner's pairing code and Send request (a device signed in to the
// account keeps its one-tap request); then "Waiting for approval" with the
// reference and its QR, Check again and Cancel request; then "Approved — you're
// online". The page follows the customer's language.
const lang = getPreferredLanguage();
document.documentElement.lang = lang;
const L = (key, values) => format(key, values || {}, lang);

const config = window.NDAHI_CONFIG, $ = id => document.getElementById(id), form = $("pairingRequest"), message = $("pairingMessage"),
  progress = $("pairingProgress"), status = $("pairingStatus"), redeem = $("pairingRedeem"), cancel = $("pairingCancel"), retry = $("pairingRetry"),
  done = $("pairingDone"), completion = $("pairingCompletion"), account = $("pairingAccount"), hint = wifiHint();
let completionTimer, request = null, key, timer, countdown, polling = false, finishing = false, csrfToken, authenticated = false, generation = 0, qrUrl;
const signIn = $("wifiSignIn");
// "Open Wi-Fi sign-in" only helps a device the sign-in page couldn't identify (#407: not drawn otherwise).
if (config.hotspotLoginUrl) { signIn.href = config.hotspotLoginUrl; signIn.hidden = Boolean(hint); }
const pending = value => value && ["pending", "awaiting_code", "awaiting_confirmation", "connecting"].includes(value.status);
async function call(path, input) {
  const result = await requestJson(config.apiUrl + "/api/wifi/pairing/" + path, { cache: "no-store", credentials: "omit", ...(input ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) } : {}) });
  if (!result.response.ok) throw responseError(result.response, result.body);
  return result.body;
}
function remember() {
  sessionStore.set("ndahi_pairing", JSON.stringify({ key, id: request && request.id }));
  const candidate = hint ? "?mac=" + encodeURIComponent(hint.mac) + "&address=" + encodeURIComponent(hint.address) : "";
  try { history.replaceState(null, "", location.pathname + candidate + "#key=" + key + ((request && request.id) ? "&request=" + encodeURIComponent(request.id) : "")); } catch { /* Memory still supports this page. */ }
}
function forget() {
  sessionStore.remove("ndahi_pairing");
  const candidate = hint ? "?mac=" + encodeURIComponent(hint.mac) + "&address=" + encodeURIComponent(hint.address) : "";
  try { history.replaceState(null, "", location.pathname + candidate); } catch { /* Optional. */ }
}
function finish() {
  if ((request && request.status) !== "connected" || request.completionReady !== true) return;
  const target = wifiCompletionUrl(config.hotspotLoginUrl, location.origin) || new URL("/wifi-connected.html", location.origin).href;
  try { location.replace(target); } catch { /* Keep the visible Done fallback. */ }
}
done.onclick = finish;
function render(value) {
  request = value; progress.hidden = false; form.hidden = true; account.hidden = true;
  cancel.hidden = !["pending", "awaiting_code", "awaiting_confirmation"].includes(value.status);
  const ready = value.status === "connected" && value.completionReady === true, matching = value.protocol === 3 && value.status === "awaiting_confirmation";
  // Approved: who shares the bundle; the device finishes its Wi-Fi sign-in from here.
  const approved = value.status === "connected" && value.completionReady === true;
  $("pairingApproved").hidden = !approved;
  if (approved) $("pairingApprovedText").textContent = value.sharedWith?.owner ? L("pairApprovedBody", { owner: value.sharedWith.owner, plan: value.sharedWith.plan || L("pairTheBundle") }) : L("pairApprovedBodyAnon");
  progress.hidden = approved;
  $("pairingWaitTitle").textContent = L(value.status === "connecting" ? "pairConnectingTitle" : pending(value) ? "pairWaitTitle" : "pairEndedTitle");
  $("pairingCheck").hidden = !pending(value);
  // The drawn waiting screen has no progress list (owner, #407); its steps still track the state.
  document.querySelector(".pair-progress").hidden = true;
  retry.hidden = pending(value) || ready; clearTimeout(completionTimer); completion.hidden = true;
  // Approved, as drawn; Done appears only if this window hasn't moved on to the Wi-Fi sign-in.
  if (ready) completionTimer = setTimeout(() => { if (request === value) completion.hidden = false; }, 3000); redeem.hidden = value.status !== "awaiting_code";
  $("pairingReference").hidden = !matching;
  if (matching) {
    $("pairingReferenceCode").textContent = matchingCodeText(value.comparisonCode);
    if (value.qrDataUrl && /^data:image\/png;base64,/.test(value.qrDataUrl)) { $("pairingQr").src = value.qrDataUrl; $("pairingQr").hidden = false; qrUrl = value.reviewUrl; }
    if (value.referenceUnavailable) { retry.hidden = false; $("pairingQr").hidden = true; }
  } else { $("pairingQr").removeAttribute("src"); $("pairingQr").hidden = true; qrUrl = null; }
  const text = ["pending", "awaiting_confirmation"].includes(value.status) ? value.mainRequired ? "The account owner must set a main device before approving access. This device is waiting." : value.referenceUnavailable ? "This request reference is unavailable. Request access again." : matching ? "Waiting for your main device to approve." : (value.name || "Unnamed device") + " is waiting for the main device to approve access." : value.status === "awaiting_code" ? "Approved by your main device. Ask its owner for the six-digit code and enter it below." : value.status === "connecting" ? "Connecting… Wait for the router to confirm this device." : ready ? "Connected — this device's Wi-Fi access was confirmed by the router." : value.status === "connected" ? "This earlier connection is no longer confirmed. Request access again to check this device's current connection." : value.message || "Request " + value.status + ". Request access again.";
  // The drawn waiting screen says it with the reference; other states keep their line.
  const shown = matching && !value.mainRequired && !value.referenceUnavailable ? "" : text;
  if (status.textContent !== shown) status.textContent = shown;
  for (const step of document.querySelectorAll("[data-pair-step]")) {
    const current = step.dataset.pairStep === (ready ? "connected" : value.status === "connecting" ? "connecting" : "waiting");
    if (current) step.setAttribute("aria-current", "step"); else step.removeAttribute("aria-current");
  }
  clearInterval(countdown);
  if (pending(value)) {
    const offset = Date.parse(value.serverTime) - Date.now(), serverOffset = Number.isFinite(offset) ? offset : 0;
    const tick = () => { const seconds = Math.max(0, Math.ceil((Date.parse(value.expiresAt) - Date.now() - serverOffset) / 1000)); $("pairingExpiry").textContent = seconds ? "Request expires in " + Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0") + "." : "Checking whether this request expired…"; };
    tick(); countdown = setInterval(tick, 1000); remember();
  } else { $("pairingExpiry").textContent = ""; redeem.reset(); forget(); clearTimeout(timer); }
  if (ready && !finishing) { finishing = true; finish(); }
}
async function poll() {
  if (polling || !pending(request)) return;
  if (document.hidden) { timer = setTimeout(poll, 5000); return; }
  polling = true; const ticket = generation;
  try {
    const result = await call("status", { id: request.id, key, ...(!qrUrl ? { includeQr: true } : {}) });
    if (ticket !== generation) return;
    render(result.request); message.textContent = "";
  } catch (error) {
    if (ticket !== generation) return;
    if (error.status === 404) { forget(); clearTimeout(timer); clearInterval(countdown); request = null; retry.hidden = false; cancel.hidden = true; redeem.reset(); redeem.hidden = true; $("pairingReference").hidden = true; document.querySelector(".pair-progress").hidden = true; status.textContent = "This request is unavailable. Request access again."; }
    showError(message, error);
  } finally { polling = false; if (ticket === generation && pending(request)) timer = setTimeout(poll, 5000); }
}
async function identifyAccount() {
  const result = await requestJson(config.apiUrl + "/api/account/dashboard", { credentials: "include", cache: "no-store" });
  if (result.response.status === 401) { authenticated = false; csrfToken = undefined; return; }
  if (!result.response.ok) throw responseError(result.response, result.body);
  authenticated = true; csrfToken = result.body.csrfToken;
  if (result.body.deviceCapabilities && result.body.deviceCapabilities.connectionMode === "single" && hint) {
    location.replace("/hotspot?mac=" + encodeURIComponent(hint.mac) + "&address=" + encodeURIComponent(hint.address));
    return;
  }
}
function showStart() {
  form.hidden = !hint || authenticated; account.hidden = !hint || !authenticated; $("pairLede").hidden = authenticated;
  message.textContent = !hint ? "The Wi-Fi sign-in page could not identify this device. Open Wi-Fi sign-in below; if it still fails, use Connection help. You do not need the account owner's PIN to request access." : "";
}
retry.onclick = async () => {
  generation++; clearTimeout(timer); clearInterval(countdown); forget(); request = null; key = null; qrUrl = null; finishing = false; redeem.reset(); progress.hidden = true; completion.hidden = true; $("pairingQr").removeAttribute("src");
  try { await identifyAccount(); showStart(); } catch (error) { showError(message, error); }
};
async function begin(input, button) {
  try { await runButton(button, "Requesting…", async () => {
    if (!hint) throw Error("Open Wi-Fi sign-in on this device first.");
    if (!key) key = randomId(); remember();
    const payload = { ...input, key, mac: hint.mac, address: hint.address, protocol: 3, includeQr: true };
    const send = async data => {
      if (!authenticated) return call("request", data);
      const result = await requestJson(config.apiUrl + "/api/account/device-management/pairing/request", { method: "POST", credentials: "include", cache: "no-store", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify(data) });
      if (!result.response.ok) throw responseError(result.response, result.body);
      return result.body;
    };
    const result = await startWifiRequest(send, payload, next => { key = next; remember(); });
    render(result.request); message.textContent = ""; status.tabIndex = -1; status.focus(); clearTimeout(timer); timer = setTimeout(poll, 5000);
  }, { controls: authenticated ? [button] : Array.from(form.elements) }); } catch (error) { showError(message, error); }
}
form.onsubmit = event => { event.preventDefault(); void begin({ pairingCode: formValues(form).pairingCode }, form.querySelector('[type="submit"]')); };
$("pairingCheck").onclick = () => { clearTimeout(timer); void poll(); };
// The drawn words, in the customer's language.
$("pairTitle").textContent = L("pairBar"); $("pairBack").setAttribute("aria-label", L("pairBack"));
$("pairHeading").textContent = L("pairTitle");
$("pairLede").innerHTML = L("pairLede", { where: "\u0000" }).split("\u0000").map((part) => part.replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";")).join("<strong>" + L("pairWhere").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";") + "</strong>");
$("pairCodeLabel").textContent = L("pairCodeLabel"); $("pairSend").textContent = L("pairSend");
$("pairAccountText").textContent = L("pairAccountText"); $("pairingAccountRequest").textContent = L("pairAccountRequest");
$("pairingCheck").textContent = L("pairCheck"); $("pairingCancel").textContent = L("pairCancel"); $("pairingRetry").textContent = L("pairRetry");
$("pairingApprovedTitle").textContent = L("pairApprovedTitle");
$("pairRefText").firstChild.textContent = L("pairRefBefore") + " ";
$("pairRefText").lastChild.textContent = L("pairRefAfter");
$("pairingAccountRequest").onclick = event => { void begin({}, event.currentTarget); };
// Compatibility for an already-started legacy request. New requests never use
// this credential-entry step; a displayed reference cannot redeem one.
redeem.onsubmit = async event => {
  event.preventDefault();
  const approvalCode = formValues(redeem).approvalCode;
  try { await runButton(redeem.querySelector("button"), "Checking…", async () => {
    const result = await call("redeem", { id: request.id, key, approvalCode });
    redeem.reset(); render(result.request); message.textContent = ""; clearTimeout(timer); timer = setTimeout(poll, 5000);
  }, { controls: Array.from(redeem.elements) }); } catch (error) { showError(message, error); }
};
cancel.onclick = () => { void runButton(cancel, "Cancelling…", async () => { const result = await call("cancel", { id: request.id, key }); generation++; render(result.request); }).catch(error => showError(message, error)); };
document.addEventListener("visibilitychange", () => { if (!document.hidden && pending(request)) { clearTimeout(timer); void poll(); } });
window.addEventListener("pagehide", () => { generation++; clearTimeout(timer); clearInterval(countdown); $("pairingQr").removeAttribute("src"); qrUrl = null; });
window.addEventListener("pageshow", event => { if (event.persisted && pending(request)) { generation++; polling = false; clearTimeout(timer); void poll(); } });
markReady();
void (async () => {
  try {
    const fragment = new URLSearchParams(location.hash.slice(1)); let saved;
    try { saved = JSON.parse(sessionStore.get("ndahi_pairing") || "null"); } catch { /* Optional. */ }
    const candidate = fragment.get("key") || (saved && saved.key), id = fragment.get("request") || (saved && saved.id);
    key = /^[a-f0-9]{32,64}$/.test(candidate || "") ? candidate : null;
    if (key) {
      try {
        const resumed = await call("status", { key, ...(/^[a-f0-9-]{36}$/.test(id || "") ? { id } : {}), includeQr: true });
        render(resumed.request); message.textContent = ""; if (pending(request)) timer = setTimeout(poll, 5000); return;
      } catch (error) {
        if (error.status === 429) {
          request = { ...(/^[a-f0-9-]{36}$/.test(id || "") ? { id } : {}), status: "pending" };
          progress.hidden = false; status.textContent = "Resuming your existing request…"; cancel.hidden = true;
          timer = setTimeout(poll, 1600); return;
        }
        if (error.status !== 404) throw error; forget();
      }
    }
    const availability = await call("config");
    if (!availability.enabled && !availability.approvalRequired) { message.textContent = "Assisted connection is currently unavailable. Open Wi-Fi sign-in for the available connection options."; return; }
    await identifyAccount(); showStart();
  } catch (error) { showError(message, error); }
})();
