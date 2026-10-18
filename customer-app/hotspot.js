import { ApiError, responseError, saveReturnPath, showError } from "./errors.js";
import { runButton } from "/shared/pending.js";
import { allSlotsInUse, wifiDeviceList } from "./wifi-devices.js";
import { requestJson, markReady } from "./compat.js";

const config = window.NDAHI_CONFIG, form = document.getElementById("hotspotLogin"),
  button = document.getElementById("connect"), message = document.getElementById("message"),
  devices = document.getElementById("wifiDevices"), params = new URLSearchParams(location.search);
let destination = new URL("/dashboard", location.origin), csrfToken = "", submitted = false, devicePoll;
try {
  const next = new URL(params.get("next") || "/dashboard", location.origin);
  if (next.origin === location.origin && !/^\/(?:hotspot|login)(?:[/.]|$)/.test(next.pathname)) destination = next;
} catch (_) { /* Keep the fixed account destination. */ }

async function connect() {
  if (submitted) return;
  try {
    await runButton(button, "Connecting…", async () => {
      const deadline = Date.now() + 120000;
      const accessResult = await requestJson(config.apiUrl + "/api/purchase/access", { cache: "no-store" });
      if (!accessResult.response.ok) throw responseError(accessResult.response, accessResult.body);
      if (accessResult.body.allowed === false) { location.replace(destination.href); return; }
      const login = new URL(config.hotspotLoginUrl);
      if (login.protocol !== "https:" || login.pathname !== "/login" || login.username || login.password || login.search || login.hash) {
        throw new ApiError(503, "Wi-Fi activation is temporarily unavailable.");
      }
      while (Date.now() < deadline) {
        message.textContent = "Preparing your Wi-Fi access… Stay on NDAHI Wi-Fi.";
        let result;
        try {
          result = await requestJson(config.apiUrl + "/api/account/hotspot-credentials", {
            credentials: "include", cache: "no-store",
          }, Math.max(1, Math.min(15000, deadline - Date.now())));
        } catch (error) {
          if (error.name !== "TimeoutError" && error.name !== "TypeError") throw error;
          message.textContent = "The connection is slow. Checking your existing access again…";
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        if (result.response.status === 401) {
          saveReturnPath(destination.pathname + destination.search + destination.hash);
          location.replace("/login"); return;
        }
        if (result.response.status === 202 && result.body.code === "HOTSPOT_PENDING") {
          await new Promise((resolve) => setTimeout(resolve, 2000)); continue;
        }
        if (!result.response.ok) throw responseError(result.response, result.body);
        if (!/^NC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(result.body.username) || result.body.password !== result.body.username) {
          throw new ApiError(503, "Wi-Fi activation is temporarily unavailable.");
        }
        if (Date.now() >= deadline || submitted) break;
        form.action = login.href;
        form.elements.username.value = result.body.username;
        form.elements.password.value = result.body.password;
        form.elements.dst.value = destination.href;
        submitted = true;
        message.textContent = "Activating internet access…";
        HTMLFormElement.prototype.submit.call(form);
        return;
      }
      throw new ApiError(408, "Your Wi-Fi access is still being prepared. Stay on NDAHI Wi-Fi and try again.");
    });
  } catch (error) {
    const actions = [{ label: "Try connecting again", run: connect }];
    if (["QUOTA_EXHAUSTED", "BUNDLE_EXPIRED"].includes(error.code)) actions.unshift({ label: "Renew or switch plan", run: () => location.assign("/dashboard#managePlan") });
    showError(message, error, { actions });
  }
}

async function refreshDevices(explain = false) {
  const result = await requestJson(config.apiUrl + "/api/account/wifi-devices", { credentials: "include", cache: "no-store" });
  if (!result.response.ok) throw responseError(result.response, result.body);
  csrfToken = result.body.csrfToken || "";
  if (explain && !allSlotsInUse(result.body)) return;
  devices.innerHTML = wifiDeviceList(result.body);
  devices.hidden = false;
  if (explain) message.textContent = `All ${result.body.deviceLimit} device slots on your bundle are in use. Disconnect a device below, then tap Connect to Wi-Fi after confirmation.`;
  clearTimeout(devicePoll);
  devicePoll = setTimeout(async () => {
    if (!document.hidden) {
      try { await refreshDevices(); } catch (_) { scheduleRefresh(); }
    } else scheduleRefresh();
  }, 5000);
}
function scheduleRefresh() {
  clearTimeout(devicePoll);
  devicePoll = setTimeout(() => { if (!document.hidden && !devices.hidden) refreshDevices().catch(scheduleRefresh); else scheduleRefresh(); }, 5000);
}
devices.onclick = async (event) => {
  if (event.target.closest("[data-refresh-wifi]")) {
    try { await refreshDevices(); } catch (error) { showError(message, error); }
    return;
  }
  const target = event.target.closest("button[data-wifi-device]");
  if (!target) return;
  try {
    await runButton(target, "Requesting…", async () => {
      const result = await requestJson(config.apiUrl + "/api/account/wifi-devices/disconnect", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ mac: target.dataset.wifiDevice, sessionId: target.dataset.wifiSession }),
      });
      if (!result.response.ok) throw responseError(result.response, result.body);
      devices.innerHTML = wifiDeviceList(result.body);
      message.textContent = "Disconnection requested. Wait for confirmation before connecting another device.";
      scheduleRefresh();
    });
  } catch (error) { showError(message, error); }
};
button.onclick = connect;
window.addEventListener("pageshow", () => {
  form.elements.username.value = ""; form.elements.password.value = ""; submitted = false;
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && !devices.hidden) refreshDevices().catch(scheduleRefresh); });
markReady();
if (!config.hotspotLoginUrl) location.replace(destination.href);
else if (params.has("router-error")) {
  message.textContent = "Wi-Fi login was not accepted. Stay on NDAHI Wi-Fi and try again. If this continues, contact support.";
  refreshDevices(true).catch(() => {});
} else void connect();
