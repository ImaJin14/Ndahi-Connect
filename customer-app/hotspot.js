import { ApiError, responseError, saveReturnPath, showError } from "./errors.js";
import { runButton } from "/shared/pending.js";

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
  } catch (error) { showError(message, error); }
}

button.onclick = connect;
window.addEventListener("pageshow", () => {
  form.elements.username.value = "";
  form.elements.password.value = "";
});
if (!config.hotspotLoginUrl) {
  location.replace(destination.href);
} else if (params.has("router-error")) {
  message.textContent = "Wi-Fi login was not accepted. Stay on NDAHI Wi-Fi and try again. If this continues, contact support.";
} else void connect();
