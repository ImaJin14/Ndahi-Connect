import { escapeHtml as h } from "/shared/safe-html.js";
import { wifiHint } from "./wifi-pairing.js";
import { automaticPoll } from "./automatic-poll.js";
import { routerLoginUrl } from "./wifi-completion.js";

const labels = { unknown: "Connection unknown", unavailable: "Wi-Fi unavailable", stale: "Connection needs checking", connecting: "Connecting…", connected: "Connected", disconnecting: "Disconnecting…", disconnected: "Disconnected", failed: "Connection check failed" };

export function mountCurrentWifi({ container, call, onMainDisconnect }) {
  if (!container) return () => {};
  let inFlight, stopped = false, busy = false, failures = 0, lastIdentifyAt = -Infinity, value = { state: "unknown", message: "Checking this device's Wi-Fi connection…" };
  const hint = wifiHint(), login = routerLoginUrl(window.NDAHI_CONFIG.hotspotLoginUrl);
  function render() {
    if (stopped || !container.isConnected) return;
    const focused = container.contains(document.activeElement) && document.activeElement.dataset.currentAction;
    const state = labels[value.state] ? value.state : "unknown", device = value.device;
    const tone = state === "connected" ? "connected" : state === "disconnected" ? "disconnected" : ["connecting", "disconnecting"].includes(state) ? "pending" : "unknown";
    const fresh = value.checkedAt && Date.now() - Date.parse(value.checkedAt) <= 120000;
    const canDisconnect = device && fresh && ["connected", "failed"].includes(state);
    const connect = new URL("/hotspot", location.origin);
    if (value.candidate) { connect.searchParams.set("mac", value.candidate.mac); connect.searchParams.set("address", value.candidate.address); }
    container.innerHTML = `<h2>This device's Wi-Fi</h2><p data-current-state="${h(state)}" class="current-wifi-status current-wifi-${tone}" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"><span class="current-wifi-indicator" aria-hidden="true"></span><strong>${h(labels[state])}</strong> · ${h(value.message || "")}</p>
      ${value.checkedAt ? `<p>Last checked: <time datetime="${h(value.checkedAt)}">${h(new Date(value.checkedAt).toLocaleTimeString())}</time></p>` : ""}
      ${value.lastObservedAt ? `<p>Last successful check: ${h(new Date(value.lastObservedAt).toLocaleTimeString())}. Checking automatically.</p>` : ""}
      ${!value.checkedAt && value.lastConfirmedAt ? `<p>Last confirmed connected: ${h(new Date(value.lastConfirmedAt).toLocaleTimeString())}</p>` : ""}
      ${canDisconnect ? `<button type="button" data-current-action="disconnect" ${busy ? "disabled" : ""}>${device.main ? "Verify to disconnect this device" : state === "failed" ? "Retry disconnect" : "Disconnect this device"}</button>` : ""}
      ${state === "disconnected" ? `<a class="button" href="${h(connect.pathname + connect.search)}">Connect to Wi-Fi</a>` : ""}
      ${login && ["unknown", "stale", "failed"].includes(state) ? `<p><a href="${h(login.href)}">Open Wi-Fi sign-in to identify this device</a></p>` : ""}
      ${value.candidate && ["unknown", "stale", "failed", "disconnected"].includes(state) ? `<button type="button" class="secondary-action" data-current-action="reidentify" ${busy ? "disabled" : ""}>Identify this device again</button>` : ""}
      ${value.identificationOptions?.length ? `<form data-current-identify><p>Identify this installed app once. Match this device's Wi-Fi MAC address in its Wi-Fi settings before choosing it.</p><label>This device <select name="device" required><option value="">Choose the matching device</option>${value.identificationOptions.map((d, i) => `<option value="${i}">${h(d.name || "Unnamed device")} · ${h(d.mac)}</option>`).join("")}</select></label><label><input type="checkbox" name="confirmed" required> I matched the Wi-Fi MAC address on this device.</label><button type="button" data-current-action="identify" ${busy ? "disabled" : ""}>Identify this device</button></form>` : ""}
      <p>Disconnect ends this session and keeps saved approval. Use Forget device below to remove that approval.</p><p data-current-message role="status" aria-live="polite"></p>`;
    if (focused) (container.querySelector(`[data-current-action="${focused}"]`) || container.querySelector("[data-current-state]")).focus();
  }
  function refresh(identify = false, selected, context = { current: () => !stopped && container.isConnected && !document.hidden && navigator.onLine !== false }) {
    if (inFlight) return inFlight;
    const identifyDevice = (candidate = {}) => {
      lastIdentifyAt = Date.now();
      return call("/api/account/device-management/current/identify", { method: "POST", body: JSON.stringify(candidate), signal: context.signal });
    };
    inFlight = (async () => {
      try {
        let next = await (identify ? identifyDevice(selected || (hint ? { mac: hint.mac, address: hint.address } : {})) : call("/api/account/device-management/current", { signal: context.signal, cache: "no-store" }));
        // Only the server's own session may supply a saved candidate. Renewal
        // needs a fresh router read; failures retry at most once per 30 seconds.
        if (!identify && next.identificationRequired && Date.now() - lastIdentifyAt >= 30000 && context.current()) next = await identifyDevice();
        if (!context.current()) return;
        const evidence = next.connectivity;
        if (["connected", "disconnected", "connecting", "disconnecting"].includes(next.state) && (!evidence || evidence.version !== 1 || evidence.network.state !== "confirmed" || !Number.isFinite(Date.parse(evidence.expiresAt)) || Date.parse(evidence.expiresAt) <= Date.now())) {
          next = { ...next, device: undefined, state: "unknown", message: "This device's NDAHI request path is not confirmed. Checking automatically." };
        }
        failures = 0; value = next; render();
      } catch (error) {
        if (!context.current()) return;
        failures++;
        value = { ...value, device: undefined, state: "failed", lastObservedAt: value.checkedAt || value.lastObservedAt,
          lastConfirmedAt: value.state === "connected" ? value.checkedAt : value.lastConfirmedAt, checkedAt: null,
          message: "Connection is not confirmed. " + (error.message || "The router check failed.") + " Retrying automatically." }; render();
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  const relevant = () => !stopped && container.isConnected && !container.closest("[hidden]") && !document.hidden && navigator.onLine !== false && !busy && !container.querySelector("[data-current-identify]")?.contains(document.activeElement);
  let initialHint = Boolean(hint);
  const poll = automaticPoll({
    active: relevant,
    run: context => { const identify = initialHint; initialHint = false; return refresh(identify, undefined, context); },
    delay: () => failures ? Math.min(60000, 10000 * 2 ** (failures - 1)) : ["connecting", "disconnecting"].includes(value.state) ? 2000 : 10000,
    onPause: () => {
      if (stopped || !container.isConnected || busy || container.querySelector("[data-current-identify]")?.contains(document.activeElement)) return;
      value = { ...value, device: undefined, state: "unknown", lastObservedAt: value.checkedAt || value.lastObservedAt, checkedAt: null,
        message: navigator.onLine === false ? "This browser is offline. Checks resume automatically when it reconnects." : "Connection checks are paused. Rechecking when this view resumes." };
      render();
    },
  });
  const tick = () => { if (!container.isConnected) stop(); else poll.wake(); };
  const stop = () => {
    stopped = true; poll.stop(); container.onclick = null;
    document.removeEventListener("visibilitychange", tick); container.removeEventListener("focusout", focusedOut);
    for (const event of ["pageshow", "pagehide", "online", "offline", "hashchange"]) window.removeEventListener(event, tick);
  };
  const focusedOut = () => { if (!container.contains(document.activeElement)) tick(); };
  container.onclick = async (event) => {
    const button = event.target.closest("[data-current-action]");
    if (!button || busy) return;
    const action = button.dataset.currentAction;
    const form = container.querySelector("[data-current-identify]");
    if (action === "identify" && !form?.reportValidity()) return;
    const selected = action === "identify" ? { ...value.identificationOptions[Number(form.elements.device.value)], confirmMac: true } : undefined;
    const target = value.device;
    busy = true; poll.pause();
    render();
    try {
      // Let an existing status read finish before starting a user action.
      await inFlight;
      if (stopped || !container.isConnected) return;
      if (action === "reidentify") {
        try { value = await call("/api/account/device-management/current/reset", { method: "POST", body: "{}" }); }
        catch (error) { value = { ...value, state: "failed", device: undefined, message: error.message }; }
        render();
      }
      else if (action === "identify") await refresh(true, selected);
      else if (target) {
        if (target.main) await onMainDisconnect(target.mac);
        else {
          container.querySelector("[data-current-message]").textContent = "Submitting the disconnect request. Router confirmation is still required.";
          let failure;
          try {
            await call("/api/account/wifi-devices/disconnect", { method: "POST", body: JSON.stringify({ mac: target.mac, sessionId: target.sessionId, startedAt: target.startedAt, retainApproval: true }) });
          } catch (error) {
            failure = error;
          }
          await refresh();
          if (failure && !stopped && container.isConnected && !["disconnecting", "disconnected"].includes(value.state)) container.querySelector("[data-current-message]").textContent = failure.message || "Disconnection was not confirmed. Checking automatically before retrying.";
        }
      }
    } finally {
      busy = false;
      if (!stopped && container.isConnected) {
        render(); poll.wake();
      }
    }
  };
  render();
  document.addEventListener("visibilitychange", tick); container.addEventListener("focusout", focusedOut);
  for (const event of ["pageshow", "pagehide", "online", "offline", "hashchange"]) window.addEventListener(event, tick);
  poll.start();
  return stop;
}
