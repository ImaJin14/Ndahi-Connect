import { body, json } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { funnelInput, funnelRowId, recordFunnelStep } from "../insights-recording.mjs";
// Funnel beacons written per minute, across all visitors: hotspot visitors
// share the gateway's address, so a per-address limit would drop real visits.
const FUNNEL_PER_MINUTE = 600;
export function createPerformanceRoutes({ performanceMetrics, customerOrigin, adminOrigins, mutate, clock = () => new Date() }) {
  let funnelWindow = 0, funnelWritten = 0;
  return async function (req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/metrics") {
      if (!performanceMetrics.authorized(req.headers.authorization)) {
        return json(res, performanceMetrics.enabled ? 401 : 404, {
          error: performanceMetrics.enabled ? "Metrics authentication required." : "Not found.",
        });
      }
      res.writeHead(200, {
        "content-type": performanceMetrics.registry.contentType,
        "cache-control": "no-store",
      });
      return res.end(await performanceMetrics.registry.metrics());
    }
    if (req.method === "POST" && url.pathname === "/api/telemetry/vitals") {
      const origin = req.headers.origin;
      if (origin !== customerOrigin && !adminOrigins.has(origin)) {
        return json(res, 403, { error: "A trusted origin is required." });
      }
      const status = performanceMetrics.ingest(
        await body(req, false, 2048),
        adminOrigins.has(origin) ? "admin" : "customer",
      );
      if (status !== 204) return json(res, status, { error: "Measurement not accepted." });
      res.writeHead(204);
      return res.end();
    }
    // Wi-Fi page → paid funnel (#262): one anonymous step of one visit. Only
    // the step, the design variant and the day are kept; no identifier, IP,
    // account or URL.
    if (req.method === "POST" && url.pathname === "/api/telemetry/funnel") {
      if (req.headers.origin !== customerOrigin) return json(res, 403, { error: "A trusted origin is required." });
      let input;
      try { input = funnelInput(JSON.parse(await body(req, true, 256) || "{}")); } catch { input = null; }
      if (!input) return json(res, 400, { error: "Measurement not accepted." });
      const now = clock(), minute = Math.floor(+now / 60000);
      if (minute !== funnelWindow) { funnelWindow = minute; funnelWritten = 0; }
      if (mutate && ++funnelWritten <= FUNNEL_PER_MINUTE) {
        const id = funnelRowId(now, input.variant);
        await mutate((s) => { recordFunnelStep(s, input, now); }, { scope: [`insight:${id}`], load: [{ rows: { insightCounters: { id: [id] } } }] });
      }
      res.writeHead(204);
      return res.end();
    }
    return NOT_HANDLED;
  };
}
