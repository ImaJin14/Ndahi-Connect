import { consumeReturnPath } from "./errors.js";
import { wifiHint } from "./wifi-pairing.js";

export function hotspotPath(next = "/dashboard") {
  const hint = wifiHint();
  return window.NDAHI_CONFIG.hotspotLoginUrl ? `/hotspot?next=${encodeURIComponent(next)}${hint ? `&mac=${encodeURIComponent(hint.mac)}&address=${encodeURIComponent(hint.address)}` : ""}` : next;
}

export function afterSignInPath(accountOnly = new URLSearchParams(location.search).get("account") === "1") {
  const next = consumeReturnPath();
  return accountOnly ? "/dashboard#account" : hotspotPath(next);
}
