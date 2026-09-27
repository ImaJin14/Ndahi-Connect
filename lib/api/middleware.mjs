import { json, body, ip } from "./http.mjs";
import { log, customerCsrfPaths, ensureState, authEdgeScopes, sec } from "./state.mjs";
import { safeEqual } from "../security.mjs";
import { randomUUID } from "node:crypto";
import { NOT_HANDLED } from "./routing.mjs";
export function createMiddleware({
  adminOrigins,
  customerOrigin,
  env,
  mutate,
  store,
  auth,
  clock,
  edgeWindowMs,
  edgeLimits,
}) {
  return async function (req, res, url) {
    res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains; preload");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=()",
    );
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("x-content-type-options", "nosniff");
    const origin = req.headers.origin,
      isAdmin = url.pathname.startsWith("/api/admin/");
    if (origin) {
      const allowed = isAdmin
        ? adminOrigins.has(origin)
        : origin === customerOrigin || adminOrigins.has(origin);
      if (!allowed) return json(res, 403, { error: "Origin is not allowed." });
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-credentials", "true");
      res.setHeader("vary", "Origin");
      if (req.method === "OPTIONS") {
        res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type, x-csrf-token");
        res.writeHead(204);
        return res.end();
      }
    }
    const serverToServer = [
      "/api/webhooks/flutterwave",
      "/api/webhooks/mesomb",
      "/api/csp-report",
    ].includes(url.pathname);
    if (env.NODE_ENV === "production" && req.method === "POST" && !serverToServer && !origin) {
      return json(res, 403, { error: "A trusted request origin is required." });
    }
    if (req.method === "POST" && url.pathname === "/api/csp-report") {
      const raw = await body(req, true);
      try {
        const parsed = JSON.parse(raw || "{}"),
          report = parsed["csp-report"] || parsed[0]?.body || parsed.body || {};
        await mutate((s) =>
          log(s, "security.csp_violation", {
            document: String(report["document-uri"] || report.documentURL || "").slice(0, 300),
            directive: String(
              report["violated-directive"] || report.effectiveDirective || "",
            ).slice(0, 100),
            blocked: String(report["blocked-uri"] || report.blockedURL || "").slice(0, 300),
          }),
          { scope: [] },
        );
      } catch {
        // Malformed reports are intentionally discarded without affecting clients.
      }
      res.writeHead(204);
      return res.end();
    }
    if (env.NODE_ENV === "production" && req.method === "POST" && customerCsrfPaths[url.pathname]) {
      const state = ensureState(await store.snapshot()),
        session = auth(req, state, "dashboardSessions");
      if (!session) return json(res, 401, { error: "Customer session expired." });
      if (!safeEqual(req.headers["x-csrf-token"] || "", session.csrfToken || "")) {
        return json(res, 403, {
          error: "Security token expired. Refresh the page and try again.",
        });
      }
    }
    const edgeScope = req.method === "POST" && authEdgeScopes[url.pathname];
    if (edgeScope) {
      const limited = await mutate((s) => {
        const cutoff = new Date(clock().getTime() - edgeWindowMs),
          recent = s.rateLimitEvents.filter(
            (event) =>
              event.scope === edgeScope && event.ip === ip(req) && new Date(event.at) > cutoff,
          );
        if (recent.length >= edgeLimits[edgeScope]) {
          sec(s, "auth.edge.throttled", req, { scope: edgeScope });
          return true;
        }
        s.rateLimitEvents.push({
          id: randomUUID(),
          scope: edgeScope,
          ip: ip(req),
          at: clock().toISOString(),
        });
        return false;
      }, { scope: [`edge:${edgeScope}:${ip(req)}`] });
      if (limited) {
        return json(
          res,
          429,
          {
            error: "Too many authentication requests. Try again later.",
          },
          { "retry-after": String(Math.ceil(edgeWindowMs / 1000)) },
        );
      }
    }
    return NOT_HANDLED;
  };
}
