import http from "node:http";
import { createAssetCatalog, sendAsset } from "./lib/static-assets.mjs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, errorFields } from "./lib/logger.mjs";

export function createStaticServer(
  kind = "customer",
  {
    apiUrl = process.env.API_URL || "http://localhost:8082",
    production = process.env.NODE_ENV === "production",
    telemetry = process.env.PERFORMANCE_METRICS_ENABLED === "true",
    logger = createLogger({ service: kind, level: process.env.LOG_LEVEL }),
  } = {},
) {
  const root = join(process.cwd(), kind === "admin" ? "admin-app" : "customer-app");
  let assets;
  const getAssets = () => assets ||= createAssetCatalog(root, { telemetry }).catch((error) => { assets = undefined; throw error; });
  const reportUrl = `${apiUrl.replace(/\/$/, "")}/api/csp-report`,
    csp = [
      "default-src 'self'",
      `connect-src 'self' ${apiUrl}`,
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      production ? "upgrade-insecure-requests" : "",
      "report-to csp-endpoint",
      `report-uri ${reportUrl}`,
    ].filter(Boolean).join("; "),
    securityHeaders = {
      "content-security-policy": csp,
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(self), publickey-credentials-get=(self)",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "cross-origin-opener-policy": "same-origin",
      "reporting-endpoints": `csp-endpoint=\"${reportUrl}\"`,
      ...(production ? {
        "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
      } : {}),
    };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204, securityHeaders);
      return res.end();
    }
    if (url.pathname === "/config.js") {
      res.writeHead(200, {
        ...securityHeaders,
        "content-type": "text/javascript",
        "cache-control": "no-store",
      });
      return res.end(`window.NDAHI_CONFIG=${JSON.stringify({ apiUrl, app: kind })}`);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(302, { ...securityHeaders, location: "/login", "cache-control": "no-store" });
      return res.end();
    }
    let path = url.pathname;
    if (path === "/dashboard") path = "/index.html";
    if (path === "/login") path = "/login.html";
    if (path === "/forgot-pin") path = "/forgot-pin.html";
    if (path === "/admin" && kind === "customer") {
      res.writeHead(404, securityHeaders);
      return res.end("Not found");
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, { ...securityHeaders, allow: "GET, HEAD" });
      return res.end();
    }
    try {
      const { catalog } = await getAssets(), entry = catalog.get(path);
      if (!entry) {
        res.writeHead(404, { ...securityHeaders, "cache-control": "no-store" });
        return res.end("Not found");
      }
      sendAsset(req, res, entry, securityHeaders);
    } catch (error) {
      logger.error("static.assets_unavailable", errorFields(error));
      res.writeHead(503, { ...securityHeaders, "cache-control": "no-store" });
      res.end("Assets temporarily unavailable");
    }
  });
}

const main = process.argv[1] &&
  fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (main) {
  const kind = process.env.APP_KIND || "customer",
    port = Number(process.env.PORT ||
      (kind === "admin" ? process.env.ADMIN_PORT || 8081 : process.env.CUSTOMER_PORT || 8080));
  createStaticServer(kind).listen(
    port,
    process.env.HOST || "0.0.0.0",
    () => createLogger({ service: kind, level: process.env.LOG_LEVEL }).info("app.listening", { host: process.env.HOST || "0.0.0.0", port }),
  );
}
