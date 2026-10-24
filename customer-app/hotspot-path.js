import { consumeReturnPath } from "./errors.js";
import { customerDestination, customerEntry } from "./customer-destination.js";
import { fetchConnectivity } from "./connectivity.js";
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
  const safe = customerDestination(next);
  return window.NDAHI_CONFIG.hotspotLoginUrl && wifiHint() ? withWifiHint(`/hotspot?next=${encodeURIComponent(safe)}`) : safe;
}

export async function afterSignInPath(accountOnly = new URLSearchParams(location.search).get("account") === "1") {
  const params = new URLSearchParams(location.search);
  // account=1 is emitted by explicit account-settings/recovery links. Ordinary
  // sign-in has no intended destination and opens Dashboard.
  const next = consumeReturnPath(null) || customerDestination(params.get("next"), null) || (params.get("account") === "1" && !params.has("next") ? "/dashboard#account" : "/dashboard");
  let evidence;
  try { evidence = await fetchConnectivity(window.NDAHI_CONFIG.apiUrl); } catch (_) { /* Dashboard displays unavailable evidence and preserves account access. */ }
  const target = customerEntry({ next, evidence, accountOnly, hasCandidate: Boolean(wifiHint()), hotspotEnabled: Boolean(window.NDAHI_CONFIG.hotspotLoginUrl) });
  return target.indexOf("/hotspot?") === 0 ? withWifiHint(target) : target;
}
