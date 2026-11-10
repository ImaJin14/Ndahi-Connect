// Chooses which copy of the customer or admin front end a visitor sees while a
// redesign (v2) runs beside the current pages (v1). Both call the same API.
// Operating guide: docs/operations/ui-rollout.md.
export const uiVariantCookie = "ndahi_ui";
const maxAgeSeconds = 30 * 24 * 60 * 60;
const requested = { new: "v2", old: "v1" };

// Unset or empty values keep the safe defaults: nobody sampled, kill switch off.
export function uiRolloutErrors(env = {}) {
  const errors = [], percent = String(env.UI_V2_PERCENT ?? ""), off = String(env.UI_V2_OFF ?? "");
  if (percent !== "" && !/^(?:100|[1-9]?\d)$/.test(percent)) errors.push("UI_V2_PERCENT must be a whole number from 0 to 100");
  if (off !== "" && !["true", "false"].includes(off)) errors.push('UI_V2_OFF must be exactly "true" or "false"');
  return errors;
}

export function uiRolloutConfig(env = {}) {
  const errors = uiRolloutErrors(env);
  if (errors.length) throw new Error(`${errors.join("; ")}.`);
  return { percent: Number(env.UI_V2_PERCENT || 0), off: String(env.UI_V2_OFF) === "true" };
}

// Precedence: kill switch, then ?ui=new|old, then the saved cookie, then sampling.
// Staff opt in to the admin redesign explicitly, so admin visitors are never sampled.
export function selectUiVariant({ kind, url, cookieHeader = "", config, random = Math.random }) {
  if (config.off) return { variant: "v1" };
  const choice = requested[url.searchParams.get("ui")];
  if (choice) {
    const params = new URLSearchParams(url.searchParams);
    params.delete("ui");
    const query = params.toString();
    // A single leading slash keeps the redirect on this site even for paths like //host.
    const path = `/${url.pathname.replace(/^[/\\]+/, "")}`;
    return { variant: choice, persist: true, requested: true, redirect: query ? `${path}?${query}` : path };
  }
  const saved = String(cookieHeader).match(/(?:^|;)\s*ndahi_ui=(v1|v2)\s*(?:;|$)/)?.[1];
  if (saved) return { variant: saved };
  return { variant: kind === "customer" && random() * 100 < config.percent ? "v2" : "v1", persist: true };
}

// Host-only (no Domain), so the portal and admin choices stay separate.
export const uiVariantSetCookie = (variant, secure) =>
  `${uiVariantCookie}=${variant}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}`;
