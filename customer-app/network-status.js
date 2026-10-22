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

export function networkBannerState(options) {
  const opts = options || {};
  const purchaseAccess = opts.purchaseAccess;
  const active = opts.active;
  const zone = opts.zone;
  if (purchaseAccess && purchaseAccess.allowed === false) {
    return {
      status: "off-network",
      badge: "Mobile Data / Off-network",
      message: "Viewing via Mobile Data • Purchases require joining NDAHI Wi-Fi",
      actionText: "Join Wi-Fi",
      actionHref: "/hotspot",
    };
  }
  const isActive = Boolean(active && (active.status === "active" || (active.remainingBytes > 0 && active.status !== "expired")));
  if (!isActive) {
    return {
      status: "pre-auth",
      badge: "Pre-Auth Captive",
      message: "Connected to NDAHI Wi-Fi • Select a bundle or enter voucher to unlock internet",
      actionText: "Choose package",
      actionHref: "/dashboard#bundles",
    };
  }
  let linkDetail = "Starlink Active";
  if (zone && zone.status === "degraded") linkDetail = "Network degraded";
  else if (zone && zone.status === "offline") linkDetail = "Upstream link offline";
  else if (zone && zone.status === "maintenance") linkDetail = "Scheduled maintenance";

  return {
    status: "active",
    badge: "Connected & Active",
    message: "Connected to NDAHI Wi-Fi • " + linkDetail,
    actionText: null,
    actionHref: null,
  };
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
  let advice = "Wi-Fi connection to gateway is healthy.";
  if (packetLoss === 100) {
    quality = "offline";
    advice = "Cannot reach NDAHI gateway. Check if you are connected to the NDAHI Wi-Fi network.";
  } else if (packetLoss > 0 || (avgLatency && avgLatency > 300)) {
    quality = "poor";
    advice = "High latency or packet loss detected. Move closer to the Wi-Fi access point.";
  } else if (avgLatency && avgLatency > 120) {
    quality = "fair";
    advice = "Acceptable connection speed to gateway.";
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

