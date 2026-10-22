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

