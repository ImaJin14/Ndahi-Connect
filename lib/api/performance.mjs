import { body, json } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
export function createPerformanceRoutes({ performanceMetrics, customerOrigin, adminOrigins }) {
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
    return NOT_HANDLED;
  };
}
