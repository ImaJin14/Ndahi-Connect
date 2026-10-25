import { escapeHtml as h } from "/shared/safe-html.js";
import { requestJson, sessionStore, randomId } from "./compat.js";
import { responseError, showError } from "./errors.js";
import { runButton } from "/shared/pending.js";
import { matchingRequestContent, mountMatchActions } from "./pairing-review.js";

// Retry a finished operation with a fresh key; the server rechecks the saved
// grant and current router target. In-flight retries retain their original key.
export async function startWifiRequest(send, input, onKeyChanged = () => {}) {
  try { return await send(input); }
  catch (error) {
    if (error.code !== "PAIRING_RESTART_REQUIRED") throw error;
    input.key = randomId(); onKeyChanged(input.key);
    return send(input);
  }
}

export function wifiHint() {
  const query = new URLSearchParams(location.search), mac = String(query.get("mac") || "").toUpperCase(), address = query.get("address") || "";
  const valid = (value) => value && /^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/.test(value.mac) &&
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value.address) && value.address.split(".").every((n) => Number(n) <= 255);
  const current = { mac, address, at: Date.now() };
  if (valid(current)) sessionStore.set("ndahi_wifi_hint", JSON.stringify(current));
  try {
    const stored = valid(current) ? current : JSON.parse(sessionStore.get("ndahi_wifi_hint") || "null");
    return valid(stored) && Date.now() - stored.at < 900000 ? stored : null;
  } catch (_) { return null; }
}

export async function configurePairingLink(link) {
  if (!link) return;
  const hint = wifiHint();
  if (hint) document.querySelectorAll('a[href="/login"],a[href="/hotspot"]').forEach((a) => {
    const url = new URL(a.href); url.searchParams.set("mac", hint.mac); url.searchParams.set("address", hint.address); a.href = url.href;
  });
  if (hint) link.href = "/pair?mac=" + encodeURIComponent(hint.mac) + "&address=" + encodeURIComponent(hint.address);
  try {
    const result = await requestJson(window.NDAHI_CONFIG.apiUrl + "/api/wifi/pairing/config", { cache: "no-store", credentials: "omit" });
    link.hidden = !result.response.ok || !result.body.enabled;
  } catch (_) { link.hidden = true; }
}

export async function mountPairingControls({ container, call, onChanged }) {
  if (!container) return;
  container.innerHTML = '<h3>Connection requests</h3><p data-pairing-help></p><button type="button" data-pairing-refresh class="secondary-action">Refresh requests</button><div data-pairing-requests></div><p data-pairing-output role="status" aria-live="polite"></p>';
  const list = container.querySelector("[data-pairing-requests]"), output = container.querySelector("[data-pairing-output]");
  let timer, role;
  async function refresh() {
    clearTimeout(timer);
    if (!container.isConnected) return;
    try {
      const result = await call("/api/account/device-management/pairing");
      if (!container.isConnected) return;
      output.textContent = "";
      const controller = result.enabled && result.isMainController;
      container.querySelector("[data-pairing-help]").textContent = !result.enabled ? "New device approvals are currently paused. Existing approved devices can reconnect while their bundle remains valid." : controller
        ? "Review the requesting device and compare its code. Choose Codes match — allow device. Earlier code-entry requests can still be completed."
        : "Set a main device and use its controlling browser to approve requests. Wi-Fi access does not give a device access to account settings.";
      if (role !== controller) {
        list.innerHTML = ""; role = controller;
        const manual = container.querySelector("[data-manual-device]"); if (manual) manual.remove();
        if (controller) {
          const details = document.createElement("details"); details.dataset.manualDevice = "true";
          details.innerHTML = '<summary>Add a device without a browser</summary><p>For a TV, console or other device: join NDAHI Wi-Fi, then enter its Wi-Fi MAC and IP address from its network settings.</p><form data-manual-form><label>Wi-Fi MAC address<input name="mac" placeholder="AA:BB:CC:DD:EE:FF" required></label><label>Device IP address<input name="address" inputmode="decimal" placeholder="10.20.0.10" required></label><label><input name="confirm" type="checkbox" required> I checked these details on the device I want to connect.</label><button type="submit">Approve this device</button><p data-manual-message role="status"></p></form>';
          container.appendChild(details);
          const form = details.querySelector("form"); let key;
          form.onsubmit = async (event) => {
            event.preventDefault(); const input = { mac: form.elements.mac.value.toUpperCase().trim(), address: form.elements.address.value.trim(), confirm: form.elements.confirm.checked, key: key || (key = randomId()) };
            try { await runButton(form.querySelector("button"), "Connecting…", async () => {
              await startWifiRequest((payload) => call("/api/account/device-management/pairing/manual", { method: "POST", body: JSON.stringify(payload) }), input, (next) => { key = next; });
              form.reset(); key = null; details.querySelector("[data-manual-message]").textContent = "Connection requested. Waiting for router confirmation.";
              await refresh(); if (onChanged) await onChanged();
            }, { controls: Array.from(form.elements) }); } catch (error) { showError(details.querySelector("[data-manual-message]"), error); }
          };
        }
      }
      const requests = (result.requests || []).filter((p) => ["pending", "awaiting_code", "awaiting_confirmation", "connecting"].includes(p.status));
      Array.from(list.children).forEach((row) => { if (!requests.some((p) => p.id === row.dataset.request)) row.remove(); });
      if (requests.length && !list.children.length) list.textContent = "";
      for (const request of requests) {
        let row = Array.from(list.children).find((item) => item.dataset.request === request.id);
        if (!row) { row = document.createElement("article"); row.className = "surface"; row.dataset.request = request.id; list.appendChild(row); }
        const renderVersion = JSON.stringify([request.status, request.approvalCode, request.comparisonCode, request.referenceUnavailable, request.expiresAt, request.message]);
        if (row.dataset.version === renderVersion) continue;
        row.dataset.version = renderVersion; row.dataset.status = request.status;
        row.innerHTML = `<h4>${h(request.name || "Unnamed device")} · ending ${h(request.macSuffix)}</h4><p data-request-status role="status">${h(request.status === "awaiting_confirmation" ? "Waiting for your confirmation" : request.status === "pending" ? "Awaiting approval" : request.status === "awaiting_code" ? "Approved — waiting for the device to enter your code" : request.status === "connecting" ? "Connecting — waiting for the router" : request.status === "connected" ? "Connected — confirmed by the router" : request.status.charAt(0).toUpperCase() + request.status.slice(1))}</p>
          ${request.message && request.status !== "connected" ? `<p>${h(request.message)}</p>` : ""}${["pending", "awaiting_code", "awaiting_confirmation", "connecting"].includes(request.status) ? `<p>Code expires ${h(new Date(request.expiresAt).toLocaleTimeString())}.</p>` : ""}
          ${controller && request.status === "awaiting_confirmation" ? matchingRequestContent(request) + (request.referenceUnavailable ? "<p>Request access again to obtain a new matching reference.</p>" : '<form data-pairing-approval data-matching-request><button type="submit">Codes match — allow device</button><button type="button" data-pairing-decline class="secondary-action">Decline</button><p data-pairing-error role="alert"></p></form>') : ""}
          ${controller && request.status === "awaiting_code" && request.approvalCode ? `<div data-sensitive-output><p>Enter this code on the requesting device:</p><output class="pairing-code" aria-label="Approval code">${h(request.approvalCode)}</output><p>This code works once for this device. Keep it private.</p></div>` : ""}
          ${controller && ["pending", "awaiting_code"].includes(request.status) ? `<form data-pairing-approval>${request.status === "pending" ? '<button type="submit">Approve &amp; show code</button>' : ""}<button type="button" data-pairing-decline class="secondary-action">${request.status === "pending" ? "Decline" : "Cancel approval"}</button><p data-pairing-error role="alert"></p></form>` : ""}`;
        const form = row.querySelector("form");
        if (form && form.hasAttribute("data-matching-request")) {
          mountMatchActions({ form, request, call, onChanged: async reply => {
            output.textContent = reply.request.status === "connecting" ? "Approved. Waiting for router confirmation." : "Request declined.";
            await refresh(); output.tabIndex = -1; output.focus(); if (onChanged) await onChanged();
          } });
        } else if (form) {
          const act = async (decline) => {
            const error = form.querySelector("[data-pairing-error]");
            error.textContent = "";
            try {
              await runButton(form.querySelector(decline ? "[data-pairing-decline]" : '[type="submit"]'), decline ? "Cancelling…" : "Approving…", async () => {
                await call("/api/account/device-management/pairing/" + (decline ? "decline" : "approve"), { method: "POST", body: JSON.stringify({ id: request.id }) });
                await refresh();
                if (onChanged) await onChanged();
              }, { controls: Array.from(form.elements) });
            } catch (failure) { showError(error, failure); }
          };
          form.onsubmit = (event) => { event.preventDefault(); void act(false); };
          form.querySelector("[data-pairing-decline]").onclick = () => { void act(true); };
        }
      }
      if (!requests.length) list.textContent = "No pending connection requests. Past activity is in Notifications → Devices/access.";
    } catch (error) { showError(output, error); }
    if (container.isConnected) timer = setTimeout(() => { if (!document.hidden) void refresh(); else timer = setTimeout(refresh, 5000); }, 5000);
  }
  container.querySelector("[data-pairing-refresh]").onclick = async () => {
    try { await call("/api/account/wifi-devices"); await refresh(); } catch (error) { showError(output, error); }
  };
  await refresh();
}
