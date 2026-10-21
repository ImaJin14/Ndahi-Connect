import { escapeHtml as h } from "/shared/safe-html.js";
import { wifiHint } from "./wifi-pairing.js";
import { routerLoginUrl } from "./wifi-completion.js";

const labels = { unknown: "Connection unknown", unavailable: "Wi-Fi unavailable", stale: "Connection needs checking", connecting: "Connecting…", connected: "Connected", disconnecting: "Disconnecting…", disconnected: "Disconnected", failed: "Connection check failed" };

export function mountCurrentWifi({ container, call, onMainDisconnect }) {
  if (!container) return () => {};
  let timer, inFlight, stopped = false, busy = false, lastIdentifyAt = -Infinity, value = { state: "unknown", message: "Checking this device's Wi-Fi connection…" };
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
  function refresh(identify = false) {
    if (inFlight) return inFlight;
    const identifyDevice = (candidate = {}) => {
      lastIdentifyAt = Date.now();
      return call("/api/account/device-management/current/identify", { method: "POST", body: JSON.stringify(candidate) });
    };
    inFlight = (async () => {
      try {
        let next = await (identify ? identifyDevice(hint ? { mac: hint.mac, address: hint.address } : {}) : call("/api/account/device-management/current", {}));
        // Only the server's own session may supply a saved candidate. Renewal
        // needs a fresh router read; failures retry at most once per 30 seconds.
        if (!identify && next.identificationRequired && Date.now() - lastIdentifyAt >= 30000 && !stopped && container.isConnected) next = await identifyDevice();
        if (stopped || !container.isConnected) return;
        value = next; render();
      } catch (error) {
        if (stopped || !container.isConnected) return;
        value = { state: "failed", checkedAt: value.checkedAt, message: error.message || "Could not check the current router connection. Refresh to retry." }; render();
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  const stop = () => {
    stopped = true; clearInterval(timer); container.onclick = null;
    document.removeEventListener("visibilitychange", tick);
    window.removeEventListener("pageshow", tick);
  };
  const tick = () => {
    if (stopped) return;
    if (!container.isConnected) return stop();
    if (!document.hidden && !busy) void refresh();
  };
  container.onclick = async (event) => {
    const button = event.target.closest("[data-current-action]");
    if (!button || busy) return;
    const target = value.device;
    busy = true;
    render();
    try {
      // Let an existing status read finish before starting a user action.
      await inFlight;
      if (stopped || !container.isConnected) return;
      if (button.dataset.currentAction === "refresh") await refresh(true);
      else if (target) {
        if (target.main) await onMainDisconnect(target.mac);
        else {
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
  timer = setInterval(tick, 5000);
  document.addEventListener("visibilitychange", tick);
  window.addEventListener("pageshow", tick);
  void refresh(Boolean(hint));
  return stop;
}
