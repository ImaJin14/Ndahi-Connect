import { routerLoginUrl } from "./wifi-completion.js";
import { customerDestination } from "./customer-destination.js";
import { fetchConnectivity } from "./connectivity.js";
import { deviceKind } from "/shared/device-kind.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

// This public fallback is not an account session or evidence of a live connection.
// Do not auto-navigate back to /login: a saved tab must never become a loop.
const login = routerLoginUrl(window.NDAHI_CONFIG.hotspotLoginUrl);
if (login) {
  const link = document.getElementById("wifiSignIn");
  link.href = login.href; link.hidden = false;
}

// After Finish Wi-Fi sign-in (#372, canvas: PhoneWifiConnected) the router
// returns here with `next`. "You're online" shows only once the network
// confirms this device is signed in; until then (or a saved tab later) the
// fallback above stays. An unsafe `next` gets only the fallback, with no
// account request at all.
const next = customerDestination(new URLSearchParams(location.search).get("next"), null);
if (next) void (async () => {
  const lang = currentLanguage(), L = (key) => format(key, {}, lang);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const evidence = await fetchConnectivity(window.NDAHI_CONFIG.apiUrl);
      if (evidence?.network?.state === "confirmed" && evidence?.hotspot?.state === "authenticated") {
        document.documentElement.lang = lang;
        document.getElementById("onlineTitle").textContent = L("onlineTitle");
        document.getElementById("onlineText").textContent = L(["android_phone", "iphone"].includes(deviceKind(navigator.userAgent)) ? "onlinePhone" : "onlineDevice");
        document.getElementById("onlineTip").textContent = L("onlineTip");
        const home = document.getElementById("onlineHome");
        home.textContent = L("onlineHome"); home.href = next;
        document.getElementById("wifiFallback").hidden = true;
        document.getElementById("wifiOnline").hidden = false;
        document.body.setAttribute("data-wifi-online", "");
        return;
      }
    } catch (_) { /* Keep the fallback; try again shortly. */ }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
})();
