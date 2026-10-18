import { isIP } from "node:net";
import { json, resolveClientIp } from "./api/http.mjs";

// Only new bundle purchases require the hotspot's coverage area. Guest API
// traffic leaves through the cloud gateway's fixed public IPv4, so a request
// from any other address cannot start a purchase. Account access stays public.
// Misconfiguration fails at startup and in the pre-deploy check, so a typo
// cannot silently allow off-network purchases or block every purchase.
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

const message = "Connect to NDAHI Wi-Fi to purchase a bundle.";

export function createCoverageGuard(env = {}) {
  const errors = coverageConfigErrors(env);
  if (errors.length) throw new Error(errors.join("; "));
  const enabled = env.COVERAGE_ACCESS_ENABLED === "true", allowed = new Set(addresses(env));
  const allows = (req) => !enabled || allowed.has(req.clientIp || resolveClientIp(req, env));
  const guard = (req, res) => {
    if (allows(req)) return true;
    json(res, 403, { error: message, code: "OUTSIDE_COVERAGE" });
    return false;
  };
  guard.enabled = enabled;
  guard.access = (req) => allows(req) ? { allowed: true } : { allowed: false, message };
  return guard;
}
