import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { resolveClientIp } from "./api/http.mjs";

// The customer portal and its API serve only the hotspot's coverage area. All
// guest traffic leaves through the cloud gateway's fixed public IPv4, so a
// request from any other address comes from outside the network.
// Misconfiguration fails at startup and in the pre-deploy check, so a typo
// cannot silently open the portal or lock every customer out.
const addresses = (env) => String(env.COVERAGE_ALLOWED_IPS || "").split(",").map((value) => value.trim()).filter(Boolean);

export function coverageConfigErrors(env = {}) {
  const errors = [], flag = env.COVERAGE_ACCESS_ENABLED;
  if (![undefined, "", "true", "false"].includes(flag)) errors.push('COVERAGE_ACCESS_ENABLED must be exactly "true" or "false"');
  if (flag !== "true") return errors;
  if (env.TRUST_PROXY !== "render") errors.push("COVERAGE_ACCESS_ENABLED requires TRUST_PROXY=render so the original client address is used");
  const allowed = addresses(env);
  if (!allowed.length) errors.push("COVERAGE_ALLOWED_IPS must list the hotspot's public IPv4 exit address");
  else if (allowed.some((value) => isIP(value) !== 4)) errors.push("COVERAGE_ALLOWED_IPS must contain only bare IPv4 addresses");
  return errors;
}

const message = "NDAHI Connect is only available on NDAHI Wi-Fi. Connect to the NDAHI Connect network, then open this page again.",
  style = "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f4ee;color:#163020;font:16px/1.5 system-ui,sans-serif}main{max-width:28rem;padding:2rem 1.25rem}h1{font-size:1.4rem;margin:0 0 .5rem}",
  page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to NDAHI Wi-Fi</title><style>${style}</style></head><body><main><h1>Connect to NDAHI Wi-Fi</h1><p>${message}</p></main></body></html>`,
  pageCsp = `default-src 'none'; style-src 'sha256-${createHash("sha256").update(style).digest("base64")}'; base-uri 'none'; frame-ancestors 'none'`;

export function createCoverageGuard(env = {}, { html = false } = {}) {
  const errors = coverageConfigErrors(env);
  if (errors.length) throw new Error(errors.join("; "));
  const enabled = env.COVERAGE_ACCESS_ENABLED === "true", allowed = new Set(addresses(env));
  const guard = (req, res) => {
    if (!enabled || allowed.has(req.clientIp || resolveClientIp(req, env))) return true;
    const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", vary: "Accept" };
    if (html && /text\/html/.test(String(req.headers?.accept || ""))) {
      res.writeHead(403, { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": pageCsp });
      res.end(page);
    } else {
      res.writeHead(403, { ...headers, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Connect to NDAHI Wi-Fi to use NDAHI Connect.", code: "OUTSIDE_COVERAGE" }));
    }
    return false;
  };
  guard.enabled = enabled;
  return guard;
}
