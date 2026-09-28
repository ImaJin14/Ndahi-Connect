import { onCLS, onINP, onLCP } from "/vendor/web-vitals.js";

const pages = {
  "/dashboard": "dashboard",
  "/login": "login",
  "/login.html": "login",
  "/verify.html": "verify",
  "/onboarding.html": "onboarding",
  "/forgot-pin": "forgot-pin",
  "/forgot-pin.html": "forgot-pin",
  "/billing-terms.html": "billing-terms",
};
const page = pages[location.pathname];

function networkClass() {
  const type = navigator.connection?.effectiveType;
  if (!type) return "unknown";
  return ["slow-2g", "2g", "3g"].includes(type) ? "slow" : "fast";
}

// Fixed categories only: never send URLs, query strings, identities, metric IDs or attribution.
function send({ name, value }) {
  const apiUrl = window.NDAHI_CONFIG?.apiUrl;
  if (!page || !apiUrl) return;
  const payload = {
    name,
    value,
    page,
    device: matchMedia("(max-width: 800px)").matches ? "mobile" : "desktop",
    network: networkClass(),
  };
  void fetch(`${apiUrl.replace(/\/$/, "")}/api/telemetry/vitals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    credentials: "omit",
    keepalive: true,
  }).catch(() => {});
}

onCLS(send);
onINP(send);
onLCP(send);
