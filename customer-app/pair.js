import { formValues, markReady, randomId, requestJson, sessionStore } from "./compat.js";
import { wifiHint, startWifiRequest } from "./wifi-pairing.js";
import { responseError, showError } from "./errors.js";
import { runButton } from "/shared/pending.js";

const config = window.NDAHI_CONFIG, form = document.getElementById("pairingRequest"), message = document.getElementById("pairingMessage"),
  progress = document.getElementById("pairingProgress"), status = document.getElementById("pairingStatus"), redeem = document.getElementById("pairingRedeem"),
  cancel = document.getElementById("pairingCancel"), retry = document.getElementById("pairingRetry"), hint = wifiHint();
let request = null, key, timer, polling = false;
const signIn = document.getElementById("wifiSignIn");
if (config.hotspotLoginUrl) { signIn.href = config.hotspotLoginUrl; signIn.hidden = false; }
const pending = (value) => value && ["pending", "awaiting_code", "connecting"].includes(value.status);
async function call(path, input) {
  const result = await requestJson(config.apiUrl + "/api/wifi/pairing/" + path, { cache: "no-store", credentials: "omit", ...(input ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) } : {}) });
  if (!result.response.ok) throw responseError(result.response, result.body);
  return result.body;
}
function remember() {
  const value = { key, id: request && request.id, expiresAt: request && request.expiresAt };
  sessionStore.set("ndahi_pairing", JSON.stringify(value));
  // Fragments survive a reload when storage is blocked, and are not sent in HTTP.
  const candidate = hint ? "?mac=" + encodeURIComponent(hint.mac) + "&address=" + encodeURIComponent(hint.address) : "";
  try { history.replaceState(null, "", location.pathname + candidate + "#key=" + key + (value.id ? "&request=" + encodeURIComponent(value.id) : "")); } catch (_) { /* Memory still supports this page. */ }
}
function forget() {
  sessionStore.remove("ndahi_pairing");
  const candidate = hint ? "?mac=" + encodeURIComponent(hint.mac) + "&address=" + encodeURIComponent(hint.address) : "";
  try { history.replaceState(null, "", location.pathname + candidate); } catch (_) { /* Optional. */ }
}
function render(value) {
  request = value;
  progress.hidden = false; form.hidden = true;
  cancel.hidden = !["pending", "awaiting_code"].includes(value.status);
  retry.hidden = pending(value) || value.status === "connected";
  redeem.hidden = value.status !== "awaiting_code";
  status.textContent = value.status === "pending" ? value.mainRequired ? "The account owner must set a main device before approving access. This device is waiting." : (value.name || "Unnamed device") + " is waiting for the main device to approve access." : value.status === "awaiting_code" ? "Approved by your main device. Ask its owner for the six-digit code and enter it below." : value.status === "connecting" ? "Connecting… Wait for the router to confirm internet access." : value.status === "connected" ? "Connected — internet access was confirmed by the router. You can now browse." : value.message || "Request " + value.status + ". Request access again.";
  document.getElementById("pairingExpiry").textContent = pending(value) ? "Expires at " + new Date(value.expiresAt).toLocaleTimeString() + "." : "";
  if (!pending(value)) { redeem.reset(); forget(); clearTimeout(timer); }
  else remember();
}
async function poll() {
  if (polling || !pending(request)) return;
  if (document.hidden) { timer = setTimeout(poll, 5000); return; }
  polling = true;
  try {
    const result = await call("status", { id: request.id, key }); render(result.request);
    message.textContent = "";
  }
  catch (error) {
    if (error.status === 404) { forget(); clearTimeout(timer); request = null; retry.hidden = false; cancel.hidden = true; redeem.reset(); redeem.hidden = true; }
    showError(message, error);
  } finally {
    polling = false;
    if (pending(request)) timer = setTimeout(poll, 5000);
  }
}
retry.onclick = () => {
  clearTimeout(timer); forget(); request = null; key = null; redeem.reset(); progress.hidden = true;
  form.hidden = !hint; message.textContent = hint ? "Request access again, then enter the code supplied by your main device." : "Open Wi-Fi sign-in on this device before requesting access.";
};
form.onsubmit = (event) => {
  event.preventDefault();
  const input = formValues(form);
  void (async () => {
    try {
      await runButton(form.querySelector('button[type="submit"]'), "Requesting…", async () => {
        if (!hint) throw Error("Open Wi-Fi sign-in on this device first.");
        if (!key) key = randomId();
        remember();
        const result = await startWifiRequest((payload) => call("request", payload), Object.assign(input, { key, mac: hint.mac, address: hint.address }), (next) => { key = next; remember(); });
        render(result.request);
        form.reset(); message.textContent = "Keep this page open while your main device reviews the request.";
        clearTimeout(timer); timer = setTimeout(poll, 5000);
      }, { controls: Array.from(form.elements) });
    } catch (error) { showError(message, error); }
  })();
};
redeem.onsubmit = async (event) => {
  event.preventDefault();
  const approvalCode = formValues(redeem).approvalCode;
  try {
    await runButton(redeem.querySelector("button"), "Checking…", async () => {
      const result = await call("redeem", { id: request.id, key, approvalCode });
      redeem.reset(); render(result.request); message.textContent = "";
      clearTimeout(timer); timer = setTimeout(poll, 5000);
    }, { controls: Array.from(redeem.elements) });
  } catch (error) { showError(message, error); }
};
cancel.onclick = () => {
  void (async () => {
    try { await runButton(cancel, "Cancelling…", async () => { const result = await call("cancel", { id: request.id, key }); render(result.request); }); }
    catch (error) { showError(message, error); }
  })();
};
document.addEventListener("visibilitychange", () => { if (!document.hidden && pending(request)) { clearTimeout(timer); void poll(); } });
window.addEventListener("pagehide", () => clearTimeout(timer));
markReady();
void (async () => {
  try {
    const fragment = new URLSearchParams(location.hash.slice(1));
    let saved;
    try { saved = JSON.parse(sessionStore.get("ndahi_pairing") || "null"); } catch (_) { /* Optional. */ }
    const candidate = fragment.get("key") || (saved && saved.key), id = fragment.get("request") || (saved && saved.id);
    key = /^[a-f0-9]{32,64}$/.test(candidate || "") ? candidate : null;
    if (key && /^[a-f0-9-]{36}$/.test(id || "")) { request = { id, status: "pending" }; await poll(); return; }
    const availability = await call("config");
    if (!availability.enabled) { message.textContent = "Assisted connection is currently unavailable. Use your voucher and PIN to connect."; return; }
    form.hidden = !hint;
    message.textContent = hint ? "Enter the account number and active voucher to request access. Your main device supplies the approval code." : "Open the Wi-Fi sign-in page on this device, then choose Connect using your main device. This lets the router identify it.";
  } catch (error) { showError(message, error); }
})();
