const LABELS = {
  online: "Network online",
  degraded: "Network degraded",
  offline: "Network offline",
  maintenance: "Scheduled maintenance",
  unavailable: "Status unavailable",
};

export function networkStatusLabel(status) {
  return LABELS[status] || LABELS.unavailable;
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
  if (textNode) textNode.textContent = LABELS[known];
  else el.textContent = LABELS[known];
}

export function networkBannerState(options = {}) {
  const value = options.connectivity, now = Date.now();
  if (!value || value.version !== 1 || !(Date.parse(value.expiresAt) > now)) return { status: "unknown", badge: "Connection not verified", message: "Checking this device's network. Account access remains available from any network.", actionText: "Connection help", actionHref: "/help#connection" };
  if (value.network.state !== "confirmed") return { status: "unknown", badge: "NDAHI Wi-Fi not confirmed", message: "This request did not verify NDAHI Wi-Fi. Mobile data, a VPN or routing changes can affect this check.", actionText: "Check Wi-Fi sign-in", actionHref: "/hotspot" };
  if (value.hotspot.state === "authenticated") return { status: value.internet.state === "available" ? "active" : "degraded", badge: "Router connection confirmed", message: value.internet.state === "available" ? "This device has HotSpot access. The browser's internet check passed." : "This device has HotSpot access. Internet availability is not confirmed; do not buy again to fix connectivity.", actionText: value.internet.state === "available" ? null : "Connection help", actionHref: value.internet.state === "available" ? null : "/help#connection" };
  if (value.account.state === "signed-out") return { status: "pre-auth", badge: "NDAHI network detected", message: "Sign in to use your existing access or check bundle eligibility. Internet access is not yet confirmed.", actionText: "Sign in", actionHref: "/login" };
  if (["expired", "exhausted", "none"].includes(value.subscription.state)) return { status: "pre-auth", badge: "NDAHI network detected", message: "Review eligible bundles to connect. Network presence does not grant internet access.", actionText: "View bundles", actionHref: "/dashboard#bundles" };
  return { status: "unknown", badge: "NDAHI network detected", message: "Your account is available. This device's HotSpot authorization is still being checked.", actionText: "Connection help", actionHref: "/help#connection" };
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

