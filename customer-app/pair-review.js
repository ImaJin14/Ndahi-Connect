import { escapeHtml as h } from "/shared/safe-html.js";
import { requestJson, markReady } from "./compat.js";
import { responseError, showError } from "./errors.js";
import { matchingRequestContent, mountMatchActions } from "./pairing-review.js";
const host = document.getElementById("pairingReview"), message = document.getElementById("pairingReviewMessage"), api = window.NDAHI_CONFIG.apiUrl,
  id = new URLSearchParams(location.search).get("request");
let csrf, timer, version, generation = 0, busy = false;
const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || "");
async function call(path, options = {}) {
  const result = await requestJson(api + path, { credentials: "include", cache: "no-store", ...options, headers: { "content-type": "application/json", "x-csrf-token": csrf || "" } });
  if (!result.response.ok) throw responseError(result.response, result.body);
  return result.body;
}
async function refresh() {
  clearTimeout(timer); if (!validId) return; if (busy) { timer = setTimeout(refresh, 5000); return; }
  const ticket = generation;
  try {
    const result = await call("/api/account/device-management/pairing?request=" + encodeURIComponent(id));
    if (ticket !== generation) return;
    const request = result.requests[0];
    // serverTime changes on every poll; it is not a reason to replace a focused
    // approval button. Only visible/authority state belongs in this signature.
    const stable = JSON.stringify([request.status, request.comparisonCode, request.referenceUnavailable, request.name, request.macSuffix, request.expiresAt, request.message, result.isMainController, result.enabled]);
    if (version !== stable) {
      const focused = host.contains(document.activeElement); version = stable;
      host.innerHTML = `<h2>${h(request.name || "Unnamed device")} · ending ${h(request.macSuffix)}</h2>`;
      if (request.status === "awaiting_confirmation") {
        host.innerHTML += matchingRequestContent(request);
        if (!result.isMainController) host.innerHTML += '<p>Use the browser or installed app registered as your main device to approve. Opening this link does not transfer main-device control.</p>';
        else if (!result.enabled || request.referenceUnavailable) host.innerHTML += '<p>Approval is unavailable. Ask the requesting device to try again or contact support.</p>';
        else {
          host.innerHTML += '<form><div class="pair-actions"><button type="submit">Codes match — allow device</button><button type="button" data-pairing-decline class="secondary-action">Decline</button></div><p data-pairing-error role="alert"></p></form>';
          const form = host.querySelector("form");
          mountMatchActions({ form, request, call: async (...args) => { busy = true; try { return await call(...args); } finally { busy = false; } }, onChanged: async reply => {
            message.textContent = reply.request.status === "connecting" ? "Approved. Waiting for router confirmation." : "Request declined.";
            await refresh(); host.querySelector("h2").tabIndex = -1; host.querySelector("h2").focus();
          } });
        }
      } else host.innerHTML += `<p role="status">${h(request.status === "connecting" ? "Connecting — waiting for the router to confirm." : request.status === "connected" ? "The router confirmed this connection. Open Manage devices for its current status." : ["pending", "awaiting_code"].includes(request.status) ? "This is an earlier code-entry request. Finish it in Manage devices." : request.message || "Request " + request.status + ".")}</p>`;
      if (focused && !host.contains(document.activeElement)) { host.querySelector("h2").tabIndex = -1; host.querySelector("h2").focus(); }
    }
    message.textContent = "";
    if (["awaiting_confirmation", "connecting"].includes(request.status)) timer = setTimeout(() => { if (!document.hidden) void refresh(); else timer = setTimeout(refresh, 5000); }, 5000);
  } catch (error) { if (ticket === generation) { if ([401,403,404].includes(error.status)) { host.textContent = ""; version = undefined; } else timer = setTimeout(refresh, 5000); showError(message, error); } }
}
document.getElementById("pairingReviewRefresh").onclick = () => { void refresh(); };
markReady();
void (async () => {
  if (!validId) { message.textContent = "This device request link is invalid. Open the request from Notifications."; return; }
  try { const account = await call("/api/account/dashboard"); csrf = account.csrfToken; await refresh(); }
  catch (error) {
    if (error.status === 401) { message.textContent = "Sign in on your main device to review this request."; const link = document.createElement("a"); link.href = "/login?account=1&next=" + encodeURIComponent("/pair-review.html?request=" + id); link.textContent = "Sign in on main device"; message.append(" ", link); }
    else showError(message, error);
  }
})();
document.addEventListener("visibilitychange", () => { if (!document.hidden && csrf) void refresh(); });
window.addEventListener("pagehide", () => { generation++; clearTimeout(timer); host.textContent = ""; version = undefined; });
window.addEventListener("pageshow", event => { if (event.persisted && csrf) { generation++; void refresh(); } });
