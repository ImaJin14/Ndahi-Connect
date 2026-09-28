import client from "@prometheus-io/client";
import { safeEqual } from "./security.mjs";

// Proposed p95 completion targets in seconds; see docs/operations/performance.md.
export const performanceTargets = Object.freeze({
  login: 1,
  dashboard: 0.5,
  payment_creation: 2.5,
  voucher_redemption: 1,
  admin: 1.5,
});
// Proposed p75 Core Web Vitals targets for mobile visitors.
export const webVitalTargets = Object.freeze({ LCP: 2500, INP: 200, CLS: 0.1 });
const vitalBuckets = {
  LCP: [500, 1000, 1500, 2500, 4000, 8000, 15000],
  INP: [50, 100, 200, 300, 500, 1000, 3000],
  CLS: [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1],
};
const pages = ["login", "dashboard", "verify", "onboarding", "forgot-pin", "billing-terms"];

export function operationFor(path) {
  if (path.endsWith("/dashboard")) return "dashboard";
  if (path === "/api/purchase" || path === "/api/account/plan/purchase") return "payment_creation";
  if (path === "/api/vouchers/redeem") return "voucher_redemption";
  if (/^\/api\/(account|admin)\/(login(?:\/|$)|access\/|passkey\/|setup\/pin)/.test(path)) return "login";
  if (path.startsWith("/api/admin/")) return "admin";
  return null;
}

export function createPerformanceMetrics({ enabled = false, token = "", now = Date.now, sampleLimit = 10000 } = {}) {
  const registry = new client.Registry();
  const duration = new client.Histogram({
    name: "ndahi_request_duration_seconds",
    help: "API completion latency including persistence",
    labelNames: ["operation", "outcome"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2.5, 5, 10, 30],
    registers: [registry],
  });
  const targets = new client.Gauge({
    name: "ndahi_request_target_seconds",
    help: "Proposed p95 latency targets",
    labelNames: ["operation"],
    registers: [registry],
  });
  for (const [operation, seconds] of Object.entries(performanceTargets)) targets.set({ operation }, seconds);
  const vitalTargets = new client.Gauge({
    name: "ndahi_web_vital_target",
    help: "Proposed p75 Core Web Vitals targets (milliseconds, CLS unitless)",
    labelNames: ["metric"],
    registers: [registry],
  });
  for (const [metric, value] of Object.entries(webVitalTargets)) vitalTargets.set({ metric }, value);
  const vitals = Object.fromEntries(Object.entries(vitalBuckets).map(([name, buckets]) => [name, new client.Histogram({
    name: `ndahi_web_vital_${name.toLowerCase()}`,
    help: `${name} browser measurement`,
    labelNames: ["app", "page", "device", "network"],
    buckets,
    registers: [registry],
  })]));
  const rejected = new client.Counter({
    name: "ndahi_web_vital_rejected_total",
    help: "Browser measurements rejected as invalid or over the rate limit",
    labelNames: ["reason"],
    registers: [registry],
  });
  let windowStart = now(), samples = 0;
  return {
    enabled,
    registry,
    authorized(value) {
      return enabled && token.length >= 32 && safeEqual(String(value || ""), `Bearer ${token}`);
    },
    observe(path, status, seconds) {
      const operation = operationFor(path);
      if (!enabled || !operation) return;
      const outcome = status >= 500 ? "server_error" : status >= 400 ? "client_error" : "success";
      duration.observe({ operation, outcome }, Math.max(0, seconds));
    },
    ingest(input, app) {
      if (!enabled) return 404;
      if (now() - windowStart >= 60000) { windowStart = now(); samples = 0; }
      if (++samples > sampleLimit) { rejected.inc({ reason: "rate_limited" }); return 429; }
      const { name, value, page, device, network } = input || {};
      const valid = Object.hasOwn(vitals, name) && Number.isFinite(value) && value >= 0 &&
        value <= (name === "CLS" ? 100 : 300000) && pages.includes(page) &&
        ["mobile", "desktop"].includes(device) && ["slow", "fast", "unknown"].includes(network) &&
        ["customer", "admin"].includes(app);
      if (!valid) { rejected.inc({ reason: "invalid" }); return 400; }
      vitals[name].observe({ app, page, device, network }, value);
      return 204;
    },
  };
}
