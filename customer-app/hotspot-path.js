import { consumeReturnPath } from "./errors.js";
import { wifiHint } from "./wifi-pairing.js";

// Carry only router-verifiable device candidates across local page changes.
// Captive browsers may deny storage, so the next document needs them in its URL.
export function withWifiHint(path) {
  const hint = wifiHint();
  if (!hint) return path;
  const target = new URL(path, location.origin);
  if (target.origin !== location.origin) return path;
  target.searchParams.set("mac", hint.mac);
  target.searchParams.set("address", hint.address);
  return target.pathname + target.search + target.hash;
}

export function hotspotPath(next = "/dashboard") {
  return window.NDAHI_CONFIG.hotspotLoginUrl ? withWifiHint(`/hotspot?next=${encodeURIComponent(next)}`) : next;
}

export function afterSignInPath(accountOnly = new URLSearchParams(location.search).get("account") === "1") {
  const next = consumeReturnPath();
  return accountOnly ? "/dashboard#account" : hotspotPath(next || "/dashboard");
}
