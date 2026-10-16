import { ApiError, responseError, saveReturnPath, showError } from "./errors.js";
import { runButton } from "/shared/pending.js";
import { allSlotsInUse, wifiDeviceList } from "./wifi-devices.js";

const config = window.NDAHI_CONFIG, form = document.getElementById("hotspotLogin"),
  button = document.getElementById("connect"), message = document.getElementById("message"),
  params = new URLSearchParams(location.search);
let destination = new URL("/dashboard", location.origin);
try {
  const next = new URL(params.get("next") || "/dashboard", location.origin);
  if (next.origin === location.origin && !/^\/(?:hotspot|login)(?:[/.]|$)/.test(next.pathname)) destination = next;
} catch { /* Keep the fixed account destination for invalid return paths. */ }

async function connect() {
  try {
    await runButton(button, "Connecting…", async () => {
      const login = new URL(config.hotspotLoginUrl);
      if (login.protocol !== "https:" || login.pathname !== "/login" || login.username || login.password || login.search || login.hash) {
        throw new ApiError(503, "Wi-Fi activation is temporarily unavailable.");
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        message.textContent = "Preparing your Wi-Fi access…";
        const response = await fetch(config.apiUrl + "/api/account/hotspot-credentials", {
          credentials: "include", cache: "no-store", signal: AbortSignal.timeout(15000),
        }), result = await response.json();
        if (response.status === 401) {
          saveReturnPath(destination.pathname + destination.search + destination.hash);
          location.replace("/login");
          return;
        }
        if (response.status === 202 && result.code === "HOTSPOT_PENDING") {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        if (!response.ok) throw responseError(response, result);
        if (!/^NC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(result.username) || result.password !== result.username) {
          throw new ApiError(503, "Wi-Fi activation is temporarily unavailable.");
        }
        form.action = login.href;
        form.elements.username.value = result.username;
        form.elements.password.value = result.password;
        form.elements.dst.value = destination.href;
        message.textContent = "Activating internet access…";
        HTMLFormElement.prototype.submit.call(form);
        return;
      }
      throw new ApiError(409, "Your Wi-Fi access is still being prepared. Wait a moment, then try again.");
    });
  } catch (error) {
    showError(message, error, ["QUOTA_EXHAUSTED", "BUNDLE_EXPIRED"].includes(error.code)
      ? { actions: [{ label: "Renew or switch plan", run: () => location.assign("/dashboard#managePlan") }] } : {});
  }
}

// The router refuses a login when every device slot is taken. Show the
// connected devices so the customer can free one and try again.
let csrfToken = "";
const devices = document.getElementById("wifiDevices");
function showDevices(list) {
  devices.innerHTML = wifiDeviceList(list);
  devices.hidden = false;
}
async function explainRouterError() {
  try {
    const response = await fetch(config.apiUrl + "/api/account/wifi-devices", { credentials: "include", cache: "no-store" }),
      list = await response.json();
    if (!response.ok || !allSlotsInUse(list)) return;
    csrfToken = list.csrfToken || "";
    message.textContent = `All ${list.deviceLimit} device slots on your bundle are in use. Disconnect a device below, then tap Connect to Wi-Fi.`;
    showDevices(list);
  } catch { /* Keep the general router message. */ }
}
devices.onclick = async (event) => {
  const target = event.target.closest("button[data-wifi-device]");
  if (!target) return;
  try {
    await runButton(target, "Disconnecting…", async () => {
      const response = await fetch(config.apiUrl + "/api/account/wifi-devices/disconnect", {
          method: "POST", credentials: "include",
          headers: { "content-type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
          body: JSON.stringify({ mac: target.dataset.wifiDevice }),
        }), result = await response.json();
      if (!response.ok) throw responseError(response, result);
      showDevices(result);
      message.textContent = "Device disconnected. Wait a few seconds, then tap Connect to Wi-Fi.";
    });
  } catch (error) { showError(message, error); }
};

button.onclick = connect;
window.addEventListener("pageshow", () => {
  form.elements.username.value = "";
  form.elements.password.value = "";
});
if (!config.hotspotLoginUrl) {
  location.replace(destination.href);
} else if (params.has("router-error")) {
  message.textContent = "Wi-Fi login was not accepted. Stay on NDAHI Wi-Fi and try again. If this continues, contact support.";
  void explainRouterError();
} else void connect();
