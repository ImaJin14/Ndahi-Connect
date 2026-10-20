import { ApiError, responseError, saveReturnPath, showError } from "./errors.js";
import { runButton } from "/shared/pending.js";
import { allSlotsInUse, wifiDeviceList } from "./wifi-devices.js";
import { requestJson, markReady, randomId, loadPasskeys } from "./compat.js";
import { mountDeviceControls } from "./device-controls.js";
import { wifiHint } from "./wifi-pairing.js";

const config = window.NDAHI_CONFIG, form = document.getElementById("hotspotLogin"),
  button = document.getElementById("connect"), message = document.getElementById("message"),
  devices = document.getElementById("wifiDevices"), params = new URLSearchParams(location.search);
let destination = new URL("/dashboard", location.origin), csrfToken = "", submitted = false, devicePoll, controlsMounted = false;
try {
  const next = new URL(params.get("next") || "/dashboard", location.origin);
  if (next.origin === location.origin && !/^\/(?:hotspot|login)(?:[/.]|$)/.test(next.pathname)) destination = next;
} catch (_) { /* Keep the fixed account destination. */ }


async function protectedConnect(proof = {}) {
  const hint = wifiHint();
  if (!hint) {
    message.textContent = "Open Wi-Fi sign-in on this device so the network can identify it.";
    const link = document.createElement("a"); link.href = config.hotspotLoginUrl; link.textContent = "Open Wi-Fi sign-in"; message.append(" ", link); return;
  }
  const account = await requestJson(config.apiUrl + "/api/account/dashboard", { credentials: "include", cache: "no-store" });
  if (account.response.status === 401) {
    const login = new URL("/login", location.origin); login.searchParams.set("mac", hint.mac); login.searchParams.set("address", hint.address);
    location.replace(login.href); return;
  }
  if (!account.response.ok) throw responseError(account.response, account.body);
  csrfToken = account.body.csrfToken;
  const fragment = new URLSearchParams(location.hash.slice(1));
  let key = fragment.get("wifi_key");
  if (!/^[a-f0-9]{32,64}$/.test(key || "")) key = randomId();
  try { history.replaceState(null, "", location.pathname + location.search + "#wifi_key=" + key); } catch (_) {}
  const input = { ...hint, key, ...proof }, deadline = Date.now() + 120000;
  const call = async (path, payload, owned = false) => {
    const reply = await requestJson(config.apiUrl + path, { method: "POST", credentials: owned ? "include" : "omit", cache: "no-store",
      headers: { "content-type": "application/json", ...(owned ? { "x-csrf-token": csrfToken } : {}) }, body: JSON.stringify(payload) });
    if (!reply.response.ok) throw responseError(reply.response, reply.body);
    return reply.body;
  };
  let result;
  while (Date.now() < deadline) {
    try {
      result = await call("/api/account/device-management/connect", input, true);
      if (result.code === "HOTSPOT_PENDING") { result = null; message.textContent = "Preparing your Wi-Fi access…"; await new Promise((resolve) => setTimeout(resolve, 2000)); continue; }
      break;
    }
    catch (error) {
      if (error.code === "DEVICE_REFRESH_REQUIRED") { message.textContent = "Refreshing your Wi-Fi connection…"; await new Promise((resolve) => setTimeout(resolve, 2000)); continue; }
      if (error.code !== "DEVICE_APPROVAL_REQUIRED") throw error;
      message.textContent = "This device needs approval from your main device.";
      const link = document.createElement("a"); link.href = "/pair?mac=" + encodeURIComponent(hint.mac) + "&address=" + encodeURIComponent(hint.address); link.textContent = "Request access";
      message.append(" ", link);
      if (!document.querySelector("#recoverWifiOwner")) {
        const recovery = document.createElement("details"); recovery.id = "recoverWifiOwner";
        recovery.innerHTML = '<summary>Lost your main device?</summary><p>Verify account ownership to connect a replacement. This revokes the previous browser’s approval control and its unused codes.</p><form><label>Account PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password"></label><button type="submit">Verify PIN and recover</button><button type="button" data-recover-passkey>Recover with passkey</button><p data-recovery-message role="status"></p></form>';
        message.after(recovery);
        const form = recovery.querySelector("form"), output = recovery.querySelector("[data-recovery-message]");
        const recover = async (usePasskey) => {
          const pin = form.elements.pin.value;
          try { await runButton(form.querySelector(usePasskey ? "[data-recover-passkey]" : '[type="submit"]'), "Verifying…", async () => {
            let payload = { recover: true, pin };
            if (usePasskey) {
              const challenge = await call("/api/account/device-management/connect/options", input, true), browser = await loadPasskeys();
              payload = { recover: true, challengeId: challenge.challengeId, response: await browser.startAuthentication({ optionsJSON: challenge.options }) };
            } else if (!/^\d{4}$/.test(pin)) throw Error("Enter your four-digit account PIN.");
            await protectedConnect(payload); form.reset();
          }, { controls: Array.from(form.elements) }); } catch (error) { showError(output, error); }
        };
        form.onsubmit = (event) => { event.preventDefault(); void recover(false); };
        form.querySelector("[data-recover-passkey]").hidden = !account.body.customer.passkeys || !window.PublicKeyCredential;
        form.querySelector("[data-recover-passkey]").onclick = () => { void recover(true); };
      }
      return;
    }
  }
  if (!result) throw new ApiError(408, "Wi-Fi preparation is taking longer than expected. Try again.");
  let request = result.request;
  while (Date.now() < deadline && request.status === "connecting") {
    message.textContent = "Connecting… Waiting for the router to confirm this device.";
    await new Promise((resolve) => setTimeout(resolve, 2000));
    request = (await call("/api/wifi/pairing/status", { id: request.id, key })).request;
  }
  if (request.status !== "connected") {
    if (!["pending", "awaiting_code", "connecting"].includes(request.status)) { try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {} }
    throw new ApiError(408, request.message || "Connection is not confirmed. Try again to check the existing request.");
  }
  if (request.firstDevice || proof.recover) { destination.searchParams.set("main-device", hint.mac); destination.hash = "home"; }
  location.replace(destination.href);
}

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
      const policy = await requestJson(config.apiUrl + "/api/wifi/pairing/config", { cache: "no-store", credentials: "omit" });
      if (!policy.response.ok) throw responseError(policy.response, policy.body);
      if (policy.body.approvalRequired) { await protectedConnect(); return; }
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
  if (!controlsMounted) {
    controlsMounted = true;
    const container = document.getElementById("deviceManagement");
    container.hidden = false;
    void mountDeviceControls({ container, call: async (path, options = {}) => {
      const reply = await requestJson(config.apiUrl + path, { credentials: "include", ...options,
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken } });
      if (!reply.response.ok) throw responseError(reply.response, reply.body);
      return reply.body;
    }, onChanged: () => refreshDevices() });
  }
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
