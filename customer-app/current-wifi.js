import { escapeHtml as h } from "/shared/safe-html.js";
import { wifiHint } from "./wifi-pairing.js";
import { routerLoginUrl } from "./wifi-completion.js";

const labels = { unknown: "Connection unknown", unavailable: "Wi-Fi unavailable", stale: "Connection needs checking", connecting: "Connecting…", connected: "Connected", disconnecting: "Disconnecting…", disconnected: "Disconnected", failed: "Connection check failed" };

export function mountCurrentWifi({ container, call, onMainDisconnect }) {
  if (!container) return () => {};
  let timer, stopped = false, busy = false, value = { state: "unknown", message: "Checking this device's Wi-Fi connection…" };
  const hint = wifiHint(), login = routerLoginUrl(window.NDAHI_CONFIG.hotspotLoginUrl);
  function render() {
    if (stopped || !container.isConnected) return;
    const focused = container.contains(document.activeElement) && document.activeElement.dataset.currentAction;
    const state = labels[value.state] ? value.state : "unknown", device = value.device;
    const fresh = value.checkedAt && Date.now() - Date.parse(value.checkedAt) <= 120000;
    const canDisconnect = device && fresh && ["connected", "failed"].includes(state);
    const connect = new URL("/hotspot", location.origin);
    if (value.candidate) { connect.searchParams.set("mac", value.candidate.mac); connect.searchParams.set("address", value.candidate.address); }
    container.innerHTML = `<h2>This device's Wi-Fi</h2><p data-current-state="${h(state)}" role="status" tabindex="-1"><strong>${h(labels[state])}</strong> · ${h(value.message || "")}</p>
      ${value.checkedAt ? `<p>Last checked: <time datetime="${h(value.checkedAt)}">${h(new Date(value.checkedAt).toLocaleTimeString())}</time></p>` : ""}
      ${canDisconnect ? `<button type="button" data-current-action="disconnect">${device.main ? "Verify to disconnect this device" : state === "failed" ? "Retry disconnect" : "Disconnect this device"}</button>` : ""}
      ${state === "disconnected" ? `<a class="button" href="${h(connect.pathname + connect.search)}">Connect to Wi-Fi</a>` : ""}
      <button type="button" class="secondary-action" data-current-action="refresh" ${busy ? "disabled" : ""}>Refresh connection status</button>
      ${login && ["unknown", "stale", "failed"].includes(state) ? `<p><a href="${h(login.href)}">Open Wi-Fi sign-in to identify this device</a></p>` : ""}
      <p>Disconnect ends this session and keeps saved approval. Use Forget device below to remove that approval.</p><p data-current-message role="status" aria-live="polite"></p>`;
    if (focused) (container.querySelector(`[data-current-action="${focused}"]`) || container.querySelector("[data-current-state]")).focus();
  }
  async function refresh(identify = false) {
    try {
      const next = await call("/api/account/device-management/current" + (identify ? "/identify" : ""), identify ? { method: "POST", body: JSON.stringify(hint ? { mac: hint.mac, address: hint.address } : {}) } : {});
      if (stopped || !container.isConnected) return;
      value = next; render();
    } catch (error) {
      if (stopped || !container.isConnected) return;
      value = { state: "failed", checkedAt: value.checkedAt, message: error.message || "Could not check the current router connection. Refresh to retry." }; render();
    }
  }
  const tick = async () => {
    if (stopped || !container.isConnected) return;
    if (!document.hidden && !busy) await refresh();
    if (!stopped) timer = setTimeout(tick, 5000);
  };
  container.onclick = async (event) => {
    const button = event.target.closest("[data-current-action]");
    if (!button || busy) return;
    busy = true;
    try {
      if (button.dataset.currentAction === "refresh") await refresh(true);
      else if (value.device) {
        if (value.device.main) await onMainDisconnect(value.device.mac);
        else {
          const target = value.device;
          value = { ...value, state: "disconnecting", message: "Requesting disconnection. Waiting for the router." }; render();
          let failure;
          try {
            await call("/api/account/wifi-devices/disconnect", { method: "POST", body: JSON.stringify({ mac: target.mac, sessionId: target.sessionId, startedAt: target.startedAt, retainApproval: true }) });
          } catch (error) {
            failure = error;
          }
          await refresh();
          if (failure && !stopped && container.isConnected && !["disconnecting", "disconnected"].includes(value.state)) container.querySelector("[data-current-message]").textContent = failure.message || "Disconnection was not confirmed. Refresh before retrying.";
        }
      }
    } finally {
      busy = false;
      if (!stopped && container.isConnected) {
        const refreshButton = container.querySelector('[data-current-action="refresh"]');
        refreshButton.disabled = false;
        if (button.dataset.currentAction === "refresh" && document.activeElement === document.body) refreshButton.focus();
      }
    }
  };
  render();
  void refresh(Boolean(hint)).then(() => { if (!stopped) timer = setTimeout(tick, 5000); });
  return () => { stopped = true; clearTimeout(timer); container.onclick = null; };
}
