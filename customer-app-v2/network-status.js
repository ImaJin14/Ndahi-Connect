import { t } from '/shared/i18n.js';
import { currentLanguage } from '/shared/ui/dom.js';
const L = key => t(key, currentLanguage());
const LABELS = {
  online: "homeNetworkOnline",
  degraded: "homeNetworkDegraded",
  offline: "homeNetworkOffline",
  maintenance: "homeNetworkMaintenance",
  unavailable: "homeNetworkUnavailable",
};

export function networkStatusLabel(status) {
  return L(LABELS[status] || LABELS.unavailable);
}

// Public, unauthenticated endpoint — used by pages that have no other
// authenticated payload to read the zone status from (login, onboarding).
export async function fetchNetworkStatus(apiUrl) {
  try {
    const response = await fetch(`${apiUrl}/api/status`);
    if (!response.ok) return "unavailable";
    const result = await response.json();
    return LABELS[result.service] ? result.service : "unavailable";
  } catch {
    return "unavailable";
  }
}

export function applyNetworkStatus(el, status) {
  if (!el) return;
  const known = LABELS[status] ? status : "unavailable";
  el.dataset.status = known;
  const textNode = [...el.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
  if (textNode) textNode.textContent = L(LABELS[known]);
  else el.textContent = L(LABELS[known]);
}

export function networkBannerState(options = {}) {
  const value = options.connectivity, now = Date.now();
  if (!value || value.version !== 1 || !(Date.parse(value.expiresAt) > now)) return { status: "unknown", badge: L("homeNetworkCheckingBadge"), message: L("homeNetworkCheckingBody"), actionText: L("homeNetworkHelp"), actionHref: "/help#connection" };
  if (value.network.state !== "confirmed") return { status: "unknown", badge: L("homeNetworkUnknownBadge"), message: L("homeNetworkUnknownBody"), actionText: L("homeNetworkCheck"), actionHref: "/hotspot" };
  if (value.hotspot.state === "authenticated") return { status: value.internet.state === "available" ? "active" : "degraded", badge: L("homeNetworkRouterConfirmed"), message: value.internet.state === "available" ? L("homeNetworkInternetAvailable") : L("homeNetworkInternetUnconfirmed"), actionText: value.internet.state === "available" ? null : L("homeNetworkHelp"), actionHref: value.internet.state === "available" ? null : "/help#connection" };
  if (value.account.state === "signed-out") return { status: "pre-auth", badge: L("homeNetworkDetected"), message: L("homeNetworkSignInBody"), actionText: L("homeNetworkSignIn"), actionHref: "/login" };
  if (["expired", "exhausted", "none"].includes(value.subscription.state)) return { status: "pre-auth", badge: L("homeNetworkDetected"), message: L("homeNetworkBundlesBody"), actionText: L("homeNetworkViewBundles"), actionHref: "/dashboard#bundles" };
  return { status: "unknown", badge: L("homeNetworkDetected"), message: L("homeNetworkAuthorizingBody"), actionText: L("homeNetworkHelp"), actionHref: "/help#connection" };
}

// Fixed HTTPS/CORS target, no cookies, referrer or account/device details. Only
// validates an independent browser path, never an SSID, router or purchase right.
export async function probeBrowserInternet({ signal, request = fetch, now = () => new Date() } = {}) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const abort = () => controller && controller.abort();
  if (signal && signal.aborted) abort();
  signal && signal.addEventListener("abort", abort, { once: true });
  let timer;
  try {
    return await Promise.race([(async () => {
      const response = await request("https://www.cloudflare.com/cdn-cgi/trace?ndahi_check=" + now().getTime(), { credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: controller ? controller.signal : undefined });
      const text = response.ok && !response.redirected && /text\/plain/i.test(response.headers.get("content-type") || "") ? await response.text() : "";
      return { state: /^h=www\.cloudflare\.com$/m.test(text) && /^colo=[A-Z]{3}$/m.test(text) ? "available" : "unavailable", scope: "browser-path", observedAt: now().toISOString() };
    })(), new Promise((_, reject) => { timer = setTimeout(() => { abort(); reject(Error("Internet check timed out")); }, 3500); })]);
  } catch (_) { return { state: "unavailable", scope: "browser-path", observedAt: now().toISOString() }; }
  finally { clearTimeout(timer); signal && signal.removeEventListener("abort", abort); }
}

export async function runConnectionDiagnostics(apiUrl) {
  const pings = [];
  const count = 3;
  let successful = 0;
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    try {
      const res = await fetch(`${apiUrl}/api/status?_t=${Date.now()}_${i}`, { cache: "no-store" });
      const duration = Math.round(performance.now() - start);
      if (res.ok) {
        successful++;
        pings.push(duration);
      } else {
        pings.push(null);
      }
    } catch {
      pings.push(null);
    }
    if (i < count - 1) await new Promise((r) => setTimeout(r, 200));
  }
  const validPings = pings.filter((p) => typeof p === "number");
  const packetLoss = Math.round(((count - successful) / count) * 100);
  const avgLatency = validPings.length ? Math.round(validPings.reduce((a, b) => a + b, 0) / validPings.length) : null;
  const minLatency = validPings.length ? Math.min(...validPings) : null;
  const maxLatency = validPings.length ? Math.max(...validPings) : null;
  const jitter = validPings.length > 1 ? Math.round(Math.abs(maxLatency - minLatency)) : 0;

  let quality = "good";
  let advice = "The hosted NDAHI API is reachable. This does not verify local Wi-Fi or internet authorization.";
  if (packetLoss === 100) {
    quality = "offline";
    advice = "The hosted NDAHI API could not be reached. Check your connection; this alone cannot identify the Wi-Fi or router state.";
  } else if (packetLoss > 0 || (avgLatency && avgLatency > 300)) {
    quality = "poor";
    advice = "Slow or failed API requests. Wi-Fi, mobile data, upstream routing or the hosted service may be responsible.";
  } else if (avgLatency && avgLatency > 120) {
    quality = "fair";
    advice = "The hosted API responded with moderate latency; local router status is separate.";
  }
  return {
    count,
    successful,
    packetLoss,
    avgLatency,
    minLatency,
    maxLatency,
    jitter,
    quality,
    advice,
    timestamp: new Date().toISOString(),
  };
}

