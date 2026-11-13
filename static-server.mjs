import http from "node:http";
import { createAssetCatalog, sendAsset } from "./lib/static-assets.mjs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, errorFields } from "./lib/logger.mjs";
import { selectUiVariant, uiRolloutConfig, uiVariantSetCookie } from "./lib/ui-variant.mjs";

const folders = { customer: "customer-app", admin: "admin-app", store: "store-app" };
// HTML and the service worker differ per variant, so shared caches must not keep them.
const privateCache = { immutable: "public, max-age=31536000, immutable", revalidate: "private, no-cache" };

export function createStaticServer(
  kind = "customer",
  {
    apiUrl = process.env.API_URL || "http://localhost:8082",
    production = process.env.NODE_ENV === "production",
    telemetry = process.env.PERFORMANCE_METRICS_ENABLED === "true",
    portalUrl = process.env.CUSTOMER_APP_URL || "http://localhost:8080",
    supportEmail = process.env.SUPPORT_EMAIL || "",
    supportPhone = process.env.SUPPORT_PHONE || "",
    hotspotLoginUrl = process.env.HOTSPOT_LOGIN_URL || "",
    logger = createLogger({ service: kind, level: process.env.LOG_LEVEL }),
    env = process.env,
    random = Math.random,
  } = {},
) {
  let hotspotOrigin = "";
  if (kind === "customer" && hotspotLoginUrl) {
    const login = new URL(hotspotLoginUrl);
    if (login.protocol !== "https:" || login.pathname !== "/login" || login.username || login.password || login.search || login.hash) {
      throw new Error("HOTSPOT_LOGIN_URL must be an HTTPS /login URL without credentials, query, or fragment.");
    }
    hotspotOrigin = login.origin;
  }
  // Customer and admin pages can run the v2 redesign beside v1; the store has one version.
  const rollout = kind === "customer" || kind === "admin" ? uiRolloutConfig(env, kind) : null,
    // The same Secure rule the API applies to its session cookies.
    secureCookie = env.SESSION_COOKIE_SECURE ? env.SESSION_COOKIE_SECURE !== "false" : production,
    folder = folders[kind] || folders.customer,
    catalogs = new Map();
  const getAssets = (variant = "v1") => {
    const root = join(process.cwd(), variant === "v2" ? `${folder}-v2` : folder);
    if (!catalogs.has(root)) catalogs.set(root, createAssetCatalog(root, { telemetry }).catch((error) => { catalogs.delete(root); throw error; }));
    return catalogs.get(root);
  };
  const reportUrl = `${apiUrl.replace(/\/$/, "")}/api/csp-report`,
    csp = [
      "default-src 'self'",
      `connect-src 'self' ${apiUrl}${kind === 'customer' ? ' https://www.cloudflare.com' : ''}`,
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      `form-action 'self'${hotspotOrigin ? ` ${hotspotOrigin}` : ""}`,
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
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return res.end("ok");
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204, securityHeaders);
      return res.end();
    }
    // Versioned /static/ files are named after their content, so they are shared
    // safely, never set the variant cookie and ignore ?ui=.
    const versioned = url.pathname.startsWith("/static/"),
      { variant, persist, requested, redirect } = rollout
        ? selectUiVariant({ kind, url, cookieHeader: req.headers.cookie, config: rollout, random })
        : { variant: "v1" };
    let headers = securityHeaders;
    if (rollout && !versioned) {
      headers = { ...securityHeaders, vary: "Cookie" };
      if (persist) res.setHeader("set-cookie", uiVariantSetCookie(variant, secureCookie, kind));
      if (requested) logger.info("ui.variant_requested", { kind, variant });
      if (redirect) {
        res.writeHead(302, { ...headers, location: redirect, "cache-control": "no-store" });
        return res.end();
      }
    }
    if (url.pathname === "/version.json") {
      const cacheControl = rollout ? "private, no-store" : "no-store";
      try {
        const { revision } = await getAssets(variant);
        res.writeHead(200, { ...headers, "content-type": "application/json", "cache-control": cacheControl });
        return res.end(JSON.stringify({ revision }));
      } catch {
        res.writeHead(503, { ...headers, "content-type": "application/json", "cache-control": cacheControl });
        return res.end(JSON.stringify({ error: "Release information is unavailable." }));
      }
    }
    if (url.pathname === "/config.js") {
      res.writeHead(200, {
        ...headers,
        "content-type": "text/javascript",
        "cache-control": "no-store",
      });
      return res.end(`window.NDAHI_CONFIG=${JSON.stringify({ apiUrl, portalUrl, app: kind, supportEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail) ? supportEmail : "", supportPhone: /^\+?[0-9 ()-]{6,24}$/.test(supportPhone) ? supportPhone : "", ...(hotspotOrigin ? { hotspotLoginUrl } : {}) })}`);
    }
    if (kind !== "store" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(302, { ...headers, location: kind === "customer" ? "/onboarding.html" : "/login", "cache-control": "no-store" });
      return res.end();
    }
    let path = kind === "store" && url.pathname === "/" ? "/index.html" : url.pathname;
    if (path === "/help" && kind === "customer") path = "/help.html";
    if (path === "/dashboard") path = "/index.html";
    if (path === "/login") path = "/login.html";
    if (path === "/hotspot" && kind === "customer") path = "/hotspot.html";
    if (path === "/pair" && kind === "customer") path = "/pair.html";
    if (path === "/forgot-pin") path = "/forgot-pin.html";
    if (path === "/admin" && kind === "customer") {
      res.writeHead(404, headers);
      return res.end("Not found");
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, { ...headers, allow: "GET, HEAD" });
      return res.end();
    }
    try {
      let entry = (await getAssets(variant)).catalog.get(path);
      // A page already open in the other variant, or a browser that refuses cookies,
      // may still request that variant's versioned files.
      if (!entry && versioned && rollout && !rollout.off) entry = (await getAssets(variant === "v2" ? "v1" : "v2")).catalog.get(path);
      if (!entry) {
        res.writeHead(404, { ...headers, "cache-control": "no-store" });
        return res.end("Not found");
      }
      sendAsset(req, res, entry, headers, rollout && (path === "/sw.js" || entry.type.startsWith("text/html")) ? privateCache : undefined);
    } catch (error) {
      logger.error("static.assets_unavailable", { ...errorFields(error), ...(rollout ? { variant } : {}) });
      res.writeHead(503, { ...headers, "cache-control": "no-store" });
      res.end("Assets temporarily unavailable");
    }
  });
}

const main = process.argv[1] &&
  fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (main) {
  const kind = process.env.APP_KIND || "customer",
    port = Number(process.env.PORT ||
      (kind === "admin" ? process.env.ADMIN_PORT || 8081 : kind === "store" ? process.env.STORE_PORT || 8083 : process.env.CUSTOMER_PORT || 8080));
  createStaticServer(kind).listen(
    port,
    process.env.HOST || "0.0.0.0",
    () => createLogger({ service: kind, level: process.env.LOG_LEVEL }).info("app.listening", { host: process.env.HOST || "0.0.0.0", port }),
  );
}
