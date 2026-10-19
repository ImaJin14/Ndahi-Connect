import { escapeHtml as h } from "/shared/safe-html.js";
import { requestJson, sessionStore } from "./compat.js";
import { responseError, showError } from "./errors.js";
import { runButton } from "/shared/pending.js";

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
      container.querySelector("[data-pairing-help]").textContent = !result.enabled ? "Assisted connection is currently unavailable. Other devices can sign in with their voucher and PIN." : controller
        ? "On the new device, join NDAHI Wi-Fi and choose Connect using your main device. Match its name and six-digit code before approving."
        : "Use your main device's controlling browser to approve requests. Wi-Fi access does not give a device access to account settings.";
      if (role !== controller) { list.innerHTML = ""; role = controller; }
      const requests = result.requests || [];
      Array.from(list.children).forEach((row) => { if (!requests.some((p) => p.id === row.dataset.request)) row.remove(); });
      if (requests.length && !list.children.length) list.textContent = "";
      for (const request of requests) {
        let row = Array.from(list.children).find((item) => item.dataset.request === request.id);
        if (!row) { row = document.createElement("article"); row.className = "surface"; row.dataset.request = request.id; list.appendChild(row); }
        if (row.dataset.status === request.status) continue;
        row.dataset.status = request.status;
        row.innerHTML = `<h4>${h(request.name || "Unnamed device")} · ending ${h(request.macSuffix)}</h4><p data-request-status role="status">${h(request.status === "pending" ? "Awaiting approval" : request.status === "connecting" ? "Connecting — waiting for the router" : request.status === "connected" ? "Connected — confirmed by the router" : request.status.charAt(0).toUpperCase() + request.status.slice(1))}</p>
          ${request.message && request.status !== "connected" ? `<p>${h(request.message)}</p>` : ""}${["pending", "connecting"].includes(request.status) ? `<p>Code expires ${h(new Date(request.expiresAt).toLocaleTimeString())}.</p>` : ""}
          ${controller && request.status === "pending" ? '<form data-pairing-approval><label>Code shown on the new device<input name="pairingCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required></label><button type="submit">Approve connection</button><button type="button" data-pairing-decline class="secondary-action">Decline</button><p data-pairing-error role="alert"></p></form>' : ""}`;
        const form = row.querySelector("form");
        if (form) {
          const act = async (decline) => {
            const error = form.querySelector("[data-pairing-error]");
            error.textContent = "";
            try {
              await runButton(form.querySelector(decline ? "[data-pairing-decline]" : '[type="submit"]'), decline ? "Declining…" : "Approving…", async () => {
                await call("/api/account/device-management/pairing/" + (decline ? "decline" : "approve"), { method: "POST", body: JSON.stringify({ id: request.id, code: form.elements.pairingCode.value.replace(/\s/g, "") }) });
                await refresh();
                if (onChanged) await onChanged();
              }, { controls: Array.from(form.elements) });
            } catch (failure) { showError(error, failure); }
          };
          form.onsubmit = (event) => { event.preventDefault(); void act(false); };
          form.querySelector("[data-pairing-decline]").onclick = () => { void act(true); };
        }
      }
      if (!requests.length) list.textContent = "No connection requests yet.";
    } catch (error) { showError(output, error); }
    if (container.isConnected) timer = setTimeout(() => { if (!document.hidden) void refresh(); else timer = setTimeout(refresh, 5000); }, 5000);
  }
  container.querySelector("[data-pairing-refresh]").onclick = async () => {
    try { await call("/api/account/wifi-devices"); await refresh(); } catch (error) { showError(output, error); }
  };
  await refresh();
}
