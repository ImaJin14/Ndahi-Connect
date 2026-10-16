import { consumeReturnPath } from "./errors.js";

export function hotspotPath(next = "/dashboard") {
  return window.NDAHI_CONFIG.hotspotLoginUrl ? `/hotspot?next=${encodeURIComponent(next)}` : next;
}

export function afterSignInPath() {
  return hotspotPath(consumeReturnPath());
}
