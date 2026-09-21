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
